import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { ObsidianNoteRepository } from '../src/3_Infrastructure/Obsidian/ObsidianNoteRepository';
import { LoroDoc } from 'loro-crdt';
import { TFile, TFolder } from 'obsidian';

describe('Bug Reproduction: Offline Moves, Crashes & Duplications', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;

    let appMock: any;
    let remoteStoreMock: any;
    let noteRepoMock: any;

    let updateCounter = 100;
    let mockVaultFiles = new Map<string, any>();

    const waitMemory = (ms = 50) => new Promise(r => setTimeout(r, ms));
    
    const waitForDisk = async () => {
        await (diskReconciler as any).diskQueue.onIdle();
        await waitMemory(10);
    };

    const createLocalFile = async (path: string) => {
        const f = new TFile(); 
        (f as any).path = path;
        mockVaultFiles.set(path, f);
        
        // Update the mock to use our local map so the Reconciler can find the file
        appMock.vault.getAbstractFileByPath.mockImplementation((p: string) => mockVaultFiles.get(p) || null);
        
        eventBus.emit('LocalFileCreated', { path, isFolder: false });
        await waitMemory();
    };

    const pushMockRemoteUpdate = (docId: string, delta: Uint8Array) => {
        const updateId = ++updateCounter;
        remoteStoreMock.getLatestUpdateId.mockResolvedValue(updateId);
        remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([{
            id: updateId, 
            documentId: docId, 
            encryptedUpdate: { ciphertext: Buffer.from(delta).toString('base64') }
        }]);
    };

    beforeEach(async () => {
        eventBus = new SyncEventBus();
        syncEngine = new LoroSyncEngine();
        await syncEngine.localStore.clearAll();

        vfsController = new LoroVfsController(syncEngine, eventBus);
        await vfsController.initialize();

        appMock = {
            vault: {
                on: vi.fn(),
                getAbstractFileByPath: vi.fn(),
                create: vi.fn().mockResolvedValue(undefined),
                modify: vi.fn().mockResolvedValue(undefined),
                trash: vi.fn().mockResolvedValue(undefined),
                read: vi.fn().mockResolvedValue('Mock Content')
            },
            fileManager: {
                renameFile: vi.fn().mockResolvedValue(undefined)
            }
        };

        remoteStoreMock = {
            getBulkLatestUpdateIds: vi.fn().mockResolvedValue({}),
            getLatestUpdateId: vi.fn().mockResolvedValue(0),
            fetchSnapshotDetails: vi.fn().mockResolvedValue({ encryptedState: null, maxCompactedId: 0, isDeleted: false }),
            fetchUpdatesSince: vi.fn().mockResolvedValue([]),
            pushUpdate: vi.fn().mockResolvedValue(undefined)
        };

        noteRepoMock = {
            readNote: vi.fn().mockResolvedValue('Mock Content'),
            writeNote: vi.fn().mockResolvedValue(undefined),
            listAllNotes: vi.fn().mockResolvedValue([])
        };

        diskReconciler = new ObsidianDiskReconciler(appMock, syncEngine, eventBus);
        diskReconciler.initialize();

        orchestrator = new NetworkOrchestrator(
            remoteStoreMock,
            { encrypt: vi.fn(), decrypt: vi.fn() } as any, // Mock crypto
            syncEngine,
            noteRepoMock,
            vfsController,
            eventBus,
            vi.fn(),
            0
        );
        orchestrator.initialize();
        orchestrator.setCryptoKey({} as any); // Unlock orchestrator
    });

    afterEach(() => {
        vi.restoreAllMocks();
        orchestrator.stopAll();
        diskReconciler.destroy();
        vfsController.destroy();
        syncEngine.destroy();
        eventBus.destroy();
    });

    it('TEST 1: Successfully rehydrates a moved file when the local source is missing (Fixes Deadlock & Crash)', async () => {
        // 1. Simulate source file missing from local disk
        appMock.vault.getAbstractFileByPath.mockReturnValue(null);

        const moveExecution = new Promise((resolve, reject) => {
            (diskReconciler as any).diskQueue.on('error', reject);
            (diskReconciler as any).diskQueue.on('idle', resolve);
        });

        // 2. Emit the remote move
        eventBus.emit('CrdtNodeMoved', {
            uuid: 'missing-doc-uuid',
            oldPath: 'GhostFile.md',
            newPath: 'Folder/GhostFile.md'
        });

        // 3. Wait for the disk queue to finish WITHOUT timing out or crashing
        await moveExecution;

        // 4. Verify it was safely created at the new path
        expect(appMock.vault.create).toHaveBeenCalledWith('Folder/GhostFile.md', '');
    });
    it('TEST 2: Exposes CRDT Duplication caused by runFullSync ingestion order', async () => {
        // 1. Simulate Storage B's local disk containing the original file.
        noteRepoMock.listAllNotes.mockResolvedValue(['test.md']);
        appMock.vault.getAbstractFileByPath.mockImplementation((p: string) => p === 'test.md' ? new TFile() : null);

        // 2. Simulate the remote server having the file moved to 'Popa/test.md'.
        // We generate a valid remote CRDT update binary to inject into the mock.
        const remoteDoc = new LoroDoc();
        const localDoc = await syncEngine.getOrCreateDoc('shard-index');
        remoteDoc.import(localDoc.export({ mode: 'snapshot' }));
        
        const originalUuid = 'original-synced-uuid';
        const tree = remoteDoc.getTree('vault-tree');
        
        // Setup original file
        const fileNode = tree.createNode();
        fileNode.data.set('uuid', originalUuid);
        fileNode.data.set('filename', 'test.md');
        fileNode.data.set('type', 'file');

        // Setup folder and move the file into it
        const folderNode = tree.createNode();
        folderNode.data.set('uuid', 'folder-popa-uuid');
        folderNode.data.set('filename', 'Popa');
        folderNode.data.set('type', 'folder');
        tree.move(fileNode.id, folderNode.id);
        
        remoteDoc.commit();
        const remoteDelta = remoteDoc.export({ mode: 'update' });

        // 3. Inject the remote move into the network mock
        remoteStoreMock.getBulkLatestUpdateIds.mockResolvedValue({ 'shard-index': 100 });
        remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([{
            id: 100, 
            documentId: 'shard-index', 
            encryptedUpdate: { ciphertext: Buffer.from(remoteDelta).toString('base64') }
        }]);

        // 4. Trigger the sync process
        await orchestrator.runFullSync();
        
        // Wait for asynchronous disk/VFS operations to settle
        await (diskReconciler as any).diskQueue.onIdle();

        // 5. Audit the tracked files inside the VFS Controller (Mirroring your exact console.log)
        const trackedFiles = vfsController.getActiveFiles().filter(f => f.type === 'file');
        const testMdNodes = trackedFiles.filter(f => f.path.includes('test.md'));

        // EXPECTATION: The unpatched runFullSync ingests the local disk FIRST. It sees 'test.md', 
        // doesn't recognize it, and creates a NEW CRDT node for it. Then it pulls the remote index, 
        // discovering the original UUID at 'Popa/test.md'. 
        // The test expects 1 node, but the buggy code will have 2.
        expect(testMdNodes.length, 'Phantom duplicates detected in the CRDT Index!').toBe(1);
        
        // EXPECTATION: The single remaining node MUST be at the new folder path.
        expect(testMdNodes[0].path).toBe('Popa/test.md');
    });
    it('TEST 3: Exposes CRDT Duplication on Remote Directory Rename', async () => {
        // 1. Simulate local disk having a file inside an old directory structure
        noteRepoMock.listAllNotes.mockResolvedValue(['OldDir/test.md']);
        appMock.vault.getAbstractFileByPath.mockImplementation((p: string) => p === 'OldDir/test.md' ? new TFile() : null);

        // 2. Simulate the remote server renaming 'OldDir' to 'NewDir'
        const remoteDoc = new LoroDoc();
        const localDoc = await syncEngine.getOrCreateDoc('shard-index');
        remoteDoc.import(localDoc.export({ mode: 'snapshot' }));
        const tree = remoteDoc.getTree('vault-tree');
        
        const fileNode = tree.createNode();
        fileNode.data.set('uuid', 'child-file-uuid');
        fileNode.data.set('filename', 'test.md');
        fileNode.data.set('type', 'file');

        const folderNode = tree.createNode();
        folderNode.data.set('uuid', 'parent-folder-uuid');
        folderNode.data.set('filename', 'NewDir'); // The remote renamed folder
        folderNode.data.set('type', 'folder');
        tree.move(fileNode.id, folderNode.id);
        
        remoteDoc.commit();
        const remoteDelta = remoteDoc.export({ mode: 'update' });

        // 3. Inject the remote update
        remoteStoreMock.getBulkLatestUpdateIds.mockResolvedValue({ 'shard-index': 101 });
        remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([{
            id: 101, 
            documentId: 'shard-index', 
            encryptedUpdate: { ciphertext: Buffer.from(remoteDelta).toString('base64') }
        }]);

        // 4. Trigger sync
        await orchestrator.runFullSync();
        await (diskReconciler as any).diskQueue.onIdle();

        // EXPECTATION: The unpatched code sweeps 'OldDir/test.md', generates a NEW CRDT node for it,
        // and then pulls the remote index containing 'NewDir/test.md'.
        // This expects 1 node, but the buggy code will have 2.
        const trackedFiles = vfsController.getActiveFiles().filter(f => f.type === 'file');
        expect(trackedFiles.length, 'Phantom duplicates detected on directory rename!').toBe(1);
        expect(trackedFiles[0].path).toBe('NewDir/test.md');
    });

    it('TEST 4: Exposes Ghost Resurrection on Remote File Deletion', async () => {
        // 1. Simulate local disk having a file that was deleted remotely while offline
        noteRepoMock.listAllNotes.mockResolvedValue(['doomed.md']);
        appMock.vault.getAbstractFileByPath.mockImplementation((p: string) => p === 'doomed.md' ? new TFile() : null);

        // 2. Simulate the remote index marking the file as deleted
        const remoteDoc = new LoroDoc();
        const localDoc = await syncEngine.getOrCreateDoc('shard-index');
        remoteDoc.import(localDoc.export({ mode: 'snapshot' }));
        const tree = remoteDoc.getTree('vault-tree');
        
        const fileNode = tree.createNode();
        fileNode.data.set('uuid', 'doomed-uuid');
        fileNode.data.set('filename', 'doomed.md');
        fileNode.data.set('type', 'file');
        fileNode.data.set('isDeleted', true); // Deleted remotely
        
        remoteDoc.commit();
        const remoteDelta = remoteDoc.export({ mode: 'update' });

        // 3. Inject the remote update
        remoteStoreMock.getBulkLatestUpdateIds.mockResolvedValue({ 'shard-index': 102 });
        remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([{
            id: 102, 
            documentId: 'shard-index', 
            encryptedUpdate: { ciphertext: Buffer.from(remoteDelta).toString('base64') }
        }]);

        // 4. Trigger sync
        await orchestrator.runFullSync();
        await (diskReconciler as any).diskQueue.onIdle();

        // EXPECTATION: The unpatched code sweeps 'doomed.md' first. Because it hasn't pulled the remote 
        // index yet, it thinks this is a brand new file created offline and pushes a NEW creation node 
        // to the server, effectively resurrecting the deleted file.
        const trackedFiles = vfsController.getActiveFiles().filter(f => f.type === 'file');
        expect(trackedFiles.length, 'Deleted file was resurrected by the local offline scan!').toBe(0);
    });

    it('TEST 5: Validates Text Content Merging on Conflicting Offline vs Remote Edits', async () => {
        // 1. Setup the CRDT base state so the file is known locally
        const localDoc = await syncEngine.getOrCreateDoc('shard-index');
        const tree = localDoc.getTree('vault-tree');
        const fileNode = tree.createNode();
        fileNode.data.set('uuid', 'edit-uuid');
        fileNode.data.set('filename', 'edit.md');
        fileNode.data.set('type', 'file');
        localDoc.commit();
        vfsController.rebuildCache();

        // 2. Simulate local offline edit
        noteRepoMock.listAllNotes.mockResolvedValue(['edit.md']);
        appMock.vault.getAbstractFileByPath.mockImplementation((p: string) => p === 'edit.md' ? new TFile() : null);
        noteRepoMock.readNote.mockResolvedValue('Local Offline Edit\n');

        // 3. Simulate remote edit occurring simultaneously
        const remoteTextDoc = new LoroDoc();
        remoteTextDoc.getText('markdown').insert(0, 'Remote Edit\n');
        remoteTextDoc.commit();
        const textDelta = remoteTextDoc.export({ mode: 'update' });

        remoteStoreMock.getBulkLatestUpdateIds.mockResolvedValue({ 'shard-index': 0, 'edit-uuid': 103 });
        remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([{
            id: 103, 
            documentId: 'edit-uuid', 
            encryptedUpdate: { ciphertext: Buffer.from(textDelta).toString('base64') }
        }]);

        // 4. Trigger sync
        await orchestrator.runFullSync();
        await (diskReconciler as any).diskQueue.onIdle();

        // EXPECTATION: Text should merge gracefully without crashing or duplicating the file node.
        const mergedDoc = await syncEngine.getOrCreateDoc('edit-uuid');
        const finalContent = mergedDoc.getText('markdown').toString();
        
        expect(finalContent).toContain('Local Offline Edit');
        expect(finalContent).toContain('Remote Edit');
    });

it('TEST 6: Exposes massive performance leak in ObsidianNoteRepository (Vestigial listener)', async () => {
        // 1. Spy on the vault read method to track redundant I/O calls
        const vaultReadSpy = vi.spyOn(appMock.vault, 'read');
        
        // 2. Instantiate the repository (the buggy version attaches a hidden 'modify' listener)
        const repo = new ObsidianNoteRepository(appMock as any);
        
        // 3. Manually trigger a vault 'modify' event if it was registered
        const modifyCallback = appMock.vault.on.mock.calls.find((call: any) => call[0] === 'modify')?.[1];
        
        if (modifyCallback) {
            const mockFile = new TFile();
            (mockFile as any).extension = 'md';
            (mockFile as any).path = 'Test.md';
            appMock.vault.getAbstractFileByPath.mockReturnValue(mockFile);
            
            await modifyCallback(mockFile);
        }
        
        // EXPECTATION: The unpatched code will perform an unnecessary vault.read(). 
        // The patched code has the listener stripped out entirely, resulting in 0 reads.
        expect(vaultReadSpy, 'Redundant disk I/O leak detected in NoteRepository!').not.toHaveBeenCalled();
    });

    it('TEST 7: Exposes dangling disk queue operations after plugin unload', async () => {
        let executionCount = 0;
        
        // 1. Mock a slow disk write that takes 50ms
        appMock.vault.modify.mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 50));
            executionCount++;
        });

        // 2. Flood the queue with 10 remote text changes
        for (let i = 0; i < 10; i++) {
            eventBus.emit('CrdtTextChanged', {
                uuid: `doc-${i}`,
                path: `Path-${i}.md`,
                content: 'Content'
            });
        }

        // 3. Immediately destroy the reconciler (simulating user disabling the plugin)
        diskReconciler.destroy();

        // 4. Wait long enough for the queue to theoretically finish if it wasn't stopped
        await new Promise(r => setTimeout(r, 600));

        // EXPECTATION: The unpatched code leaves the queue running in the background, 
        // resulting in 10 executions. The patched code halts it immediately.
        // Note: Depending on timing, 1 or 2 items might have already started processing 
        // before destroy() was called, but it should be strictly less than 10.
        expect(executionCount, 'Disk queue continued processing after plugin was destroyed!').toBeLessThan(10);
    });

    describe('Remote Change Testing: Cases 1 to 8', () => {
        
        const pushRemoteIndex = async (actions: (tree: any) => void) => {
            const remoteDoc = new LoroDoc();
            const localDoc = await syncEngine.getOrCreateDoc('shard-index');
            remoteDoc.import(localDoc.export({ mode: 'snapshot' }));
            syncEngine.removeDoc('shard-index');
            const tree = remoteDoc.getTree('vault-tree');
            actions(tree);
            remoteDoc.commit();
            
            const updateId = ++updateCounter;
            remoteStoreMock.getLatestUpdateId.mockResolvedValue(updateId);
            remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([{
                id: updateId, documentId: 'shard-index', encryptedUpdate: { ciphertext: Buffer.from(remoteDoc.export({ mode: 'update' })).toString('base64') }
            }]);
            
            await orchestrator.pullDocument('shard-index');
            (vfsController as any).rebuildCacheAndEmitRemoteDiffs();
            await waitForDisk();
        };

        it('Case 1: Remote Note Creation', async () => {
            await pushRemoteIndex(tree => {
                const node = tree.createNode();
                node.data.set('uuid', 'case1-uuid');
                node.data.set('filename', 'Case1_NewNote.md');
                node.data.set('type', 'file');
                node.data.set('isDeleted', false);
            });

            expect(appMock.vault.create).toHaveBeenCalledWith('Case1_NewNote.md', '');
        });

        it('Case 2: Remote Note Edit', async () => {
            await createLocalFile('Case2_EditNote.md');
            const uuid = vfsController.getUuidForPath('Case2_EditNote.md')!;

            const remoteDoc = new LoroDoc();
            remoteDoc.getText('markdown').insert(0, 'Remote Edit Content');
            remoteDoc.commit();
            
            pushMockRemoteUpdate(uuid, remoteDoc.export({ mode: 'update' }));
            await orchestrator.pullDocument(uuid, 'Case2_EditNote.md');
            await waitForDisk();

            expect(appMock.vault.modify).toHaveBeenCalledWith(expect.any(TFile), 'Remote Edit Content');
        });

        it('Case 3: Remote Note Rename', async () => {
            await createLocalFile('Case3_OldName.md');
            const uuid = vfsController.getUuidForPath('Case3_OldName.md')!;

            await pushRemoteIndex(tree => {
                const node = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (node) node.data.set('filename', 'Case3_NewName.md');
            });

            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFile), 'Case3_NewName.md');
        });

        it('Case 4: Remote Note Deletion', async () => {
            await createLocalFile('Case4_Trash.md');
            const uuid = vfsController.getUuidForPath('Case4_Trash.md')!;

            await pushRemoteIndex(tree => {
                const node = tree.getNodes().find((n: any) => n.data.get('uuid') === uuid);
                if (node) {
                    node.data.set('isDeleted', true);
                    tree.delete(node.id);
                }
            });

            expect(appMock.vault.trash).toHaveBeenCalledWith(expect.any(TFile), true);
        });

        it('Case 5: Remote Folder Creation', async () => {
            await pushRemoteIndex(tree => {
                const folder = tree.createNode();
                folder.data.set('uuid', 'case5-folder-uuid');
                folder.data.set('filename', 'Case5_NewFolder');
                folder.data.set('type', 'folder');
                folder.data.set('isDeleted', false);
            });

            expect(appMock.vault.createFolder).toHaveBeenCalledWith('Case5_NewFolder');
        });

        it('Case 6: Remote Move Note into Folder', async () => {
            await createLocalFile('Case6_Root.md');
            const fileUuid = vfsController.getUuidForPath('Case6_Root.md')!;

            await pushRemoteIndex(tree => {
                const folder = tree.createNode();
                folder.data.set('uuid', 'case6-folder');
                folder.data.set('filename', 'Case6_Target');
                folder.data.set('type', 'folder');

                const file = tree.getNodes().find((n: any) => n.data.get('uuid') === fileUuid);
                if (file) tree.move(file.id, folder.id);
            });

            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFile), 'Case6_Target/Case6_Root.md');
        });

        it('Case 7: Remote Folder Rename (Cascading Check)', async () => {
            // Setup folder and nested file
            await pushRemoteIndex(tree => {
                const folder = tree.createNode();
                folder.data.set('uuid', 'case7-folder');
                folder.data.set('filename', 'Case7_OldDir');
                folder.data.set('type', 'folder');
                
                const file = tree.createNode();
                file.data.set('uuid', 'case7-file');
                file.data.set('filename', 'Child.md');
                file.data.set('type', 'file');
                tree.move(file.id, folder.id);
            });
            
            // Rename the folder remotely
            await pushRemoteIndex(tree => {
                const folder = tree.getNodes().find((n: any) => n.data.get('uuid') === 'case7-folder');
                if (folder) folder.data.set('filename', 'Case7_NewDir');
            });

            expect(appMock.fileManager.renameFile).toHaveBeenCalledWith(expect.any(TFolder), 'Case7_NewDir');
            // The file's path should cascade automatically in the VFS cache
            expect(vfsController.getPathForUuid('case7-file')).toBe('Case7_NewDir/Child.md');
        });

        it('Case 8: Remote Folder Deletion (Cascading Check)', async () => {
            // Setup folder
            await pushRemoteIndex(tree => {
                const folder = tree.createNode();
                folder.data.set('uuid', 'case8-folder');
                folder.data.set('filename', 'Case8_DeleteMe');
                folder.data.set('type', 'folder');
                folder.data.set('isDeleted', false);
            });

            // Delete the folder remotely
            await pushRemoteIndex(tree => {
                const folder = tree.getNodes().find((n: any) => n.data.get('uuid') === 'case8-folder');
                if (folder) {
                    folder.data.set('isDeleted', true);
                    tree.delete(folder.id);
                }
            });

            // In ObsidianDiskReconciler, when a node is deleted, it resolves to its path and trashes it
            expect(appMock.vault.trash).toHaveBeenCalledWith(expect.any(TFolder), true);
        });
    });
});

