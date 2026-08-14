import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';

describe('Reactive Event-Driven VFS Reconciler Tests', () => {
	let eventBus: SyncEventBus;
	let syncEngine: LoroSyncEngine;
	let vfsController: LoroVfsController;
	let diskReconciler: ObsidianDiskReconciler;
	let appMock: any;

	beforeEach(async () => {
		eventBus = new SyncEventBus();
		syncEngine = new LoroSyncEngine();
		await syncEngine.localStore.clearAll();

		appMock = {
			vault: {
				getAbstractFileByPath: vi.fn(),
				trash: vi.fn().mockResolvedValue(undefined),
				createFolder: vi.fn().mockResolvedValue(undefined),
				create: vi.fn().mockResolvedValue(undefined),
				modify: vi.fn().mockResolvedValue(undefined),
				read: vi.fn().mockResolvedValue('Mock Content')
			},
			fileManager: {
				renameFile: vi.fn().mockResolvedValue(undefined)
			}
		};

		vfsController = new LoroVfsController(syncEngine, eventBus);
		await vfsController.initialize();

		diskReconciler = new ObsidianDiskReconciler(appMock as any, syncEngine, eventBus);
		diskReconciler.initialize();
	});

	it('Emits and processes LocalFileCreated event correctly', async () => {
		const createdPromise = new Promise<void>((resolve) => {
			eventBus.on('CrdtNodeCreated', (payload) => {
				expect(payload.path).toBe('Documents/Note.md');
				expect(payload.isFolder).toBe(false);
				resolve();
			});
		});

		eventBus.emit('LocalFileCreated', {
			path: 'Documents/Note.md',
			isFolder: false,
			content: 'Hello World'
		});

		await createdPromise;
	});

	it('Reconciles remote creation on disk via CrdtNodeCreated', async () => {
		eventBus.emit('CrdtNodeCreated', {
			uuid: 'test-uuid-123',
			path: 'Notes/Ideas.md',
			isFolder: false,
			content: 'Some remote edits'
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(appMock.vault.create).toHaveBeenCalledWith('Notes/Ideas.md', 'Some remote edits');
	});

	it('Triggers proper native move on LoroTree and renames correctly', async () => {
		eventBus.emit('LocalFileCreated', {
			path: 'Notes/Draft.md',
			isFolder: false
		});

		const movedPromise = new Promise<void>((resolve) => {
			eventBus.on('CrdtNodeMoved', (payload) => {
				expect(payload.oldPath).toBe('Notes/Draft.md');
				expect(payload.newPath).toBe('Notes/Published.md');
				resolve();
			});
		});

		eventBus.emit('LocalFileRenamed', {
			oldPath: 'Notes/Draft.md',
			newPath: 'Notes/Published.md'
		});

		await movedPromise;
	});

	it('Processes CrdtNodeSoftDeleted and invokes trashing fallback correctly', async () => {
		const fileObj = { path: 'TrashMe.md' };
		appMock.vault.getAbstractFileByPath.mockImplementation((p: string) => p === 'TrashMe.md' ? fileObj : null);

		appMock.vault.trash.mockImplementationOnce(() => Promise.reject(new Error('System trash restricted')));
		appMock.vault.trash.mockImplementationOnce(() => Promise.resolve());

		eventBus.emit('CrdtNodeSoftDeleted', {
			uuid: 'deleted-uuid',
			path: 'TrashMe.md'
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(appMock.vault.trash).toHaveBeenCalledTimes(2);
		expect(appMock.vault.trash).toHaveBeenNthCalledWith(1, fileObj, true);
		expect(appMock.vault.trash).toHaveBeenNthCalledWith(2, fileObj, false);
	});
});
