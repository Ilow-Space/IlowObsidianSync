import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroDoc } from 'loro-crdt';
import { TFile, TFolder } from 'obsidian';

describe('Windows CRLF Move & Edit Reconciliation Suite', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;

    let appMock: any;
    let remoteStoreMock: any;
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
                getFiles: vi.fn(() => Array.from(mockVaultFiles.values()).filter(f => f instanceof TFile)),
                getAllLoadedFiles: vi.fn(() => Array.from(mockVaultFiles.values())),
                create: vi.fn().mockImplementation(async (p: string, content = '') => {
                    const f = new TFile(); (f as any).path = p; (f as any).content = content;
                    mockVaultFiles.set(p, f); return f;
                }),
                createFolder: vi.fn().mockImplementation(async (p: string) => {
                    const d = new TFolder(); (d as any).path = p;
                    mockVaultFiles.set(p, d); return d;
                }),
                modify: vi.fn().mockImplementation(async (f: any, content: string) => { if (f) f.content = content; }),
                trash: vi.fn().mockImplementation(async (f: any) => mockVaultFiles.delete(f.path)),
                read: vi.fn().mockImplementation(async (f: any) => f?.content || '')
            },
            fileManager: {
                renameFile: vi.fn().mockImplementation(async (f: any, newPath: string) => {
                    mockVaultFiles.delete(f.path); f.path = newPath; mockVaultFiles.set(newPath, f);
                })
            }
        };

        const noteRepoMock = {
            readNote: vi.fn().mockImplementation(async (path: string) => {
                const f = mockVaultFiles.get(path);
                return f ? f.content || '' : null;
            }),
            writeNote: vi.fn().mockImplementation(async (path: string, content: string) => {
                const f = mockVaultFiles.get(path); if (f) f.content = content;
            }),
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

        const cryptoMock = {
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

    it('Ignores Windows CRLF (\\r\\n) differences when comparing local disk content against baseline', async () => {
        const docUuid = 'crlf-doc-uuid';
        // Simulate Windows file on disk using CRLF (\r\n)
        const windowsDiskContent = 'Line 1: Hello\r\nLine 2: World\r\n';
        const remoteUpdatedContent = 'Line 1: Hello\nLine 2: World\nLine 3: Remote Append\n';

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
        (file as any).content = windowsDiskContent;
        mockVaultFiles.set('Doc1.md', file);

        const textDoc = await syncEngine.getOrCreateDoc(docUuid);
        textDoc.getText('markdown').insert(0, 'Line 1: Hello\nLine 2: World\n');
        textDoc.commit();

        // Server update: Remote node moves file and appends Line 3
        const remoteIndexDoc = new LoroDoc();
        remoteIndexDoc.import(localIndex.export({ mode: 'snapshot' }));
        const remoteTree = remoteIndexDoc.getTree('vault-tree');
        const folderNode = remoteTree.createNode();
        folderNode.data.set('uuid', 'renamed-folder-uuid');
        folderNode.data.set('filename', 'FastRenameFolderRenamed');
        folderNode.data.set('type', 'folder');

        const remoteFileNode = remoteTree.getNodes().find((n: any) => n.data.get('uuid') === docUuid);
        if (remoteFileNode) remoteTree.move(remoteFileNode.id, folderNode.id);
        remoteIndexDoc.commit();

        const remoteTextDoc = new LoroDoc();
        remoteTextDoc.import(textDoc.export({ mode: 'snapshot' }));
        const baseVer = remoteTextDoc.version();
        remoteTextDoc.getText('markdown').insert('Line 1: Hello\nLine 2: World\n'.length, 'Line 3: Remote Append\n');
        remoteTextDoc.commit();

        pushServerUpdate('shard-index', remoteIndexDoc.export({ mode: 'update', from: localIndex.version() }));
        pushServerUpdate(docUuid, remoteTextDoc.export({ mode: 'update', from: baseVer }));

        remoteStoreMock.pushUpdate.mockClear();

        await orchestrator.runFullSync();
        await diskReconciler.onIdle();

        const pushedDocumentUpdates = remoteStoreMock.pushUpdate.mock.calls.filter((call: any) => call[0] === docUuid);
        expect(pushedDocumentUpdates.length, 'Windows CRLF line endings caused an unwanted push to server!').toBe(0);

        const finalCrdtDoc = await syncEngine.getOrCreateDoc(docUuid);
        expect(finalCrdtDoc.getText('markdown').toString()).toBe(remoteUpdatedContent);
    });
});