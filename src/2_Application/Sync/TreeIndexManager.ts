import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import * as Y from 'yjs';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { SyncOrchestrator } from './SyncOrchestrator';

export class TreeIndexManager {
    public readonly INDEX_DOC_ID = 'shard-index';
    private treeDoc: Y.Doc | null = null;
    private treeMap: Y.Map<any> | null = null;
    private pathToUuid = new Map<string, string>();
    private uuidToLastKnownPath = new Map<string, string>();
    private isReconciling = false;
    private initPromise: Promise<void> | null = null;

    constructor(
        private app: App,
        private crdtEngine: YjsEngine,
        private syncOrchestrator: SyncOrchestrator
    ) {}

    public async initialize(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = this.doInitialize();
        }
        return this.initPromise;
    }

    private async doInitialize(): Promise<void> {
        this.treeDoc = await this.crdtEngine.getOrCreateDoc(this.INDEX_DOC_ID);
        this.treeMap = this.treeDoc.getMap('vault-tree');
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
        await this.syncOrchestrator.pushDocumentUpdate(this.INDEX_DOC_ID, update);
    }

    public async reconcileFilesystem(): Promise<void> {
        await this.initialize();
        if (!this.treeMap) return;
        if (this.isReconciling) return;
        this.isReconciling = true;
        
        const safeExists = async (p: string) => {
            try { return await this.app.vault.adapter.exists(p); } catch { return false; }
        };

        const safeRemove = async (p: string, abstractFile: TAbstractFile | null) => {
            let success = false;
            if (abstractFile) {
                try { await this.app.vault.trash(abstractFile, true); success = true; } 
                catch (e) { 
                    try { await this.app.vault.trash(abstractFile, false); success = true; } catch(e2) {} 
                }
            }
            
            let attempts = 0;
            while (!success && attempts < 3) {
                if (await safeExists(p)) {
                    try {
                        if (this.app.vault.adapter.remove) {
                            await this.app.vault.adapter.remove(p);
                        }
                        success = true;
                    } catch(e) {
                        attempts++;
                        await new Promise(r => window.setTimeout(r, 200));
                    }
                } else {
                    success = true;
                }
            }
        };

        try {
            const dedupeEntries = Array.from(this.treeMap.entries());
            const seenPaths = new Set<string>();
            const justDeletedPaths = new Set<string>(); 
            
            const pendingUpdates = new Map<string, string>();
            
            for (const [uuid, node] of dedupeEntries) {
                if (node.isDeleted) continue;
                
                const isNewRemote = !this.uuidToLastKnownPath.has(uuid);
                const localFile = this.app.vault.getAbstractFileByPath(node.path);
                const localExists = !!localFile || await safeExists(node.path);
                const isFolder = node.type === 'folder';
                
                if (seenPaths.has(node.path) || (!isFolder && isNewRemote && localExists)) {
                    let collisionCount = 1;
                    let newPath = '';
                    const extMatch = node.path.match(/(\.[^.]+)$/);
                    const ext = extMatch ? extMatch[0] : '';
                    const base = extMatch ? node.path.slice(0, -ext.length) : node.path;
                    
                    do {
                        newPath = `${base} (Conflict ${collisionCount})${ext}`;
                        collisionCount++;
                    } while (seenPaths.has(newPath) || !!this.app.vault.getAbstractFileByPath(newPath) || await safeExists(newPath));
                    
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

            this.rebuildReverseLookup();

            const entries = Array.from(this.treeMap.entries());
            
            const toDelete = entries
                .filter(e => e[1].isDeleted)
                .sort((a, b) => b[1].path.split('/').length - a[1].path.split('/').length);
                
            const toKeep = entries
                .filter(e => !e[1].isDeleted)
                .sort((a, b) => a[1].path.split('/').length - b[1].path.split('/').length);

            // Phase 1: Aggressive Deletions
            for (const [uuid, node] of toDelete) {
                this.uuidToLastKnownPath.delete(uuid);
                
                if (!this.pathToUuid.has(node.path)) {
                    justDeletedPaths.add(node.path);
                    const localFile = this.app.vault.getAbstractFileByPath(node.path);
                    await safeRemove(node.path, localFile);
                }
            }

            // Phase 2: Creations & Renames
            for (const [uuid, node] of toKeep) {
                const localFile = this.app.vault.getAbstractFileByPath(node.path);
                if (!localFile && !(await safeExists(node.path))) {
                    const lastKnownPath = this.uuidToLastKnownPath.get(uuid);
                    const oldLocalFile = lastKnownPath ? this.app.vault.getAbstractFileByPath(lastKnownPath) : null;

                    if (oldLocalFile) {
                        await this.ensureFolderExists(node.path, false);
                        try {
                            await this.app.fileManager.renameFile(oldLocalFile, node.path);
                        } catch (e) {}
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

            // Phase 3: Scan for untracked offline files
            const allFiles = this.app.vault.getAllLoadedFiles();
            const newFilesToTrack: any[] = [];
            
            for (const file of allFiles) {
                if (file.path === '/' || file.path.startsWith('.')) continue; 
                
                if (!this.pathToUuid.has(file.path) && !justDeletedPaths.has(file.path)) {
                    newFilesToTrack.push(file);
                }
            }

            if (newFilesToTrack.length > 0) {
                await this.applyAndPushIndexTransaction(() => {
                    for (const file of newFilesToTrack) {
                        const type = file instanceof TFolder ? 'folder' : 'file';
                        const uuid = window.crypto.randomUUID() as string;
                        this.treeMap!.set(uuid, { type, path: file.path, isDeleted: false });
                        this.pathToUuid.set(file.path, uuid);
                        this.uuidToLastKnownPath.set(uuid, file.path);
                    }
                });
            }
            
        } finally {
            this.isReconciling = false;
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

    public async handleCreate(file: TAbstractFile): Promise<void> {
        await this.initialize();
        if (!this.treeMap || this.isReconciling) return;
        
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
            this.treeMap!.set(uuid, { type, path: file.path, isDeleted: false });
        });
        
        this.pathToUuid.set(file.path, uuid);
        this.uuidToLastKnownPath.set(uuid, file.path);
        
        if (type === 'file' && file instanceof TFile) {
            const content = await this.app.vault.read(file);
            const doc = await this.crdtEngine.getOrCreateDoc(uuid, content);
            
            const fullState = Y.encodeStateAsUpdate(doc);
            await this.syncOrchestrator.pushDocumentUpdate(uuid, fullState, file.path);
            
            await this.syncOrchestrator.handleLocalChange(file.path, content);
        }
    }

    public async handleRename(oldPath: string, newPath: string): Promise<void> {
        await this.initialize();
        if (!this.treeMap || this.isReconciling) return;

        const targetUuid = this.pathToUuid.get(oldPath);
        
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
                for (const [uuid, node] of this.treeMap!.entries()) {
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

        const entries = Array.from(this.treeMap.entries());

        await this.applyAndPushIndexTransaction(() => {
            for (const [uuid, node] of entries) {
                if (node.isDeleted) continue;

                if (node.path === oldPath) {
                    this.treeMap!.set(uuid, { ...node, path: finalNewPath });
                    this.uuidToLastKnownPath.set(uuid, finalNewPath); 
                } else if (node.path.startsWith(oldPath + '/')) {
                    const updatedPath = node.path.replace(oldPath, finalNewPath);
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