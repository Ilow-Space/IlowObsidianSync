import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeIndexManager } from '../src/2_Application/Sync/TreeIndexManager';
import * as Y from 'yjs';

describe('Virtual File System (VFS) Reconciler & Edge Cases', () => {
    let appMock: any;
    let engineMock: any;
    let syncMock: any;
    let manager: TreeIndexManager;
    
    // Use a real Yjs document instead of a mock so Y.encodeStateAsUpdate works natively
    let testDoc: Y.Doc;
    let testMap: Y.Map<any>;

    beforeEach(() => {
        testDoc = new Y.Doc();
        testMap = testDoc.getMap('vault-tree');

        appMock = {
            vault: {
                getAbstractFileByPath: vi.fn(),
                trash: vi.fn(),
                createFolder: vi.fn().mockResolvedValue(undefined),
                create: vi.fn().mockResolvedValue(undefined),
                getAllLoadedFiles: vi.fn().mockReturnValue([]),
                read: vi.fn().mockResolvedValue('Mock Content')
            },
            fileManager: {
                renameFile: vi.fn().mockResolvedValue(undefined)
            }
        };

        engineMock = {
            // Hand the real CRDT document to the manager
            getOrCreateDoc: vi.fn().mockResolvedValue(testDoc),
            localStore: { saveDocumentState: vi.fn() }
        };

        syncMock = {
            pushDocumentUpdate: vi.fn(),
            pullDocument: vi.fn().mockResolvedValue(undefined),
            handleLocalChange: vi.fn(),
            deleteRemoteSnapshot: vi.fn().mockResolvedValue(undefined)
        };

        manager = new TreeIndexManager(appMock as any, engineMock as any, syncMock as any);
    });

    it('The "Ghost Node" Edge Case', async () => {
        await manager.initialize();
        
        testMap.set('uuid-deleted-ghost', { type: 'file', path: 'Notes/Meeting.md', isDeleted: true });
        testMap.set('uuid-active-node', { type: 'file', path: 'Notes/Meeting.md', isDeleted: false });
        
        (manager as any).rebuildReverseLookup();
        appMock.vault.getAbstractFileByPath.mockReturnValue({ path: 'Notes/Meeting.md' });

        await manager.reconcileFilesystem();

        expect(appMock.vault.trash).not.toHaveBeenCalled();
    });

    it('Deep Folder Recreation', async () => {
        await manager.initialize();
        
        testMap.set('uuid-deep-file', { type: 'file', path: 'Projects/2026/Q3/Launch.md', isDeleted: false });
        (manager as any).rebuildReverseLookup();
        
        appMock.vault.getAbstractFileByPath.mockReturnValue(null);
        await manager.reconcileFilesystem();

        expect(appMock.vault.createFolder).toHaveBeenCalledWith('Projects');
        expect(appMock.vault.createFolder).toHaveBeenCalledWith('Projects/2026');
        expect(appMock.vault.createFolder).toHaveBeenCalledWith('Projects/2026/Q3');
        expect(appMock.vault.create).not.toHaveBeenCalled();
    });

    it('Fallback Trashing', async () => {
        await manager.initialize();
        
        testMap.set('uuid-deleted-doc', { type: 'file', path: 'Legacy.md', isDeleted: true });
        (manager as any).rebuildReverseLookup();
        
        const mockFile = { path: 'Legacy.md' };
        appMock.vault.getAbstractFileByPath.mockReturnValue(mockFile);

        appMock.vault.trash.mockImplementationOnce(() => Promise.reject(new Error('System trash restricted')));
        appMock.vault.trash.mockImplementationOnce(() => Promise.resolve());

        await manager.reconcileFilesystem();

        expect(appMock.vault.trash).toHaveBeenCalledTimes(2);
        expect(appMock.vault.trash).toHaveBeenNthCalledWith(1, mockFile, true);
        expect(appMock.vault.trash).toHaveBeenNthCalledWith(2, mockFile, false);
    });

    it('Vault Event Feedback Loop Prevention', async () => {
        await manager.initialize();
        
        const transactSpy = vi.spyOn(testDoc, 'transact');
        (manager as any).isReconciling = true;

        await manager.handleDelete('OldFolder/File.md');

        expect(transactSpy).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // EDGE CASE TESTS
    // -------------------------------------------------------------------------

    it('Bug 1: "Untitled" Ghost Duplication (Missing Last Known Path Update)', async () => {
        await manager.initialize();
        
        const mockFile = { path: 'Untitled.md' };
        appMock.vault.getAllLoadedFiles.mockReturnValue([mockFile]);
        
        await manager.handleCreate(mockFile as any);
        const uuid = Array.from((manager as any).pathToUuid.values())[0] as string;

        await manager.handleRename('Untitled.md', 'New Folder/Note.md');

        const lastKnown = (manager as any).uuidToLastKnownPath.get(uuid);
        expect(lastKnown).toBe('New Folder/Note.md'); 
    });

    it('Bug 2: Runaway UUID Duplication (Phase 2 Untracked Race Condition)', async () => {
        await manager.initialize();
        
        testMap.set('existing-uuid', { type: 'file', path: 'Renamed.md', isDeleted: false });
        appMock.vault.getAllLoadedFiles.mockReturnValue([{ path: 'Renamed.md' }]);

        await manager.reconcileFilesystem();

        expect((manager as any).pathToUuid.size).toBe(1); 
    });

    it('Feature 3: File Deletion Triggers Physical DB Purge', async () => {
        await manager.initialize();
        
        testMap.set('uuid-to-delete', { type: 'file', path: 'Old.md', isDeleted: false });
        (manager as any).rebuildReverseLookup();

        await manager.handleDelete('Old.md');

        expect(syncMock.deleteRemoteSnapshot).toHaveBeenCalledWith('uuid-to-delete');
    });

    it('Feature 4: Folder Deletion Cascades DB Purges to Children', async () => {
        await manager.initialize();
        
        testMap.set('folder-uuid', { type: 'folder', path: 'SecretProject', isDeleted: false });
        testMap.set('file-uuid-1', { type: 'file', path: 'SecretProject/Plans.md', isDeleted: false });
        testMap.set('file-uuid-2', { type: 'file', path: 'SecretProject/Code.md', isDeleted: false });

        await manager.handleDelete('SecretProject');

        expect(syncMock.deleteRemoteSnapshot).toHaveBeenCalledWith('file-uuid-1');
        expect(syncMock.deleteRemoteSnapshot).toHaveBeenCalledWith('file-uuid-2');
    });

    it('Misalignment 5: Case-Only Renames (Mac/Windows Edge Case)', async () => {
        await manager.initialize();
        
        testMap.set('uuid-case', { type: 'file', path: 'note.md', isDeleted: false });
        (manager as any).rebuildReverseLookup();
        
        await manager.handleRename('note.md', 'Note.md');

        expect((manager as any).pathToUuid.get('Note.md')).toBe('uuid-case');
    });

    it('Misalignment 6: Concurrent Same-Path Offline Creation (Orphaned UUIDs)', async () => {
        await manager.initialize();
        
        testMap.set('uuid-dev-a', { type: 'file', path: 'Daily.md', isDeleted: false });
        testMap.set('uuid-dev-b', { type: 'file', path: 'Daily.md', isDeleted: false });
        
        (manager as any).uuidToLastKnownPath.set('uuid-dev-a', 'Daily.md');
        (manager as any).uuidToLastKnownPath.set('uuid-dev-b', 'Daily.md');

        appMock.vault.getAbstractFileByPath.mockImplementation((path: string) => {
            if (path === 'Daily.md') return { path: 'Daily.md' };
            return null;
        });

        await manager.reconcileFilesystem();

        expect(appMock.fileManager.renameFile).toHaveBeenCalled(); 
    });

    it('Misalignment 7: Rename Target Collision', async () => {
        await manager.initialize();
        
        testMap.set('uuid-1', { type: 'file', path: 'A.md', isDeleted: false });
        testMap.set('uuid-2', { type: 'file', path: 'B.md', isDeleted: false });
        (manager as any).rebuildReverseLookup();

        await manager.handleRename('A.md', 'B.md');

        const updatedNode = testMap.get('uuid-1') as any;
        expect(updatedNode.path).not.toBe('B.md');
    });

    it('Misalignment 8: Recreating a previously deleted file (Tombstone Override)', async () => {
        await manager.initialize();
        
        testMap.set('uuid-dead', { type: 'file', path: 'Resurrect.md', isDeleted: true });
        (manager as any).rebuildReverseLookup();

        await manager.handleCreate({ path: 'Resurrect.md' } as any);

        const node = testMap.get('uuid-dead') as any;
        expect(node.isDeleted).toBe(false);
        expect((manager as any).pathToUuid.size).toBe(1);
    });

    it('Misalignment 9: Moving a file out of a remotely deleted folder', async () => {
        await manager.initialize();
        
        testMap.set('uuid-folder', { type: 'folder', path: 'DropFolder', isDeleted: true }); 
        testMap.set('uuid-file', { type: 'file', path: 'DropFolder/Keep.md', isDeleted: false }); 
        
        appMock.vault.getAbstractFileByPath.mockImplementation((path: string) => {
            if (path === 'Root/Keep.md') return { path: 'Root/Keep.md' };
            return null;
        });
        (manager as any).uuidToLastKnownPath.set('uuid-file', 'Root/Keep.md');

        await manager.reconcileFilesystem();

        expect(appMock.vault.trash).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'Root/Keep.md' }), expect.anything());
    });

    it('Misalignment 10: Rapid Create-Rename-Delete Sequence', async () => {
        await manager.initialize();
        
        const mockFile = { path: 'Temp.md' };
        await manager.handleCreate(mockFile as any);
        await manager.handleRename('Temp.md', 'Temp2.md');
        await manager.handleDelete('Temp2.md');

        expect((manager as any).pathToUuid.has('Temp.md')).toBe(false);
        expect((manager as any).pathToUuid.has('Temp2.md')).toBe(false);
        
        const uuid = Array.from(testMap.keys())[0];
        if (uuid) {
            expect((manager as any).uuidToLastKnownPath.has(uuid)).toBe(false);
        }
    });

    it('Misalignment 11: Prevent (1) postfix self-collision during native nested file rename events', async () => {
        await manager.initialize();

        testMap.set('uuid-folder', { type: 'folder', path: 'OldFolder', isDeleted: false });
        testMap.set('uuid-file', { type: 'file', path: 'OldFolder/File.md', isDeleted: false });
        (manager as any).rebuildReverseLookup();

        appMock.vault.getAbstractFileByPath.mockImplementation((path: string) => {
            if (path === 'NewFolder/File.md') return { path: 'NewFolder/File.md' };
            return null;
        });

        await manager.handleRename('OldFolder', 'NewFolder');
        await manager.handleRename('OldFolder/File.md', 'NewFolder/File.md');

        expect(appMock.fileManager.renameFile).not.toHaveBeenCalledWith(
            expect.objectContaining({ path: 'NewFolder/File.md' }),
            'NewFolder/File (1).md'
        );
    });

    it('Misalignment 12: Prevents empty file creation overriding contents', async () => {
        await manager.initialize();
        
        testMap.set('uuid-file', { type: 'file', path: 'Missing.md', isDeleted: false });
        appMock.vault.getAbstractFileByPath.mockReturnValue(null);

        await manager.reconcileFilesystem();

        expect(appMock.vault.create).not.toHaveBeenCalled();
    });

    it('Misalignment 13: Prevents folder duplication by depth-sorting renames', async () => {
        await manager.initialize();
        
        testMap.set('uuid-child', { type: 'file', path: 'NewFolder/File.md', isDeleted: false });
        testMap.set('uuid-parent', { type: 'folder', path: 'NewFolder', isDeleted: false });
        
        (manager as any).uuidToLastKnownPath.set('uuid-parent', 'OldFolder');
        (manager as any).uuidToLastKnownPath.set('uuid-child', 'OldFolder/File.md');
        
        appMock.vault.getAbstractFileByPath.mockImplementation((path: string) => {
            if (path === 'OldFolder') return { path: 'OldFolder' };
            if (path === 'OldFolder/File.md') return { path: 'OldFolder/File.md' };
            return null;
        });

        let order: string[] = [];
        appMock.fileManager.renameFile.mockImplementation((file: any) => {
            order.push(file.path);
        });

        await manager.reconcileFilesystem();

        expect(order[0]).toBe('OldFolder');
    });

    // -------------------------------------------------------------------------
    // NETWORK EVENT VALIDATION TESTS
    // -------------------------------------------------------------------------

    it('Network 1: handleCreate triggers WS broadcast', async () => {
        await manager.initialize();
        syncMock.pushDocumentUpdate.mockClear();

        await manager.handleCreate({ path: 'BroadcastCreate.md' } as any);

        expect(syncMock.pushDocumentUpdate).toHaveBeenCalledWith(
            manager.INDEX_DOC_ID, 
            expect.any(Uint8Array), 
            null
        );
    });

    it('Network 2: handleRename triggers WS broadcast', async () => {
        await manager.initialize();
        
        testMap.set('uuid-rename', { type: 'file', path: 'OldName.md', isDeleted: false });
        (manager as any).rebuildReverseLookup();
        syncMock.pushDocumentUpdate.mockClear();

        await manager.handleRename('OldName.md', 'NewName.md');

        expect(syncMock.pushDocumentUpdate).toHaveBeenCalledWith(
            manager.INDEX_DOC_ID, 
            expect.any(Uint8Array), 
            null
        );
    });

    it('Network 3: handleDelete triggers WS broadcast', async () => {
        await manager.initialize();
        
        testMap.set('uuid-delete', { type: 'file', path: 'ToDelete.md', isDeleted: false });
        (manager as any).rebuildReverseLookup();
        syncMock.pushDocumentUpdate.mockClear();

        await manager.handleDelete('ToDelete.md');

        expect(syncMock.pushDocumentUpdate).toHaveBeenCalledWith(
            manager.INDEX_DOC_ID, 
            expect.any(Uint8Array), 
            null
        );
    });

    it('Network 4: Offline Reconcile triggers WS broadcast for newly discovered files', async () => {
        await manager.initialize();
        syncMock.pushDocumentUpdate.mockClear();

        appMock.vault.getAllLoadedFiles.mockReturnValue([{ path: 'OfflineDiscovered.md' }]);

        await manager.reconcileFilesystem();

        expect(syncMock.pushDocumentUpdate).toHaveBeenCalledWith(
            manager.INDEX_DOC_ID, 
            expect.any(Uint8Array), 
            null
        );
    });
});