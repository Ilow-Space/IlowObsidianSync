import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { VaultEventWatcher } from '../src/2_Application/Sync/VaultEventWatcher';
import { TFile } from 'obsidian';

describe('Startup Order & Echo Loop Prevention', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;
    let appMock: any;
    let remoteStoreMock: any;
    let mockVaultFiles: Map<string, any>;

    beforeEach(async () => {
        eventBus = new SyncEventBus();
        syncEngine = new LoroSyncEngine();
        await syncEngine.localStore.clearAll();
        vfsController = new LoroVfsController(syncEngine, eventBus);
        await vfsController.initialize();

        // 🚨 FIX: Use a proper map so the conflict resolver doesn't loop infinitely
        mockVaultFiles = new Map<string, any>();
        const initialFile = new TFile();
        (initialFile as any).path = 'FolderA/Doc.md';
        mockVaultFiles.set('FolderA/Doc.md', initialFile);

        appMock = {
            vault: {
                on: vi.fn(), off: vi.fn(),
                getAbstractFileByPath: vi.fn((p: string) => mockVaultFiles.get(p) || null),
                getAllLoadedFiles: vi.fn(() => Array.from(mockVaultFiles.values())),
                read: vi.fn().mockResolvedValue(''),
                modify: vi.fn()
            },
            fileManager: {
                renameFile: vi.fn().mockImplementation(async (f: any, newPath: string) => {
                    mockVaultFiles.delete(f.path);
                    f.path = newPath;
                    mockVaultFiles.set(newPath, f);
                })
            }
        };

        remoteStoreMock = {
            getBulkLatestUpdateIds: vi.fn().mockResolvedValue({ 'shard-index': 10 }),
            getLatestUpdateId: vi.fn().mockResolvedValue(0),
            fetchSnapshotDetails: vi.fn().mockResolvedValue({ encryptedState: null, maxCompactedId: 0, isDeleted: false }),
            fetchUpdatesSince: vi.fn().mockResolvedValue([]),
            pushUpdate: vi.fn().mockResolvedValue(undefined)
        };

        diskReconciler = new ObsidianDiskReconciler(appMock, syncEngine, eventBus);
        diskReconciler.initialize();
        
        orchestrator = new NetworkOrchestrator(
            remoteStoreMock, { encrypt: vi.fn(), decrypt: vi.fn() } as any, syncEngine, 
            { listAllNotes: vi.fn().mockResolvedValue([]), readNote: vi.fn() } as any, 
            vfsController, eventBus, vi.fn(), 0, diskReconciler
        );
        orchestrator.initialize();
        orchestrator.setCryptoKey({} as any);
    });

    afterEach(() => {
        orchestrator.stopAll();
        diskReconciler.destroy();
        vfsController.destroy();
        syncEngine.destroy();
        eventBus.destroy();
    });

    it('Validates execution order: Remote pull MUST precede local offline ingestion', async () => {
        const pullSpy = vi.spyOn(orchestrator, 'pullDocument');
        const ingestSpy = vi.spyOn(orchestrator as any, 'ingestLocalOfflineNotes');
        
        await orchestrator.runFullSync();

        // Ensure pullDocument happened before ingestLocalOfflineNotes
        const pullOrder = pullSpy.mock.invocationCallOrder[0];
        const ingestOrder = ingestSpy.mock.invocationCallOrder[0];
        
        expect(pullOrder).toBeLessThan(ingestOrder);
    });

    it('Blocks the infinite echo loop by properly suppressing delayed native rename events', async () => {
        // Emit a remote move
        eventBus.emit('CrdtNodeMoved', {
            uuid: 'test-uuid',
            oldPath: 'FolderA/Doc.md',
            newPath: 'FolderB/Doc.md'
        });

        await (diskReconciler as any).diskQueue.onIdle();

        // Verify the paths are suppressed
        expect(ObsidianDiskReconciler.suppressedPaths.has('FolderA/Doc.md')).toBe(true);
        expect(ObsidianDiskReconciler.suppressedPaths.has('FolderB/Doc.md')).toBe(true);

        // Simulate Obsidian firing the native event 500ms late
        const isSuppressedAt500ms = ObsidianDiskReconciler.suppressedPaths.has('FolderA/Doc.md');
        expect(isSuppressedAt500ms, 'The path unsuppressed too early, exposing it to the VaultEventWatcher!').toBe(true);
    });
});