import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroDoc } from 'loro-crdt';
import { TFile, TFolder } from 'obsidian';

describe('Async VFS Diff Race Condition', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;

    let appMock: any;
    let remoteStoreMock: any;
    let cryptoMock: any;
    let noteRepoMock: any;
    let mockVaultFiles = new Map<string, any>();
    let serverUpdatesDb: Record<string, any[]> = {};
    let updateCounter = 0;

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
                on: vi.fn(), off: vi.fn(),
                getAbstractFileByPath: vi.fn((p: string) => mockVaultFiles.get(p) || null),
                create: vi.fn().mockImplementation(async (p: string) => {
                    const f = new TFile(); (f as any).path = p;
                    mockVaultFiles.set(p, f);
                }),
                createFolder: vi.fn().mockImplementation(async (p: string) => {
                    const d = new TFolder(); (d as any).path = p;
                    mockVaultFiles.set(p, d);
                }),
                modify: vi.fn().mockImplementation(async (f: any, content: string) => {
                    if (f) f.content = content;
                }),
                trash: vi.fn().mockImplementation(async (f: any) => mockVaultFiles.delete(f.path)),
                read: vi.fn().mockImplementation(async (f: any) => f?.content || ''),
                getAllLoadedFiles: vi.fn(() => Array.from(mockVaultFiles.values()))
            },
            fileManager: {
                renameFile: vi.fn().mockImplementation(async (f: any, newPath: string) => {
                    mockVaultFiles.delete(f.path);
                    f.path = newPath;
                    mockVaultFiles.set(newPath, f);
                })
            }
        };

        noteRepoMock = {
            readNote: vi.fn().mockImplementation(async (path: string) => {
                const f = mockVaultFiles.get(path);
                return f ? f.content || '' : null;
            }),
            writeNote: vi.fn().mockResolvedValue(undefined),
            listAllNotes: vi.fn().mockImplementation(async () => Array.from(mockVaultFiles.keys()))
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
            remoteStoreMock, cryptoMock, syncEngine, noteRepoMock, vfsController, eventBus, vi.fn(), 0, diskReconciler
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

    const pushServerUpdate = (docId: string, delta: Uint8Array) => {
        const updateId = ++updateCounter;
        if (!serverUpdatesDb[docId]) serverUpdatesDb[docId] = [];
        serverUpdatesDb[docId].push({
            id: updateId, documentId: docId, 
            encryptedUpdate: { ciphertext: Buffer.from(delta).toString('base64') }
        });
    };

    it('Guarantees CrdtNodeMoved is processed before remote pull completion message and local note ingestion', async () => {
        const docUuid = 'doc-1-uuid';
        const initialContent = 'Hello World';

        // 1. Initial State: File exists locally at root "Doc1.md"
        const localIndex = await syncEngine.getOrCreateDoc('shard-index');
        const tree = localIndex.getTree('vault-tree');

        const fileNode = tree.createNode();
        fileNode.data.set('uuid', docUuid);
        fileNode.data.set('filename', 'Doc1.md');
        fileNode.data.set('type', 'file');
        localIndex.commit();

        vfsController.rebuildCache();

        const file = new TFile();
        (file as any).path = 'Doc1.md';
        (file as any).content = initialContent;
        mockVaultFiles.set('Doc1.md', file);

        const textDoc = await syncEngine.getOrCreateDoc(docUuid);
        textDoc.getText('markdown').insert(0, initialContent);
        textDoc.commit();

        // 2. Server Update: Remote node moves "Doc1.md" inside "FastRenameFolderRenamed/Doc1.md"
        const remoteIndexDoc = new LoroDoc();
        remoteIndexDoc.import(localIndex.export({ mode: 'snapshot' }));
        const remoteTree = remoteIndexDoc.getTree('vault-tree');

        const folderNode = remoteTree.createNode();
        folderNode.data.set('uuid', 'folder-renamed-uuid');
        folderNode.data.set('filename', 'FastRenameFolderRenamed');
        folderNode.data.set('type', 'folder');

        const remoteFileNode = remoteTree.getNodes().find((n: any) => n.data.get('uuid') === docUuid);
        if (remoteFileNode) {
            remoteTree.move(remoteFileNode.id, folderNode.id);
        }
        remoteIndexDoc.commit();

        pushServerUpdate('shard-index', remoteIndexDoc.export({ mode: 'update', from: localIndex.version() }));

        // Track order of CrdtNodeMoved vs Settlement log
        let movedEventTimestamp = 0;
        let settledLogTimestamp = 0;

        eventBus.on('CrdtNodeMoved', () => {
            movedEventTimestamp = performance.now();
        });

        const originalConsoleLog = console.log;
        console.log = vi.fn((...args: any[]) => {
            if (args[0] && String(args[0]).includes('REMOTE CHANGES PULLED AND SETTLED')) {
                settledLogTimestamp = performance.now();
            }
            originalConsoleLog.apply(console, args);
        });

        // 3. Node B runs full sync
        await orchestrator.runFullSync();
        await (diskReconciler as any).diskQueue.onIdle();

        console.log = originalConsoleLog;

        // 4. Assertions: Move MUST execute BEFORE settlement log
        expect(movedEventTimestamp, 'CrdtNodeMoved was never emitted!').toBeGreaterThan(0);
        expect(settledLogTimestamp, 'Settlement log was never emitted!').toBeGreaterThan(0);
        expect(movedEventTimestamp, 'CrdtNodeMoved was emitted AFTER remote changes were settled!').toBeLessThan(settledLogTimestamp);

        // 5. Assert disk state: File must reside at new path and not at old path
        expect(mockVaultFiles.has('Doc1.md'), 'Old file path still exists on disk!').toBe(false);
        expect(mockVaultFiles.has('FastRenameFolderRenamed/Doc1.md'), 'File was not moved to the target directory!').toBe(true);
    });
});