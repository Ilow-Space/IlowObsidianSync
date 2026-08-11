
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeIndexManager } from '../src/2_Application/Sync/TreeIndexManager';
import { YjsEngine } from '../src/3_Infrastructure/Crdt/YjsEngine';

describe('Virtual File System (VFS) Reconciler', () => {
    let appMock: any;
    let engineMock: any;
    let syncMock: any;
    let manager: TreeIndexManager;

    beforeEach(() => {
        appMock = {
            vault: {
                getAbstractFileByPath: vi.fn(),
                trash: vi.fn(),
                createFolder: vi.fn().mockResolvedValue(undefined),
                create: vi.fn().mockResolvedValue(undefined),
                getAllLoadedFiles: vi.fn().mockReturnValue([]),
            }
        };

        engineMock = {
            getOrCreateDoc: vi.fn().mockResolvedValue({
                getMap: vi.fn().mockReturnValue({
                    entries: vi.fn().mockReturnValue([]),
                    observe: vi.fn(),
                    set: vi.fn()
                }),
                once: vi.fn(),
                transact: vi.fn((cb: any) => cb())
            }),
            localStore: { saveDocumentState: vi.fn() }
        };

        syncMock = {
            pushDocumentUpdate: vi.fn(),
            pullDocument: vi.fn().mockResolvedValue(undefined),
            handleLocalChange: vi.fn()
        };

        manager = new TreeIndexManager(appMock as any, engineMock as any, syncMock as any);
    });

    it('The "Ghost Node" Edge Case', async () => {
        await manager.initialize();
        
        // Inject a simulated CRDT map state where an old file was deleted, but a new file was 
        // created at the exact same path concurrently.
        const mockMap = new Map();
        mockMap.set('uuid-deleted-ghost', { type: 'file', path: 'Notes/Meeting.md', isDeleted: true });
        mockMap.set('uuid-active-node', { type: 'file', path: 'Notes/Meeting.md', isDeleted: false });
        
        (manager as any).treeMap = mockMap;
        (manager as any).rebuildReverseLookup(); // Updates pathToUuid
        
        appMock.vault.getAbstractFileByPath.mockReturnValue({ path: 'Notes/Meeting.md' });

        await manager.reconcileFilesystem();

        // The trash system should NEVER be called because an active node exists for 'Notes/Meeting.md'
        expect(appMock.vault.trash).not.toHaveBeenCalled();
    });

    it('Deep Folder Recreation', async () => {
        await manager.initialize();
        
        const mockMap = new Map();
        mockMap.set('uuid-deep-file', { type: 'file', path: 'Projects/2026/Q3/Launch.md', isDeleted: false });
        
        (manager as any).treeMap = mockMap;
        (manager as any).rebuildReverseLookup();
        
        // Simulate missing folders natively
        appMock.vault.getAbstractFileByPath.mockReturnValue(null);

        await manager.reconcileFilesystem();

        expect(appMock.vault.createFolder).toHaveBeenCalledWith('Projects');
        expect(appMock.vault.createFolder).toHaveBeenCalledWith('Projects/2026');
        expect(appMock.vault.createFolder).toHaveBeenCalledWith('Projects/2026/Q3');
        expect(appMock.vault.create).toHaveBeenCalledWith('Projects/2026/Q3/Launch.md', '');
    });

    it('Fallback Trashing', async () => {
        await manager.initialize();
        
        const mockMap = new Map();
        mockMap.set('uuid-deleted-doc', { type: 'file', path: 'Legacy.md', isDeleted: true });
        
        (manager as any).treeMap = mockMap;
        (manager as any).rebuildReverseLookup();
        
        const mockFile = { path: 'Legacy.md' };
        appMock.vault.getAbstractFileByPath.mockReturnValue(mockFile);

        // Force system trash (true) to throw an exception
        appMock.vault.trash.mockImplementationOnce(() => Promise.reject(new Error('System trash restricted')));
        // Local vault trash (false) succeeds
        appMock.vault.trash.mockImplementationOnce(() => Promise.resolve());

        await manager.reconcileFilesystem();

        // Ensure both were attempted in order
        expect(appMock.vault.trash).toHaveBeenCalledTimes(2);
        expect(appMock.vault.trash).toHaveBeenNthCalledWith(1, mockFile, true);
        expect(appMock.vault.trash).toHaveBeenNthCalledWith(2, mockFile, false);
    });
});

