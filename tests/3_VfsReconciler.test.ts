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

	it('Emits LocalDeltaReadyForPush when local file is created', async () => {
		const createdPromise = new Promise<void>((resolve) => {
			// FIX: We listen for the push event now, NOT CrdtNodeCreated (which is for remote nodes only)
			eventBus.on('LocalDeltaReadyForPush', (payload) => {
				expect(payload.documentId).toBe('shard-index');
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

	it('Triggers proper native move on LoroTree and schedules delta push', async () => {
		eventBus.emit('LocalFileCreated', {
			path: 'Notes/Draft.md',
			isFolder: false
		});

		// Wait for creation debounce to settle
		await new Promise(r => setTimeout(r, 100));

		const movedPromise = new Promise<void>((resolve) => {
			eventBus.on('LocalDeltaReadyForPush', (payload) => {
				expect(payload.documentId).toBe('shard-index');
				resolve();
			});
		});

		eventBus.emit('LocalFileRenamed', {
			oldPath: 'Notes/Draft.md',
			newPath: 'Notes/Published.md'
		});

		await movedPromise;
	});

	it('PERF REGRESSION: ObsidianDiskReconciler must throttle global vault writes to prevent UI freezing', async () => {
		let activeWrites = 0;
		let maxConcurrentWrites = 0;

		appMock.vault.modify.mockImplementation(async () => {
			activeWrites++;
			maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
			await new Promise(r => setTimeout(r, 50));
			activeWrites--;
		});

		const promises = Array.from({ length: 50 }).map((_, i) => {
			return eventBus.emit('CrdtTextChanged', {
				uuid: `doc-${i}`,
				path: `Folder/Doc-${i}.md`,
				content: 'New network data'
			});
		});

		await Promise.all(promises);
		await new Promise(r => setTimeout(r, 100)); 

		expect(maxConcurrentWrites).toBeLessThanOrEqual(5);
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

	it('PERF REGRESSION: Bulk deletions must execute O(1) cache eviction and batch WASM exports', async () => {
		const rebuildSpy = vi.spyOn(vfsController, 'rebuildCache');
		const exportSpy = vi.spyOn(vfsController['treeDoc'], 'export');

		for (let i = 0; i < 100; i++) {
			eventBus.emit('LocalFileCreated', { path: `Bulk/File-${i}.md`, isFolder: false });
		}
		
		await new Promise(r => setTimeout(r, 100));
		
		rebuildSpy.mockClear();
		exportSpy.mockClear();

		for (let i = 0; i < 100; i++) {
			eventBus.emit('LocalFileDeleted', { path: `Bulk/File-${i}.md` });
		}

		await new Promise(r => setTimeout(r, 100));

		expect(rebuildSpy).toHaveBeenCalledTimes(0); 
		expect(exportSpy).toHaveBeenCalledTimes(1);
	});

	it('PERF REGRESSION: Local mutations must NOT emit CrdtNode events to prevent eager REST fetching loops', async () => {
		const remoteCreatedSpy = vi.fn();
		eventBus.on('CrdtNodeCreated', remoteCreatedSpy);

		eventBus.emit('LocalFileCreated', {
			path: 'Test/Local.md',
			isFolder: false,
			content: 'Local Data'
		});

		await new Promise(r => setTimeout(r, 100));

		expect(remoteCreatedSpy).not.toHaveBeenCalled();
	});
	it('BUG REGRESSION: File move to an uncommitted directory must process correctly and update tree paths', async () => {
		// 1. Create a loose file
		eventBus.emit('LocalFileCreated', { path: 'LooseFile.md', isFolder: false, content: 'Data' });
		
		// 2. We do NOT wait for the 50ms batch to commit. We immediately move it to a NEW folder.
		eventBus.emit('LocalFileRenamed', {
			oldPath: 'LooseFile.md',
			newPath: 'NewFolder/LooseFile.md'
		});

		// 3. Wait for the debounce push batch to settle
		await new Promise(r => setTimeout(r, 100));

		// 4. Verify the CRDT accurately resolved the path
		const fileUuid = vfsController.getUuidForPath('NewFolder/LooseFile.md');
		const obsoleteUuid = vfsController.getUuidForPath('LooseFile.md');
		
		expect(fileUuid).not.toBeNull();
		expect(obsoleteUuid).toBeNull();
	});
});