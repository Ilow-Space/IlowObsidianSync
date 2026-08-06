
import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { PullRemoteChangesUseCase } from './PullRemoteChanges';
import { PushLocalChangesUseCase } from './PushLocalChanges';
import { IndexManager } from './IndexManager';

export type SyncStatus = 'synced' | 'syncing' | 'error' | 'offline';

export class SyncOrchestrator {
    private pullUseCase: PullRemoteChangesUseCase;
    private pushUseCase: PushLocalChangesUseCase;
    private indexManager: IndexManager | null = null;
    
    private fileLastSyncIds = new Map<string, number>();
    private fileUpdateCounters = new Map<string, number>();
    private activeSubscriptions = new Map<string, () => void>();
    private activeKey: CryptoKey | null = null;
    
    private activeDocumentId: string | null = null;
    private activePath: string | null = null;

    // Queue tracking, ping tracking & anti-flicker
    private activeTasks = new Set<string>();
    private statusIdleTimer: any = null;
    private lastPingMs: number | null = null;

    private isApplyingRemoteChanges = false;
    private localChangeDebounceTimers = new Map<string, any>();
    private pendingContents = new Map<string, string>();
    private remoteWriteHashes = new Map<string, string>();

    constructor(
        private remoteStore: IRemoteStore,
        private crypto: ICryptography,
        private crdtEngine: YjsEngine,
        private noteRepo: INoteRepository,
        private statusCallback: (status: SyncStatus, msg: string) => void
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

    public getRemoteStore(): IRemoteStore {
        return this.remoteStore;
    }

    public getActiveKey(): CryptoKey | null {
        return this.activeKey;
    }

    public getCrypto(): ICryptography {
        return this.crypto;
    }

    public setIndexManager(im: IndexManager) {
        this.indexManager = im;
    }

    public setCryptoKey(key: CryptoKey | null) {
        this.activeKey = key;
        this.triggerStatusUpdate();
    }

    public getActiveSyncPaths(): string[] {
        return Array.from(this.activeTasks);
    }

    public getLastPing(): number | null {
        return this.lastPingMs;
    }

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
        setTimeout(() => {
            if (this.remoteWriteHashes.get(path) === content) {
                this.remoteWriteHashes.delete(path);
            }
        }, 2000);
    }

    public async handleFileOpen(path: string): Promise<void> {
        if (!this.activeKey || !this.indexManager) return;

        let documentId = this.indexManager.getUuidForPath(path);
        if (!documentId) {
             await this.indexManager.handleFileCreate(path);
             documentId = this.indexManager.getUuidForPath(path)!;
        }

        this.activePath = path;
        this.activeDocumentId = documentId;

        const content = await this.noteRepo.readNote(path) || '';
        await this.crdtEngine.getOrCreateDoc(documentId, content);
        await this.pullDocument(documentId, path);
        
        // Subscribe to real-time remote changes for this active document
        const unsubscribe = this.remoteStore.subscribeToUpdates(documentId, () => {
            this.pullDocument(documentId, path, true).catch(console.error);
        });
        
        this.activeSubscriptions.set(documentId, unsubscribe);
    }

    public async handleFileClose(path: string): Promise<void> {
        if (!this.indexManager) return;
        const documentId = this.indexManager.getUuidForPath(path);
        if (!documentId) return;

        const unsubscribe = this.activeSubscriptions.get(documentId);
        if (unsubscribe) {
            unsubscribe();
            this.activeSubscriptions.delete(documentId);
        }

        if (this.localChangeDebounceTimers.has(documentId)) {
            clearTimeout(this.localChangeDebounceTimers.get(documentId));
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
                } finally {
                    this.removeActiveTask(path);
                }
            }
        }

        this.crdtEngine.removeDoc(documentId);
    }

    public async handleLocalChange(path: string, content: string): Promise<void> {
        if (!this.activeKey || !this.indexManager) return;
        
        if (this.remoteWriteHashes.get(path) === content) {
            this.remoteWriteHashes.delete(path);
            return;
        }

        const documentId = this.indexManager.getUuidForPath(path);
        if (!documentId) return;

        if (this.isApplyingRemoteChanges) return;

        this.pendingContents.set(documentId, content);

        if (this.localChangeDebounceTimers.has(documentId)) {
            clearTimeout(this.localChangeDebounceTimers.get(documentId));
        }

        const timer = setTimeout(async () => {
            this.localChangeDebounceTimers.delete(documentId);
            const latestContent = this.pendingContents.get(documentId);
            if (latestContent !== undefined && this.activeKey) {
                this.pendingContents.delete(documentId);
                const start = performance.now();
                try {
                    this.addActiveTask(path);
                    await this.pushUseCase.execute(documentId, latestContent, this.activeKey, path);
                    this.lastPingMs = Math.round(performance.now() - start);

                    const currentCount = (this.fileUpdateCounters.get(documentId) || 0) + 1;
                    this.fileUpdateCounters.set(documentId, currentCount);

                    if (currentCount >= 50) {
                        await this.pushUseCase.forceCompact(documentId, this.activeKey, path);
                        this.fileUpdateCounters.set(documentId, 0);
                    }
                } catch (err) {
                    console.error(`SyncOrchestrator push failed for ${documentId}:`, err);
                } finally {
                    this.removeActiveTask(path);
                }
            }
        }, 1000);

        this.localChangeDebounceTimers.set(documentId, timer);
    }

    public async forceSyncAndCompact(path: string): Promise<void> {
        if (!this.activeKey) throw new Error('Master key not loaded');
        if (!this.indexManager) throw new Error('Index manager not loaded');
        
        const documentId = this.indexManager.getUuidForPath(path);
        if (!documentId) throw new Error('Document ID not found in index');

        this.addActiveTask(path);
        try {
            await this.pullDocument(documentId, path);
            await this.pushUseCase.forceCompact(documentId, this.activeKey, path);
            this.fileUpdateCounters.set(documentId, 0);
        } finally {
            this.removeActiveTask(path);
        }
    }

    public async pullDocument(documentId: string, path: string | null = null, isSilent: boolean = false): Promise<void> {
    if (!this.activeKey) return;
    
    // ⚡ FIX: Do NOT abort pullDocument if isApplyingRemoteChanges is true!
    // Only skip if there's an active local typing debounce timer for this specific document.
    if (this.localChangeDebounceTimers.has(documentId)) return;

    const lastId = this.fileLastSyncIds.get(documentId) || 0;

    if (lastId > 0) {
        try {
            const latestRemoteId = await this.remoteStore.getLatestUpdateId(documentId);
            if (latestRemoteId <= lastId) {
                return; // Up to date
            }
        } catch (err) {
            console.warn(`Pre-flight check failed for ${documentId}:`, err);
        }
    }

    const taskName = path || 'System Index';
    if (!isSilent) this.addActiveTask(taskName);

    const start = performance.now();
    try {
        const result = await this.pullUseCase.execute(
            documentId,
            path,
            lastId,
            this.activeKey,
            () => { this.isApplyingRemoteChanges = true; },
            () => { this.isApplyingRemoteChanges = false; }
        );
        this.fileLastSyncIds.set(documentId, result.newLastSyncId);
        this.lastPingMs = Math.round(performance.now() - start);

        if (result.appliedCount > 50) {
            this.pushUseCase.forceCompact(documentId, this.activeKey).catch(err => {
                console.error(`Auto-compaction failed for ${documentId}:`, err);
            });
            this.fileUpdateCounters.set(documentId, 0);
        }

    } catch (err) {
        console.error(`Sync pull failed for ${documentId}:`, err);
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
        } finally {
            this.removeActiveTask('System Index');
        }
    }

    public stopAll() {
        for (const unsubscribe of this.activeSubscriptions.values()) {
            unsubscribe();
        }
        this.activeSubscriptions.clear();
        
        for (const timer of this.localChangeDebounceTimers.values()) {
            clearTimeout(timer);
        }
        if (this.statusIdleTimer) {
            clearTimeout(this.statusIdleTimer);
            this.statusIdleTimer = null;
        }
        this.localChangeDebounceTimers.clear();
        this.pendingContents.clear();
        this.activeTasks.clear();
        this.triggerStatusUpdate();
    }

    public acquireRemoteLock() {
        this.isApplyingRemoteChanges = true;
    }

    public releaseRemoteLock() {
        this.isApplyingRemoteChanges = false;
    }
}


