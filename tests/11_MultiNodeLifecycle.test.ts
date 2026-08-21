import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroDoc } from 'loro-crdt';
import { TFile, TFolder } from 'obsidian';

describe('Real-World Race Condition: runFullSync & Unlocked oldPath Move Stalls', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;

    let appMock: any;
    let remoteStoreMock: any;
    let cryptoMock: any;
    let mockVaultFiles = new Map<string, any>();
    
    let serverUpdatesDb: Record<string, any[]> = {};
    let updateCounter = 0;

    const waitMemory = (ms = 50) => new Promise(r => setTimeout(r, ms));

    beforeEach(async () => {
        eventBus = new SyncEventBus();
        syncEngine = new LoroSyncEngine();
        await syncEngine.localStore.clearAll();

        vfsController = new LoroVfsController(syncEngine, eventBus);
        await vfsController.initialize();

        mockVaultFiles.clear();
        serverUpdatesDb = {};
        updateCounter = 0;

        appMock = {
            vault: {
                getAbstractFileByPath: vi.fn((p: string) => mockVaultFiles.get(p) || null),
                create: vi.fn().mockImplementation(async (p: string) => {
                    const f = new TFile(); (f as any).path = p;
                    mockVaultFiles.set(p, f);
                }),
                createFolder: vi.fn().mockImplementation(async (p: string) => {
                    const d = new TFolder(); (d as any).path = p;
                    mockVaultFiles.set(p, d);
                }),
                modify: vi.fn().mockResolvedValue(undefined),
                trash: vi.fn().mockImplementation(async (f: any) => mockVaultFiles.delete(f.path)),
                read: vi.fn().mockResolvedValue(''),
                getAllLoadedFiles: vi.fn(() => Array.from(mockVaultFiles.values()))
            },
            fileManager: {
                renameFile: vi.fn().mockResolvedValue(undefined)
            }
        };

        remoteStoreMock = {
            getBulkLatestUpdateIds: vi.fn().mockImplementation(async () => {
                const ids: Record<string, number> = {};
                for (const docId in serverUpdatesDb) {
                    ids[docId] = serverUpdatesDb[docId][serverUpdatesDb[docId].length - 1].id;
                }
                return ids;
            }),
            getLatestUpdateId: vi.fn().mockResolvedValue(0),
            fetchSnapshotDetails: vi.fn().mockResolvedValue({ encryptedState: null, maxCompactedId: 0, isDeleted: false }),
            fetchUpdatesSince: vi.fn().mockImplementation(async (docId: string, lastId: number) => {
                return (serverUpdatesDb[docId] || []).filter((u: any) => u.id > lastId);
            }),
            pushUpdate: vi.fn().mockResolvedValue(undefined)
        };

        cryptoMock = {
            encrypt: vi.fn().mockImplementation(async (data: Uint8Array) => ({ ciphertext: Buffer.from(data).toString('base64') })),
            decrypt: vi.fn().mockImplementation(async (blob: any) => new Uint8Array(Buffer.from(blob.ciphertext, 'base64')))
        };

        diskReconciler = new ObsidianDiskReconciler(appMock, syncEngine, eventBus);
        diskReconciler.initialize();

        orchestrator = new NetworkOrchestrator(
            remoteStoreMock, cryptoMock, syncEngine, {} as any, vfsController, eventBus, vi.fn(), 0, diskReconciler
        );
        orchestrator.initialize();
        orchestrator.setCryptoKey({} as any);
        (orchestrator as any).isInitialized = true;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        orchestrator.stopAll();
        diskReconciler.destroy();
        vfsController.destroy();
        syncEngine.destroy();
        eventBus.destroy();
    });

    const nodeAPushUpdate = (docId: string, delta: Uint8Array) => {
        const updateId = ++updateCounter;
        if (!serverUpdatesDb[docId]) serverUpdatesDb[docId] = [];
        serverUpdatesDb[docId].push({
            id: updateId, documentId: docId, 
            encryptedUpdate: { ciphertext: Buffer.from(delta).toString('base64') }
        });
    };

    it('Must properly lock oldPath and prevent concurrent sync duplicates during moves', async () => {
        // SETUP: Establish initial synced file in 'FolderA'
        const nodeAIndex = new LoroDoc();
        const treeA = nodeAIndex.getTree('vault-tree');
        
        const folderA = treeA.createNode();
        folderA.data.set('uuid', 'folder-a');
        folderA.data.set('filename', 'FolderA');
        folderA.data.set('type', 'folder');

        const fileNode = treeA.createNode();
        fileNode.data.set('uuid', 'file-doc');
        fileNode.data.set('filename', 'Doc.md');
        fileNode.data.set('type', 'file');
        treeA.move(fileNode.id, folderA.id);
        nodeAIndex.commit();
        
        nodeAPushUpdate('shard-index', nodeAIndex.export({ mode: 'update' }));
        
        await orchestrator.pullDocument('shard-index');
        (vfsController as any).rebuildCacheAndEmitRemoteDiffs();
        await (diskReconciler as any).diskQueue.onIdle();

        const f = new TFile(); (f as any).path = 'FolderA/Doc.md';
        mockVaultFiles.set('FolderA/Doc.md', f);

        // TRIGGER: Node A moves the file to 'FolderB' and edits it while B is off
        const oldVersion = nodeAIndex.version();
        const folderB = treeA.createNode();
        folderB.data.set('uuid', 'folder-b');
        folderB.data.set('filename', 'FolderB');
        folderB.data.set('type', 'folder');
        treeA.move(fileNode.id, folderB.id);
        nodeAIndex.commit();
        
        const fileDoc = new LoroDoc();
        fileDoc.getText('markdown').insert(0, 'Concurrent Text Update');
        fileDoc.commit();

        nodeAPushUpdate('shard-index', nodeAIndex.export({ mode: 'update', from: oldVersion }));
        nodeAPushUpdate('file-doc', fileDoc.export({ mode: 'update' }));

        // TRAP: Inject physical I/O delay & Spy on Locks
        const mutexSpy = vi.spyOn(diskReconciler as any, 'getFileMutex');

        appMock.fileManager.renameFile.mockImplementation(async (f: any, newPath: string) => {
            await waitMemory(150); // Simulate Obsidian taking 150ms to move the file
            mockVaultFiles.delete(f.path);
            f.path = newPath;
            mockVaultFiles.set(newPath, f);
        });

        // EXECUTION: Node B runs Full Sync
        const syncPromise = orchestrator.runFullSync();
        await waitMemory(30); 

        // SIMULATE ROGUE NATIVE EVENT: Obsidian touches the old path during the slow rename
        await (orchestrator as any).handleLocalFileModified({ path: 'FolderA/Doc.md', content: 'Obsidian Indexing Read' });
        
        await syncPromise;
        await (diskReconciler as any).diskQueue.onIdle();

        // 🚨 EXPECTATION 1: The reconciler MUST lock both the new AND the old path to prevent races.
        // This will currently FAIL because `this.getFileMutex(payload.oldPath)` is missing in your code.
        expect(mutexSpy, 'The reconciler failed to acquire a mutex lock for the oldPath during the move!').toHaveBeenCalledWith('FolderA/Doc.md');
        expect(mutexSpy, 'The reconciler failed to acquire a mutex lock for the newPath during the move!').toHaveBeenCalledWith('FolderB/Doc.md');

        // 🚨 EXPECTATION 2: The rogue event should have been blocked/suppressed, leaving only ONE file.
        // This will currently FAIL because the race condition creates a duplicate ghost file at 'FolderA/Doc.md'.
        const activeFiles = vfsController.getActiveFiles().filter(f => f.type === 'file');
        
        const ghostFile = activeFiles.find(f => f.path === 'FolderA/Doc.md');
        expect(ghostFile, 'A ghost duplicate was resurrected at the old path!').toBeUndefined();
        
        expect(activeFiles.length, 'Phantom duplicates detected in the CRDT Index!').toBe(1);
    });
});