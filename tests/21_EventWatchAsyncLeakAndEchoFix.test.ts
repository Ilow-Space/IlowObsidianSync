import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { VaultEventWatcher } from '../src/2_Application/Sync/VaultEventWatcher';
import { LoroDoc } from 'loro-crdt';
import { TFile } from 'obsidian';

describe('Vault Event Async Leak & Echo Suppression Suite', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;
    let vaultWatcher: VaultEventWatcher;

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

        const modifyListeners: Function[] = [];

        appMock = {
            vault: {
                on: vi.fn((event: string, callback: Function) => {
                    if (event === 'modify') modifyListeners.push(callback);
                }),
                off: vi.fn(),
                getAbstractFileByPath: vi.fn((p: string) => mockVaultFiles.get(p) || null),
                getFiles: vi.fn(() => Array.from(mockVaultFiles.values()).filter(f => f instanceof TFile)),
                getAllLoadedFiles: vi.fn(() => Array.from(mockVaultFiles.values())),
                read: vi.fn().mockImplementation(async (f: any) => {
                    // Simulate asynchronous delay during vault disk reads
                    await new Promise(r => setTimeout(r, 20));
                    return f?.content || '';
                }),
                modify: vi.fn().mockImplementation(async (f: any, content: string) => {
                    if (f) {
                        f.content = content;
                        for (const cb of modifyListeners) cb(f);
                    }
                })
            },
            fileManager: {
                renameFile: vi.fn().mockImplementation(async (f: any, newPath: string) => {
                    mockVaultFiles.delete(f.path);
                    f.path = newPath;
                    mockVaultFiles.set(newPath, f);
                })
            }
        };

        const noteRepoMock = {
            readNote: vi.fn().mockImplementation(async (path: string) => mockVaultFiles.get(path)?.content || null),
            writeNote: vi.fn().mockImplementation(async (path: string, content: string) => {
                const file = mockVaultFiles.get(path);
                if (file) await appMock.vault.modify(file, content);
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

        vaultWatcher = new VaultEventWatcher(appMock, eventBus);
        vaultWatcher.initialize();

        orchestrator = new NetworkOrchestrator(
            remoteStoreMock, cryptoMock, syncEngine, noteRepoMock, vfsController, eventBus, vi.fn(), 0, diskReconciler
        );
        orchestrator.initialize();
        orchestrator.setCryptoKey({} as any);
        (orchestrator as any).isInitialized = true;

        vaultWatcher.setOrchestrator(orchestrator);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        orchestrator.stopAll();
        vaultWatcher.destroy();
        diskReconciler.destroy();
        vfsController.destroy();
        syncEngine.destroy();
        eventBus.destroy();
    });

    it('Filters out async vault event leaks during full sync and safe note writes', async () => {
        const docUuid = 'async-leak-guard-uuid';
        const initialContent = 'Base Line\n';
        const remoteContent = 'Base Line\nRemote Line\n';

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

        const remoteTextDoc = new LoroDoc();
        remoteTextDoc.import(textDoc.export({ mode: 'snapshot' }));
        const baseVer = remoteTextDoc.version();
        remoteTextDoc.getText('markdown').insert(initialContent.length, 'Remote Line\n');
        remoteTextDoc.commit();

        serverUpdatesDb['shard-index'] = [{ id: 1, documentId: 'shard-index', encryptedUpdate: { ciphertext: Buffer.from(localIndex.export({ mode: 'snapshot' })).toString('base64') } }];
        serverUpdatesDb[docUuid] = [{ id: 1, documentId: docUuid, encryptedUpdate: { ciphertext: Buffer.from(remoteTextDoc.export({ mode: 'update', from: baseVer })).toString('base64') } }];

        remoteStoreMock.pushUpdate.mockClear();

        await orchestrator.runFullSync();
        await diskReconciler.onIdle();

        // Verify zero echo pushes happened back to remote store
        const pushedDocUpdates = remoteStoreMock.pushUpdate.mock.calls.filter((c: any) => c[0] === docUuid);
        expect(pushedDocUpdates.length, 'Async read leakage caused an echo push during sync!').toBe(0);

        // Verify local disk content matches remote content
        expect(mockVaultFiles.get('Doc1.md').content).toBe(remoteContent);
    });
});