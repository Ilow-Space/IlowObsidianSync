
import { LoroDoc, LoroTree, LoroTreeNode } from 'loro-crdt';
import { SyncEventBus } from './SyncEventBus';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';
import { PluginSettings } from '@presentation/Plugin';
import { isAllowedConfigPath } from '@domain/Utils/ConfigPathFilter';

export class LoroVfsController {
	public treeDoc!: LoroDoc;
	public loroTree!: LoroTree;
	private pathToUuid = new Map<string, string>();
	private uuidToLastKnownPath = new Map<string, string>();
	private uuidToNodeId = new Map<string, unknown>();
	private nodeIdToUuid = new Map<string, string>();
	private snapshotBeforeRemoteUpdate: Map<string, string> | null = null;

	private boundCreated = this.handleLocalFileCreated.bind(this);
	private boundRenamed = this.handleLocalFileRenamed.bind(this);
	private boundDeleted = this.handleLocalFileDeleted.bind(this);
	private boundRebalance = this.handleRebalancePathUuid.bind(this);

	private unsubscribeDoc: (() => void) | null = null;
	private changeTimeout: number | null = null;
	private pushTimeout: number | null = null;
	private pendingFrontier: ReturnType<LoroDoc['version']> | null = null;

	constructor(
		private syncEngine: LoroSyncEngine,
		private eventBus: SyncEventBus,
		private settings?: PluginSettings,
		private configDir?: string
	) {}

	public prepareForRemoteVfsUpdate(): void {
		// Capture exact state of last known paths before remote index updates are imported
		this.snapshotBeforeRemoteUpdate = new Map(this.uuidToLastKnownPath);
	}

	private getNodeIdStr(id: unknown): string {
		if (id === null || id === undefined) return '';
		if (typeof id === 'string') return id;
		if (typeof id === 'object') {
			const idObj = id as { peer?: unknown; counter?: unknown };
			if (idObj.peer !== undefined && idObj.counter !== undefined) {
				return `${String(idObj.peer)}_${String(idObj.counter)}`;
			}
			try {
				const j = JSON.stringify(id);
				if (j !== '{}') return j;
			} catch {
				// Suppress JSON error
			}
		}
		return String(id);
	}

	public async initialize(): Promise<void> {
		if (this.unsubscribeDoc) return;
		this.treeDoc = await this.syncEngine.getOrCreateDoc('shard-index');
		this.loroTree = this.treeDoc.getTree('vault-tree');

		this.rebuildCache();
		this.resolvePathCollisions();

		this.eventBus.on('LocalFileCreated', this.boundCreated);
		this.eventBus.on('LocalFileRenamed', this.boundRenamed);
		this.eventBus.on('LocalFileDeleted', this.boundDeleted);
		this.eventBus.on('RebalancePathUuid', this.boundRebalance);

		this.unsubscribeDoc = this.treeDoc.subscribe((event) => {
			if (event.by === 'local') return;

			if (this.changeTimeout) window.clearTimeout(this.changeTimeout);

			this.changeTimeout = window.setTimeout(() => {
				this.treeDoc.commit();
				this.rebuildCacheAndEmitRemoteDiffs();
			}, 10);
		});
	}

	private captureFrontierIfNeeded() {
		if (!this.pendingFrontier) {
			this.pendingFrontier = this.treeDoc.version();
		}
	}

	private scheduleLocalPush(): void {
		if (this.pushTimeout) window.clearTimeout(this.pushTimeout);

		this.pushTimeout = window.setTimeout(() => {
			this.flushPendingPush();
		}, 10);
	}

	public flushPendingPush(): void {
		if (this.pushTimeout) {
			window.clearTimeout(this.pushTimeout);
			this.pushTimeout = null;
		}
		if (this.pendingFrontier) {
			const updateBinary = new Uint8Array(this.treeDoc.export({ mode: 'update', from: this.pendingFrontier }));
			this.pendingFrontier = null;

			this.eventBus.emit('LocalDeltaReadyForPush', {
				documentId: 'shard-index',
				updateBinary,
				path: null
			});
		}
	}

	public getUuidForPath(path: string): string | null {
		const cached = this.pathToUuid.get(path);
		if (cached) return cached;

		if (this.loroTree) {
			const nodes = this.loroTree.getNodes();
			const nodeMap = new Map<string, LoroTreeNode>();
			for (const n of nodes) nodeMap.set(this.getNodeIdStr(n.id), n);

			for (const node of nodes) {
				try {
					if (node.isDeleted() || node.data.get('isDeleted') === true) continue;
					const nodePath = this.resolvePathForNode(node, nodeMap);
					if (nodePath === path) {
						const uuid = node.data.get('uuid');
						if (typeof uuid === 'string' && uuid) {
							this.pathToUuid.set(path, uuid);
							this.uuidToLastKnownPath.set(uuid, path);
							return uuid;
						}
					}
				} catch (e: unknown) {
					// Ignore node path resolution errors
					void e;
				}
			}
		}

		return null;
	}

	public getPathForUuid(uuid: string): string | null {
		return this.uuidToLastKnownPath.get(uuid) || null;
	}

	public getActiveBlobHashes(): string[] {
		const hashes = new Set<string>();
		const nodes = this.loroTree.getNodes();

		for (const node of nodes) {
			try {
				if (!node.isDeleted() && node.data.get('isDeleted') !== true) {
					const blobHash = node.data.get('blob_hash');
					if (typeof blobHash === 'string' && blobHash.trim().length > 0) {
						hashes.add(blobHash.trim());
					}
				}
			} catch (e: unknown) {
				// Suppress blob hash extraction errors
				void e;
			}
		}

		return Array.from(hashes);
	}

	public getActiveFiles(): Array<{ uuid: string; path: string; type: string }> {
		const result: Array<{ uuid: string; path: string; type: string }> = [];
		const nodes = this.loroTree.getNodes();
		const nodeMap = new Map<string, LoroTreeNode>();
		for (const n of nodes) nodeMap.set(this.getNodeIdStr(n.id), n);

		for (const [uuid, path] of this.uuidToLastKnownPath.entries()) {
			const nodeId = this.uuidToNodeId.get(uuid);
			if (nodeId) {
				try {
					const node = nodeMap.get(this.getNodeIdStr(nodeId));
					if (node && !node.isDeleted() && node.data.get('isDeleted') !== true) {
						const type = node.data.get('type');
						result.push({ uuid, path, type: typeof type === 'string' ? type : 'file' });
					}
				} catch (e: unknown) {
					// Suppress active file retrieval errors
					void e;
				}
			}
		}
		return result;
	}

	private handleRebalancePathUuid(payload: { remoteUuid: string; path: string }): void {
		const nodes = this.loroTree.getNodes();
		const nodeMap = new Map<string, LoroTreeNode>();
		for (const n of nodes) nodeMap.set(this.getNodeIdStr(n.id), n);

		let mutated = false;
		for (const node of nodes) {
			try {
				if (node.isDeleted() || node.data.get('isDeleted') === true) continue;

				const uuid = node.data.get('uuid');
				if (typeof uuid !== 'string' || !uuid || uuid === payload.remoteUuid) continue;

				const resolvedPath = this.resolvePathForNode(node, nodeMap);
				if (resolvedPath === payload.path) {
					node.data.set('isDeleted', true);
					try { this.loroTree.delete(node.id); } catch (e: unknown) { void e; }
					mutated = true;
				}
			} catch (e: unknown) {
				// Suppress rebalance errors
				void e;
			}
		}

		if (mutated) {
			this.treeDoc.commit();
		}
		this.rebuildCache();
	}

	private handleLocalFileCreated(payload: { path: string; isFolder: boolean; content?: string }): void {
		if (payload.path === '/') return;
		if (!isAllowedConfigPath(payload.path, this.configDir, this.settings)) return;
		if (this.pathToUuid.has(payload.path)) return;

		const filename = payload.path.substring(payload.path.lastIndexOf('/') + 1);
		if (this.findMovedFileMatch(filename, payload.path)) return;

		this.captureFrontierIfNeeded();

		const { dirPath, name } = this.splitPath(payload.path);
		const parentUuid = this.getOrCreateFolderChainUuid(dirPath);

		const nodeUuid = window.crypto.randomUUID() as string;
		const childNode = this.loroTree.createNode();

		if (parentUuid) {
			const parentNodeId = this.uuidToNodeId.get(parentUuid);
			if (parentNodeId) {
				try { this.loroTree.move(childNode.id, parentNodeId as LoroTreeNode['id']); } catch (e: unknown) { void e; }
			}
		}

		childNode.data.set('uuid', nodeUuid);
		childNode.data.set('filename', name);
		childNode.data.set('type', payload.isFolder ? 'folder' : 'file');
		childNode.data.set('isDeleted', false);

		this.treeDoc.commit();

		this.pathToUuid.set(payload.path, nodeUuid);
		this.uuidToLastKnownPath.set(nodeUuid, payload.path);
		this.uuidToNodeId.set(nodeUuid, childNode.id);
		this.nodeIdToUuid.set(this.getNodeIdStr(childNode.id), nodeUuid);

		this.scheduleLocalPush();
	}

	private handleLocalFileRenamed(payload: { oldPath: string; newPath: string }): void {
		const nodeUuid = this.pathToUuid.get(payload.oldPath) || this.getUuidForPath(payload.oldPath);
		if (!nodeUuid) return;

		const targetNodeId = this.uuidToNodeId.get(nodeUuid);
		if (!targetNodeId) return;

		this.captureFrontierIfNeeded();

		const { dirPath, name } = this.splitPath(payload.newPath);
		const parentUuid = this.getOrCreateFolderChainUuid(dirPath);
		const parentNodeId = parentUuid ? this.uuidToNodeId.get(parentUuid) : undefined;

		try {
			if (parentNodeId !== undefined && parentNodeId !== null) {
				this.loroTree.move(targetNodeId as LoroTreeNode['id'], parentNodeId as LoroTreeNode['id']);
			} else {
				this.loroTree.move(targetNodeId as LoroTreeNode['id'], undefined);
			}

			const targetIdStr = this.getNodeIdStr(targetNodeId);
			const freshNode = this.loroTree.getNodes().find(n => this.getNodeIdStr(n.id) === targetIdStr);
			if (freshNode) freshNode.data.set('filename', name);

			this.treeDoc.commit();
		} catch (e: unknown) {
			// Suppress move errors
			void e;
		}

		this.rebuildCache();
		this.scheduleLocalPush();
	}

	private handleLocalFileDeleted(payload: { path: string; uuid?: string }): void {
		const nodeUuid = this.pathToUuid.get(payload.path);
		if (!nodeUuid) return;

		const targetNodeId = this.uuidToNodeId.get(nodeUuid);
		if (!targetNodeId) return;

		this.captureFrontierIfNeeded();

		try {
			const targetIdStr = this.getNodeIdStr(targetNodeId);
			const freshNode = this.loroTree.getNodes().find(n => this.getNodeIdStr(n.id) === targetIdStr);
			if (freshNode) freshNode.data.set('isDeleted', true);

			this.treeDoc.commit();
		} catch (e: unknown) {
			// Suppress soft delete error
			void e;
		}

		this.pathToUuid.delete(payload.path);
		this.uuidToLastKnownPath.delete(nodeUuid);
		this.uuidToNodeId.delete(nodeUuid);
		this.nodeIdToUuid.delete(this.getNodeIdStr(targetNodeId));

		try {
			this.loroTree.delete(targetNodeId as LoroTreeNode['id']);
			this.treeDoc.commit();
		} catch (e: unknown) {
			// Suppress tree delete error
			void e;
		}

		this.scheduleLocalPush();
	}

	public rebuildCache(): void {
		this.pathToUuid.clear();
		this.uuidToLastKnownPath.clear();
		this.uuidToNodeId.clear();
		this.nodeIdToUuid.clear();

		const nodes = this.loroTree.getNodes();
		const nodeMap = new Map<string, LoroTreeNode>();

		for (const node of nodes) {
			try {
				const idStr = this.getNodeIdStr(node.id);
				nodeMap.set(idStr, node);

				if (node.isDeleted() || node.data.get('isDeleted') === true) continue;

				const nodeUuid = node.data.get('uuid');
				if (typeof nodeUuid !== 'string' || !nodeUuid) continue;

				this.uuidToNodeId.set(nodeUuid, node.id);
				this.nodeIdToUuid.set(idStr, nodeUuid);
			} catch (e: unknown) {
				// Suppress node indexing error
				void e;
			}
		}

		for (const node of nodes) {
			try {
				if (node.isDeleted() || node.data.get('isDeleted') === true) continue;

				const nodeUuid = node.data.get('uuid');
				if (typeof nodeUuid !== 'string' || !nodeUuid) continue;

				const resolvedPath = this.resolvePathForNode(node, nodeMap);
				if (resolvedPath) {
					this.pathToUuid.set(resolvedPath, nodeUuid);
					this.uuidToLastKnownPath.set(nodeUuid, resolvedPath);
				}
			} catch (e: unknown) {
				// Suppress path resolution error
				void e;
			}
		}
	}

	private resolvePathForNode(node: LoroTreeNode, nodeMap: Map<string, LoroTreeNode>, ignoreDeleted: boolean = false): string | null {
		const parts: string[] = [];
		let curr: LoroTreeNode | null = node;
		const visited = new Set<string>();

		while (curr) {
			const idStr = this.getNodeIdStr(curr.id);
			if (!idStr || visited.has(idStr)) return null;
			visited.add(idStr);

			try {
				if (!ignoreDeleted && (curr.isDeleted() || curr.data.get('isDeleted') === true)) break;

				const filename = curr.data.get('filename');
				if (typeof filename === 'string' && filename) parts.unshift(filename);

				const parentNode = typeof curr.parent === 'function' ? curr.parent() : undefined;
				if (!parentNode) break;

				const parentIdStr = this.getNodeIdStr(parentNode.id);
				curr = nodeMap.get(parentIdStr) || null;
			} catch (e: unknown) {
				void e;
				break;
			}
		}

		return parts.length > 0 ? parts.join('/') : null;
	}

	private getOrCreateFolderChainUuid(dirPath: string): string | null {
		if (!dirPath || dirPath === '.' || dirPath === '') return null;

		let currentParentUuid: string | null = null;
		let cumulative = '';

		for (const part of dirPath.split('/')) {
			cumulative = cumulative ? cumulative + '/' + part : part;

			const existingUuid = this.pathToUuid.get(cumulative);
			if (existingUuid) {
				currentParentUuid = existingUuid;
			} else {
				const folderUuid = window.crypto.randomUUID() as string;
				const newFolderNode = this.loroTree.createNode();

				if (currentParentUuid) {
					const parentNodeId = this.uuidToNodeId.get(currentParentUuid);
					if (parentNodeId) {
						try { this.loroTree.move(newFolderNode.id, parentNodeId as LoroTreeNode['id']); } catch (e: unknown) { void e; }
					}
				}

				newFolderNode.data.set('uuid', folderUuid);
				newFolderNode.data.set('filename', part);
				newFolderNode.data.set('type', 'folder');
				newFolderNode.data.set('isDeleted', false);

				this.treeDoc.commit();

				this.pathToUuid.set(cumulative, folderUuid);
				this.uuidToLastKnownPath.set(folderUuid, cumulative);
				this.uuidToNodeId.set(folderUuid, newFolderNode.id);
				this.nodeIdToUuid.set(this.getNodeIdStr(newFolderNode.id), folderUuid);

				currentParentUuid = folderUuid;
			}
		}
		return currentParentUuid;
	}

	private splitPath(p: string): { dirPath: string; name: string } {
		const lastSlash = p.lastIndexOf('/');
		const dirPath = lastSlash !== -1 ? p.substring(0, lastSlash) : '';
		const name = lastSlash !== -1 ? p.substring(lastSlash + 1) : p;
		return { dirPath, name };
	}
	
	public processRemoteVfsUpdates(): void {
		if (this.changeTimeout) {
			window.clearTimeout(this.changeTimeout);
			this.changeTimeout = null;
		}
		this.treeDoc.commit();
		this.rebuildCacheAndEmitRemoteDiffs();
	}

	private rebuildCacheAndEmitRemoteDiffs(): void {
		const oldUuidToLastKnown = this.snapshotBeforeRemoteUpdate || new Map(this.uuidToLastKnownPath);
		this.snapshotBeforeRemoteUpdate = null;

		this.rebuildCache();
		this.resolvePathCollisions();

		const nodes = this.loroTree.getNodes();
		const nodeMap = new Map<string, LoroTreeNode>();
		for (const n of nodes) nodeMap.set(this.getNodeIdStr(n.id), n);

		// Moves go out before creations: a file displaced by a collision must leave its path before the winner lands on it.
		const created: Array<{ uuid: string; path: string; isFolder: boolean }> = [];
		for (const [uuid, newPath] of this.uuidToLastKnownPath.entries()) {
			const oldPath = oldUuidToLastKnown.get(uuid);
			const nodeId = this.uuidToNodeId.get(uuid);
			try {
				const node = nodeId ? nodeMap.get(this.getNodeIdStr(nodeId)) : null;
				const isFolder = node ? node.data.get('type') === 'folder' : false;

				if (!oldPath) {
					created.push({ uuid, path: newPath, isFolder });
				} else if (oldPath !== newPath) {
					this.eventBus.emit('CrdtNodeMoved', { uuid, oldPath, newPath });
				}
			} catch (e: unknown) {
				// Suppress remote diff emission error
				void e;
			}
		}

		for (const c of created) this.eventBus.emit('CrdtNodeCreated', c);

		for (const [uuid, oldPath] of oldUuidToLastKnown.entries()) {
			if (!this.uuidToLastKnownPath.has(uuid)) {
				if (this.pathToUuid.has(oldPath)) continue;
				this.eventBus.emit('CrdtNodeSoftDeleted', { uuid, path: oldPath });
			}
		}
	}

	public isFilenameDeletedRemotely(filename: string, path: string): boolean {
		if (!this.loroTree) return false;
		const nodes = this.loroTree.getNodes();
		const nodeMap = new Map<string, LoroTreeNode>();
		for (const n of nodes) nodeMap.set(this.getNodeIdStr(n.id), n);

		for (const node of nodes) {
			try {
				if (node.data.get('filename') === filename && (node.isDeleted() || node.data.get('isDeleted') === true)) {
					const nodePath = this.resolvePathForNode(node, nodeMap, true);
					if (nodePath === path || nodePath === filename) {
						return true;
					}
				}
			} catch (e: unknown) {
				// Suppress remote delete check error
				void e;
			}
		}
		return false;
	}

	public findMovedFileMatch(filename: string, oldPath: string): { uuid: string; path: string } | null {
		const activeFiles = this.getActiveFiles();
		for (const file of activeFiles) {
			if (file.type === 'file') {
				const fileFilename = file.path.substring(file.path.lastIndexOf('/') + 1);
				if (fileFilename === filename && file.path !== oldPath) {
					return { uuid: file.uuid, path: file.path };
				}
			}
		}
		return null;
	}

	public getBlobHashForUuid(uuid: string): string | null {
		const nodeId = this.uuidToNodeId.get(uuid);
		if (!nodeId) return null;
		const nodes = this.loroTree.getNodes();
		const node = nodes.find(n => this.getNodeIdStr(n.id) === this.getNodeIdStr(nodeId));
		if (!node) return null;
		const hash = node.data.get('blob_hash');
		return typeof hash === 'string' ? hash : null;
	}

	public setBlobHashForUuid(uuid: string, hash: string): void {
		const nodeId = this.uuidToNodeId.get(uuid);
		if (!nodeId) return;
		const nodes = this.loroTree.getNodes();
		const node = nodes.find(n => this.getNodeIdStr(n.id) === this.getNodeIdStr(nodeId));
		if (node) {
			this.captureFrontierIfNeeded();
			node.data.set('blob_hash', hash);
			this.treeDoc.commit();
			this.scheduleLocalPush();
		}
	}

	/**
	 * One path must be one live document. Two devices that independently create the same path
	 * produce two valid tree nodes; this resolves them by a rule every device computes alike, so
	 * the merged index converges without any device-local decision:
	 *  - a folder beats a file, otherwise the lowest uuid wins;
	 *  - a losing folder hands its children to the winner and is deleted;
	 *  - a losing file is renamed `name (conflict <uuid6>).ext` (same name on every device) and
	 *    tagged `conflictOf`, so no content is lost. Identical copies are dropped later by the
	 *    orchestrator once the content of both documents is known.
	 */
	private resolvePathCollisions(): void {
		let mutated = false;
		for (let pass = 0; pass < 3; pass++) {
			const collisions = this.findPathCollisions();
			if (collisions.length === 0) break;
			if (!mutated) this.captureFrontierIfNeeded();
			for (const [winner, ...losers] of collisions) {
				for (const loser of losers) this.demoteLoser(winner, loser);
			}
			mutated = true;
			this.treeDoc.commit();
			this.rebuildCache();
		}
		if (mutated) this.scheduleLocalPush();
	}

	/** Groups of live nodes that resolve to one path, each ordered winner-first. */
	private findPathCollisions(): LoroTreeNode[][] {
		const nodes = this.loroTree.getNodes();
		const nodeMap = new Map<string, LoroTreeNode>();
		for (const n of nodes) nodeMap.set(this.getNodeIdStr(n.id), n);

		const byPath = new Map<string, LoroTreeNode[]>();
		for (const node of nodes) {
			const path = this.livePathOf(node, nodeMap);
			// Config files are singletons per device and are reconciled by RebalancePathUuid, never renamed.
			if (!path || (this.configDir && (path === this.configDir || path.startsWith(this.configDir + '/')))) continue;
			const group = byPath.get(path);
			if (group) group.push(node); else byPath.set(path, [node]);
		}
		const rank = (n: LoroTreeNode) => `${n.data.get('type') === 'folder' ? '0' : '1'}${String(n.data.get('uuid'))}`;
		return Array.from(byPath.values())
			.filter(group => group.length > 1)
			.map(group => group.sort((a, b) => (rank(a) < rank(b) ? -1 : 1)));
	}

	private livePathOf(node: LoroTreeNode, nodeMap: Map<string, LoroTreeNode>): string | null {
		try {
			if (node.isDeleted() || node.data.get('isDeleted') === true) return null;
			const uuid = node.data.get('uuid');
			if (typeof uuid !== 'string' || !uuid) return null;
			return this.resolvePathForNode(node, nodeMap) || null;
		} catch (e: unknown) {
			void e;
			return null;
		}
	}

	private demoteLoser(winner: LoroTreeNode, loser: LoroTreeNode): void {
		try {
			if (loser.data.get('type') === 'folder' && winner.data.get('type') === 'folder') {
				for (const child of loser.children() ?? []) this.loroTree.move(child.id, winner.id);
				loser.data.set('isDeleted', true);
				this.loroTree.delete(loser.id);
				return;
			}
			const name = String(loser.data.get('filename'));
			const dot = name.lastIndexOf('.');
			const base = dot > 0 ? name.substring(0, dot) : name;
			const ext = dot > 0 ? name.substring(dot) : '';
			loser.data.set('filename', `${base} (conflict ${String(loser.data.get('uuid')).substring(0, 6)})${ext}`);
			loser.data.set('conflictOf', String(winner.data.get('uuid')));
		} catch (e: unknown) {
			void e;
		}
	}

	/** Live conflict copies and the document each one lost to. */
	public getConflictCopies(): Array<{ uuid: string; path: string; winnerUuid: string }> {
		const out: Array<{ uuid: string; path: string; winnerUuid: string }> = [];
		for (const node of this.loroTree.getNodes()) {
			try {
				if (node.isDeleted() || node.data.get('isDeleted') === true) continue;
				const uuid = node.data.get('uuid');
				const winnerUuid = node.data.get('conflictOf');
				if (typeof uuid !== 'string' || typeof winnerUuid !== 'string') continue;
				const path = this.uuidToLastKnownPath.get(uuid);
				if (path) out.push({ uuid, path, winnerUuid });
			} catch (e: unknown) { void e; }
		}
		return out;
	}

	/** Deletes a conflict copy from the index and from disk. */
	public dropConflictCopy(uuid: string): void {
		const path = this.uuidToLastKnownPath.get(uuid);
		if (!path) return;
		this.handleLocalFileDeleted({ path });
		this.eventBus.emit('CrdtNodeSoftDeleted', { uuid, path });
	}

	/** Re-binds to a freshly loaded index doc, discarding any unpushed local index changes. */
	public async reinitialize(): Promise<void> {
		this.pendingFrontier = null;
		this.destroy();
		await this.initialize();
	}

	public destroy(): void {
		this.flushPendingPush();
		this.eventBus.off('LocalFileCreated', this.boundCreated);
		this.eventBus.off('LocalFileRenamed', this.boundRenamed);
		this.eventBus.off('LocalFileDeleted', this.boundDeleted);
		this.eventBus.off('RebalancePathUuid', this.boundRebalance);

		if (this.unsubscribeDoc) {
			this.unsubscribeDoc();
			this.unsubscribeDoc = null;
		}
		if (this.changeTimeout) {
			window.clearTimeout(this.changeTimeout);
			this.changeTimeout = null;
		}
		if (this.pushTimeout) {
			window.clearTimeout(this.pushTimeout);
			this.pushTimeout = null;
		}
	}
}

