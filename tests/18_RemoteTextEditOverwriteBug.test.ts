import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroDoc } from 'loro-crdt';
import { TFile } from 'obsidian';

describe('Remote Text Edit Overwrite Bug Reproduction', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;

    let appMock: any;
    let remoteStoreMock: any;
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
                getFiles: vi.fn(() => Array.from(mockVaultFiles.values()).filter(f => f instanceof TFile)),
                getAllLoadedFiles: vi.fn(() => Array.from(mockVaultFiles.values())),
                read: vi.fn().mockImplementation(async (f: any) => f?.content || ''),
                modify: vi.fn().mockImplementation(async (f: any, content: string) => { if (f) f.content = content; })
            },
            fileManager: {
                renameFile: vi.fn().mockImplementation(async (f: any, newPath: string) => {
                    mockVaultFiles.delete(f.path); f.path = newPath; mockVaultFiles.set(newPath, f);
                })
            }
        };

        noteRepoMock = {
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

    it('FAILS: Remote text modifications are overwritten by pre-existing disk content during catch-up', async () => {
        const docUuid = 'doc-overwrite-test-uuid';
        const originalDiskContent = 'Title: Old Note\nAuthor: Local User\nBody: Unchanged local text.';
        const remoteModifiedContent = 'Title: Modified Note\nAuthor: Remote Node A\nBody: Completely replaced remote text.';

        // 1. Setup local disk with pre-existing note content
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
        (file as any).content = originalDiskContent;
        mockVaultFiles.set('Doc1.md', file);

        // 2. Remote Node A updates docUuid text to remoteModifiedContent
        const remoteTextDoc = new LoroDoc();
        remoteTextDoc.getText('markdown').insert(0, remoteModifiedContent);
        remoteTextDoc.commit();

        pushServerUpdate('shard-index', localIndex.export({ mode: 'snapshot' }));
        pushServerUpdate(docUuid, remoteTextDoc.export({ mode: 'snapshot' }));

        remoteStoreMock.pushUpdate.mockClear();

        // 3. Node B runs full sync
        await orchestrator.runFullSync();
        await diskReconciler.onIdle();

        // 4. Assertions
        const pushedUpdates = remoteStoreMock.pushUpdate.mock.calls.filter((call: any) => call[0] === docUuid);
        
        // THIS EXPECTATION WILL FAIL ON CURRENT CODE!
        expect(pushedUpdates.length, 'Node B mistakenly pushed local disk content to server, overwriting remote edits!').toBe(0);

        const finalDiskFile = mockVaultFiles.get('Doc1.md');
        expect(finalDiskFile.content, 'Local disk content was not updated to reflect remote edits!').toBe(remoteModifiedContent);
    });
});