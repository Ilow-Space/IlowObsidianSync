import { LoroDoc, LoroTree, LoroTreeNode, LoroMap } from 'loro-crdt';
import { SyncEventBus } from './SyncEventBus';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';

export class LoroVfsController {
	private treeDoc!: LoroDoc;
	private loroTree!: LoroTree;
	private pathToUuid = new Map<string, string>();
	private uuidToLastKnownPath = new Map<string, string>();
	private uuidToNodeId = new Map<string, string>();
	private nodeIdToUuid = new Map<string, string>();

	private unsubscribeDoc: (() => void) | null = null;
	private changeTimeout: any = null;

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
			if (event.local) return;

			if (this.changeTimeout) {
				clearTimeout(this.changeTimeout);
			}

			this.changeTimeout = setTimeout(() => {
				this.treeDoc.commit();
				this.rebuildCacheAndEmitRemoteDiffs();
			}, 0);
		});
	}

	public getUuidForPath(path: string): string | null {
		return this.pathToUuid.get(path) || null;
	}

	public getPathForUuid(uuid: string): string | null {
		return this.uuidToLastKnownPath.get(uuid) || null;
	}

	public getActiveFiles(): Array<{ uuid: string; path: string; type: string }> {
		const result: Array<{ uuid: string; path: string; type: string }> = [];
		for (const [uuid, path] of this.uuidToLastKnownPath.entries()) {
			const nodeId = this.uuidToNodeId.get(uuid);
			if (nodeId) {
				try {
					const node = this.loroTree.getNodeByID(nodeId);
					if (node && !node.isDeleted()) {
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

		const { dirPath, name } = this.splitPath(payload.path);
		const parentNodeId = this.getOrCreateFolderChainNodeId(dirPath);

		const nodeUuid = window.crypto.randomUUID() as string;

		const childNode = this.loroTree.createNode();
		if (parentNodeId) {
			this.loroTree.move(childNode.id, parentNodeId);
		}

		childNode.data.set('uuid', nodeUuid);
		childNode.data.set('filename', name);
		childNode.data.set('type', payload.isFolder ? 'folder' : 'file');
		childNode.data.set('isDeleted', false);

		this.treeDoc.commit();

		this.pathToUuid.set(payload.path, nodeUuid);
		this.uuidToLastKnownPath.set(nodeUuid, payload.path);
		this.uuidToNodeId.set(nodeUuid, childNode.id);
		this.nodeIdToUuid.set(childNode.id, nodeUuid);

		const updateBinary = this.treeDoc.export({ mode: 'update' });
		this.eventBus.emit('LocalDeltaReadyForPush', {
			documentId: 'shard-index',
			updateBinary,
			path: null
		});

		this.eventBus.emit('CrdtNodeCreated', {
			uuid: nodeUuid,
			path: payload.path,
			isFolder: payload.isFolder,
			content: payload.content
		});
	}

	private handleLocalFileRenamed(payload: { oldPath: string; newPath: string }): void {
		const nodeUuid = this.pathToUuid.get(payload.oldPath);
		if (!nodeUuid) return;

		const nodeId = this.uuidToNodeId.get(nodeUuid);
		if (!nodeId) return;

		const { dirPath, name } = this.splitPath(payload.newPath);
		const parentNodeId = this.getOrCreateFolderChainNodeId(dirPath);

		try {
			const node = this.loroTree.getNodeByID(nodeId);
			if (!node) return;

			if (parentNodeId) {
				this.loroTree.move(nodeId, parentNodeId);
			} else {
				this.loroTree.move(nodeId, null);
			}

			node.data.set('filename', name);
			this.treeDoc.commit();
		} catch (e) {}

		this.rebuildCache();

		const updateBinary = this.treeDoc.export({ mode: 'update' });
		this.eventBus.emit('LocalDeltaReadyForPush', {
			documentId: 'shard-index',
			updateBinary,
			path: null
		});

		this.eventBus.emit('CrdtNodeMoved', {
			uuid: nodeUuid,
			oldPath: payload.oldPath,
			newPath: payload.newPath
		});
	}

	private handleLocalFileDeleted(payload: { path: string }): void {
		const nodeUuid = this.pathToUuid.get(payload.path);
		if (!nodeUuid) return;

		const nodeId = this.uuidToNodeId.get(nodeUuid);
		if (!nodeId) return;

		try {
			const node = this.loroTree.getNodeByID(nodeId);
			if (!node) return;

			node.data.set('isDeleted', true);
			this.loroTree.delete(nodeId);
			this.treeDoc.commit();
		} catch (e) {}

		this.rebuildCache();

		const updateBinary = this.treeDoc.export({ mode: 'update' });
		this.eventBus.emit('LocalDeltaReadyForPush', {
			documentId: 'shard-index',
			updateBinary,
			path: null
		});

		this.eventBus.emit('CrdtNodeSoftDeleted', {
			uuid: nodeUuid,
			path: payload.path
		});
	}

	public rebuildCache(): void {
		this.pathToUuid.clear();
		this.uuidToLastKnownPath.clear();
		this.uuidToNodeId.clear();
		this.nodeIdToUuid.clear();

		const nodes = this.loroTree.getNodes();
		for (const node of nodes) {
			try {
				if (node.isDeleted()) continue;

				const isDeletedMeta = node.data.get('isDeleted');
				if (isDeletedMeta === true) continue;

				const nodeUuid = node.data.get('uuid') as string;
				if (!nodeUuid) continue;

				this.uuidToNodeId.set(nodeUuid, node.id);
				this.nodeIdToUuid.set(node.id, nodeUuid);
			} catch (e) {}
		}

		for (const node of nodes) {
			try {
				if (node.isDeleted()) continue;
				const isDeletedMeta = node.data.get('isDeleted');
				if (isDeletedMeta === true) continue;

				const nodeUuid = node.data.get('uuid') as string;
				if (!nodeUuid) continue;

				const resolvedPath = this.resolvePathForNode(node);
				if (resolvedPath) {
					this.pathToUuid.set(resolvedPath, nodeUuid);
					this.uuidToLastKnownPath.set(nodeUuid, resolvedPath);
				}
			} catch (e) {}
		}
	}

	private rebuildCacheAndEmitRemoteDiffs(): void {
		const oldUuidToLastKnown = new Map(this.uuidToLastKnownPath);
		this.rebuildCache();

		for (const [uuid, newPath] of this.uuidToLastKnownPath.entries()) {
			const oldPath = oldUuidToLastKnown.get(uuid);
			const nodeId = this.uuidToNodeId.get(uuid);
			try {
				const node = nodeId ? this.loroTree.getNodeByID(nodeId) : null;
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

	private resolvePathForNode(node: LoroTreeNode): string | null {
		const parts: string[] = [];
		let curr: LoroTreeNode | null = node;
		const visited = new Set<string>();

		while (curr) {
			if (visited.has(curr.id)) {
				console.error('[LoroVfsController] Cycle detected during path resolution for node:', curr.id);
				return null;
			}
			visited.add(curr.id);

			try {
				const filename = curr.data.get('filename') as string;
				if (filename) {
					parts.unshift(filename);
				}

				const parentId = curr.parent;
				curr = parentId ? this.loroTree.getNodeByID(parentId) : null;
			} catch (e) {
				break;
			}
		}

		return parts.join('/');
	}

	private getOrCreateFolderChainNodeId(dirPath: string): string | null {
		if (!dirPath || dirPath === '.' || dirPath === '') return null;

		let currentParentId: string | null = null;
		let cumulative = '';

		for (const part of dirPath.split('/')) {
			cumulative = cumulative ? cumulative + '/' + part : part;

			const existingUuid = this.pathToUuid.get(cumulative);
			if (existingUuid) {
				const nodeId = this.uuidToNodeId.get(existingUuid);
				if (nodeId) {
					currentParentId = nodeId;
				}
			} else {
				const folderUuid = window.crypto.randomUUID() as string;
				const newFolderNode = this.loroTree.createNode();
				if (currentParentId) {
					this.loroTree.move(newFolderNode.id, currentParentId);
				}

				newFolderNode.data.set('uuid', folderUuid);
				newFolderNode.data.set('filename', part);
				newFolderNode.data.set('type', 'folder');
				newFolderNode.data.set('isDeleted', false);

				this.treeDoc.commit();

				this.pathToUuid.set(cumulative, folderUuid);
				this.uuidToLastKnownPath.set(folderUuid, cumulative);
				this.uuidToNodeId.set(folderUuid, newFolderNode.id);
				this.nodeIdToUuid.set(newFolderNode.id, folderUuid);

				currentParentId = newFolderNode.id;
			}
		}

		return currentParentId;
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
	}
}
