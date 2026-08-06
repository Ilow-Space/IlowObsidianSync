
import { App, TFile, TFolder, TAbstractFile } from 'obsidian';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { SyncOrchestrator } from './SyncOrchestrator';
import { CryptoUtils } from '@infrastructure/Crypto/CryptoUtils';
import { EncryptedBlob } from '@domain/ValueObjects/CryptoTypes';

export class IndexManager {
    private uuidToPath = new Map<string, string>();
    private pathToUuid = new Map<string, string>();

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
        
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const uuid = cache?.frontmatter?.['crdt-sync-id'];
            if (uuid) {
                this.uuidToPath.set(uuid, file.path);
                this.pathToUuid.set(file.path, uuid);
            }
        }
        console.log(`[IndexManager] Initialized: ${this.uuidToPath.size} files mapped.`);
    }

    public async syncIndex(isSilent: boolean = false): Promise<void> {
        try {
            const key = this.syncOrchestrator.getActiveKey();
            if (!key) return;

            const remoteStore = this.syncOrchestrator.getRemoteStore();
            const crypto = this.syncOrchestrator.getCrypto();

            // 1. Fetch remote manifest
            const manifest = await remoteStore.fetchManifest();

            // 2. Process each manifest record
            for (const item of manifest) {
                const docId = item.document_id;
                
                if (!item.encrypted_path) continue;

                // Decrypt the file path
                let decryptedPath: string;
                try {
                    const rawJson = CryptoUtils.hexToString(item.encrypted_path);
                    const blob = JSON.parse(rawJson) as EncryptedBlob;
                    const decryptedBytes = await crypto.decrypt(blob, key);
                    decryptedPath = new TextDecoder().decode(decryptedBytes);
                } catch (decErr) {
                    console.error(`Failed to decrypt path for document ${docId}:`, decErr);
                    continue;
                }

                if (item.is_deleted) {
                    // Handle deletion
                    const file = this.app.vault.getAbstractFileByPath(decryptedPath);
                    if (file) {
                        console.log(`[IndexManager] Deleting locally trashed file: ${decryptedPath}`);
                        try {
                            await this.app.vault.trash(file, true);
                        } catch (e) {
                            try {
                                await this.app.vault.trash(file, false);
                            } catch (e2) {
                                console.error(`Failed to delete file ${decryptedPath}:`, e2);
                            }
                        }
                    }
                    this.uuidToPath.delete(docId);
                    this.pathToUuid.delete(decryptedPath);
                } else {
                    // Handle active file mapping and creation/sync
                    let file = this.app.vault.getAbstractFileByPath(decryptedPath);

                    if (!file) {
                        // Recursively create directory structure if subfolders are present
                        await this.ensureFolderExists(decryptedPath);

                        console.log(`[IndexManager] Creating missing remote file: ${decryptedPath}`);
                        file = await this.app.vault.create(decryptedPath, '');
                    }

                    if (file instanceof TFile) {
                        // Ensure frontmatter UUID is written
                        const cache = this.app.metadataCache.getFileCache(file);
                        const localUuid = cache?.frontmatter?.['crdt-sync-id'];

                        if (localUuid !== docId) {
                            await this.app.fileManager.processFrontMatter(file, (fm) => {
                                fm['crdt-sync-id'] = docId;
                            });
                        }

                        // Register in memory mapping
                        this.uuidToPath.set(docId, decryptedPath);
                        this.pathToUuid.set(decryptedPath, docId);

                        // Pull document changes silenty
                        this.syncOrchestrator.pullDocument(docId, decryptedPath, true).catch(console.error);
                    }
                }
            }

            // 3. Scan local files for any newly created untracked notes
            await this.scanLocalFilesForNew();
        } catch (err) {
            console.warn('Failed to sync decentralized manifest index:', err);
        }
    }

    public async scanLocalFilesForNew(): Promise<void> {
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const uuid = cache?.frontmatter?.['crdt-sync-id'];
            if (!uuid) {
                console.log(`[IndexManager] Found untracked note, auto-generating UUID: ${file.path}`);
                await this.handleFileCreate(file.path);
            } else {
                // Ensure local tracking maps are up to date
                this.uuidToPath.set(uuid, file.path);
                this.pathToUuid.set(file.path, uuid);
            }
        }
    }

    public async runCompletenessCheck(): Promise<void> {
        // A periodic manifest sync and local scan guarantees completeness
        await this.syncIndex(true);
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

    public async handleFileCreate(path: string): Promise<void> {
        if (this.pathToUuid.has(path)) return;
        
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;

        const uuid = this.generateUuid();
        this.pathToUuid.set(path, uuid);
        this.uuidToPath.set(uuid, path);

        // Safely insert UUID into markdown YAML frontmatter
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm['crdt-sync-id'] = uuid;
        });

        // Initialize document CRDT state & trigger push to remote
        const content = await this.app.vault.read(file);
        await this.crdtEngine.getOrCreateDoc(uuid, content);
        await this.syncOrchestrator.handleLocalChange(path, content);
    }

    public async handleFileRename(oldPath: string, newPath: string): Promise<void> {
        const uuid = this.pathToUuid.get(oldPath);
        if (!uuid) return;

        this.pathToUuid.delete(oldPath);
        this.pathToUuid.set(newPath, uuid);
        this.uuidToPath.set(uuid, newPath);

        // Immediately update remote server with the new encrypted path
        const emptyUpdate = new Uint8Array();
        await this.syncOrchestrator.pushDocumentUpdate(uuid, emptyUpdate, newPath);
    }

    public async handleFileDelete(path: string): Promise<void> {
        const uuid = this.pathToUuid.get(path);
        if (!uuid) return;

        this.pathToUuid.delete(path);
        this.uuidToPath.delete(uuid);

        try {
            const remoteStore = this.syncOrchestrator.getRemoteStore();
            await remoteStore.deleteSnapshot(uuid);
            console.log(`[IndexManager] Marked file as deleted remotely: ${path} (${uuid})`);
        } catch (err) {
            console.error(`Failed to mark deletion remote-side for ${path}:`, err);
        }
    }

    // Unused folder lifecycle stubs (folders are managed on-demand statelessly)
    public async handleFolderCreate(path: string): Promise<void> {}
    public async handleFolderRename(oldPath: string, newPath: string): Promise<void> {}

    public getUuidForPath(path: string): string | undefined {
        return this.pathToUuid.get(path);
    }
}
