import { LoroDoc, LoroTree, LoroTreeNode } from 'loro-crdt';
import { SyncEventBus } from './SyncEventBus';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';

export class LoroVfsController {
	private treeDoc!: LoroDoc;
	private loroTree!: LoroTree;
	private pathToUuid = new Map<string, string>();
	private uuidToLastKnownPath = new Map<string, string>();
	private uuidToNodeId = new Map<string, string>();
	private nodeIdToUuid = new Map<string, string>();
	
	// Caches only RAW TreeID objects (safe across WASM transactions)
	private stringToTreeId = new Map<string, any>();

	private unsubscribeDoc: (() => void) | null = null;
	private changeTimeout: any = null;
	private pushTimeout: any = null;
	private pendingFrontier: any = null; 

	constructor(
		private syncEngine: LoroSyncEngine,
		private eventBus: SyncEventBus
	) {}

	public async initialize(): Promise<void> {
		this.treeDoc = await this.syncEngine.getOrCreateDoc('shard-index');
		this.loroTree = this.treeDoc.getTree('vault-tree');

		this.rebuildCache();

		this.eventBus.on('LocalFileCreated', this.handleLocalFileCreated.bind(this));
		this.eventBus.on('LocalFileRenamed', this.handleLocalFileRenamed.bind(this));
		this.eventBus.on('LocalFileDeleted', this.handleLocalFileDeleted.bind(this));

		this.unsubscribeDoc = this.treeDoc.subscribe((event) => {
			if (event.by === 'local') return;

			if (this.changeTimeout) {
				clearTimeout(this.changeTimeout);
			}

			this.changeTimeout = setTimeout(() => {
				this.treeDoc.commit();
				this.rebuildCacheAndEmitRemoteDiffs();
			}, 50);
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
			if (this.pendingFrontier) {
				const updateBinary = new Uint8Array(this.treeDoc.export({ mode: 'update', from: this.pendingFrontier }));
				this.pendingFrontier = null; 
				
				this.eventBus.emit('LocalDeltaReadyForPush', {
					documentId: 'shard-index',
					updateBinary,
					path: null
				});
			}
			this.pushTimeout = null;
		}, 50);
	}

	private idToStr(id: any): string {
		if (!id) return '';
		if (typeof id === 'string') return id.replace('@', ':');
		if (id.peer !== undefined && id.counter !== undefined) return `${id.peer}:${id.counter}`;
		return String(id).replace('@', ':');
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
		const fastNodeMap = new Map<string, LoroTreeNode>();
		for (const n of nodes) fastNodeMap.set(this.idToStr(n.id), n);

		for (const [uuid, path] of this.uuidToLastKnownPath.entries()) {
			const nodeIdStr = this.uuidToNodeId.get(uuid);
			if (nodeIdStr) {
				try {
					const node = fastNodeMap.get(nodeIdStr);
					if (node && !node.isDeleted() && node.data.get('isDeleted') !== true) {
						const type = node.data.get('type') as string;
						result.push({ uuid, path, type });
					}
				} catch (e) {}
			}
		}
		return result;
	}

	private handleLocalFileCreated(payload: { path: string; isFolder: boolean; content?: string }): void {
		if (payload.path.startsWith('.') || payload.path === '/') return;
		if (this.pathToUuid.has(payload.path)) return;

		this.captureFrontierIfNeeded();

		const { dirPath, name } = this.splitPath(payload.path);
		const parentNodeIdStr = this.getOrCreateFolderChainNodeId(dirPath);

		const nodeUuid = window.crypto.randomUUID() as string;
		const childNode = this.loroTree.createNode();
		const childIdStr = this.idToStr(childNode.id);
		
		this.stringToTreeId.set(childIdStr, childNode.id);
		
		if (parentNodeIdStr) {
			const parentTreeId = this.stringToTreeId.get(parentNodeIdStr);
			if (parentTreeId) this.loroTree.move(childNode.id, parentTreeId);
		}

		childNode.data.set('uuid', nodeUuid);
		childNode.data.set('filename', name);
		childNode.data.set('type', payload.isFolder ? 'folder' : 'file');
		childNode.data.set('isDeleted', false);

		this.treeDoc.commit();

		this.pathToUuid.set(payload.path, nodeUuid);
		this.uuidToLastKnownPath.set(nodeUuid, payload.path);
		this.uuidToNodeId.set(nodeUuid, childIdStr);
		this.nodeIdToUuid.set(childIdStr, nodeUuid);

		this.scheduleLocalPush();
	}

	private handleLocalFileRenamed(payload: { oldPath: string; newPath: string }): void {
		const nodeUuid = this.pathToUuid.get(payload.oldPath);
		if (!nodeUuid) return;

		const nodeIdStr = this.uuidToNodeId.get(nodeUuid);
		if (!nodeIdStr) return;

		this.captureFrontierIfNeeded();

		const { dirPath, name } = this.splitPath(payload.newPath);
		const parentNodeIdStr = this.getOrCreateFolderChainNodeId(dirPath);

		const targetTreeId = this.stringToTreeId.get(nodeIdStr);
		const parentTreeId = parentNodeIdStr ? this.stringToTreeId.get(parentNodeIdStr) : undefined;

		if (targetTreeId) {
			try {
				// Move strictly using raw IDs (safe across WASM boundaries)
				this.loroTree.move(targetTreeId, parentTreeId);

				// Fetch a fresh node wrapper to safely mutate the metadata
				const freshNode = this.loroTree.getNodes().find(n => this.idToStr(n.id) === nodeIdStr);
				if (freshNode) freshNode.data.set('filename', name);
				
				this.treeDoc.commit();
			} catch (e) {
				console.error("[LoroVfsController] Error during tree move:", e);
			}
		}

		this.rebuildCache();
		this.scheduleLocalPush();
	}

	private handleLocalFileDeleted(payload: { path: string }): void {
		const nodeUuid = this.pathToUuid.get(payload.path);
		if (!nodeUuid) return;

		const nodeIdStr = this.uuidToNodeId.get(nodeUuid);
		if (!nodeIdStr) return;

		this.captureFrontierIfNeeded();

		const targetTreeId = this.stringToTreeId.get(nodeIdStr);

		if (targetTreeId) {
			try {
				// Set meta data using fresh node wrapper before deleting the actual node
				const freshNode = this.loroTree.getNodes().find(n => this.idToStr(n.id) === nodeIdStr);
				if (freshNode) freshNode.data.set('isDeleted', true);
				
				this.loroTree.delete(targetTreeId);
				this.treeDoc.commit();
			} catch (e) {}
		}

		this.pathToUuid.delete(payload.path);
		this.uuidToLastKnownPath.delete(nodeUuid);
		this.uuidToNodeId.delete(nodeUuid);
		this.nodeIdToUuid.delete(nodeIdStr);

		this.scheduleLocalPush();
	}

	public rebuildCache(): void {
		this.pathToUuid.clear();
		this.uuidToLastKnownPath.clear();
		this.uuidToNodeId.clear();
		this.nodeIdToUuid.clear();
		this.stringToTreeId.clear();

		const nodes = this.loroTree.getNodes();
		const fastNodeMap = new Map<string, LoroTreeNode>();

		for (const node of nodes) {
			try {
				const idStr = this.idToStr(node.id);
				fastNodeMap.set(idStr, node);
				this.stringToTreeId.set(idStr, node.id);
			} catch (e) {}
		}

		for (const node of nodes) {
			try {
				if (node.isDeleted() || node.data.get('isDeleted') === true) continue;

				const nodeUuid = node.data.get('uuid') as string;
				if (!nodeUuid) continue;

				const idStr = this.idToStr(node.id);
				this.uuidToNodeId.set(nodeUuid, idStr);
				this.nodeIdToUuid.set(idStr, nodeUuid);

				// Resolves O(1) instantly via map injection
				const resolvedPath = this.resolvePathForNode(node, fastNodeMap);
				if (resolvedPath) {
					this.pathToUuid.set(resolvedPath, nodeUuid);
					this.uuidToLastKnownPath.set(nodeUuid, resolvedPath);
				}
			} catch (e) {}
		}
	}

	private resolvePathForNode(node: LoroTreeNode, fastNodeMap: Map<string, LoroTreeNode>): string | null {
		const parts: string[] = [];
		let curr: LoroTreeNode | null = node;
		const visited = new Set<string>();

		while (curr) {
			const idStr = this.idToStr(curr.id);
			if (!idStr || visited.has(idStr)) return null;
			visited.add(idStr);

			try {
				if (curr.isDeleted() || curr.data.get('isDeleted') === true) break;

				const filename = curr.data.get('filename') as string;
				if (filename) {
					parts.unshift(filename);
				}

				const parentId = curr.parent;
				if (!parentId) break;

				const parentStr = this.idToStr(parentId);
				curr = fastNodeMap.get(parentStr) || null;
			} catch (e) {
				break;
			}
		}

		return parts.length > 0 ? parts.join('/') : null;
	}

	private rebuildCacheAndEmitRemoteDiffs(): void {
		const oldUuidToLastKnown = new Map(this.uuidToLastKnownPath);
		this.rebuildCache();

		// Fetch fresh nodes for comparison
		const nodes = this.loroTree.getNodes();
		const fastNodeMap = new Map<string, LoroTreeNode>();
		for (const n of nodes) fastNodeMap.set(this.idToStr(n.id), n);

		for (const [uuid, newPath] of this.uuidToLastKnownPath.entries()) {
			const oldPath = oldUuidToLastKnown.get(uuid);
			const nodeIdStr = this.uuidToNodeId.get(uuid);
			try {
				const node = nodeIdStr ? fastNodeMap.get(nodeIdStr) : null;
				const isFolder = node ? node.data.get('type') === 'folder' : false;

				if (!oldPath) {
					this.eventBus.emit('CrdtNodeCreated', {
						uuid,
						path: newPath,
						isFolder
					});
				} else if (oldPath !== newPath) {
					this.eventBus.emit('CrdtNodeMoved', {
						uuid,
						oldPath,
						newPath
					});
				}
			} catch (e) {}
		}

		for (const [uuid, oldPath] of oldUuidToLastKnown.entries()) {
			if (!this.uuidToLastKnownPath.has(uuid)) {
				this.eventBus.emit('CrdtNodeSoftDeleted', {
					uuid,
					path: oldPath
				});
			}
		}
	}

	private getOrCreateFolderChainNodeId(dirPath: string): string | null {
		if (!dirPath || dirPath === '.' || dirPath === '') return null;

		let currentParentIdStr: string | null = null;
		let cumulative = '';

		for (const part of dirPath.split('/')) {
			cumulative = cumulative ? cumulative + '/' + part : part;

			const existingUuid = this.pathToUuid.get(cumulative);
			if (existingUuid) {
				const nodeIdStr = this.uuidToNodeId.get(existingUuid);
				if (nodeIdStr) {
					currentParentIdStr = nodeIdStr;
				}
			} else {
				const folderUuid = window.crypto.randomUUID() as string;
				const newFolderNode = this.loroTree.createNode();
				const newFolderIdStr = this.idToStr(newFolderNode.id);
				
				this.stringToTreeId.set(newFolderIdStr, newFolderNode.id);

				if (currentParentIdStr) {
					const parentTreeId = this.stringToTreeId.get(currentParentIdStr);
					if (parentTreeId) this.loroTree.move(newFolderNode.id, parentTreeId);
				}

				newFolderNode.data.set('uuid', folderUuid);
				newFolderNode.data.set('filename', part);
				newFolderNode.data.set('type', 'folder');
				newFolderNode.data.set('isDeleted', false);

				this.treeDoc.commit();

				this.pathToUuid.set(cumulative, folderUuid);
				this.uuidToLastKnownPath.set(folderUuid, cumulative);
				this.uuidToNodeId.set(folderUuid, newFolderIdStr);
				this.nodeIdToUuid.set(newFolderIdStr, folderUuid);

				currentParentIdStr = newFolderIdStr;
			}
		}

		return currentParentIdStr;
	}

	private splitPath(p: string): { dirPath: string; name: string } {
		const lastSlash = p.lastIndexOf('/');
		const dirPath = lastSlash !== -1 ? p.substring(0, lastSlash) : '';
		const name = lastSlash !== -1 ? p.substring(lastSlash + 1) : p;
		return { dirPath, name };
	}

	public destroy(): void {
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