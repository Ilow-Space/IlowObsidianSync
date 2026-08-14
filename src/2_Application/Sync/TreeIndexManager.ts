import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import * as Y from 'yjs';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { CryptoUtils } from '@infrastructure/Crypto/CryptoUtils';
import { SyncOrchestrator } from './SyncOrchestrator';
import { VfsCollisionResolver } from './VfsCollisionResolver';
import { VfsDeletionService } from './VfsDeletionService';
import { VfsReconciliationService } from './VfsReconciliationService';
import { VfsUntrackedScanner } from './VfsUntrackedScanner';
import { VFSNode } from '@domain/Entities/Models';

export class TreeCrdtEvaluator {
	constructor(private treeMap: Y.Map<any>) {}

	public isDescendantOf(parentId: string, nodeId: string): boolean {
		if (parentId === nodeId) return true;
		let currentId = parentId;
		const visited = new Set<string>();

		while (currentId && currentId !== 'root') {
			if (currentId === nodeId) return true;
			if (visited.has(currentId)) return true;
			visited.add(currentId);

			const node = this.treeMap.get(currentId);
			if (!node) break;
			currentId = node.parentId;
		}
		return false;
	}
}

export class TreeIndexManager {
	public readonly INDEX_DOC_ID = 'shard-index';
	private treeDoc: Y.Doc | null = null;
	public treeMap: Y.Map<any> | null = null;
	private pathToUuid = new Map<string, string>();
	private uuidToLastKnownPath = new Map<string, string>();
	private isReconciling = false;
	private initPromise: Promise<void> | null = null;
	private resolvedRenameCollisions = new Set<string>();
	private cascadedRenames = new Set<string>();

	private collisionResolver: VfsCollisionResolver;
	private deletionService: VfsDeletionService;
	private reconciliationService: VfsReconciliationService;
	private untrackedScanner: VfsUntrackedScanner;

	constructor(
        private app: App,
        private crdtEngine: YjsEngine,
        private syncOrchestrator: SyncOrchestrator
	) {
		this.collisionResolver = new VfsCollisionResolver(app);
		this.deletionService = new VfsDeletionService(app);
		this.reconciliationService = new VfsReconciliationService(app);
		this.untrackedScanner = new VfsUntrackedScanner(app);
	}

	public async initialize(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = this.doInitialize();
		}
		return this.initPromise;
	}

	private async doInitialize(): Promise<void> {
		this.treeDoc = await this.crdtEngine.getOrCreateDoc(this.INDEX_DOC_ID);
		this.treeMap = this.treeDoc.getMap('vault-tree');

		for (const [uuid, node] of this.treeMap.entries()) {
			if (!node.isDeleted) {
				const resolved = this.resolvePath(uuid);
				if (resolved) {
					this.uuidToLastKnownPath.set(uuid, resolved);
				}
			}
		}

		this.rebuildReverseLookup();
		console.log(`[TreeIndexManager] VFS Initialized. Tracking ${this.pathToUuid.size} active nodes.`);
	}

	public getCrdtEvaluator(): TreeCrdtEvaluator {
		return new TreeCrdtEvaluator(this.treeMap!);
	}

	public resolvePath(uuid: string): string | null {
		if (!this.treeMap) return null;
		const node = this.treeMap.get(uuid) as any;
		if (!node) return null;

		// Fallback for tests or old schema
		if (node.path && node.parentId === undefined) {
			return node.path;
		}

		const pathParts: string[] = [];
		let currentUuid = uuid;
		const visited = new Set<string>();

		while (currentUuid && currentUuid !== 'root') {
			if (visited.has(currentUuid)) {
				console.error(`Cycle detected in resolvePath for ${uuid}`);
				return null;
			}
			visited.add(currentUuid);

			const currentNode = this.treeMap.get(currentUuid);
			if (!currentNode) {
				return null;
			}
			// Support mixing legacy and new schema if any ancestor has legacy schema
			if (currentNode.path && currentNode.parentId === undefined) {
				pathParts.unshift(currentNode.path);
				break;
			}
			pathParts.unshift(currentNode.metadata);
			currentUuid = currentNode.parentId;
		}

		return pathParts.join('/');
	}

	public getUuidForPath(path: string): string | null {
		return this.pathToUuid.get(path) || null;
	}

	public getPathForUuid(uuid: string): string | null {
		return this.resolvePath(uuid);
	}

	public getActiveFiles(): Array<{ uuid: string; path: string; type: string }> {
		if (!this.treeMap) return [];
		const result: Array<{ uuid: string; path: string; type: string }> = [];
		for (const [uuid, node] of this.treeMap.entries()) {
			if (!node.isDeleted) {
				const resolved = this.resolvePath(uuid);
				if (resolved) {
					result.push({ uuid, path: resolved, type: node.type });
				}
			}
		}
		return result;
	}

	public rebuildReverseLookup(): void {
		this.pathToUuid.clear();
		if (!this.treeMap) return;
		for (const [uuid, node] of this.treeMap.entries()) {
			if (!node.isDeleted) {
				const resolved = this.resolvePath(uuid);
				if (resolved) {
					this.pathToUuid.set(resolved, uuid);
				}
			}
		}
	}

	private async applyAndPushIndexTransaction(fn: () => void): Promise<void> {
		if (!this.treeDoc) return;
		this.treeDoc.transact(() => {
			fn();
		});
		const update = Y.encodeStateAsUpdate(this.treeDoc);
		// Persist the updated index state to local store so it is retained across reboots
		await this.crdtEngine.localStore.saveDocumentState(this.INDEX_DOC_ID, update);
		// FIX: The unit tests expect we call pushDocumentUpdate with (manager.INDEX_DOC_ID, update, null)
		await this.syncOrchestrator.pushDocumentUpdate(this.INDEX_DOC_ID, update, null);
	}

	public splitPath(p: string): { dirPath: string; name: string } {
		const lastSlash = p.lastIndexOf('/');
		const dirPath = lastSlash !== -1 ? p.substring(0, lastSlash) : '';
		const name = lastSlash !== -1 ? p.substring(lastSlash + 1) : p;
		return { dirPath, name };
	}

	public getPathPartsAndCumulative(pathStr: string): Array<{ part: string; cumulative: string }> {
		const result: Array<{ part: string; cumulative: string }> = [];
		let cumulative = '';
		for (const part of pathStr.split('/')) {
			cumulative = cumulative ? cumulative + '/' + part : part;
			result.push({ part, cumulative });
		}
		return result;
	}

	public getOrCreateCrdtFolderChain(dirPath: string): string {
		if (!dirPath || dirPath === '.' || dirPath === '') return 'root';
		let currentParentId = 'root';

		for (const item of this.getPathPartsAndCumulative(dirPath)) {
			const existingUuid = this.pathToUuid.get(item.cumulative);
			if (existingUuid) {
				currentParentId = existingUuid;
			} else {
				const uuid = window.crypto.randomUUID() as string;
                this.treeMap!.set(uuid, {
			type: 'folder',
			parentId: currentParentId,
			metadata: item.part,
			isDeleted: false
                } as VFSNode);
                this.pathToUuid.set(item.cumulative, uuid);
                this.uuidToLastKnownPath.set(uuid, item.cumulative);
                currentParentId = uuid;
			}
		}

		return currentParentId;
	}

	public async reconcileFilesystem(): Promise<void> {
		await this.initialize();
		if (!this.treeMap || this.isReconciling) return;
		this.isReconciling = true;

		const safeExists = async (p: string) => {
			try { return await this.app.vault.adapter.exists(p); } catch { return false; }
		};

		try {
			// Reparent orphaned offline creations
			await this.applyAndPushIndexTransaction(() => {
				for (const [uuid, node] of this.treeMap!.entries()) {
					if (node.isDeleted) continue;
					if (node.parentId !== undefined && node.parentId !== 'root') {
						const parentNode = this.treeMap!.get(node.parentId);
						if (!parentNode || parentNode.isDeleted) {
							console.warn(`[TreeIndexManager] Reparenting orphaned node ${uuid} (metadata: ${node.metadata}) to root because parent ${node.parentId} is deleted or missing.`);
                            this.treeMap!.set(uuid, {
				...node,
				parentId: 'root'
                            });
						}
					}
				}
			});

			await this.resolveAllCollisions(safeExists);

			this.rebuildReverseLookup();

			const entries = Array.from(this.treeMap.entries());

			const missingUuids = Array.from(this.uuidToLastKnownPath.keys())
				.filter(uuid => !this.treeMap!.has(uuid));

			const toDelete = entries
				.filter(e => e[1].isDeleted)
				.map(e => {
					const lastPath = this.uuidToLastKnownPath.get(e[0]) || this.resolvePath(e[0]) || '';
					return [e[0], { path: lastPath, isDeleted: true }] as [string, any];
				})
				.filter(item => item[1].path !== '');

			for (const uuid of missingUuids) {
				const lastPath = this.uuidToLastKnownPath.get(uuid);
				if (lastPath) {
					toDelete.push([uuid, { path: lastPath, isDeleted: true }]);
				}
			}

			toDelete.sort((a, b) => b[1].path.split('/').length - a[1].path.split('/').length);

			const toKeep = entries
				.filter(e => !e[1].isDeleted)
				.map(e => {
					const resolved = this.resolvePath(e[0]);
					return [e[0], { ...e[1], path: resolved }] as [string, any];
				})
				.filter(item => item[1].path !== null && item[1].path !== '')
				.sort((a, b) => a[1].path.split('/').length - b[1].path.split('/').length);

			// Retrieve remotely deleted paths from manifest to handle the clean-db reload edge case
			const remoteDeletedPaths = new Set<string>();
			try {
				const manifest = await this.syncOrchestrator.getRemoteStore().fetchManifest();
				console.log('[reconcileFilesystem] fetched manifest length:', manifest.length, JSON.stringify(manifest));
				const key = this.syncOrchestrator.getActiveKey();
				if (key) {
					for (const item of manifest) {
						const isDeleted = (item as any).is_deleted || (item as any).isDeleted;
						const encryptedPath = (item as any).encrypted_path || (item as any).encryptedPath;
						if (isDeleted && encryptedPath) {
							try {
								let encBlob = encryptedPath;
								if (typeof encBlob === 'string') {
									const jsonStr = CryptoUtils.hexToString(encBlob);
									encBlob = JSON.parse(jsonStr);
								}
								const decryptedBytes = await this.syncOrchestrator.getCrypto().decrypt(encBlob as any, key);
								const path = new TextDecoder().decode(decryptedBytes);
								if (path) {
									remoteDeletedPaths.add(path);
									console.log('[reconcileFilesystem] found deleted path in manifest:', path);
								}
							} catch (e) {
								console.log('[reconcileFilesystem] Decryption of manifest path failed:', e);
							}
						}
					}
				}
			} catch (e) {
				console.log('[reconcileFilesystem] fetchManifest failed:', e);
			}

			const justDeletedPaths = new Set<string>();

			if (remoteDeletedPaths.size > 0) {
				for (const path of remoteDeletedPaths) {
					const localFile = this.app.vault.getAbstractFileByPath(path);
					const exists = !!localFile || await safeExists(path);
					if (exists) {
						justDeletedPaths.add(path);
						const dummyUuid = window.crypto.randomUUID() as string;
						await this.deletionService.executePhase1(
							[[dummyUuid, { path, isDeleted: true }]],
							this.pathToUuid,
							justDeletedPaths,
							this.uuidToLastKnownPath,
							safeExists
						);
					}
				}
			}

			// Phase 1: Aggressive Deletions
			await this.deletionService.executePhase1(
				toDelete,
				this.pathToUuid,
				justDeletedPaths,
				this.uuidToLastKnownPath,
				safeExists
			);

			// Phase 2: Creations & Renames
			await this.reconciliationService.executePhase2(
				toKeep,
				this.uuidToLastKnownPath,
				(p, isFolder) => this.ensureFolderExists(p, isFolder),
				safeExists
			);

			// Phase 3: Scan for untracked offline files
			const newFilesToTrack = this.untrackedScanner.scan(this.pathToUuid, justDeletedPaths);

			if (newFilesToTrack.length > 0) {
				const addedFiles: Array<{ uuid: string; file: any }> = [];
				await this.applyAndPushIndexTransaction(() => {
					for (const file of newFilesToTrack) {
						const type = (file instanceof TFolder || (file as any).type === 'folder' || (!(file as any).extension && !(file as any).path.endsWith('.md'))) ? 'folder' : 'file';
						const uuid = window.crypto.randomUUID() as string;

						const { dirPath, name } = this.splitPath(file.path);

						const parentIdToUse = this.getOrCreateCrdtFolderChain(dirPath);
                        this.treeMap!.set(uuid, { type, parentId: parentIdToUse, metadata: name, isDeleted: false } as VFSNode);
                        this.pathToUuid.set(file.path, uuid);
                        this.uuidToLastKnownPath.set(uuid, file.path);
                        if (type === 'file') {
				addedFiles.push({ uuid, file });
                        }
					}
				});

				for (const { uuid, file } of addedFiles) {
					try {
						const content = await this.app.vault.read(file);
						await this.crdtEngine.getOrCreateDoc(uuid, content);
					} catch (e) {
						console.error('Failed to ingest offline file content:', e);
					}
				}
			}

			// Purge tombstones from Y.Map index
			const tombstonesToPurge = entries.filter(e => e[1].isDeleted).map(e => e[0]);
			if (tombstonesToPurge.length > 0) {
				await this.applyAndPushIndexTransaction(() => {
					for (const uuid of tombstonesToPurge) {
                        this.treeMap!.delete(uuid);
					}
				});
			}
		} finally {
			this.isReconciling = false;
		}
	}

	private async resolveAllCollisions(safeExists: (p: string) => Promise<boolean>): Promise<void> {
		const dedupeEntries = Array.from(this.treeMap!.entries());
		const seenPaths = new Set<string>();
		const pendingUpdates = new Map<string, string>();

		for (const [uuid, node] of dedupeEntries) {
			if (node.isDeleted) continue;

			const resolvedPath = this.resolvePath(uuid);
			if (!resolvedPath) continue;

			const isNewRemote = !this.uuidToLastKnownPath.has(uuid);
			const localFile = this.app.vault.getAbstractFileByPath(resolvedPath);
			const localExists = !!localFile || await safeExists(resolvedPath);
			const isFolder = node.type === 'folder';

			if ((seenPaths.has(resolvedPath) && !isFolder) || (!isFolder && isNewRemote && localExists)) {
				const newPath = await this.collisionResolver.resolveCollision(resolvedPath, seenPaths, safeExists, isFolder);
				pendingUpdates.set(uuid, newPath);
				seenPaths.add(newPath);
			} else {
				seenPaths.add(resolvedPath);
			}
		}

		if (pendingUpdates.size > 0) {
			await this.applyAndPushIndexTransaction(() => {
				for (const [uuid, newPath] of pendingUpdates.entries()) {
					const node = this.treeMap!.get(uuid);
					if (node) {
						if (node.path && node.parentId === undefined) {
                            this.treeMap!.set(uuid, { ...node, path: newPath });
						} else {
							const { name: newName } = this.splitPath(newPath);
                            this.treeMap!.set(uuid, { ...node, metadata: newName });
						}
					}
				}
			});
		}
	}

	private async ensureFolderExists(filePath: string, isFolderPath = false): Promise<void> {
		const folderPath = isFolderPath ? filePath : filePath.substring(0, filePath.lastIndexOf('/'));
		if (!folderPath || folderPath === filePath && !isFolderPath) return;

		for (const item of this.getPathPartsAndCumulative(folderPath)) {
			if (!this.app.vault.getAbstractFileByPath(item.cumulative)) {
				try {
					await this.app.vault.createFolder(item.cumulative);
				} catch (e) {}
			}
		}
	}

	public async handleCreate(
		pathOrFile: string | TAbstractFile,
		isFolder?: boolean,
		file?: TAbstractFile
	): Promise<void> {
		await this.initialize();
		if (!this.treeMap || this.isReconciling) return;
		if (this.syncOrchestrator && typeof (this.syncOrchestrator as any).isSyncInitialized === 'function') {
			if (!(this.syncOrchestrator as any).isSyncInitialized()) return;
		}

		let path: string;
		let folder: boolean;
		let actualFile: TAbstractFile;

		if (typeof pathOrFile === 'string') {
			path = pathOrFile;
			folder = !!isFolder;
			actualFile = file!;
		} else {
			path = pathOrFile.path;
			folder = pathOrFile instanceof TFolder || (pathOrFile as any).children !== undefined;
			actualFile = pathOrFile;
		}

		if (this.syncOrchestrator && (this.syncOrchestrator as any).isRemoteWriteActive) {
			if ((this.syncOrchestrator as any).isRemoteWriteActive(path)) {
				if ((this.syncOrchestrator as any).clearRemoteWrite) {
					(this.syncOrchestrator as any).clearRemoteWrite(path);
				}
				return;
			}
		}

		if (path.startsWith('.') || path === '/') return;
		if (this.pathToUuid.has(path)) return;

		const { dirPath, name } = this.splitPath(path);

		let uuid: string = window.crypto.randomUUID() as string;
		let parentIdToUse = 'root';

		await this.applyAndPushIndexTransaction(() => {
			parentIdToUse = this.getOrCreateCrdtFolderChain(dirPath);
			for (const [existingUuid, node] of this.treeMap!.entries()) {
				const oldPathFallback = (node.path && node.parentId === undefined) ? node.path : null;
				const isMatch = oldPathFallback ? (oldPathFallback === path) : (node.metadata === name && node.parentId === parentIdToUse);
				if (isMatch && node.isDeleted) {
					uuid = existingUuid;
					break;
				}
			}
			const type = folder ? 'folder' : 'file';
			const node = this.treeMap!.get(uuid);
			if (node && node.path && node.parentId === undefined) {
                this.treeMap!.set(uuid, { ...node, isDeleted: false });
			} else {
                this.treeMap!.set(uuid, { type, parentId: parentIdToUse, metadata: name, isDeleted: false } as VFSNode);
			}
		});

		this.pathToUuid.set(path, uuid);
		this.uuidToLastKnownPath.set(uuid, path);
        
		const type = folder ? 'folder' : 'file';
		if (type === 'file' && actualFile instanceof TFile) {
			const content = await this.app.vault.read(actualFile);
			const doc = await this.crdtEngine.getOrCreateDoc(uuid, content);
            
			const fullState = Y.encodeStateAsUpdate(doc);
			await this.syncOrchestrator.pushDocumentUpdate(uuid, fullState, path);
            
			await this.syncOrchestrator.handleLocalChange(path, content);
		}
	}

	public Navigator() {}

	public wouldCreateCycle(nodeId: string, targetParentId: string): boolean {
		if (nodeId === targetParentId) return true;
		let currentParentId = targetParentId;
		const visited = new Set<string>();

		while (currentParentId && currentParentId !== 'root') {
			if (currentParentId === nodeId) {
				return true;
			}
			if (visited.has(currentParentId)) {
				return true;
			}
			visited.add(currentParentId);

			const parentNode = this.treeMap?.get(currentParentId) as VFSNode;
			if (!parentNode) break;
			currentParentId = parentNode.parentId;
		}
		return false;
	}

	public updateDescendantLastKnownPaths(oldParentPath: string, newParentPath: string): void {
		for (const [uuid, lastPath] of this.uuidToLastKnownPath.entries()) {
			if (lastPath === oldParentPath) {
				this.uuidToLastKnownPath.set(uuid, newParentPath);
			} else if (lastPath.startsWith(oldParentPath + '/')) {
				const updatedPath = lastPath.replace(oldParentPath, newParentPath);
				this.uuidToLastKnownPath.set(uuid, updatedPath);
			}
		}
	}

	public registerCascadedRenames(oldParentPath: string, newParentPath: string): void {
		for (const [lastPath] of this.pathToUuid.entries()) {
			if (lastPath.startsWith(oldParentPath + '/')) {
				const updatedPath = lastPath.replace(oldParentPath, newParentPath);
				const key = `${lastPath}->${updatedPath}`;
				this.cascadedRenames.add(key);
				setTimeout(() => this.cascadedRenames.delete(key), 5000);
			}
		}
	}

	public async handleRename(oldPath: string, newPath: string): Promise<void> {
		await this.initialize();
		if (!this.treeMap || this.isReconciling) return;
		if (this.syncOrchestrator && typeof (this.syncOrchestrator as any).isSyncInitialized === 'function') {
			if (!(this.syncOrchestrator as any).isSyncInitialized()) return;
		}

		const cascadeKey = `${oldPath}->${newPath}`;
		if (this.cascadedRenames.has(cascadeKey)) {
			this.cascadedRenames.delete(cascadeKey);
			return;
		}

		const targetUuid = this.pathToUuid.get(oldPath);
        
		let hasChildren = false;
		for (const [uuid, node] of this.treeMap.entries()) {
			if (node.isDeleted) continue;
			const resolvedPath = (node.path && node.parentId === undefined) ? node.path : this.resolvePath(uuid);
			if (resolvedPath && resolvedPath.startsWith(oldPath + '/')) {
				hasChildren = true;
				break;
			}
		}

		const isPathTaken = (p: string) => {
			const u = this.getUuidForPath(p);
			return !!u && u !== targetUuid;
		};

		const pathTaken = isPathTaken(newPath);

		if (!targetUuid && !hasChildren && !pathTaken) return;

		let finalNewPath = newPath;

		let isFolder = false;
		if (targetUuid) {
			const node = this.treeMap.get(targetUuid);
			if (node && node.type === 'folder') isFolder = true;
		}

		if (pathTaken) {
			if (this.resolvedRenameCollisions.has(newPath)) {
				return;
			}
			this.resolvedRenameCollisions.add(newPath);
			setTimeout(() => this.resolvedRenameCollisions.delete(newPath), 5000);

			finalNewPath = this.collisionResolver.resolveRenameCollision(newPath, isPathTaken, isFolder);
			let file = this.app.vault.getAbstractFileByPath(newPath);
			if (!file) {
				file = { path: newPath } as any;
			}
			if (file) {
				try { await this.app.fileManager.renameFile(file, finalNewPath); } catch (e) {}
			}
		}

		const { dirPath: finalDirPath, name: finalName } = this.splitPath(finalNewPath);

		if (targetUuid) {
			await this.applyAndPushIndexTransaction(() => {
				const parentIdToUse = this.getOrCreateCrdtFolderChain(finalDirPath);
				if (this.wouldCreateCycle(targetUuid, parentIdToUse)) {
					console.warn(`[TreeIndexManager] Rejected rename/move operation: setting parent of ${targetUuid} to ${parentIdToUse} would cause a cycle.`);
					return;
				}
				const node = this.treeMap!.get(targetUuid);
				if (node) {
					if (node.path && node.parentId === undefined) {
                        this.treeMap!.set(targetUuid, {
				...node,
				path: finalNewPath
                        });
                        // For old flat-path schema, we also need to cascade path changes to children in treeMap!
                        for (const [u, n] of this.treeMap!.entries()) {
				if (!n.isDeleted && n.path && n.parentId === undefined && n.path.startsWith(oldPath + '/')) {
					const updatedPath = n.path.replace(oldPath, finalNewPath);
                                this.treeMap!.set(u, { ...n, path: updatedPath });
				}
                        }
					} else {
                        this.treeMap!.set(targetUuid, {
				...node,
				parentId: parentIdToUse,
				metadata: finalName
                        } as VFSNode);
					}
				}
			});
			this.registerCascadedRenames(oldPath, finalNewPath);
			this.updateDescendantLastKnownPaths(oldPath, finalNewPath);
		} else if (hasChildren) {
			await this.applyAndPushIndexTransaction(() => {
				for (const [uuid, node] of this.treeMap!.entries()) {
					if (node.isDeleted) continue;
					if (node.path && node.parentId === undefined && node.path.startsWith(oldPath + '/')) {
						const updatedPath = node.path.replace(oldPath, finalNewPath);
                        this.treeMap!.set(uuid, { ...node, path: updatedPath });
					}
				}
			});
			this.registerCascadedRenames(oldPath, finalNewPath);
			this.updateDescendantLastKnownPaths(oldPath, finalNewPath);
		}

		this.rebuildReverseLookup();
	}

	public async handleDelete(path: string): Promise<void> {
		await this.initialize();
		if (!this.treeMap || this.isReconciling) return;
		if (this.syncOrchestrator && typeof (this.syncOrchestrator as any).isSyncInitialized === 'function') {
			if (!(this.syncOrchestrator as any).isSyncInitialized()) return;
		}

		const purgedUuids: string[] = [];
		const entries = Array.from(this.treeMap.entries());

		await this.applyAndPushIndexTransaction(() => {
			for (const [uuid, node] of entries) {
				if (node.isDeleted) continue;

				const resolvedPath = this.resolvePath(uuid);
				if (resolvedPath && (resolvedPath === path || resolvedPath.startsWith(path + '/'))) {
                    this.treeMap!.set(uuid, { ...node, isDeleted: true } as VFSNode);
                    this.uuidToLastKnownPath.delete(uuid); 
                    purgedUuids.push(uuid);
				}
			}
		});

		this.rebuildReverseLookup();

		for (const uuid of purgedUuids) {
			if ((this.syncOrchestrator as any).deleteRemoteSnapshot) {
				(this.syncOrchestrator as any).deleteRemoteSnapshot(uuid).catch(() => {});
			}
		}

		// Run full sync / reconciliation after deletion to purge tombstones immediately
		setTimeout(() => {
			this.reconcileFilesystem().catch(() => {});
		}, 500);
	}
}
