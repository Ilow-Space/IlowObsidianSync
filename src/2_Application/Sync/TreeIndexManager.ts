import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import * as Y from 'yjs';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { CryptoUtils } from '@infrastructure/Crypto/CryptoUtils';
import { SyncOrchestrator } from './SyncOrchestrator';
import { VfsCollisionResolver } from './VfsCollisionResolver';
import { VfsDeletionService } from './VfsDeletionService';
import { VfsReconciliationService } from './VfsReconciliationService';
import { VfsUntrackedScanner } from './VfsUntrackedScanner';

export class TreeIndexManager {
    public readonly INDEX_DOC_ID = 'shard-index';
    private treeDoc: Y.Doc | null = null;
    private treeMap: Y.Map<any> | null = null;
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
                this.uuidToLastKnownPath.set(uuid, node.path);
            }
        }

        this.rebuildReverseLookup();
        console.log(`[TreeIndexManager] VFS Initialized. Tracking ${this.pathToUuid.size} active nodes.`);
    }

    public getUuidForPath(path: string): string | null {
        return this.pathToUuid.get(path) || null;
    }

    public getPathForUuid(uuid: string): string | null {
        if (!this.treeMap) return null;
        const node = this.treeMap.get(uuid);
        return (node && !node.isDeleted) ? node.path : null;
    }

    public getActiveFiles(): Array<{ uuid: string; path: string; type: string }> {
        if (!this.treeMap) return [];
        const result: Array<{ uuid: string; path: string; type: string }> = [];
        for (const [uuid, node] of this.treeMap.entries()) {
            if (!node.isDeleted) {
                result.push({ uuid, path: node.path, type: node.type });
            }
        }
        return result;
    }

    public rebuildReverseLookup(): void {
        this.pathToUuid.clear();
        if (!this.treeMap) return;
        for (const [uuid, node] of this.treeMap.entries()) {
            if (!node.isDeleted) {
                this.pathToUuid.set(node.path, uuid);
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

    public async reconcileFilesystem(): Promise<void> {
        await this.initialize();
        if (!this.treeMap || this.isReconciling) return;
        this.isReconciling = true;

        const safeExists = async (p: string) => {
            try { return await this.app.vault.adapter.exists(p); } catch { return false; }
        };

        try {
            await this.resolveAllCollisions(safeExists);

            this.rebuildReverseLookup();

            const entries = Array.from(this.treeMap.entries());

            const missingUuids = Array.from(this.uuidToLastKnownPath.keys())
                .filter(uuid => !this.treeMap!.has(uuid));

            const toDelete = entries
                .filter(e => e[1].isDeleted)
                .map(e => [e[0], e[1]] as [string, any]);

            for (const uuid of missingUuids) {
                const lastPath = this.uuidToLastKnownPath.get(uuid);
                if (lastPath) {
                    toDelete.push([uuid, { path: lastPath, isDeleted: true }]);
                }
            }

            toDelete.sort((a, b) => b[1].path.split('/').length - a[1].path.split('/').length);

            const toKeep = entries
                .filter(e => !e[1].isDeleted)
                .sort((a, b) => a[1].path.split('/').length - b[1].path.split('/').length);

            // Retrieve remotely deleted paths from manifest to handle the clean-db reload edge case
            const remoteDeletedPaths = new Set<string>();
            try {
                const manifest = await this.syncOrchestrator.getRemoteStore().fetchManifest();
                console.log('[reconcileFilesystem] fetched manifest length:', manifest.length, JSON.stringify(manifest));
                const key = this.syncOrchestrator.getActiveKey();
                if (key) {
                    for (const item of manifest) {
                        const isDeleted = (item as any).is_deleted || item.isDeleted;
                        const encryptedPath = (item as any).encrypted_path || item.encryptedPath;
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
                        this.treeMap!.set(uuid, { type, path: file.path, isDeleted: false });
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

            const isNewRemote = !this.uuidToLastKnownPath.has(uuid);
            const localFile = this.app.vault.getAbstractFileByPath(node.path);
            const localExists = !!localFile || await safeExists(node.path);
            const isFolder = node.type === 'folder';

            if ((seenPaths.has(node.path) && !isFolder) || (!isFolder && isNewRemote && localExists)) {
                const newPath = await this.collisionResolver.resolveCollision(node.path, seenPaths, safeExists, isFolder);
                pendingUpdates.set(uuid, newPath);
                seenPaths.add(newPath);
            } else {
                seenPaths.add(node.path);
            }
        }

        if (pendingUpdates.size > 0) {
            await this.applyAndPushIndexTransaction(() => {
                for (const [uuid, newPath] of pendingUpdates.entries()) {
                    const node = this.treeMap!.get(uuid);
                    if (node) {
                        this.treeMap!.set(uuid, { ...node, path: newPath });
                    }
                }
            });
        }
    }

    private async ensureFolderExists(filePath: string, isFolderPath = false): Promise<void> {
        const folderPath = isFolderPath ? filePath : filePath.substring(0, filePath.lastIndexOf('/'));
        if (!folderPath || folderPath === filePath && !isFolderPath) return;

        const parts = folderPath.split('/');
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                try {
                    await this.app.vault.createFolder(current);
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

        let uuid: string = window.crypto.randomUUID() as string;
        for (const [existingUuid, node] of this.treeMap.entries()) {
            if (node.path === path && node.isDeleted) {
                uuid = existingUuid;
                break;
            }
        }

        const type = folder ? 'folder' : 'file';

        // SYNCHRONOUS PRE-REGISTRATION to prevent immediate rename/delete event race conditions!
        this.pathToUuid.set(path, uuid);
        this.uuidToLastKnownPath.set(uuid, path);

        await this.applyAndPushIndexTransaction(() => {
            this.treeMap!.set(uuid, { type, path: path, isDeleted: false });
        });
        
        if (type === 'file' && actualFile instanceof TFile) {
            const content = await this.app.vault.read(actualFile);
            const doc = await this.crdtEngine.getOrCreateDoc(uuid, content);
            
            const fullState = Y.encodeStateAsUpdate(doc);
            await this.syncOrchestrator.pushDocumentUpdate(uuid, fullState, path);
            
            await this.syncOrchestrator.handleLocalChange(path, content);
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
        for (const [, node] of this.treeMap.entries()) {
            if (!node.isDeleted && node.path.startsWith(oldPath + '/')) {
                hasChildren = true;
                break;
            }
        }

        const isPathTaken = (p: string) => {
            for (const [uuid, node] of this.treeMap!.entries()) {
                if (targetUuid && uuid === targetUuid) continue;
                if (node.path === p && !node.isDeleted) return true;
            }
            return false;
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
            try { await this.app.fileManager.renameFile(file, finalNewPath); } catch (e) {}
        }

        const entries = Array.from(this.treeMap.entries());

        await this.applyAndPushIndexTransaction(() => {
            for (const [uuid, node] of entries) {
                if (node.isDeleted) continue;

                if (node.path === oldPath) {
                    this.treeMap!.set(uuid, { ...node, path: finalNewPath });
                    this.uuidToLastKnownPath.set(uuid, finalNewPath); 
                } else if (node.path.startsWith(oldPath + '/')) {
                    const updatedPath = node.path.replace(oldPath, finalNewPath);
                    const key = `${node.path}->${updatedPath}`;
                    this.cascadedRenames.add(key);
                    setTimeout(() => this.cascadedRenames.delete(key), 5000);

                    this.treeMap!.set(uuid, { ...node, path: updatedPath });
                    this.uuidToLastKnownPath.set(uuid, updatedPath); 
                }
            }
        });

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

                if (node.path === path || node.path.startsWith(path + '/')) {
                    this.treeMap!.set(uuid, { ...node, isDeleted: true });
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
    }
}