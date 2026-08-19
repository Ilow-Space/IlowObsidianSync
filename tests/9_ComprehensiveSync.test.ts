import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroDoc } from 'loro-crdt';
import { TFile, TFolder, TAbstractFile } from 'obsidian';

describe('Comprehensive Sync Suite: Outgoing & Incoming State Machine', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;

    let remoteStoreMock: any;
    let cryptoMock: any;
    let appMock: any;
    let noteRepoMock: any;

    let mockVaultFiles: Map<string, any>;
    const dummyKey = {} as CryptoKey;

    beforeEach(async () => {
        eventBus = new SyncEventBus();
        syncEngine = new LoroSyncEngine();
        await syncEngine.localStore.clearAll();

        vfsController = new LoroVfsController(syncEngine, eventBus);
        await vfsController.initialize();

        mockVaultFiles = new Map<string, any>();

        remoteStoreMock = {
            pushUpdate: vi.fn().mockResolvedValue(undefined),
            fetchSnapshotDetails: vi.fn().mockResolvedValue({ encryptedState: null, maxCompactedId: 0, isDeleted: false }),
            fetchUpdatesSince: vi.fn().mockResolvedValue([]),
            getBulkLatestUpdateIds: vi.fn().mockResolvedValue({}),
            getLatestUpdateId: vi.fn().mockResolvedValue(0)
        };

        cryptoMock = {
            encrypt: vi.fn().mockImplementation(async (data: Uint8Array) => ({ ciphertext: Buffer.from(data).toString('base64'), iv: 'mock-iv' })),
            decrypt: vi.fn().mockImplementation(async (blob: any) => new Uint8Array(Buffer.from(blob.ciphertext, 'base64')))
        };

        // Mini In-Memory Virtual File System
        appMock = {
            vault: {
                getAbstractFileByPath: vi.fn((p: string) => mockVaultFiles.get(p) || null),
                create: vi.fn().mockImplementation(async (p: string) => {
                    const f = new TFile(); f.path = p;
                    mockVaultFiles.set(p, f);
                }),
                createFolder: vi.fn().mockImplementation(async (p: string) => {
                    const d = new TFolder(); d.path = p;
                    mockVaultFiles.set(p, d);
                }),
                modify: vi.fn().mockResolvedValue(undefined),
                trash: vi.fn().mockImplementation(async (f: any) => {
                    mockVaultFiles.delete(f.path);
                }),
                read: vi.fn().mockResolvedValue(''),
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
        	readNote: vi.fn().mockResolvedValue(''),
        	writeNote: vi.fn().mockResolvedValue(undefined),
        	listAllNotes: vi.fn().mockImplementation(async () => Array.from(mockVaultFiles.keys()).filter(p => !mockVaultFiles.get(p)?.children))
        };

        diskReconciler = new ObsidianDiskReconciler(appMock, syncEngine, eventBus);
        diskReconciler.initialize();

        orchestrator = new NetworkOrchestrator(
            remoteStoreMock,
            cryptoMock,
            syncEngine,
            noteRepoMock,
            vfsController,
            eventBus,
            vi.fn(),
            0 // 0ms debounce for synchronous testing
        );
        orchestrator.initialize();
        orchestrator.setCryptoKey(dummyKey);
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

    const waitMemory = (ms = 50) => new Promise(r => setTimeout(r, ms));
    const waitForDisk = async () => {
        await (diskReconciler as any).diskQueue.onIdle();
        await waitMemory(10);
    };

    const createLocalFile = async (path: string) => {
        const f = new TFile(); f.path = path;
        mockVaultFiles.set(path, f);
        eventBus.emit('LocalFileCreated', { path, isFolder: false });
        await waitMemory();
    };

    // =====================================================================
    // GROUP 1: OUTGOING DATA (ONLINE)
    // =====================================================================
    describe('Outgoing Data Validations (Online)', () => {
        it('1. Create Online: Generates valid shard-index push', async () => {
            await createLocalFile('New.md');
            expect(remoteStoreMock.pushUpdate).toHaveBeenCalledWith('shard-index', expect.anything(), null);
        });

        it('2. Edit Online: Pushes valid CRDT delta to specific document UUID', async () => {
            await createLocalFile('Edit.md');
            const uuid = vfsController.getUuidForPath('Edit.md')!;
            remoteStoreMock.pushUpdate.mockClear();

            await (orchestrator as any).handleLocalFileModified({ path: 'Edit.md', content: 'Edits' });
            await waitMemory();
            
            expect(remoteStoreMock.pushUpdate).toHaveBeenCalledWith(uuid, expect.anything(), expect.anything());
        });

        it('3. Rename Online: Modifies tree node and pushes index update', async () => {
            await createLocalFile('Old.md');
            remoteStoreMock.pushUpdate.mockClear();

            eventBus.emit('LocalFileRenamed', { oldPath: 'Old.md', newPath: 'Renamed.md' });
            await waitMemory();

            expect(remoteStoreMock.pushUpdate).toHaveBeenCalledWith('shard-index', expect.anything(), null);
            expect(vfsController.getUuidForPath('Renamed.md')).toBeDefined();
        });

        it('4. Move Online: Modifies tree hierarchy and pushes index', async () => {
            await createLocalFile('Root.md');
            remoteStoreMock.pushUpdate.mockClear();

            eventBus.emit('LocalFileRenamed', { oldPath: 'Root.md', newPath: 'Folder/Root.md' });
            await waitMemory();

            expect(remoteStoreMock.pushUpdate).toHaveBeenCalledWith('shard-index', expect.anything(), null);
            expect(vfsController.getUuidForPath('Folder/Root.md')).toBeDefined();
        });

        it('5. Delete Online: Sets isDeleted flag and pushes index', async () => {
            await createLocalFile('Trash.md');
            remoteStoreMock.pushUpdate.mockClear();

            eventBus.emit('LocalFileDeleted', { path: 'Trash.md' });
            await waitMemory();

            expect(remoteStoreMock.pushUpdate).toHaveBeenCalledWith('shard-index', expect.anything(), null);
            expect(vfsController.getUuidForPath('Trash.md')).toBeNull();
        });
    });

    // =====================================================================
    // GROUP 2: OUTGOING DATA (OFFLINE)
    // =====================================================================
    describe('Outgoing Data Validations (Offline Queuing)', () => {
        beforeEach(() => {
            remoteStoreMock.pushUpdate.mockRejectedValue(new Error('Offline'));
        });

        it('6. Create Offline: Queues index delta in pendingRetries', async () => {
            await createLocalFile('OffCreate.md');
            expect((orchestrator as any).pendingRetries.length).toBeGreaterThan(0);
        });

        it('7. Edit Offline: Queues document delta', async () => {
            await createLocalFile('OffEdit.md');
            const uuid = vfsController.getUuidForPath('OffEdit.md')!;
            
            await (orchestrator as any).handleLocalFileModified({ path: 'OffEdit.md', content: 'Offline Edits' });
            await waitMemory();
            
            const retries = (orchestrator as any).pendingRetries;
            expect(retries.some((r: any) => r.documentId === uuid)).toBe(true);
        });

        it('8. Rename Offline: Queues index delta for rename', async () => {
            await createLocalFile('OffRename.md');
            eventBus.emit('LocalFileRenamed', { oldPath: 'OffRename.md', newPath: 'OffRenamed.md' });
            await waitMemory();
            expect((orchestrator as any).pendingRetries.length).toBeGreaterThan(0);
        });

        it('9. Move Offline: Queues index delta for cross-folder move', async () => {
            await createLocalFile('OffMove.md');
            eventBus.emit('LocalFileRenamed', { oldPath: 'OffMove.md', newPath: 'Dir/OffMove.md' });
            await waitMemory();
            expect((orchestrator as any).pendingRetries.length).toBeGreaterThan(0);
        });

        it('10. Delete Offline: Queues index delta for deletion', async () => {
            await createLocalFile('OffDel.md');
            eventBus.emit('LocalFileDeleted', { path: 'OffDel.md' });
            await waitMemory();
            expect((orchestrator as any).pendingRetries.length).toBeGreaterThan(0);
        });
    });

    // =====================================================================
    // GROUP 3: OUTGOING DATA (SUDDEN OFFLINE & BACK ONLINE)
    // =====================================================================
    describe('Outgoing Data Validations (Back Online Flush)', () => {
        let uuid: string;

        beforeEach(async () => {
            await createLocalFile('Flush.md');
            uuid = vfsController.getUuidForPath('Flush.md')!;
            remoteStoreMock.pushUpdate.mockRejectedValue(new Error('Offline'));
        });

        it('11. Back Online (Create): Flushes queued create index', async () => {
            await createLocalFile('FlushCreate.md');
            
            remoteStoreMock.pushUpdate.mockResolvedValue(undefined);
            remoteStoreMock.getBulkLatestUpdateIds.mockResolvedValueOnce({ 'shard-index': 0 });
            await orchestrator.runFullSync();
            
            expect((orchestrator as any).pendingRetries.length).toBe(0);
            expect(remoteStoreMock.pushUpdate).toHaveBeenCalledWith('shard-index', expect.anything(), null);
        });

        it('12. Back Online (Edit): Flushes queued document edits', async () => {
            await (orchestrator as any).handleLocalFileModified({ path: 'Flush.md', content: 'Queued Edit' });
            await waitMemory();
            
            remoteStoreMock.pushUpdate.mockResolvedValue(undefined);
            remoteStoreMock.getBulkLatestUpdateIds.mockResolvedValueOnce({ 'shard-index': 0, [uuid]: 0 });
            await orchestrator.runFullSync();
            
            expect((orchestrator as any).pendingRetries.length).toBe(0);
            expect(remoteStoreMock.pushUpdate).toHaveBeenCalledWith(uuid, expect.anything(), expect.anything());
        });

        it('13. Back Online (Rename): Flushes queued rename', async () => {
            eventBus.emit('LocalFileRenamed', { oldPath: 'Flush.md', newPath: 'FlushRenamed.md' });
            await waitMemory();
            
            remoteStoreMock.pushUpdate.mockResolvedValue(undefined);
            await orchestrator.runFullSync();
            expect((orchestrator as any).pendingRetries.length).toBe(0);
        });

        it('14. Back Online (Move): Flushes queued move', async () => {
            eventBus.emit('LocalFileRenamed', { oldPath: 'Flush.md', newPath: 'SubDir/Flush.md' });
            await waitMemory();
            
            remoteStoreMock.pushUpdate.mockResolvedValue(undefined);
            await orchestrator.runFullSync();
            expect((orchestrator as any).pendingRetries.length).toBe(0);
        });

        it('15. Back Online (Delete): Flushes queued deletion', async () => {
            eventBus.emit('LocalFileDeleted', { path: 'Flush.md' });
            await waitMemory();
            
            remoteStoreMock.pushUpdate.mockResolvedValue(undefined);
            await orchestrator.runFullSync();
            expect((orchestrator as any).pendingRetries.length).toBe(0);
        });
    });

    // =====================================================================
    // GROUP 4 & 5 HELPER FUNCTIONS
    // =====================================================================
    let updateCounter = 100;

    const createRemoteIndexDelta = async (actions: (tree: any) => void) => {
        const remoteDoc = new LoroDoc();
        const localDoc = await syncEngine.getOrCreateDoc('shard-index');
        remoteDoc.import(localDoc.export({ mode: 'snapshot' }));
        syncEngine.removeDoc('shard-index');
        const tree = remoteDoc.getTree('vault-tree');
        actions(tree);
        remoteDoc.commit();
        return remoteDoc.export({ mode: 'update' });
    };

    const pushMockRemoteUpdate = (docId: string, delta: Uint8Array) => {
        const updateId = ++updateCounter;
        remoteStoreMock.getLatestUpdateId.mockResolvedValue(updateId);
        remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([{
            id: updateId, documentId: docId, encryptedUpdate: { ciphertext: Buffer.from(delta).toString('base64') }
        }]);
    };

    // =====================================================================
    // GROUP 4: INCOMING DATA (MIRRORING BASIC ACTIONS)
    // =====================================================================
    describe('Incoming Data (Mirroring Basic Actions)', () => {

        it('16. Remote Create: Reconciler creates file locally', async () => {
            const remoteUuid = 'remote-123';
            const delta = await createRemoteIndexDelta(tree => {
                const node = tree.createNode();
                node.data.set('uuid', remoteUuid);
                node.data.set('filename', 'RemoteNew.md');
                node.data.set('type', 'file');
                node.data.set('isDeleted', false);
            });

            pushMockRemoteUpdate('shard-index', delta);
            await orchestrator.pullDocument('shard-index');
            (vfsController as any).rebuildCacheAndEmitRemoteDiffs(); 
            await waitForDisk();

            expect(appMock.vault.create).toHaveBeenCalledWith('RemoteNew.md', '');
        });

        it('17. Remote Edit: Reconciler modifies file locally', async () => {
            await createLocalFile('RemoteEdit.md');
            const uuid = vfsController.getUuidForPath('RemoteEdit.md')!;

            const remoteDoc = new LoroDoc();
            remoteDoc.getText('markdown').insert(0, 'Remote Edits Applied!');
            remoteDoc.commit();
            pushMockRemoteUpdate(uuid, remoteDoc.export({ mode: 'update' }));

            await orchestrator.pullDocument(uuid, 'RemoteEdit.md');
            await waitForDisk();

            expect(appMock.vault.modify).toHaveBeenCalledWith(expect.any(TFile), 'Remote Edits Applied!');
        });

        it('18. Remote Rename: Reconciler renames file locally', async () => {
            await createLocalFile('BeforeRename.md');
            const uuid = vfsController.getUuidForPath('BeforeRename.md')!;

            const delta = await createRemoteIndexDelta(tree => {
                const node = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (node) {
                    node.data.set('filename', 'AfterRename.md');
                }
            });

            pushMockRemoteUpdate('shard-index', delta);
            await orchestrator.pullDocument('shard-index');
            (vfsController as any).rebuildCacheAndEmitRemoteDiffs();
            await waitForDisk();

            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFile), 'AfterRename.md');
        });

        it('19. Remote Move: Reconciler moves file locally across folders', async () => {
            await createLocalFile('Root.md');
            const uuid = vfsController.getUuidForPath('Root.md')!;

            const delta = await createRemoteIndexDelta(tree => {
                const fNode = tree.createNode();
                fNode.data.set('uuid', 'folder-uuid');
                fNode.data.set('filename', 'Dest');
                fNode.data.set('type', 'folder');

                const nNode = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (nNode) {
                    tree.move(nNode.id, fNode.id);
                }
            });

            pushMockRemoteUpdate('shard-index', delta);
            await orchestrator.pullDocument('shard-index');
            (vfsController as any).rebuildCacheAndEmitRemoteDiffs();
            await waitForDisk();

            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFile), 'Dest/Root.md');
        });

        it('20. Remote Delete: Reconciler trashes file locally', async () => {
            await createLocalFile('KillMe.md');
            const uuid = vfsController.getUuidForPath('KillMe.md')!;

            const delta = await createRemoteIndexDelta(tree => {
                const node = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (node) {
                    node.data.set('isDeleted', true);
                    tree.delete(node.id);
                }
            });

            pushMockRemoteUpdate('shard-index', delta);
            await orchestrator.pullDocument('shard-index');
            (vfsController as any).rebuildCacheAndEmitRemoteDiffs();
            await waitForDisk();

            expect(appMock.vault.trash).toHaveBeenCalledWith(expect.any(TFile), true);
        });
    });

    // =====================================================================
    // GROUP 5: INCOMING DATA (COMPLEX COMPOUND ACTIONS)
    // =====================================================================
    describe('Incoming Data (Complex Compound Mirroring)', () => {
        const pushRemoteIndex = async (actions: (tree: any) => void) => {
            const delta = await createRemoteIndexDelta(actions);
            pushMockRemoteUpdate('shard-index', delta);
            await orchestrator.pullDocument('shard-index');
            (vfsController as any).rebuildCacheAndEmitRemoteDiffs();
            await waitForDisk();
        };

        const pushRemoteDocEdit = async (uuid: string, path: string, content: string) => {
            const remoteDoc = new LoroDoc();
            remoteDoc.getText('markdown').insert(0, content);
            remoteDoc.commit();
            pushMockRemoteUpdate(uuid, remoteDoc.export({ mode: 'update' }));
            await orchestrator.pullDocument(uuid, path);
            await waitForDisk();
        };

        it('21. Remote Rename & Move: Reconciler resolves absolute path change', async () => {
            await createLocalFile('A.md');
            const uuid = vfsController.getUuidForPath('A.md')!;

            await pushRemoteIndex(tree => {
                const folder = tree.createNode();
                folder.data.set('uuid', 'folder-b');
                folder.data.set('filename', 'FolderB');
                folder.data.set('type', 'folder');

                const file = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (file) {
                    tree.move(file.id, folder.id);
                    file.data.set('filename', 'RenamedA.md');
                }
            });

            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFile), 'FolderB/RenamedA.md');
        });

        it('22. Remote Rename & Edit: Applies rename then writes content to new path', async () => {
            await createLocalFile('Name1.md');
            const uuid = vfsController.getUuidForPath('Name1.md')!;

            await pushRemoteIndex(tree => {
                const file = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (file) {
                    file.data.set('filename', 'Name2.md');
                }
            });
            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFile), 'Name2.md');

            await pushRemoteDocEdit(uuid, 'Name2.md', 'Edited after rename');
            expect(appMock.vault.modify).toHaveBeenCalledWith(expect.any(TFile), 'Edited after rename');
        });

        it('23. Remote Move & Edit: Applies move then writes content to new folder', async () => {
            await createLocalFile('RootMove.md');
            const uuid = vfsController.getUuidForPath('RootMove.md')!;

            await pushRemoteIndex(tree => {
                const folder = tree.createNode();
                folder.data.set('uuid', 'f-uuid');
                folder.data.set('filename', 'TargetFolder');
                folder.data.set('type', 'folder');

                const file = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (file) {
                    tree.move(file.id, folder.id);
                }
            });
            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFile), 'TargetFolder/RootMove.md');

            await pushRemoteDocEdit(uuid, 'TargetFolder/RootMove.md', 'Data inside moved folder');
            expect(appMock.vault.modify).toHaveBeenCalledWith(expect.any(TFile), 'Data inside moved folder');
        });

        it('24. Remote Create & Edit: Creates file and instantly applies text', async () => {
            const uuid = 'remote-create-edit-uuid';
            
            await pushRemoteIndex(tree => {
                const file = tree.createNode();
                file.data.set('uuid', uuid);
                file.data.set('filename', 'InstaEdit.md');
                file.data.set('type', 'file');
            });
            expect(appMock.vault.create).toHaveBeenCalledWith('InstaEdit.md', '');

            await pushRemoteDocEdit(uuid, 'InstaEdit.md', 'Immediate Text');
            expect(appMock.vault.modify).toHaveBeenCalledWith(expect.any(TFile), 'Immediate Text');
        });

        it('25. Remote Create, Rename, Move, Edit, Delete (Full Lifecycle Verification)', async () => {
            const uuid = 'lifecycle-uuid';

            // Create
            await pushRemoteIndex(tree => {
                const file = tree.createNode();
                file.data.set('uuid', uuid);
                file.data.set('filename', 'Life1.md');
                file.data.set('type', 'file');
                file.data.set('isDeleted', false);
            });
            expect(appMock.vault.create).toHaveBeenCalledWith('Life1.md', '');

            // Rename & Move
            await pushRemoteIndex(tree => {
                const folder = tree.createNode();
                folder.data.set('uuid', 'f-life');
                folder.data.set('filename', 'LifeDir');
                folder.data.set('type', 'folder');

                const file = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (file) {
                    tree.move(file.id, folder.id);
                    file.data.set('filename', 'Life2.md');
                }
            });
            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFile), 'LifeDir/Life2.md');

            // Edit
            await pushRemoteDocEdit(uuid, 'LifeDir/Life2.md', 'Final Words');
            expect(appMock.vault.modify).toHaveBeenCalledWith(expect.any(TFile), 'Final Words');

            // Delete
            await pushRemoteIndex(tree => {
                const file = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (file) {
                    file.data.set('isDeleted', true);
                    tree.delete(file.id);
                }
            });
            expect(appMock.vault.trash).toHaveBeenCalledWith(expect.any(TFile), true);
        });
    });

    // =====================================================================
    // GROUP 6: EXTRA EDGE CASES
    // =====================================================================
    describe('Edge Cases (Sudden Network Drops & Extreme Collisions)', () => {
        it('26. Sudden offline during edit push enqueues safely', async () => {
            await createLocalFile('SuddenOff.md');
            
            remoteStoreMock.pushUpdate.mockRejectedValueOnce(new Error('Network Dropped'));
            
            await (orchestrator as any).handleLocalFileModified({ path: 'SuddenOff.md', content: 'Attempt 1' });
            await waitMemory();
            
            expect((orchestrator as any).pendingRetries.length).toBe(1);
        });

        it('27. Remote Move & Delete sequence does not crash Reconciler', async () => {
            await createLocalFile('MoveDel.md');
            const uuid = vfsController.getUuidForPath('MoveDel.md')!;

            const delta = await createRemoteIndexDelta(tree => {
                const file = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (file) {
                    file.data.set('filename', 'MovedAndDeleted.md');
                    file.data.set('isDeleted', true);
                    tree.delete(file.id);
                }
            });

            pushMockRemoteUpdate('shard-index', delta);
            await orchestrator.pullDocument('shard-index');
            (vfsController as any).rebuildCacheAndEmitRemoteDiffs();
            await waitForDisk();

            expect(appMock.fileManager.renameFile).not.toHaveBeenCalled();
            expect(appMock.vault.trash).toHaveBeenCalledWith(expect.any(TFile), true);
        });

        it('28. Offline Create + Back Online Pull Conflict applies safely', async () => {
            remoteStoreMock.pushUpdate.mockRejectedValue(new Error('Offline'));
            await createLocalFile('Conflict.md'); // Exists locally
                
            remoteStoreMock.pushUpdate.mockResolvedValue(undefined);
            const remoteDoc = new LoroDoc();
            const tree = remoteDoc.getTree('vault-tree');
            const file = tree.createNode();
            file.data.set('uuid', 'remote-conflict-uuid');
            file.data.set('filename', 'Conflict.md');
            file.data.set('type', 'file');
            remoteDoc.commit();
                
            remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([{
                id: 1, documentId: 'shard-index', encryptedUpdate: { ciphertext: Buffer.from(remoteDoc.export({ mode: 'update' })).toString('base64') }
            }]);
            
            await orchestrator.pullDocument('shard-index');
            (vfsController as any).rebuildCacheAndEmitRemoteDiffs();
            await waitForDisk();
        
            // The reconciler creates a conflict copy to preserve both distinct offline creations
            expect(appMock.vault.create).toHaveBeenCalledWith('Conflict (Conflict 1).md', '');
        });
        it('29. Remote Rename & Edit on same file avoids race conditions', async () => {
            await createLocalFile('Race.md');
            const uuid = vfsController.getUuidForPath('Race.md')!;

            const delta = await createRemoteIndexDelta(tree => {
                const file = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (file) {
                    file.data.set('filename', 'RaceDone.md');
                }
            });

            pushMockRemoteUpdate('shard-index', delta);
            await orchestrator.pullDocument('shard-index');
            (vfsController as any).rebuildCacheAndEmitRemoteDiffs();
            await waitForDisk();

            const docEdit = new LoroDoc();
            docEdit.getText('markdown').insert(0, 'Race Content');
            docEdit.commit();
            pushMockRemoteUpdate(uuid, docEdit.export({ mode: 'update' }));
            
            await orchestrator.pullDocument(uuid, 'RaceDone.md');
            await waitForDisk();

            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFile), 'RaceDone.md');
            expect(appMock.vault.modify).toHaveBeenCalledWith(expect.any(TFile), 'Race Content');
        });

        it('30. Final Verification: processRemoteVfsUpdates properly forces sync evaluation', () => {
            const rebuildSpy = vi.spyOn(vfsController, 'rebuildCache');
            const emitSpy = vi.spyOn(vfsController as any, 'rebuildCacheAndEmitRemoteDiffs');
            const commitSpy = vi.spyOn(vfsController['treeDoc'], 'commit');

            (vfsController as any).processRemoteVfsUpdates();

            expect(commitSpy).toHaveBeenCalled();
            expect(emitSpy).toHaveBeenCalled();
            expect(rebuildSpy).toHaveBeenCalled();
        });

        it('31. Offline Peer Return: Remote file move while offline propagates upon full sync', async () => {
            await createLocalFile('Projects/Active.md');
            const uuid = vfsController.getUuidForPath('Projects/Active.md')!;

            const delta = await createRemoteIndexDelta(tree => {
                const targetFolder = tree.createNode();
                targetFolder.data.set('uuid', 'archive-folder');
                targetFolder.data.set('filename', 'Archive');
                targetFolder.data.set('type', 'folder');

                const file = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (file) {
                    tree.move(file.id, targetFolder.id);
                }
            });

            pushMockRemoteUpdate('shard-index', delta);
            remoteStoreMock.getBulkLatestUpdateIds.mockResolvedValueOnce({ 'shard-index': 200 });

            await orchestrator.runFullSync();
            await waitForDisk();

            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFile), 'Archive/Active.md');
            expect(vfsController.getUuidForPath('Archive/Active.md')).toBe(uuid);
        });
    });
});