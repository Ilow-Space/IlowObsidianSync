import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroDoc } from 'loro-crdt';
describe('Critical Architecture & Data Integrity Audits', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;
    let remoteStoreMock: any;
    let cryptoMock: any;
    let noteRepoMock: any;
    let appMock: any;

    beforeEach(async () => {
        eventBus = new SyncEventBus();
        syncEngine = new LoroSyncEngine();
        await syncEngine.localStore.clearAll();

        vfsController = new LoroVfsController(syncEngine, eventBus);
        await vfsController.initialize();

        remoteStoreMock = {
            getBulkLatestUpdateIds: vi.fn().mockResolvedValue({}),
            fetchSnapshotDetails: vi.fn().mockResolvedValue({ encryptedState: null, maxCompactedId: 0, isDeleted: false }),
            fetchUpdatesSince: vi.fn().mockResolvedValue([]),
            pushUpdate: vi.fn().mockResolvedValue(undefined),
            compactSnapshot: vi.fn().mockResolvedValue(undefined),
            deleteSnapshot: vi.fn().mockResolvedValue(undefined),
            connectWebSocket: vi.fn(),
            subscribeToUpdates: vi.fn()
        };

        cryptoMock = {
            encrypt: vi.fn().mockImplementation(async (data: Uint8Array) => data),
            decrypt: vi.fn().mockImplementation(async (data: Uint8Array) => data)
        };

        noteRepoMock = {
            readNote: vi.fn().mockResolvedValue(null),
            writeNote: vi.fn().mockResolvedValue(undefined)
        };

        appMock = {
            vault: {
                getAbstractFileByPath: vi.fn().mockReturnValue(null),
                createFolder: vi.fn().mockResolvedValue(undefined),
                create: vi.fn().mockResolvedValue(undefined),
                modify: vi.fn().mockResolvedValue(undefined),
                trash: vi.fn().mockResolvedValue(undefined),
                read: vi.fn().mockResolvedValue('')
            },
            fileManager: { renameFile: vi.fn().mockResolvedValue(undefined) }
        };

        diskReconciler = new ObsidianDiskReconciler(appMock, syncEngine, eventBus);
        orchestrator = new NetworkOrchestrator(
            remoteStoreMock, cryptoMock, syncEngine, noteRepoMock, 
            vfsController, eventBus, vi.fn(), 1000
        );
        
        orchestrator.setCryptoKey({} as any);
        (orchestrator as any).isInitialized = true;
    });

    it('BUG 1: forceSyncAndCompact NEVER calls the database to compact data, abandoning storage recovery', async () => {
        await orchestrator.forceSyncAndCompact('some-doc');
        expect(remoteStoreMock.compactSnapshot).toHaveBeenCalled();
    });

    it('BUG 2: NetworkOrchestrator silently discards local edits if the remote push fails, causing permanent data loss', async () => {
        // Mock a temporary network failure during an update push
        remoteStoreMock.pushUpdate.mockRejectedValueOnce(new Error('Network Offline'));
        
        await orchestrator['handleLocalDeltaReadyForPush']({
            documentId: 'dropped-edit-doc',
            updateBinary: new Uint8Array([1, 2, 3]),
            path: 'Dropped.md'
        });
        
        // Because the push failed, the delta MUST be stored in a retry queue to prevent data loss.
        // Current Codebase: Fails because it merely sets an error flag and permanently discards the delta payload.
        const pendingRetries = (orchestrator as any).pendingRetries || [];
        expect(pendingRetries.length).toBeGreaterThan(0);
    });

    it('BUG 3: Global orchestratorMutex destroys concurrency, executing network pulls strictly sequentially', async () => {
        remoteStoreMock.fetchSnapshotDetails.mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 50));
            return { encryptedState: null, maxCompactedId: 0, isDeleted: false };
        });

        const start = performance.now();
        await Promise.all([
            orchestrator.pullDocument('doc-1'),
            orchestrator.pullDocument('doc-2')
        ]);
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(75);
    });

    it('BUG 4: NetworkOrchestrator lacks debouncing for local edits, causing network flooding on every keystroke', async () => {
        const docId = 'debounce-doc';
        vfsController.getUuidForPath = vi.fn().mockReturnValue(docId);
        syncEngine.handleLocalChange = vi.fn().mockResolvedValue(new Uint8Array([1]));
        
        for (let i = 0; i < 5; i++) {
            eventBus.emit('LocalFileModified', { path: 'doc.md', content: `Edit ${i}` });
        }
        
        await new Promise(r => setTimeout(r, 100));

        expect(remoteStoreMock.pushUpdate).toHaveBeenCalledTimes(1);
    });

    it('BUG 5: ObsidianDiskReconciler concurrent disk queue causes child files to move before their parent folders', async () => {
        let order: string[] = [];
        appMock.fileManager.renameFile.mockImplementation(async (file: any, path: string) => {
            await new Promise(r => setTimeout(r, path.includes('.') ? 10 : 50));
            order.push(path);
        });

        await diskReconciler['handleCrdtNodeMoved']({ uuid: '1', oldPath: 'Folder', newPath: 'NewFolder' });
        await diskReconciler['handleCrdtNodeMoved']({ uuid: '2', oldPath: 'Folder/File.md', newPath: 'NewFolder/File.md' });
        
        await new Promise(r => setTimeout(r, 100));
        
        expect(order[0]).toBe('NewFolder');
        expect(order[1]).toBe('NewFolder/File.md');
    });

    it('BUG 6: Offline creation of a document with the same path ignores remote CRDT state instead of merging', async () => {
        appMock.vault.getAbstractFileByPath.mockReturnValue({ path: 'Conflict.md' });
        
        await diskReconciler['handleCrdtNodeCreated']({ uuid: 'uuid', path: 'Conflict.md', isFolder: false, content: 'Remote' });
        
        expect(appMock.vault.modify).toHaveBeenCalled(); 
    });

    it('BUG 7: stopAll fails to clear fileLastSyncIds memory, causing skipped syncs across vault switches', async () => {
        // Populate the sync ID tracker (e.g., from an active session)
        (orchestrator as any).fileLastSyncIds.set('persisted-doc', 999);
        
        // User unloads key or disconnects, which triggers stopAll()
        orchestrator.stopAll();
        
        // If a new vault/key is loaded, the orchestrator MUST start with a fresh slate.
        // Current Codebase: Fails because fileLastSyncIds is never cleared, causing the new session 
        // to incorrectly ignore all remote updates with IDs < 999.
        const stillHasId = (orchestrator as any).fileLastSyncIds.has('persisted-doc');
        expect(stillHasId).toBe(false); 
    });

    it('BUG 8: Deleting a remote snapshot leaves a zombie node in the CRDT VFS, causing it to resurrect', async () => {
        // deleteRemoteSnapshot deletes DB records but fails to remove the node from the shard-index Loro tree.
        eventBus.emit('LocalFileCreated', { path: 'Zombie.md', isFolder: false });
        await new Promise(r => setTimeout(r, 100));
        const uuid = vfsController.getUuidForPath('Zombie.md')!;
        
        await orchestrator.deleteRemoteSnapshot(uuid);
        
        // Use the public getOrCreateDoc API instead of directly accessing private activeDocs
        const shardIndexDoc = await syncEngine.getOrCreateDoc('shard-index');
        const zombieExists = shardIndexDoc.getTree('vault-tree').getNodes().some(n => n.data.get('uuid') === uuid);
        
        expect(zombieExists).toBe(false); 
    });

    it('BUG 9: Disk Reconciler 600ms suppression timeout swallows fast consecutive user keystrokes', async () => {
        ObsidianDiskReconciler.suppressPath('FastTyping.md');
        
        const isIgnored = ObsidianDiskReconciler.suppressedPaths.has('FastTyping.md');
        
        expect(isIgnored).toBe(false); 
    });

    it('BUG 10: ObsidianDiskReconciler infinitely leaks memory by never evicting Mutexes from fileLocks', async () => {
        await diskReconciler['handleCrdtNodeCreated']({ uuid: '1', path: 'Leak.md', isFolder: false });
        
        const lockCount = (diskReconciler as any).fileLocks.size;
        expect(lockCount).toBe(0); 
    });

    it('BUG 11: Real-time creation of new files by peers are silently ignored due to missing local UUIDs', async () => {
        const path = vfsController.getPathForUuid('brand-new-remote-uuid');
        
        expect(path).not.toBeNull();
    });

    it('BUG 12: Local file deletion fails to trigger remote database deletion, causing permanent storage leaks', async () => {
        eventBus.emit('LocalFileCreated', { path: 'Leaked.md', isFolder: false });
        await new Promise(r => setTimeout(r, 100));
        
        eventBus.emit('LocalFileDeleted', { path: 'Leaked.md' });
        await new Promise(r => setTimeout(r, 100));

        expect(remoteStoreMock.deleteSnapshot).toHaveBeenCalled();
    });

    it('BUG 13: NetworkOrchestrator blindly attempts to pull CRDT network payloads for Folders, wasting mass bandwidth', async () => {
        vfsController.getActiveFiles = vi.fn().mockReturnValue([{ uuid: 'folder-uuid', path: 'Dir', type: 'folder' }]);
        
        await orchestrator.runFullSync();
        
        expect(remoteStoreMock.fetchUpdatesSince).not.toHaveBeenCalledWith('folder-uuid', expect.anything());
    });

    it('BUG 14: ensureFolderExists silently swallows errors, causing nested file creation to fail without warning', async () => {
        appMock.vault.createFolder.mockRejectedValueOnce(new Error('Locked'));
        
        await expect(diskReconciler['ensureFolderExists']('A/B/C')).rejects.toThrow();
    });

    it('BUG 15: LoroVfsController leaks event listeners on destruction, continuing to process events after destroy()', async () => {
        const vfs = new LoroVfsController(syncEngine, eventBus);
        await vfs.initialize();
        vfs.destroy();

        const pushSpy = vi.fn();
        eventBus.on('LocalDeltaReadyForPush', pushSpy);

        eventBus.emit('LocalFileCreated', { path: 'DestroyedLeak.md', isFolder: false });
        await new Promise(r => setTimeout(r, 100));

        // Since destroy() fails to call eventBus.off(), the destroyed instance STILL processes events and pushes deltas
        expect(pushSpy).not.toHaveBeenCalled();
    });
    describe('Deep Architectural Flaws & Race Conditions', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let diskReconciler: ObsidianDiskReconciler;
    let appMock: any;

    beforeEach(async () => {
        eventBus = new SyncEventBus();
        syncEngine = new LoroSyncEngine();
        await syncEngine.localStore.clearAll();

        appMock = {
            vault: {
                getAbstractFileByPath: vi.fn().mockReturnValue({ path: 'mock' }),
            },
            fileManager: { renameFile: vi.fn().mockResolvedValue(undefined) }
        };

        diskReconciler = new ObsidianDiskReconciler(appMock, syncEngine, eventBus);
    });

    it('BUG 16: LoroSyncEngine async instantiation race condition causes split-brain data loss on rapid events', async () => {
        // The getOrCreateDoc method has a critical async gap. If called concurrently (e.g., rapid file modifications
        // or overlapping network pulls) before IndexedDB resolves, it spawns multiple isolated LoroDoc instances 
        // for the exact same UUID, permanently branching local history and dropping edits.
        
        // Mock a slow IndexedDB disk read
        vi.spyOn(syncEngine.localStore, 'loadDocumentState').mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 50));
            return null;
        });

        // Fire two requests simultaneously (mimicking Obsidian double-fire events or network + local collision)
        const [docInstanceA, docInstanceB] = await Promise.all([
            syncEngine.getOrCreateDoc('race-doc'),
            syncEngine.getOrCreateDoc('race-doc')
        ]);

        // They MUST be the exact same reference in memory to maintain CRDT integrity.
        // Current Codebase: Returns false (Two separate instances are created).
        expect(docInstanceA).toBe(docInstanceB);
    });

    it('BUG 17: ObsidianDiskReconciler fails to suppress cascading child renames, corrupting CRDT trees on folder moves', async () => {
        const oldFolderPath = 'Projects/Secret';
        const newFolderPath = 'Projects/Public';
        const childOldPath = 'Projects/Secret/Data.md';
        const childNewPath = 'Projects/Public/Data.md';

        // 1. Mock getAbstractFileByPath specifically so oldPath exists and newPath does NOT exist
        appMock.vault.getAbstractFileByPath.mockImplementation((p: string) => {
            if (p === oldFolderPath) return { path: oldFolderPath };
            return null; // Ensures targetExists is false so handleCrdtNodeMoved proceeds
        });

        let isChildProtected = false;

        // 2. Capture suppression state synchronously when Obsidian's native renameFile is called
        appMock.fileManager.renameFile.mockImplementation(async () => {
            isChildProtected = ObsidianDiskReconciler.suppressedPaths.has(childOldPath) || 
                               ObsidianDiskReconciler.suppressedPaths.has(childNewPath);
        });

        // 3. Await the reconciler handler execution
        await diskReconciler['handleCrdtNodeMoved']({ uuid: 'folder-uuid', oldPath: oldFolderPath, newPath: newFolderPath });

        // 4. Measurable Assertion: Current code only suppresses folder paths, so this immediately fails with:
        // AssertionError: expected false to be true
        expect(isChildProtected).toBe(true);
    });
});

});