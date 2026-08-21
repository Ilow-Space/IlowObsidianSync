import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroDoc } from 'loro-crdt';
import { TFile } from 'obsidian';

describe('Obsidian Vault Cache Lag Overwrite Bug', () => {
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
    let simulateCacheLag = false;

    beforeEach(async () => {
        eventBus = new SyncEventBus();
        syncEngine = new LoroSyncEngine();
        await syncEngine.localStore.clearAll();

        vfsController = new LoroVfsController(syncEngine, eventBus);
        await vfsController.initialize();

        mockVaultFiles.clear();
        serverUpdatesDb = {};
        updateCounter = 0;
        simulateCacheLag = false;

        appMock = {
            vault: {
                on: vi.fn(), off: vi.fn(),
                getAbstractFileByPath: vi.fn((p: string) => {
                    // Simulate Obsidian vault cache lag for newly moved paths
                    if (simulateCacheLag && p.includes('FastRenameFolderRenamed')) {
                        return null;
                    }
                    return mockVaultFiles.get(p) || null;
                }),
                getFiles: vi.fn(() => Array.from(mockVaultFiles.values()).filter(f => f instanceof TFile)),
                getAllLoadedFiles: vi.fn(() => Array.from(mockVaultFiles.values())),
                read: vi.fn().mockImplementation(async (f: any) => f?.content || ''),
                modify: vi.fn().mockImplementation(async (f: any, content: string) => { if (f) f.content = content; })
            },
            fileManager: {
                renameFile: vi.fn().mockImplementation(async (f: any, newPath: string) => {
                    mockVaultFiles.delete(f.path);
                    f.path = newPath;
                    mockVaultFiles.set(newPath, f);
                    // Enable cache lag simulation immediately after rename
                    simulateCacheLag = true;
                    setTimeout(() => { simulateCacheLag = false; }, 50);
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

    it('FAILS: Dropped text updates during vault cache lag cause local offline ingestion to overwrite remote edits', async () => {
        const docUuid = 'doc-cache-lag-uuid';
        const initialContent = 'Base Content\n';
        const remoteUpdatedContent = 'Base Content\nRemote Line Added\n';

        // 1. Initial State: File at "Doc1.md"
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

        // 2. Server Update: Move "Doc1.md" -> "FastRenameFolderRenamed/Doc1.md" AND edit text
        const remoteIndexDoc = new LoroDoc();
        remoteIndexDoc.import(localIndex.export({ mode: 'snapshot' }));
        const remoteTree = remoteIndexDoc.getTree('vault-tree');
        const folderNode = remoteTree.createNode();
        folderNode.data.set('uuid', 'folder-uuid');
        folderNode.data.set('filename', 'FastRenameFolderRenamed');
        folderNode.data.set('type', 'folder');

        const remoteFileNode = remoteTree.getNodes().find((n: any) => n.data.get('uuid') === docUuid);
        if (remoteFileNode) remoteTree.move(remoteFileNode.id, folderNode.id);
        remoteIndexDoc.commit();

        const remoteTextDoc = new LoroDoc();
        remoteTextDoc.import(textDoc.export({ mode: 'snapshot' }));
        const baseVer = remoteTextDoc.version();
        remoteTextDoc.getText('markdown').insert(initialContent.length, 'Remote Line Added\n');
        remoteTextDoc.commit();

        pushServerUpdate('shard-index', remoteIndexDoc.export({ mode: 'update', from: localIndex.version() }));
        pushServerUpdate(docUuid, remoteTextDoc.export({ mode: 'update', from: baseVer }));

        remoteStoreMock.pushUpdate.mockClear();

        // 3. Run Sync
        await orchestrator.runFullSync();
        await diskReconciler.onIdle();

        // 4. Assertions
        const movedFile = mockVaultFiles.get('FastRenameFolderRenamed/Doc1.md');
        expect(movedFile, 'Moved file does not exist on disk!').toBeDefined();
        expect(movedFile.content, 'Remote edit was dropped during vault cache lag and overwritten!').toBe(remoteUpdatedContent);

        const pushedDocumentUpdates = remoteStoreMock.pushUpdate.mock.calls.filter((call: any) => call[0] === docUuid);
        expect(pushedDocumentUpdates.length, 'Unwanted local push triggered!').toBe(0);
    });
});