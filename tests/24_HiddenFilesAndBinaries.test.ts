import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroDoc } from 'loro-crdt';

describe('Hidden Files (Config) & Binary Assets Sync Operations', () => {
    let eventBus: SyncEventBus;
    let syncEngine: LoroSyncEngine;
    let vfsController: LoroVfsController;
    let orchestrator: NetworkOrchestrator;
    let diskReconciler: ObsidianDiskReconciler;

    let appMock: any;
    let remoteStoreMock: any;
    let mockAdapterFiles = new Map<string, string>(); // Simulates hidden files
    let mockVaultFiles = new Map<string, any>();      // Simulates standard files

    beforeEach(async () => {
        eventBus = new SyncEventBus();
        syncEngine = new LoroSyncEngine();
        await syncEngine.localStore.clearAll();

        vfsController = new LoroVfsController(syncEngine, eventBus);
        await vfsController.initialize();

        mockAdapterFiles.clear();
        mockVaultFiles.clear();

        appMock = {
            vault: {
                configDir: '.obsidian',
                getAbstractFileByPath: vi.fn((p: string) => mockVaultFiles.get(p) || null),
                create: vi.fn(async (p: string, content: string) => {
                    const f = { path: p, content };
                    mockVaultFiles.set(p, f);
                    return f;
                }),
                createFolder: vi.fn(async (p: string) => {
                    const f = { path: p, isFolder: true };
                    mockVaultFiles.set(p, f);
                    return f;
                }),
                read: vi.fn(async (f: any) => f.content || ''),
                modify: vi.fn(async (f: any, content: string) => { f.content = content; }),
                adapter: {
                    exists: vi.fn(async (p: string) => mockAdapterFiles.has(p)),
                    read: vi.fn(async (p: string) => mockAdapterFiles.get(p)),
                    write: vi.fn(async (p: string, content: string) => mockAdapterFiles.set(p, content)),
                    mkdir: vi.fn(async () => {}),
                    rename: vi.fn(async (oldP: string, newP: string) => {
                        const content = mockAdapterFiles.get(oldP);
                        mockAdapterFiles.delete(oldP);
                        if (content) mockAdapterFiles.set(newP, content);
                    }),
                    remove: vi.fn(async (p: string) => { mockAdapterFiles.delete(p); })
                },
                // Mocks for standard TFile binaries
                createBinary: vi.fn(async (p: string, data: ArrayBuffer) => { mockVaultFiles.set(p, { isBinary: true, data }); }),
                readBinary: vi.fn(async (f: any) => f.data),
                trash: vi.fn(async (f: any) => mockVaultFiles.delete(f.path))
            },
            fileManager: {
                renameFile: vi.fn(async (f: any, newP: string) => {
                    mockVaultFiles.delete(f.path);
                    f.path = newP;
                    mockVaultFiles.set(newP, f);
                })
            }
        };

        remoteStoreMock = {
            getBulkLatestUpdateIds: vi.fn().mockResolvedValue({}),
            getLatestUpdateId: vi.fn().mockResolvedValue(0),
            fetchSnapshotDetails: vi.fn().mockResolvedValue(null),
            fetchUpdatesSince: vi.fn().mockResolvedValue([]),
            pushUpdate: vi.fn().mockResolvedValue(undefined)
        };

        diskReconciler = new ObsidianDiskReconciler(appMock, syncEngine, eventBus);
        diskReconciler.initialize();

        orchestrator = new NetworkOrchestrator(
            remoteStoreMock, { encrypt: vi.fn(), decrypt: vi.fn() } as any, syncEngine, 
            {} as any, vfsController, eventBus, vi.fn(), 0, diskReconciler
        );
        orchestrator.setCryptoKey({} as any);
    });

    afterEach(() => {
        orchestrator.stopAll();
        diskReconciler.destroy();
        vfsController.destroy();
        syncEngine.destroy();
        eventBus.destroy();
        vi.restoreAllMocks();
    });

    describe('Hidden Files (Config) CRUD Operations', () => {
        it('Create: Handles inbound remote creation of .obsidian config file', async () => {
            eventBus.emit('CrdtNodeCreated', {
                uuid: 'config-uuid',
                path: '.obsidian/plugins/test/data.json',
                isFolder: false,
                content: '{"setting": true}'
            });

            await diskReconciler.onIdle();

            expect(appMock.vault.adapter.mkdir).toHaveBeenCalledWith('.obsidian/plugins/test');
            expect(appMock.vault.adapter.write).toHaveBeenCalledWith('.obsidian/plugins/test/data.json', '{"setting": true}');
            expect(mockAdapterFiles.get('.obsidian/plugins/test/data.json')).toBe('{"setting": true}');
        });

        it('Read/Update: Handles inbound CRDT text changes to existing config', async () => {
            mockAdapterFiles.set('.obsidian/appearance.json', '{"theme": "dark"}');

            eventBus.emit('CrdtTextChanged', {
                uuid: 'appearance-uuid',
                path: '.obsidian/appearance.json',
                content: '{"theme": "light"}'
            });

            await diskReconciler.onIdle();

            expect(appMock.vault.adapter.write).toHaveBeenCalledWith('.obsidian/appearance.json', '{"theme": "light"}');
            expect(mockAdapterFiles.get('.obsidian/appearance.json')).toBe('{"theme": "light"}');
        });

        it('Move/Rename: Safely moves config files using adapter bypass', async () => {
            mockAdapterFiles.set('.obsidian/plugins/old/data.json', '{"key": "value"}');

            eventBus.emit('CrdtNodeMoved', {
                uuid: 'move-uuid',
                oldPath: '.obsidian/plugins/old/data.json',
                newPath: '.obsidian/plugins/new/data.json'
            });

            await diskReconciler.onIdle();

            expect(appMock.vault.adapter.rename).toHaveBeenCalledWith(
                '.obsidian/plugins/old/data.json', 
                '.obsidian/plugins/new/data.json'
            );
            expect(mockAdapterFiles.has('.obsidian/plugins/old/data.json')).toBe(false);
            expect(mockAdapterFiles.has('.obsidian/plugins/new/data.json')).toBe(true);
        });

        it('Delete: Properly removes hidden files using adapter', async () => {
            mockAdapterFiles.set('.obsidian/workspace.json', '{}');

            eventBus.emit('CrdtNodeSoftDeleted', {
                uuid: 'del-uuid',
                path: '.obsidian/workspace.json'
            });

            await diskReconciler.onIdle();

            expect(appMock.vault.adapter.remove).toHaveBeenCalledWith('.obsidian/workspace.json');
            expect(appMock.vault.trash).not.toHaveBeenCalled();
            expect(mockAdapterFiles.has('.obsidian/workspace.json')).toBe(false);
        });
    });

    describe('Binaries and Images Sync Operations', () => {
        it('Offline Create: Queues local image creation for later remote push', async () => {
            // Simulate orchestrator without active key (Offline mode)
            orchestrator.setCryptoKey(null);
            
            const imageHash = 'sha256-img-hash';
            
            // Local creation while offline
            eventBus.emit('LocalFileCreated', {
                path: 'Assets/image.png',
                isFolder: false
            });

            // Re-acquire key (Online mode)
            orchestrator.setCryptoKey({} as any);
            await orchestrator.runFullSync();

            // We expect the pending retry queue to have caught the offline creation
            const activeFiles = vfsController.getActiveFiles();
            expect(activeFiles.find(f => f.path === 'Assets/image.png')).toBeDefined();
        });

        it('Rename/Move: Reconciles offline image rename against remote state', async () => {
            // Baseline index setup for binary
            const localDoc = await syncEngine.getOrCreateDoc('shard-index');
            const tree = localDoc.getTree('vault-tree');
            const imgNode = tree.createNode();
            imgNode.data.set('uuid', 'img-uuid');
            imgNode.data.set('filename', 'photo.jpg');
            imgNode.data.set('type', 'file');
            imgNode.data.set('blob_hash', 'blob-hash-123');
            localDoc.commit();
            vfsController.rebuildCache();

            mockVaultFiles.set('photo.jpg', { path: 'photo.jpg', isBinary: true });

            // User moves image offline
            eventBus.emit('LocalFileRenamed', {
                oldPath: 'photo.jpg',
                newPath: 'Archive/photo.jpg'
            });

            await new Promise(r => setTimeout(r, 50));
            
            const path = vfsController.getPathForUuid('img-uuid');
            expect(path).toBe('Archive/photo.jpg');
        });

        it('Conflict: Rebalances duplicate image paths gracefully', async () => {
            // Disk already has the image with different content
            mockVaultFiles.set('Attachments/diagram.png', { path: 'Attachments/diagram.png', isBinary: true, content: 'local-binary-data' });

            // Remote node creation arrives with different content
            eventBus.emit('CrdtNodeCreated', {
                uuid: 'remote-diagram-uuid',
                path: 'Attachments/diagram.png',
                isFolder: false,
                content: 'remote-binary-data'
            });

            await diskReconciler.onIdle();

            // Should trigger Rebalance or generate Conflict (Depends on your binary conflict logic)
            // If binary hash matching is implemented, this should assert RebalancePathUuid
            const conflictExists = Array.from(mockVaultFiles.keys()).some(k => k.includes('Conflict'));
            expect(conflictExists).toBe(true); // Assuming naive collision logic creates a conflict file
        });
    });
});