import { App, TFile, TFolder, TAbstractFile } from 'obsidian';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { SyncOrchestrator } from './SyncOrchestrator';
import * as Y from 'yjs';

export interface VaultNode {
    type: 'file' | 'folder';
    path: string;
    isDeleted: boolean;
}

export class TreeIndexManager {
    public readonly INDEX_DOC_ID = 'system-vault-index';
    private treeMap!: Y.Map<VaultNode>;
    private doc!: Y.Doc;
    private pathToUuid = new Map<string, string>();

    constructor(
        private app: App,
        private crdtEngine: YjsEngine,
        private syncOrchestrator: SyncOrchestrator
    ) {}

    public async initialize(): Promise<void> {
        this.doc = await this.crdtEngine.getOrCreateDoc(this.INDEX_DOC_ID);
        this.treeMap = this.doc.getMap<VaultNode>('vault-tree');

        this.rebuildReverseLookup();

        this.treeMap.observe(() => {
            this.rebuildReverseLookup();
        });

        console.log(`[TreeIndexManager] VFS Initialized. Tracking ${this.pathToUuid.size} active nodes.`);
    }

    private rebuildReverseLookup() {
        this.pathToUuid.clear();
        for (const [uuid, node] of this.treeMap.entries()) {
            if (!node.isDeleted) {
                this.pathToUuid.set(node.path, uuid);
            }
        }
    }

    public async reconcileFilesystem(): Promise<void> {
        // 1. Enforce remote state onto local filesystem
        for (const [uuid, node] of this.treeMap.entries()) {
            const localFile = this.app.vault.getAbstractFileByPath(node.path);

            if (node.isDeleted) {
                if (localFile) {
                    try { 
                        await this.app.vault.trash(localFile, true); 
                    } catch (e) {
                        try { await this.app.vault.trash(localFile, false); } catch(e2) {}
                    }
                }
            } else {
                if (node.type === 'folder') {
                    if (!localFile) await this.ensureFolderExists(node.path, true);
                } else if (node.type === 'file') {
                    if (!localFile) {
                        await this.ensureFolderExists(node.path, false);
                        await this.app.vault.create(node.path, '');
                        this.syncOrchestrator.pullDocument(uuid, node.path, true).catch(() => {});
                    }
                }
            }
        }

        // 2. Scan for untracked local files/folders
        const allFiles = this.app.vault.getAllLoadedFiles();
        
        this.doc.transact(() => {
            for (const file of allFiles) {
                if (file.path === '/' || file.path.startsWith('.')) continue; 
                
                if (!this.pathToUuid.has(file.path)) {
                    const type = file instanceof TFolder ? 'folder' : 'file';
                    const uuid = window.crypto.randomUUID();
                    this.treeMap.set(uuid, { type, path: file.path, isDeleted: false });
                    this.pathToUuid.set(file.path, uuid);
                }
            }
        });

        await this.syncOrchestrator.pushDocumentUpdate(this.INDEX_DOC_ID, new Uint8Array(), null);
    }

    private async ensureFolderExists(path: string, isFolderItself: boolean): Promise<void> {
        const parts = path.split('/');
        const limit = isFolderItself ? parts.length : parts.length - 1;
        let currentPath = '';
        
        for (let i = 0; i < limit; i++) {
            currentPath += (i === 0 ? '' : '/') + parts[i];
            const folder = this.app.vault.getAbstractFileByPath(currentPath);
            if (!folder) {
                try { await this.app.vault.createFolder(currentPath); } catch (e) {}
            }
        }
    }

    public async handleCreate(file: TAbstractFile): Promise<void> {
        if (file.path.startsWith('.') || file.path === '/') return;
        if (this.pathToUuid.has(file.path)) return;

        const uuid = window.crypto.randomUUID();
        const type = file instanceof TFolder ? 'folder' : 'file';

        this.doc.transact(() => {
            this.treeMap.set(uuid, { type, path: file.path, isDeleted: false });
        });
        
        this.pathToUuid.set(file.path, uuid);
        
        await this.syncOrchestrator.pushDocumentUpdate(this.INDEX_DOC_ID, new Uint8Array(), null);

        if (type === 'file' && file instanceof TFile) {
            const content = await this.app.vault.read(file);
            await this.crdtEngine.getOrCreateDoc(uuid, content);
            await this.syncOrchestrator.handleLocalChange(file.path, content);
        }
    }

    public async handleRename(oldPath: string, newPath: string): Promise<void> {
        this.doc.transact(() => {
            for (const [uuid, node] of this.treeMap.entries()) {
                if (node.isDeleted) continue;

                if (node.path === oldPath) {
                    this.treeMap.set(uuid, { ...node, path: newPath });
                } else if (node.path.startsWith(oldPath + '/')) {
                    const updatedPath = node.path.replace(oldPath, newPath);
                    this.treeMap.set(uuid, { ...node, path: updatedPath });
                }
            }
        });

        this.rebuildReverseLookup();
        await this.syncOrchestrator.pushDocumentUpdate(this.INDEX_DOC_ID, new Uint8Array(), null);
    }

    public async handleDelete(path: string): Promise<void> {
        this.doc.transact(() => {
            for (const [uuid, node] of this.treeMap.entries()) {
                if (node.isDeleted) continue;

                if (node.path === path || node.path.startsWith(path + '/')) {
                    this.treeMap.set(uuid, { ...node, isDeleted: true });
                }
            }
        });

        this.rebuildReverseLookup();
        await this.syncOrchestrator.pushDocumentUpdate(this.INDEX_DOC_ID, new Uint8Array(), null);
    }

    public getUuidForPath(path: string): string | undefined {
        return this.pathToUuid.get(path);
    }
    
    public getActiveFiles(): { uuid: string, path: string }[] {
        const files: { uuid: string, path: string }[] = [];
        for (const [uuid, node] of this.treeMap.entries()) {
            if (!node.isDeleted && node.type === 'file') {
                files.push({ uuid, path: node.path });
            }
        }
        return files;
    }
}