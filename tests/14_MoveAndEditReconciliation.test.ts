import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroDoc } from 'loro-crdt';
import { TFile, TFolder } from 'obsidian';

describe('Move and Edit Reconciliation Bug', () => {
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

    it('Preserves remote edits when a moved file is ingested during catch-up', async () => {
        const docUuid = 'doc-active-uuid';
        const initialContent = 'Base Content\n';
        const remoteAppendedContent = 'Base Content\nNode A Remote Edit\n';

        // 1. Initial State: File exists on both Node A and Node B
        const localIndex = await syncEngine.getOrCreateDoc('shard-index');
        const tree = localIndex.getTree('vault-tree');
        const projectsFolder = tree.createNode();
        projectsFolder.data.set('uuid', 'folder-projects');
        projectsFolder.data.set('filename', 'Projects');
        projectsFolder.data.set('type', 'folder');

        const fileNode = tree.createNode();
        fileNode.data.set('uuid', docUuid);
        fileNode.data.set('filename', 'Active.md');
        fileNode.data.set('type', 'file');
        tree.move(fileNode.id, projectsFolder.id);
        localIndex.commit();

        vfsController.rebuildCache();

        const file = new TFile(); 
        (file as any).path = 'Projects/Active.md';
        (file as any).content = initialContent;
        mockVaultFiles.set('Projects/Active.md', file);

        // Populate initial CRDT text doc locally
        const textDoc = await syncEngine.getOrCreateDoc(docUuid);
        textDoc.getText('markdown').insert(0, initialContent);
        textDoc.commit();

        // 2. Node B goes offline (simulate remote updates accumulating on server)
        const remoteIndexDoc = new LoroDoc();
        remoteIndexDoc.import(localIndex.export({ mode: 'snapshot' }));
        const remoteTree = remoteIndexDoc.getTree('vault-tree');

        const archiveFolder = remoteTree.createNode();
        archiveFolder.data.set('uuid', 'folder-archive');
        archiveFolder.data.set('filename', 'Archive');
        archiveFolder.data.set('type', 'folder');

        const remoteFileNode = remoteTree.getNodes().find((n: any) => n.data.get('uuid') === docUuid);
        if (remoteFileNode) {
            remoteTree.move(remoteFileNode.id, archiveFolder.id);
        }
        remoteIndexDoc.commit();

        // Fork remote text doc from initial text doc baseline
        const remoteTextDoc = new LoroDoc();
        remoteTextDoc.import(textDoc.export({ mode: 'snapshot' }));
        const initialVer = remoteTextDoc.version();
        remoteTextDoc.getText('markdown').insert(initialContent.length, 'Node A Remote Edit\n');
        remoteTextDoc.commit();

        pushServerUpdate('shard-index', remoteIndexDoc.export({ mode: 'update', from: localIndex.version() }));
        pushServerUpdate(docUuid, remoteTextDoc.export({ mode: 'update', from: initialVer }));

        // Reset push call counts before Node B syncs
        remoteStoreMock.pushUpdate.mockClear();

        // 3. Node B comes back online and runs full sync
        await orchestrator.runFullSync();
        await (diskReconciler as any).diskQueue.onIdle();
        await waitMemory(100);

        // 4. Verify CRDT content was NOT reverted back to initialContent
        const finalCrdtDoc = await syncEngine.getOrCreateDoc(docUuid);
        const finalCrdtText = finalCrdtDoc.getText('markdown').toString();

        expect(finalCrdtText, 'Remote text edit was overwritten by the stale local file!').toBe(remoteAppendedContent);

        // 5. Verify Node B did not push an update reverting the content
        const pushedDocUpdates = remoteStoreMock.pushUpdate.mock.calls.filter((c: any) => c[0] === docUuid);
        expect(pushedDocUpdates.length, 'Node B pushed an unwanted overwrite back to the server!').toBe(0);
    });
});