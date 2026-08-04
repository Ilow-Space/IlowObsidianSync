import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { PullRemoteChangesUseCase } from './PullRemoteChanges';
import { PushLocalChangesUseCase } from './PushLocalChanges';

export class SyncOrchestrator {
    private pullUseCase: PullRemoteChangesUseCase;
    private pushUseCase: PushLocalChangesUseCase;
    private fileLastSyncIds = new Map<string, number>();
    private fileUpdateCounters = new Map<string, number>();
    private activeIntervals = new Map<string, any>();
    private activeKey: CryptoKey | null = null;
    private activePath: string | null = null;

    // Mutex/Lock to avoid infinite loops when writing remote modifications locally
    private isApplyingRemoteChanges = false;

    // Debouncing local changes to avoid network/keystroke spamming
    private localChangeDebounceTimers = new Map<string, any>();
    private pendingContents = new Map<string, string>();

    constructor(
        private remoteStore: IRemoteStore,
        private crypto: ICryptography,
        private crdtEngine: YjsEngine,
        private noteRepo: INoteRepository
    ) {
        this.pullUseCase = new PullRemoteChangesUseCase(remoteStore, crypto, crdtEngine, noteRepo);
        this.pushUseCase = new PushLocalChangesUseCase(remoteStore, crypto, crdtEngine, noteRepo);
    }

    public setCryptoKey(key: CryptoKey | null) {
        this.activeKey = key;
    }

    public async handleFileOpen(path: string): Promise<void> {
        if (!this.activeKey) return;

        this.activePath = path;

        // Ensure Yjs has loaded local storage state
        const content = await this.noteRepo.readNote(path) || '';
        await this.crdtEngine.getOrCreateDoc(path, content);

        // Perform initial pull
        await this.pullFile(path);

        // Setup real-time hybrid polling loop (every 5 seconds)
        this.startPolling(path);
    }

    public async handleFileClose(path: string): Promise<void> {
        this.stopPolling(path);

        // Clear any pending debounced triggers
        if (this.localChangeDebounceTimers.has(path)) {
            clearTimeout(this.localChangeDebounceTimers.get(path));
            this.localChangeDebounceTimers.delete(path);
        }

        if (this.activePath === path) {
            this.activePath = null;
        }

        if (!this.activeKey) return;

        // Push any remaining buffered content
        const bufferedContent = this.pendingContents.get(path);
        if (bufferedContent !== undefined) {
            await this.pushUseCase.execute(path, bufferedContent, this.activeKey);
            this.pendingContents.delete(path);
        } else {
            const content = await this.noteRepo.readNote(path);
            if (content !== null) {
                await this.pushUseCase.execute(path, content, this.activeKey);
            }
        }

        // Remove from memory to save resource
        this.crdtEngine.removeDoc(path);
    }

    public async handleLocalChange(path: string, content: string): Promise<void> {
        if (!this.activeKey) return;

        // If we are currently writing a remote change, ignore this modification event
        if (this.isApplyingRemoteChanges) {
            return;
        }

        // Buffer/save the most up-to-date content
        this.pendingContents.set(path, content);

        // Debounce actual DB pushes by 1 second to bundle rapid keystrokes cleanly
        if (this.localChangeDebounceTimers.has(path)) {
            clearTimeout(this.localChangeDebounceTimers.get(path));
        }

        const timer = setTimeout(async () => {
            this.localChangeDebounceTimers.delete(path);
            const latestContent = this.pendingContents.get(path);
            if (latestContent !== undefined && this.activeKey) {
                this.pendingContents.delete(path);
                try {
                    await this.pushUseCase.execute(path, latestContent, this.activeKey);

                    // Track push counts for compaction threshold
                    const currentCount = (this.fileUpdateCounters.get(path) || 0) + 1;
                    this.fileUpdateCounters.set(path, currentCount);

                    if (currentCount >= 50) {
                        await this.pushUseCase.forceCompact(path, this.activeKey);
                        this.fileUpdateCounters.set(path, 0);
                    }
                } catch (err) {
                    console.error(`SyncOrchestrator push failed for ${path}:`, err);
                }
            }
        }, 1000);

        this.localChangeDebounceTimers.set(path, timer);
    }

    public async forceSyncAndCompact(path: string): Promise<void> {
        if (!this.activeKey) throw new Error('Master key not loaded');

        // Pull latest updates first
        await this.pullFile(path);
        // Force compaction
        await this.pushUseCase.forceCompact(path, this.activeKey);
        this.fileUpdateCounters.set(path, 0);
    }

    private async pullFile(path: string): Promise<void> {
        if (!this.activeKey) return;

        // Ignore pull if we have a pending push that has not gone through yet,
        // to avoid clobbering latest changes or race conditions.
        if (this.localChangeDebounceTimers.has(path) || this.isApplyingRemoteChanges) {
            return;
        }

        const lastId = this.fileLastSyncIds.get(path) || 0;
        try {
            const result = await this.pullUseCase.execute(
                path,
                lastId,
                this.activeKey,
                () => { this.isApplyingRemoteChanges = true; },
                () => { this.isApplyingRemoteChanges = false; }
            );
            this.fileLastSyncIds.set(path, result.newLastSyncId);
        } catch (err) {
            console.error(`SyncOrchestrator pull failed for ${path}:`, err);
        }
    }

    private startPolling(path: string) {
        this.stopPolling(path);

        const interval = setInterval(async () => {
            if (this.activePath === path && this.activeKey) {
                await this.pullFile(path);
            }
        }, 5000);

        this.activeIntervals.set(path, interval);
    }

    private stopPolling(path: string) {
        if (this.activeIntervals.has(path)) {
            clearInterval(this.activeIntervals.get(path));
            this.activeIntervals.delete(path);
        }
    }

    public stopAll() {
        for (const path of this.activeIntervals.keys()) {
            this.stopPolling(path);
        }
        for (const timer of this.localChangeDebounceTimers.values()) {
            clearTimeout(timer);
        }
        this.localChangeDebounceTimers.clear();
        this.pendingContents.clear();
    }
}
