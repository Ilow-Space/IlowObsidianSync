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
    private uuidToLastKnownPath = new Map<string, string>();
    
    private isReconciling = false;

    constructor(
        private app: App,
        private crdtEngine: YjsEngine,
        private syncOrchestrator: SyncOrchestrator
    ) {}

    public async initialize(): Promise<void> {
        this.doc = await this.crdtEngine.getOrCreateDoc(this.INDEX_DOC_ID);
        this.treeMap = this.doc.getMap<VaultNode>('vault-tree');

        for (const [uuid, node] of this.treeMap.entries()) {
            if (!node.isDeleted) {
                this.uuidToLastKnownPath.set(uuid, node.path);
            }
        }

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

    private async applyAndPushIndexTransaction(transaction: () => void): Promise<void> {
        let update: Uint8Array | null = null;
        
        const updateHandler = (u: Uint8Array) => { update = u; };
        this.doc.once('update', updateHandler);
        
        this.doc.transact(transaction);
        
        const payload = update as Uint8Array | null;
        if (payload && payload.length > 0) {
            const state = Y.encodeStateAsUpdate(this.doc);
            await this.crdtEngine.localStore.saveDocumentState(this.INDEX_DOC_ID, state);
            await this.syncOrchestrator.pushDocumentUpdate(this.INDEX_DOC_ID, payload, null);
        }
    }

    public async reconcileFilesystem(): Promise<void> {
        if (this.isReconciling) return;
        this.isReconciling = true;
        
        try {
            // FIX: Array.from() prevents Y.Map iterator mutation skipping
            const dedupeEntries = Array.from(this.treeMap.entries());
            const seenPaths = new Set<string>();
            
            await this.applyAndPushIndexTransaction(() => {
                for (const [uuid, node] of dedupeEntries) {
                    if (node.isDeleted) continue;
                    
                    if (seenPaths.has(node.path)) {
                        let collisionCount = 1;
                        let newPath = '';
                        const extMatch = node.path.match(/(\.[^.]+)$/);
                        const ext = extMatch ? extMatch[0] : '';
                        const base = extMatch ? node.path.slice(0, -ext.length) : node.path;
                        
                        do {
                            newPath = `${base} (Conflict ${collisionCount})${ext}`;
                            collisionCount++;
                        } while (seenPaths.has(newPath));
                        
                        this.treeMap.set(uuid, { ...node, path: newPath });
                        seenPaths.add(newPath);
                    } else {
                        seenPaths.add(node.path);
                    }
                }
            });

            this.rebuildReverseLookup();

            const entries = Array.from(this.treeMap.entries());
            
            const toDelete = entries
                .filter(e => e[1].isDeleted)
                .sort((a, b) => b[1].path.split('/').length - a[1].path.split('/').length);
                
            const toKeep = entries
                .filter(e => !e[1].isDeleted)
                .sort((a, b) => a[1].path.split('/').length - b[1].path.split('/').length);

            // Phase 1: Deletions
            for (const [uuid, node] of toDelete) {
                const localFile = this.app.vault.getAbstractFileByPath(node.path);
                this.uuidToLastKnownPath.delete(uuid);
                if (localFile && !this.pathToUuid.has(node.path)) {
                    try { await this.app.vault.trash(localFile, true); } 
                    catch (e) { try { await this.app.vault.trash(localFile, false); } catch(e2) {} }
                }
            }

            // Phase 2: Creations & Renames
            for (const [uuid, node] of toKeep) {
                const localFile = this.app.vault.getAbstractFileByPath(node.path);
                if (!localFile) {
                    const lastKnownPath = this.uuidToLastKnownPath.get(uuid);
                    const oldLocalFile = lastKnownPath ? this.app.vault.getAbstractFileByPath(lastKnownPath) : null;

                    if (oldLocalFile) {
                        await this.ensureFolderExists(node.path, false);
                        try {
                            await this.app.fileManager.renameFile(oldLocalFile, node.path);
                        } catch (e) {
                            console.warn(`Failed to move local file from ${lastKnownPath} to ${node.path}:`, e);
                        }
                    } else {
                        if (node.type === 'folder') {
                            await this.ensureFolderExists(node.path, true);
                        } else if (node.type === 'file') {
                            await this.ensureFolderExists(node.path, false);
                        }
                    }
                }
                this.uuidToLastKnownPath.set(uuid, node.path);
            }

            // Phase 3: Scan for untracked
            const allFiles = this.app.vault.getAllLoadedFiles();
            await this.applyAndPushIndexTransaction(() => {
                for (const file of allFiles) {
                    if (file.path === '/' || file.path.startsWith('.')) continue; 
                    
                    if (!this.pathToUuid.has(file.path)) {
                        const type = file instanceof TFolder ? 'folder' : 'file';
                        const uuid = window.crypto.randomUUID() as string;
                        this.treeMap.set(uuid, { type, path: file.path, isDeleted: false });
                        this.pathToUuid.set(file.path, uuid);
                        this.uuidToLastKnownPath.set(uuid, file.path);
                    }
                }
            });
        } finally {
            this.isReconciling = false;
        }
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
        if (this.isReconciling) return;
        
        if (file.path.startsWith('.') || file.path === '/') return;
        if (this.pathToUuid.has(file.path)) return;

        let uuid: string = window.crypto.randomUUID() as string;
        for (const [existingUuid, node] of this.treeMap.entries()) {
            if (node.path === file.path && node.isDeleted) {
                uuid = existingUuid;
                break;
            }
        }

        const type = file instanceof TFolder ? 'folder' : 'file';

        await this.applyAndPushIndexTransaction(() => {
            this.treeMap.set(uuid, { type, path: file.path, isDeleted: false });
        });
        
        this.pathToUuid.set(file.path, uuid);
        this.uuidToLastKnownPath.set(uuid, file.path);
        
        if (type === 'file' && file instanceof TFile) {
            const content = await this.app.vault.read(file);
            await this.crdtEngine.getOrCreateDoc(uuid, content);
            await this.syncOrchestrator.handleLocalChange(file.path, content);
        }
    }

    public async handleRename(oldPath: string, newPath: string): Promise<void> {
        if (this.isReconciling) return;

        const targetUuid = this.pathToUuid.get(oldPath);
        
        // FIX: Ensure cascades happen even if the parent folder isn't explicitly tracked
        let hasChildren = false;
        for (const [, node] of this.treeMap.entries()) {
            if (!node.isDeleted && node.path.startsWith(oldPath + '/')) {
                hasChildren = true;
                break;
            }
        }

        if (!targetUuid && !hasChildren) return; 

        let finalNewPath = newPath;
        
        if (targetUuid) {
            const isPathTaken = (p: string) => {
                for (const [uuid, node] of this.treeMap.entries()) {
                    if (uuid === targetUuid) continue; 
                    if (node.path === p && !node.isDeleted) return true;
                }
                return false;
            };

            if (isPathTaken(finalNewPath)) {
                let collisionCount = 1;
                const extMatch = newPath.match(/(\.[^.]+)$/);
                const ext = extMatch ? extMatch[0] : '';
                const base = extMatch ? newPath.slice(0, -ext.length) : newPath;
                
                do {
                    finalNewPath = `${base} (${collisionCount})${ext}`;
                    collisionCount++;
                } while (isPathTaken(finalNewPath));
                
                const file = this.app.vault.getAbstractFileByPath(newPath);
                if (file) {
                    try { await this.app.fileManager.renameFile(file, finalNewPath); } catch (e) {}
                }
            }
        }

        // FIX: Array.from() snapshot prevents mutation skipping
        const entries = Array.from(this.treeMap.entries());

        await this.applyAndPushIndexTransaction(() => {
            for (const [uuid, node] of entries) {
                if (node.isDeleted) continue;

                if (node.path === oldPath) {
                    this.treeMap.set(uuid, { ...node, path: finalNewPath });
                    this.uuidToLastKnownPath.set(uuid, finalNewPath); 
                } else if (node.path.startsWith(oldPath + '/')) {
                    const updatedPath = node.path.replace(oldPath, finalNewPath);
                    this.treeMap.set(uuid, { ...node, path: updatedPath });
                    this.uuidToLastKnownPath.set(uuid, updatedPath); 
                }
            }
        });

        this.rebuildReverseLookup();
    }

    public async handleDelete(path: string): Promise<void> {
        if (this.isReconciling) return;

        const purgedUuids: string[] = [];
        // FIX: Array.from() snapshot prevents mutation skipping
        const entries = Array.from(this.treeMap.entries());

        await this.applyAndPushIndexTransaction(() => {
            for (const [uuid, node] of entries) {
                if (node.isDeleted) continue;

                if (node.path === path || node.path.startsWith(path + '/')) {
                    this.treeMap.set(uuid, { ...node, isDeleted: true });
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