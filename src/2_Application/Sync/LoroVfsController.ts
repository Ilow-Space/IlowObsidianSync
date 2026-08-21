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
	private uuidToNodeId = new Map<string, any>();
	private nodeIdToUuid = new Map<string, string>();
	private snapshotBeforeRemoteUpdate: Map<string, string> | null = null;

	private boundCreated = this.handleLocalFileCreated.bind(this);
	private boundRenamed = this.handleLocalFileRenamed.bind(this);
	private boundDeleted = this.handleLocalFileDeleted.bind(this);
	private boundRebalance = this.handleRebalancePathUuid.bind(this);

	private unsubscribeDoc: (() => void) | null = null;
	private changeTimeout: any = null;
	private pushTimeout: any = null;
	private pendingFrontier: any = null;

	constructor(
		private syncEngine: LoroSyncEngine,
		private eventBus: SyncEventBus,
		private settings?: PluginSettings,
		private configDir: string = '.obsidian'
	) {}

	public prepareForRemoteVfsUpdate(): void {
		// Capture exact state of last known paths before remote index updates are imported
		this.snapshotBeforeRemoteUpdate = new Map(this.uuidToLastKnownPath);
	}

	private getNodeIdStr(id: any): string {
		if (id === null || id === undefined) return '';
		if (typeof id === 'string') return id;
		if (typeof id === 'object') {
			if (id.peer !== undefined && id.counter !== undefined) {
				return `${id.peer.toString()}_${id.counter}`;
			}
			try {
				const j = JSON.stringify(id);
				if (j !== '{}') return j;
			} catch (e) {}
		}
		return String(id);
	}

	public async initialize(): Promise<void> {
		this.treeDoc = await this.syncEngine.getOrCreateDoc('shard-index');
		this.loroTree = this.treeDoc.getTree('vault-tree');

		this.rebuildCache();

		this.eventBus.on('LocalFileCreated', this.boundCreated);
		this.eventBus.on('LocalFileRenamed', this.boundRenamed);
		this.eventBus.on('LocalFileDeleted', this.boundDeleted);
		this.eventBus.on('RebalancePathUuid' as any, this.boundRebalance);

		this.unsubscribeDoc = this.treeDoc.subscribe((event) => {
			if (event.by === 'local') return;

			if (this.changeTimeout) clearTimeout(this.changeTimeout);

			this.changeTimeout = setTimeout(() => {
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
		if (this.pushTimeout) clearTimeout(this.pushTimeout);

		this.pushTimeout = setTimeout(() => {
			this.flushPendingPush();
		}, 10);
	}

	public flushPendingPush(): void {
		if (this.pushTimeout) {
			clearTimeout(this.pushTimeout);
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
		return this.pathToUuid.get(path) || null;
	}

	public getPathForUuid(uuid: string): string | null {
		return this.uuidToLastKnownPath.get(uuid) || null;
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
						const type = node.data.get('type') as string;
						result.push({ uuid, path, type });
					}
				} catch (e) {}
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

				const uuid = node.data.get('uuid') as string;
				if (!uuid || uuid === payload.remoteUuid) continue;

				const resolvedPath = this.resolvePathForNode(node, nodeMap);
				if (resolvedPath === payload.path) {
					node.data.set('isDeleted', true);
					try { this.loroTree.delete(node.id); } catch (e) {}
					mutated = true;
				}
			} catch (e) {}
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
				try { this.loroTree.move(childNode.id, parentNodeId); } catch (e) {}
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
				this.loroTree.move(targetNodeId, parentNodeId);
			} else {
				this.loroTree.move(targetNodeId, undefined as any);
			}

			const targetIdStr = this.getNodeIdStr(targetNodeId);
			const freshNode = this.loroTree.getNodes().find(n => this.getNodeIdStr(n.id) === targetIdStr);
			if (freshNode) freshNode.data.set('filename', name);

			this.treeDoc.commit();
		} catch (e) {}

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

			this.loroTree.delete(targetNodeId);
			this.treeDoc.commit();
		} catch (e) {}

		this.pathToUuid.delete(payload.path);
		this.uuidToLastKnownPath.delete(nodeUuid);
		this.uuidToNodeId.delete(nodeUuid);
		this.nodeIdToUuid.delete(this.getNodeIdStr(targetNodeId));

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

				const nodeUuid = node.data.get('uuid') as string;
				if (!nodeUuid) continue;

				this.uuidToNodeId.set(nodeUuid, node.id);
				this.nodeIdToUuid.set(idStr, nodeUuid);
			} catch (e) {}
		}

		for (const node of nodes) {
			try {
				if (node.isDeleted() || node.data.get('isDeleted') === true) continue;

				const nodeUuid = node.data.get('uuid') as string;
				if (!nodeUuid) continue;

				const resolvedPath = this.resolvePathForNode(node, nodeMap);
				if (resolvedPath) {
					this.pathToUuid.set(resolvedPath, nodeUuid);
					this.uuidToLastKnownPath.set(nodeUuid, resolvedPath);
				}
			} catch (e) {}
		}
	}

	private resolvePathForNode(node: LoroTreeNode, nodeMap: Map<string, LoroTreeNode>): string | null {
		const parts: string[] = [];
		let curr: LoroTreeNode | null = node;
		const visited = new Set<string>();

		while (curr) {
			const idStr = this.getNodeIdStr(curr.id);
			if (!idStr || visited.has(idStr)) return null;
			visited.add(idStr);

			try {
				if (curr.isDeleted() || curr.data.get('isDeleted') === true) break;

				const filename = curr.data.get('filename') as string;
				if (filename) parts.unshift(filename);

				const parentNode = typeof curr.parent === 'function' ? curr.parent() : (curr as any).parent;
				if (!parentNode) break;

				const parentId = parentNode.id !== undefined ? parentNode.id : parentNode;
				const parentIdStr = this.getNodeIdStr(parentId);
				curr = nodeMap.get(parentIdStr) || null;
			} catch (e) { break; }
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
						try { this.loroTree.move(newFolderNode.id, parentNodeId); } catch (e) {}
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
			clearTimeout(this.changeTimeout);
			this.changeTimeout = null;
		}
		this.treeDoc.commit();
		this.rebuildCacheAndEmitRemoteDiffs();
	}

	private rebuildCacheAndEmitRemoteDiffs(): void {
		const oldUuidToLastKnown = this.snapshotBeforeRemoteUpdate || new Map(this.uuidToLastKnownPath);
		this.snapshotBeforeRemoteUpdate = null;

		this.rebuildCache();

		const nodes = this.loroTree.getNodes();
		const nodeMap = new Map<string, LoroTreeNode>();
		for (const n of nodes) nodeMap.set(this.getNodeIdStr(n.id), n);

		for (const [uuid, newPath] of this.uuidToLastKnownPath.entries()) {
			const oldPath = oldUuidToLastKnown.get(uuid);
			const nodeId = this.uuidToNodeId.get(uuid);
			try {
				const node = nodeId ? nodeMap.get(this.getNodeIdStr(nodeId)) : null;
				const isFolder = node ? node.data.get('type') === 'folder' : false;

				if (!oldPath) {
					this.eventBus.emit('CrdtNodeCreated', { uuid, path: newPath, isFolder });
				} else if (oldPath !== newPath) {
					this.eventBus.emit('CrdtNodeMoved', { uuid, oldPath, newPath });
				}
			} catch (e) {}
		}

		for (const [uuid, oldPath] of oldUuidToLastKnown.entries()) {
			if (!this.uuidToLastKnownPath.has(uuid)) {
				if (this.pathToUuid.has(oldPath)) continue;
				this.eventBus.emit('CrdtNodeSoftDeleted', { uuid, path: oldPath });
			}
		}
	}

	public isFilenameDeletedRemotely(filename: string, path: string): boolean {
		const nodes = this.loroTree.getNodes();
		for (const node of nodes) {
			try {
				if (node.data.get('filename') === filename && (node.isDeleted() || node.data.get('isDeleted') === true)) {
					return true;
				}
			} catch (e) {}
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

	public destroy(): void {
		this.flushPendingPush();
		this.eventBus.off('LocalFileCreated', this.boundCreated);
		this.eventBus.off('LocalFileRenamed', this.boundRenamed);
		this.eventBus.off('LocalFileDeleted', this.boundDeleted);
		this.eventBus.off('RebalancePathUuid' as any, this.boundRebalance);

		if (this.unsubscribeDoc) {
			this.unsubscribeDoc();
			this.unsubscribeDoc = null;
		}
		if (this.changeTimeout) {
			clearTimeout(this.changeTimeout);
			this.changeTimeout = null;
		}
		if (this.pushTimeout) {
			clearTimeout(this.pushTimeout);
			this.pushTimeout = null;
		}
	}
}