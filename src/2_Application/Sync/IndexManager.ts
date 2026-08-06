
import { App, TFile, TFolder, TAbstractFile } from 'obsidian';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { SyncOrchestrator } from './SyncOrchestrator';
import { DocumentMetadata } from '@domain/Entities/Models';
import * as Y from 'yjs';

export class IndexManager {
    private static INDEX_DOC_ID = 'root-index';
    private uuidToPath = new Map<string, string>();
    private pathToUuid = new Map<string, string>();
    
    // Debouncer to prevent massive network spikes on atomic saves or bulk imports
    private indexUpdateTimer: any = null;

    constructor(
        private app: App,
        private crdtEngine: YjsEngine,
        private syncOrchestrator: SyncOrchestrator
    ) {}

    private generateUuid(): string {
        return window.crypto.randomUUID();
    }

    public async initialize(): Promise<void> {
        this.uuidToPath.clear();
        this.pathToUuid.clear();
        
        const doc = await this.crdtEngine.getOrCreateDoc(IndexManager.INDEX_DOC_ID);
        const map = doc.getMap<DocumentMetadata>('metadata');
        
        for (const [uuid, meta] of map.entries()) {
            if (!meta.isDeleted) {
                this.uuidToPath.set(uuid, meta.path);
                this.pathToUuid.set(meta.path, uuid);
            }
        }
    }

    public async syncIndex(isSilent: boolean = false): Promise<void> {
        try {
            await this.syncOrchestrator.pullDocument(IndexManager.INDEX_DOC_ID, null, isSilent);
            
            // Lock local modification handlers during index change application
            this.syncOrchestrator.acquireRemoteLock();
            try {
                await this.applyRemoteIndexChanges();
                await this.scanLocalFilesForNew();
            } finally {
                this.syncOrchestrator.releaseRemoteLock();
            }
        } catch (err) {
            console.warn('Failed to sync global index:', err);
        }
    }

    private async applyRemoteIndexChanges(): Promise<void> {
        const doc = await this.crdtEngine.getOrCreateDoc(IndexManager.INDEX_DOC_ID);
        const map = doc.getMap<DocumentMetadata>('metadata');

        const processedUuids = new Set<string>();

        // Step 1: Process Renames/Moves
        for (const [uuid, meta] of map.entries()) {
            const localPath = this.uuidToPath.get(uuid);
            if (!meta.isDeleted && localPath && localPath !== meta.path) {
                const file = this.app.vault.getAbstractFileByPath(localPath);
                if (file) {
                    await this.ensureFolderExists(meta.path);
                    try {
                        await this.app.vault.rename(file, meta.path);
                    } catch (e) {
                        console.error(`Failed to move item ${localPath} to ${meta.path}`, e);
                    }
                }
                
                this.uuidToPath.set(uuid, meta.path);
                this.pathToUuid.delete(localPath);
                this.pathToUuid.set(meta.path, uuid);
                processedUuids.add(uuid);
            }
        }

        // Step 2: Process Deletions and New Remote Files/Folders
        for (const [uuid, meta] of map.entries()) {
            if (processedUuids.has(uuid)) continue;
            const localPath = this.uuidToPath.get(uuid);

            if (meta.isDeleted) {
                const targetPath = localPath || meta.path; 
                const file = this.app.vault.getAbstractFileByPath(targetPath);
                if (file) {
                    try {
                        // Attempt to move to system trash
                        await this.app.vault.trash(file, true);
                    } catch (e) {
                        console.warn(`Failed to system trash ${targetPath}, attempting permanent deletion`, e);
                        try {
                            // Fallback to permanent deletion if .trash is broken
                            await this.app.vault.trash(file, false);
                        } catch (e2) {
                            console.error(`Failed to delete ${targetPath}`, e2);
                        }
                    }
                }
                
                this.uuidToPath.delete(uuid);
                if (localPath) this.pathToUuid.delete(localPath);
                else this.pathToUuid.delete(meta.path);
            } else if (!localPath) {
                const file = this.app.vault.getAbstractFileByPath(meta.path);
                if (!file) {
                    if (meta.isFolder) {
                        await this.app.vault.createFolder(meta.path);
                    } else {
                        await this.ensureFolderExists(meta.path);
                        await this.app.vault.create(meta.path, '');
                    }
                }
                this.uuidToPath.set(uuid, meta.path);
                this.pathToUuid.set(meta.path, uuid);

                if (!meta.isFolder) {
                    this.syncOrchestrator.pullDocument(uuid, meta.path, true).catch(console.error);
                }
            }
        }

        // Step 3: Purge leftover empty directories after all files have moved
        await this.pruneEmptyDirectories();
    }

    private async scanLocalFilesForNew(): Promise<void> {
    const doc = await this.crdtEngine.getOrCreateDoc(IndexManager.INDEX_DOC_ID);
    const map = doc.getMap<DocumentMetadata>('metadata');

    // Build a set of paths that are explicitly marked as deleted in the CRDT index
    const deletedPaths = new Set<string>();
    for (const meta of map.values()) {
        if (meta.isDeleted) {
            deletedPaths.add(meta.path);
        }
    }

    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
        // ⚡ FIX: Ignore files that are already tracked OR are marked as deleted tombstones
        if (!this.pathToUuid.has(file.path) && !deletedPaths.has(file.path)) {
            try {
                await this.handleFileCreate(file.path);
                const content = await this.app.vault.read(file);
                await this.syncOrchestrator.handleLocalChange(file.path, content);
            } catch (err) {
                console.error(`Failed to scan/index new file ${file.path}:`, err);
            }
        }
    }
}

    private async pruneEmptyDirectories(folder?: TFolder): Promise<void> {
        const target = folder || this.app.vault.getRoot();
        
        // Recursively check children first (bottom-up approach)
        for (const child of target.children.slice()) {
            if (child instanceof TFolder) {
                await this.pruneEmptyDirectories(child);
            }
        }
        
        // After children are processed, check if this folder is now completely empty
        if (target !== this.app.vault.getRoot() && target.children.length === 0) {
            try {
                await this.app.vault.trash(target, true);
            } catch (err) {
                // Ignore errors (e.g., hidden system files might be inside preventing deletion)
            }
        }
    }

    public async runCompletenessCheck(): Promise<void> {
        console.log('Running CRDT Vault Completeness Check...');
        const doc = await this.crdtEngine.getOrCreateDoc(IndexManager.INDEX_DOC_ID);
        const map = doc.getMap<DocumentMetadata>('metadata');

        // 1. Restore files/folders that exist in the index but are missing from the local disk
        for (const [uuid, meta] of map.entries()) {
            if (!meta.isDeleted) {
                const fileExists = this.app.vault.getAbstractFileByPath(meta.path);
                if (!fileExists) {
                    console.log(`[Reconciliation] Restoring missing item from remote: ${meta.path}`);
                    if (meta.isFolder) {
                        await this.app.vault.createFolder(meta.path);
                    } else {
                        await this.ensureFolderExists(meta.path);
                        await this.app.vault.create(meta.path, '');
                        // Pull the actual content silently
                        this.syncOrchestrator.pullDocument(uuid, meta.path, true).catch(console.error);
                    }
                    
                    this.uuidToPath.set(uuid, meta.path);
                    this.pathToUuid.set(meta.path, uuid);
                }
            }
        }

        // 2. Index local files that are missing from the CRDT metadata
        await this.scanLocalFilesForNew();

        // 3. Clean up ghost directories
        await this.pruneEmptyDirectories();
    }

    private async ensureFolderExists(path: string): Promise<void> {
        const parts = path.split('/');
        if (parts.length > 1) {
            const folderPath = parts.slice(0, -1).join('/');
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!folder) {
                await this.app.vault.createFolder(folderPath);
            }
        }
    }

    /**
     * ⚡ The Debouncer: Buffers frantic file lifecycle events and pushes 
     * the System Index to the network only once things calm down.
     */
    private pushIndexDebounced(): void {
        if (this.indexUpdateTimer) {
            clearTimeout(this.indexUpdateTimer);
        }
        
        this.indexUpdateTimer = setTimeout(async () => {
            this.indexUpdateTimer = null;
            try {
                const doc = await this.crdtEngine.getOrCreateDoc(IndexManager.INDEX_DOC_ID);
                const updateBinary = Y.encodeStateAsUpdate(doc);
                
                await this.crdtEngine.localStore.saveDocumentState(IndexManager.INDEX_DOC_ID, updateBinary);
                await this.syncOrchestrator.pushDocumentUpdate(IndexManager.INDEX_DOC_ID, updateBinary);
            } catch (err) {
                console.error('Failed to push debounced index update:', err);
            }
        }, 1500);
    }

    public async handleFileCreate(path: string): Promise<void> {
        if (this.pathToUuid.has(path)) return;
        const uuid = this.generateUuid();
        this.pathToUuid.set(path, uuid);
        this.uuidToPath.set(uuid, path);

        const doc = await this.crdtEngine.getOrCreateDoc(IndexManager.INDEX_DOC_ID);
        const map = doc.getMap<DocumentMetadata>('metadata');
        
        doc.transact(() => {
            map.set(uuid, { path, isDeleted: false, mtime: Date.now(), isFolder: false });
        });

        this.pushIndexDebounced();
    
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file && file instanceof TFile) {
            const content = await this.app.vault.read(file);
            await this.syncOrchestrator.handleLocalChange(path, content);
        }
    }
    
    public async handleFolderCreate(path: string): Promise<void> {
        if (this.pathToUuid.has(path)) return;
        const uuid = this.generateUuid();
        this.pathToUuid.set(path, uuid);
        this.uuidToPath.set(uuid, path);

        const doc = await this.crdtEngine.getOrCreateDoc(IndexManager.INDEX_DOC_ID);
        const map = doc.getMap<DocumentMetadata>('metadata');
        
        doc.transact(() => {
            map.set(uuid, { path, isDeleted: false, mtime: Date.now(), isFolder: true });
        });

        this.pushIndexDebounced();
    }

    public async handleFileRename(oldPath: string, newPath: string): Promise<void> {
        const uuid = this.pathToUuid.get(oldPath);
        if (!uuid) return;

        this.pathToUuid.delete(oldPath);
        this.pathToUuid.set(newPath, uuid);
        this.uuidToPath.set(uuid, newPath);

        const doc = await this.crdtEngine.getOrCreateDoc(IndexManager.INDEX_DOC_ID);
        const map = doc.getMap<DocumentMetadata>('metadata');
        
        doc.transact(() => {
            const existing = map.get(uuid);
            if (existing) {
                map.set(uuid, { ...existing, path: newPath, mtime: Date.now() });
            }
        });

        this.pushIndexDebounced();
    }
    
    public async handleFolderRename(oldPath: string, newPath: string): Promise<void> {
        const uuid = this.pathToUuid.get(oldPath);
        if (!uuid) return;

        this.pathToUuid.delete(oldPath);
        this.pathToUuid.set(newPath, uuid);
        this.uuidToPath.set(uuid, newPath);

        const doc = await this.crdtEngine.getOrCreateDoc(IndexManager.INDEX_DOC_ID);
        const map = doc.getMap<DocumentMetadata>('metadata');
        
        doc.transact(() => {
            const existing = map.get(uuid);
            if (existing) {
                map.set(uuid, { ...existing, path: newPath, mtime: Date.now() });
            }
        });

        this.pushIndexDebounced();
    }

    public async handleFileDelete(path: string): Promise<void> {
        const uuid = this.pathToUuid.get(path);
        if (!uuid) return;

        this.pathToUuid.delete(path);
        this.uuidToPath.delete(uuid);

        const doc = await this.crdtEngine.getOrCreateDoc(IndexManager.INDEX_DOC_ID);
        const map = doc.getMap<DocumentMetadata>('metadata');
        
        doc.transact(() => {
            const existing = map.get(uuid);
            if (existing) {
                map.set(uuid, { ...existing, isDeleted: true, mtime: Date.now() });
            }
        });

        this.pushIndexDebounced();
    }

    public getUuidForPath(path: string): string | undefined {
        return this.pathToUuid.get(path);
    }
}


