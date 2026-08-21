import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { VaultEventWatcher } from '../src/2_Application/Sync/VaultEventWatcher';
import { LoroDoc } from 'loro-crdt';
import { TFile, TFolder } from 'obsidian';

describe('Real-World Race Condition: Cascading Folder Renames & Conflict Loops', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;
    let appMock: any;
    let mockVaultFiles = new Map<string, any>();
    
    beforeEach(async () => {
        eventBus = new SyncEventBus();
        syncEngine = new LoroSyncEngine();
        await syncEngine.localStore.clearAll();
        vfsController = new LoroVfsController(syncEngine, eventBus);
        await vfsController.initialize();
        mockVaultFiles.clear();

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
                trash: vi.fn(),
                getAllLoadedFiles: vi.fn(() => Array.from(mockVaultFiles.values()))
            },
            fileManager: {
                renameFile: vi.fn().mockImplementation(async (f: any, newPath: string) => {
                    // MOCK OBSIDIAN'S NATIVE BEHAVIOR:
                    // If a folder is renamed, automatically rename all child paths recursively!
                    const isFolder = f instanceof TFolder;
                    const oldPrefix = f.path + '/';
                    const newPrefix = newPath + '/';
                    
                    mockVaultFiles.delete(f.path);
                    f.path = newPath;
                    mockVaultFiles.set(newPath, f);

                    if (isFolder) {
                        for (const [key, child] of Array.from(mockVaultFiles.entries())) {
                            if (key.startsWith(oldPrefix)) {
                                mockVaultFiles.delete(key);
                                const childNewPath = key.replace(oldPrefix, newPrefix);
                                child.path = childNewPath;
                                mockVaultFiles.set(childNewPath, child);
                            }
                        }
                    }
                })
            }
        };

        diskReconciler = new ObsidianDiskReconciler(appMock, syncEngine, eventBus);
        diskReconciler.initialize();
        
        orchestrator = new NetworkOrchestrator(
            { fetchUpdatesSince: vi.fn().mockResolvedValue([]), getBulkLatestUpdateIds: vi.fn().mockResolvedValue({}) } as any,
            { encrypt: vi.fn(), decrypt: vi.fn() } as any,
            syncEngine, {} as any, vfsController, eventBus, vi.fn(), 0, diskReconciler
        );
    });

    afterEach(() => {
        diskReconciler.destroy();
        vfsController.destroy();
        syncEngine.destroy();
    });

    it('Must not generate conflict files or duplicate renames when a parent folder is renamed', async () => {
        // SETUP: Establish initial synced file inside a folder
        const localDoc = await syncEngine.getOrCreateDoc('shard-index');
        const tree = localDoc.getTree('vault-tree');
        
        const folderNode = tree.createNode();
        folderNode.data.set('uuid', 'folder-uuid');
        folderNode.data.set('filename', 'FastRenameFolder');
        folderNode.data.set('type', 'folder');

        const fileNode = tree.createNode();
        fileNode.data.set('uuid', 'file-uuid');
        fileNode.data.set('filename', 'Doc1.md');
        fileNode.data.set('type', 'file');
        tree.move(fileNode.id, folderNode.id);
        localDoc.commit();
        
        vfsController.rebuildCache();

        // Create the physical mock files
        const d = new TFolder(); (d as any).path = 'FastRenameFolder';
        mockVaultFiles.set('FastRenameFolder', d);
        const f = new TFile(); (f as any).path = 'FastRenameFolder/Doc1.md';
        mockVaultFiles.set('FastRenameFolder/Doc1.md', f);

        const renameSpy = vi.spyOn(appMock.fileManager, 'renameFile');
        const createSpy = vi.spyOn(appMock.vault, 'create');

        // TRIGGER: Remote changes the folder name.
        folderNode.data.set('filename', 'FastRenameFolderRenamed');
        localDoc.commit();

        // EXECUTION: Emit diffs into the Reconciler
        (vfsController as any).rebuildCacheAndEmitRemoteDiffs();
        await (diskReconciler as any).diskQueue.onIdle();

        // 🟢 EVIDENCE 1: The parent folder rename was dispatched to Obsidian
        expect(renameSpy).toHaveBeenCalledWith(expect.anything(), 'FastRenameFolderRenamed');

        // 🟢 EVIDENCE 2: The reconciler realized the child file was already moved natively 
        // and did NOT dispatch a redundant structural rename for it.
        expect(renameSpy).toHaveBeenCalledTimes(1);

        // 🟢 EVIDENCE 3: The reconciler did NOT panic and attempt to rehydrate a missing file
        expect(createSpy).not.toHaveBeenCalled();

        // 🟢 EVIDENCE 4: No "(Conflict X)" files were injected into the file system
        const keys = Array.from(mockVaultFiles.keys());
        expect(keys.some(k => k.includes('Conflict'))).toBe(false);
    });
});