import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { PullRemoteChangesUseCase } from './PullRemoteChanges';
import { PushLocalChangesUseCase } from './PushLocalChanges';
import { TreeIndexManager } from './TreeIndexManager';

export type SyncStatus = 'synced' | 'syncing' | 'error' | 'offline';

export class SyncOrchestrator {
    private pullUseCase: PullRemoteChangesUseCase;
    private pushUseCase: PushLocalChangesUseCase;
    private treeIndexManager: TreeIndexManager | null = null;
    
    private fileLastSyncIds = new Map<string, number>();
    private fileUpdateCounters = new Map<string, number>();
    private activeSubscriptions = new Map<string, () => void>();
    private activeKey: CryptoKey | null = null;
    private isInitialized = false;
    
    private activeDocumentId: string | null = null;
    private activePath: string | null = null;

    private activeTasks = new Set<string>();
    private statusIdleTimer: ReturnType<typeof setTimeout> | null = null;
    private lastPingMs: number | null = null;

    private hasConnectionError = false;
    private lastErrorMessage = '';
    private isSyncingFull = false;

    private isApplyingRemoteChanges = false;
    private localChangeDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingContents = new Map<string, string>();
    private remoteWriteHashes = new Map<string, string>();

    constructor(
        private remoteStore: IRemoteStore,
        private crypto: ICryptography,
        private crdtEngine: YjsEngine,
        private noteRepo: INoteRepository,
        private statusCallback: (status: SyncStatus, msg: string) => void,
        private debounceMs: number = 1000 // FAST TEST INJECTION
    ) {
        this.pullUseCase = new PullRemoteChangesUseCase(
            remoteStore, 
            crypto, 
            crdtEngine, 
            noteRepo, 
            (path, content) => this.registerRemoteWrite(path, content)
        );
        this.pushUseCase = new PushLocalChangesUseCase(remoteStore, crypto, crdtEngine, noteRepo);
    }

    public getRemoteStore(): IRemoteStore { return this.remoteStore; }
    public getActiveKey(): CryptoKey | null { return this.activeKey; }
    public getCrypto(): ICryptography { return this.crypto; }
    public setTreeIndexManager(im: TreeIndexManager) { this.treeIndexManager = im; }

    public setCryptoKey(key: CryptoKey | null) {
        this.activeKey = key;
        this.hasConnectionError = false;
        this.triggerStatusUpdate();
    }

    public getActiveSyncPaths(): string[] { return Array.from(this.activeTasks); }
    public getLastPing(): number | null { return this.lastPingMs; }

    private addActiveTask(taskName: string) {
        this.activeTasks.add(taskName);
        this.triggerStatusUpdate();
    }

    private removeActiveTask(taskName: string) {
        this.activeTasks.delete(taskName);
        this.triggerStatusUpdate();
    }

    private triggerStatusUpdate() {
        if (!this.activeKey) {
            this.statusCallback('offline', 'Disconnected');
            return;
        }

        if (this.hasConnectionError) {
            this.statusCallback('error', this.lastErrorMessage || 'Connection Error');
            return;
        }

        if (this.statusIdleTimer) {
            clearTimeout(this.statusIdleTimer);
            this.statusIdleTimer = null;
        }

        if (this.activeTasks.size > 0) {
            this.statusCallback('syncing', `Syncing ${this.activeTasks.size} files...`);
        } else {
            this.statusIdleTimer = setTimeout(() => {
                this.statusCallback('synced', 'Fully synced');
            }, 1000);
        }
    }

    public registerRemoteWrite(path: string, content: string) {
        this.remoteWriteHashes.set(path, content);
    }

    public isRemoteWriteActive(path: string): boolean {
        return this.remoteWriteHashes.has(path);
    }

    public clearRemoteWrite(path: string) {
        this.remoteWriteHashes.delete(path);
    }

    public isSyncInitialized(): boolean {
        return this.isInitialized;
    }

    public async handleFileOpen(path: string): Promise<void> {
        if (!this.activeKey || !this.treeIndexManager) return;

        let documentId = this.treeIndexManager.getUuidForPath(path);
        if (!documentId) return;

        this.activePath = path;
        this.activeDocumentId = documentId;

        const content = await this.noteRepo.readNote(path) || '';
        await this.crdtEngine.getOrCreateDoc(documentId, content);
        await this.pullDocument(documentId, path);
        
        const unsubscribe = this.remoteStore.subscribeToUpdates(documentId, () => {
            this.pullDocument(documentId, path, true).catch(() => {});
        });
        
        this.activeSubscriptions.set(documentId, unsubscribe);
    }

    public async handleFileClose(path: string): Promise<void> {
        if (!this.treeIndexManager) return;
        const documentId = this.treeIndexManager.getUuidForPath(path);
        if (!documentId) return;

        const unsubscribe = this.activeSubscriptions.get(documentId);
        if (unsubscribe) {
            unsubscribe();
            this.activeSubscriptions.delete(documentId);
        }

        const timer = this.localChangeDebounceTimers.get(documentId);
        if (timer) {
            clearTimeout(timer);
            this.localChangeDebounceTimers.delete(documentId);
        }

        if (this.activeDocumentId === documentId) {
            this.activeDocumentId = null;
            this.activePath = null;
        }

        if (!this.activeKey) return;

        const bufferedContent = this.pendingContents.get(documentId);
        if (bufferedContent !== undefined) {
            this.addActiveTask(path);
            const start = performance.now();
            try {
                await this.pushUseCase.execute(documentId, bufferedContent, this.activeKey, path);
                this.lastPingMs = Math.round(performance.now() - start);
                this.hasConnectionError = false;
            } catch (err) {
                this.hasConnectionError = true;
                this.lastErrorMessage = 'Connection failed';
            } finally {
                this.removeActiveTask(path);
            }
            this.pendingContents.delete(documentId);
        } else {
            const content = await this.noteRepo.readNote(path);
            if (content !== null) {
                this.addActiveTask(path);
                const start = performance.now();
                try {
                    await this.pushUseCase.execute(documentId, content, this.activeKey, path);
                    this.lastPingMs = Math.round(performance.now() - start);
                    this.hasConnectionError = false;
                } catch (err) {
                    this.hasConnectionError = true;
                    this.lastErrorMessage = 'Connection failed';
                } finally {
                    this.removeActiveTask(path);
                }
            }
        }

        this.crdtEngine.removeDoc(documentId);
    }

    public async handleLocalChange(path: string, content: string): Promise<void> {
        if (!this.activeKey || !this.treeIndexManager || !this.isInitialized) return;

        const documentId = this.treeIndexManager.getUuidForPath(path);
        if (!documentId) return;

        // IDEMPOTENCY CHECK: If text content is already identical to Yjs state, do not trigger a push!
        const doc = await this.crdtEngine.getOrCreateDoc(documentId);
        if (doc.getText('markdown').toString() === content) {
            return;
        }
        
        if (this.remoteWriteHashes.get(path) === content) {
            this.remoteWriteHashes.delete(path);
            return;
        }

        if (this.isApplyingRemoteChanges) return;

        this.pendingContents.set(documentId, content);

        const existingTimer = this.localChangeDebounceTimers.get(documentId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const newTimer = setTimeout(async () => {
            this.localChangeDebounceTimers.delete(documentId);
            const latestContent = this.pendingContents.get(documentId);
            if (latestContent !== undefined && this.activeKey) {
                this.pendingContents.delete(documentId);
                const start = performance.now();
                try {
                    this.addActiveTask(path);
                    await this.pushUseCase.execute(documentId, latestContent, this.activeKey, path);
                    this.lastPingMs = Math.round(performance.now() - start);
                    this.hasConnectionError = false;

                    const currentCount = (this.fileUpdateCounters.get(documentId) || 0) + 1;
                    this.fileUpdateCounters.set(documentId, currentCount);

                    if (currentCount >= 50) {
                        await this.pushUseCase.forceCompact(documentId, this.activeKey, path);
                        this.fileUpdateCounters.set(documentId, 0);
                    }
                } catch (err) {
                    this.hasConnectionError = true;
                    this.lastErrorMessage = 'Connection failed';
                } finally {
                    this.removeActiveTask(path);
                }
            }
        }, this.debounceMs); // CONFIGURABLE INJECTION

        this.localChangeDebounceTimers.set(documentId, newTimer);
    }

    public async runFullSync(): Promise<void> {
        if (!this.activeKey || !this.treeIndexManager) return;
        
        if (this.isSyncingFull) return;
        this.isSyncingFull = true;
        this.addActiveTask('System Index');

        try {
            console.log('[SyncOrchestrator] Starting VFS Index Sync...');

            // Fetch bulk updates array to prevent N+1 request waterfalls
            let bulkUpdates: Record<string, number> = {};
            try {
                bulkUpdates = await this.remoteStore.getBulkLatestUpdateIds();
            } catch (e) {
                console.warn('[SyncOrchestrator] Bulk fetch failed, falling back to sequential checks.');
            }

            const indexLatest = bulkUpdates[this.treeIndexManager.INDEX_DOC_ID] || 0;
            console.log(`[runFullSync] INDEX_DOC_ID=${this.treeIndexManager.INDEX_DOC_ID} indexLatest=${indexLatest} lastId=${this.fileLastSyncIds.get(this.treeIndexManager.INDEX_DOC_ID) || 0}`);
            await this.pullDocument(this.treeIndexManager.INDEX_DOC_ID, null, true, indexLatest);

            await this.treeIndexManager.reconcileFilesystem();

            const activeFiles = this.treeIndexManager.getActiveFiles();
            for (const file of activeFiles) {
                if (this.hasConnectionError) break;
                
                const latestRemoteId = bulkUpdates[file.uuid] || 0;
                await this.pullDocument(file.uuid, file.path, true, latestRemoteId);
            }

            this.isInitialized = true;
            console.log('[SyncOrchestrator] Full Sync Complete.');
        } catch (error) {
            console.error('[SyncOrchestrator] Sync failed:', error);
            this.hasConnectionError = true;
            this.lastErrorMessage = 'Sync failed';
        } finally {
            this.removeActiveTask('System Index');
            this.isSyncingFull = false;
        }
    }

    public async forceSyncAndCompact(path: string): Promise<void> {
        if (!this.activeKey || !this.treeIndexManager) return;
        
        const documentId = this.treeIndexManager.getUuidForPath(path);
        if (!documentId) return;

        this.addActiveTask(path);
        try {
            await this.pullDocument(documentId, path);
            await this.pushUseCase.forceCompact(documentId, this.activeKey, path);
            this.fileUpdateCounters.set(documentId, 0);
            this.hasConnectionError = false;
        } catch (err) {
            this.hasConnectionError = true;
            this.lastErrorMessage = 'Compaction failed';
        } finally {
            this.removeActiveTask(path);
        }
    }

    public async pullDocument(documentId: string, path: string | null = null, isSilent: boolean = false, knownLatestRemoteId?: number): Promise<void> {
        if (!this.activeKey) return;
        if (this.localChangeDebounceTimers.has(documentId)) return;

        const lastId = this.fileLastSyncIds.get(documentId) || 0;

        // BULK OPTIMIZATION: Skip fetching if we already know the remote ID matches local
        if (knownLatestRemoteId !== undefined) {
            if (knownLatestRemoteId <= lastId) return;
        } else if (lastId > 0) {
            try {
                const latestRemoteId = await this.remoteStore.getLatestUpdateId(documentId);
                if (latestRemoteId <= lastId) return; 
            } catch (err) {
                this.hasConnectionError = true;
                this.lastErrorMessage = 'Connection failed';
                return; 
            }
        }

        const taskName = path || 'System Index';
        if (!isSilent) this.addActiveTask(taskName);

        const start = performance.now();
        try {
            const result = await this.pullUseCase.execute(
                documentId, path, lastId, this.activeKey,
                () => { this.isApplyingRemoteChanges = true; },
                () => { this.isApplyingRemoteChanges = false; }
            );
            this.fileLastSyncIds.set(documentId, result.newLastSyncId);
            this.lastPingMs = Math.round(performance.now() - start);

            this.hasConnectionError = false;

            if (result.appliedCount > 50) {
                const resolvedPath = path || (this.treeIndexManager ? this.treeIndexManager.getPathForUuid(documentId) : null);
                this.pushUseCase.forceCompact(documentId, this.activeKey, resolvedPath).catch(() => {});
                this.fileUpdateCounters.set(documentId, 0);
            }
        } catch (err) {
            console.error('[SyncOrchestrator] pullDocument failed for ' + documentId + ':', err);
            this.hasConnectionError = true;
            this.lastErrorMessage = 'Connection failed';
        } finally {
            if (!isSilent) this.removeActiveTask(taskName);
        }
    }

    public async pushDocumentUpdate(documentId: string, updateBinary: Uint8Array, path?: string | null): Promise<void> {
        if (!this.activeKey) return;
        
        this.addActiveTask('System Index');
        const start = performance.now();
        try {
            await this.pushUseCase.pushRawUpdate(documentId, updateBinary, this.activeKey, path);
            this.lastPingMs = Math.round(performance.now() - start);
            this.hasConnectionError = false;
        } catch (err) {
            this.hasConnectionError = true;
            this.lastErrorMessage = 'Connection failed';
        } finally {
            this.removeActiveTask('System Index');
        }
    }

    public stopAll() {
        for (const unsubscribe of this.activeSubscriptions.values()) unsubscribe();
        this.activeSubscriptions.clear();
        
        for (const timer of this.localChangeDebounceTimers.values()) clearTimeout(timer);
        if (this.statusIdleTimer) {
            clearTimeout(this.statusIdleTimer);
            this.statusIdleTimer = null;
        }
        this.localChangeDebounceTimers.clear();
        this.pendingContents.clear();
        this.activeTasks.clear();
        this.hasConnectionError = false;
        this.isSyncingFull = false;
        this.isInitialized = false;
        this.triggerStatusUpdate();
    }

    public acquireRemoteLock() { this.isApplyingRemoteChanges = true; }
    public releaseRemoteLock() { this.isApplyingRemoteChanges = false; }
    
    public async deleteRemoteSnapshot(documentId: string): Promise<void> {
        this.fileLastSyncIds.delete(documentId);
        this.fileUpdateCounters.delete(documentId);
        const timer = this.localChangeDebounceTimers.get(documentId);
        if (timer) {
            clearTimeout(timer);
            this.localChangeDebounceTimers.delete(documentId);
        }
        this.pendingContents.delete(documentId);

        if (!this.activeKey) return;
        try {
            await this.remoteStore.deleteSnapshot(documentId);
            await this.crdtEngine.localStore.deleteDocumentState(documentId);
        } catch (err) {}
    }
}