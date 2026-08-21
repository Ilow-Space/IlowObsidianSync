import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroDoc } from 'loro-crdt';
import { TFile, TFolder } from 'obsidian';

describe('Remote Move and Edit Preservation Suite', () => {
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

    const waitMs = (ms = 50) => new Promise(r => setTimeout(r, ms));

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
                    const f = new TFile(); 
                    (f as any).path = p;
                    (f as any).content = content;
                    mockVaultFiles.set(p, f);
                    return f;
                }),
                createFolder: vi.fn().mockImplementation(async (p: string) => {
                    const d = new TFolder(); 
                    (d as any).path = p;
                    mockVaultFiles.set(p, d);
                    return d;
                }),
                modify: vi.fn().mockImplementation(async (f: any, content: string) => {
                    if (f) f.content = content;
                }),
                trash: vi.fn().mockImplementation(async (f: any) => mockVaultFiles.delete(f.path)),
                read: vi.fn().mockImplementation(async (f: any) => f?.content || '')
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
            writeNote: vi.fn().mockImplementation(async (path: string, content: string) => {
                const f = mockVaultFiles.get(path);
                if (f) f.content = content;
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

    it('Preserves remote edits when a file is moved and edited remotely while local was offline', async () => {
        const docUuid = 'doc-active-123';
        const initialContent = 'Line 1: Original text\n';
        const remoteUpdatedContent = 'Line 1: Original text\nLine 2: Added on Remote Node A\n';

        // 1. Local Baseline: File exists at "Doc1.md"
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

        // 2. Remote Node A moves "Doc1.md" -> "Archive/Doc1.md" AND appends text
        const remoteIndexDoc = new LoroDoc();
        remoteIndexDoc.import(localIndex.export({ mode: 'snapshot' }));
        const remoteTree = remoteIndexDoc.getTree('vault-tree');

        const archiveFolder = remoteTree.createNode();
        archiveFolder.data.set('uuid', 'folder-archive-uuid');
        archiveFolder.data.set('filename', 'Archive');
        archiveFolder.data.set('type', 'folder');

        const remoteFileNode = remoteTree.getNodes().find((n: any) => n.data.get('uuid') === docUuid);
        if (remoteFileNode) {
            remoteTree.move(remoteFileNode.id, archiveFolder.id);
        }
        remoteIndexDoc.commit();

        const remoteTextDoc = new LoroDoc();
        remoteTextDoc.import(textDoc.export({ mode: 'snapshot' }));
        const baseVersion = remoteTextDoc.version();
        remoteTextDoc.getText('markdown').insert(initialContent.length, 'Line 2: Added on Remote Node A\n');
        remoteTextDoc.commit();

        // Push remote updates to server queue
        pushServerUpdate('shard-index', remoteIndexDoc.export({ mode: 'update', from: localIndex.version() }));
        pushServerUpdate(docUuid, remoteTextDoc.export({ mode: 'update', from: baseVersion }));

        remoteStoreMock.pushUpdate.mockClear();

        // 3. Node B reconnects and triggers full sync
        await orchestrator.runFullSync();
        await diskReconciler.onIdle();
        await waitMs(100);

        // 4. Assertions
        const movedDiskFile = mockVaultFiles.get('Archive/Doc1.md');

        expect(mockVaultFiles.has('Doc1.md'), 'Old file path was not removed from disk!').toBe(false);
        expect(movedDiskFile, 'File was not physically moved to Archive/Doc1.md on disk!').toBeDefined();
        expect(movedDiskFile.content, 'Disk content at new location was not updated with remote edit!').toBe(remoteUpdatedContent);

        const finalCrdtDoc = await syncEngine.getOrCreateDoc(docUuid);
        expect(finalCrdtDoc.getText('markdown').toString(), 'CRDT text state was corrupted or overwritten!').toBe(remoteUpdatedContent);

        const pushedDocumentUpdates = remoteStoreMock.pushUpdate.mock.calls.filter((call: any) => call[0] === docUuid);
        expect(pushedDocumentUpdates.length, 'Node B incorrectly pushed a local change overwriting remote edits!').toBe(0);
    });
});