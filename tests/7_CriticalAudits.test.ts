import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';

describe('Critical Architectural Audits Suite (17 Audits)', () => {
	let eventBus: SyncEventBus;
	let syncEngine: LoroSyncEngine;
	let vfsController: LoroVfsController;
	let orchestrator: NetworkOrchestrator;
	let diskReconciler: ObsidianDiskReconciler;

	let remoteStoreMock: any;
	let cryptoMock: any;
	let noteRepoMock: any;
	let appMock: any;

	beforeEach(async () => {
		eventBus = new SyncEventBus();
		syncEngine = new LoroSyncEngine();
		await syncEngine.localStore.clearAll();

		vfsController = new LoroVfsController(syncEngine, eventBus);
		await vfsController.initialize();

		remoteStoreMock = {
			getBulkLatestUpdateIds: vi.fn().mockResolvedValue({}),
			getLatestUpdateId: vi.fn().mockResolvedValue(0),
			fetchSnapshotDetails: vi.fn().mockResolvedValue({ encryptedState: null, maxCompactedId: 0, isDeleted: false }),
			fetchUpdatesSince: vi.fn().mockResolvedValue([]),
			pushUpdate: vi.fn().mockResolvedValue(undefined),
			compactSnapshot: vi.fn().mockResolvedValue(undefined),
			deleteSnapshot: vi.fn().mockResolvedValue(undefined)
		};

		cryptoMock = {
			encrypt: vi.fn().mockImplementation(async (data: Uint8Array) => data),
			decrypt: vi.fn().mockImplementation(async (data: Uint8Array) => data)
		};

		noteRepoMock = {
			readNote: vi.fn().mockResolvedValue('Hello Content'),
			writeNote: vi.fn().mockResolvedValue(undefined),
			listAllNotes: vi.fn().mockResolvedValue([])
		};

		appMock = {
			vault: {
				getAbstractFileByPath: vi.fn(),
				getAllLoadedFiles: vi.fn().mockReturnValue([]),
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

		diskReconciler = new ObsidianDiskReconciler(appMock as any, syncEngine, eventBus);
		diskReconciler.initialize();

		orchestrator = new NetworkOrchestrator(
			remoteStoreMock,
			cryptoMock,
			syncEngine,
			noteRepoMock,
			vfsController,
			eventBus,
			vi.fn(),
			1000
		);
		orchestrator.initialize();
	});

	// Audit 1
	it('1. Persistent Retry Queue: Enqueues failed pushes and retries on subsequent sync cycles', async () => {
		orchestrator.setCryptoKey({} as any);
		remoteStoreMock.pushUpdate.mockRejectedValueOnce(new Error('Network offline'));

		eventBus.emit('LocalDeltaReadyForPush', {
			documentId: 'doc-fail',
			updateBinary: new Uint8Array([1, 2, 3]),
			path: 'fail.md'
		});

		await new Promise(r => setTimeout(r, 50));
		expect((orchestrator as any).pendingRetries.length).toBe(1);

		remoteStoreMock.pushUpdate.mockResolvedValueOnce(undefined);
		await orchestrator.runFullSync();

		expect((orchestrator as any).pendingRetries.length).toBe(0);
	});

	// Audit 2
	it('2. Session Teardown: Clears session maps and pending retries in stopAll()', () => {
		orchestrator.setCryptoKey({} as any);
		(orchestrator as any).fileLastSyncIds.set('doc-1', 10);
		(orchestrator as any).fileUpdateCounters.set('doc-1', 5);
		(orchestrator as any).pendingRetries.push({ documentId: 'doc-1', updateBinary: new Uint8Array() });

		orchestrator.stopAll();

		expect((orchestrator as any).fileLastSyncIds.size).toBe(0);
		expect((orchestrator as any).fileUpdateCounters.size).toBe(0);
		expect((orchestrator as any).pendingRetries.length).toBe(0);
	});

	// Audit 3
	it('3. Auto-Ingest Untracked Disk Modifications: Emits LocalFileCreated if file is untracked', async () => {
		orchestrator.setCryptoKey({} as any);
		orchestrator['isInitialized'] = true;

		const createdSpy = vi.fn();
		eventBus.on('LocalFileCreated', createdSpy);

		await (orchestrator as any).handleLocalFileModified({
			path: 'Untracked/Note.md',
			content: 'New content'
		});

		expect(createdSpy).toHaveBeenCalledWith({
			path: 'Untracked/Note.md',
			isFolder: false,
			content: 'New content'
		});
	});

	// Audit 4
	it('4. Filter Folder Payloads: Excludes folders prior to pulling documents in runFullSync', async () => {
		orchestrator.setCryptoKey({} as any);

		vfsController.getActiveFiles = vi.fn().mockReturnValue([
			{ uuid: 'file-1', path: 'File1.md', type: 'file' },
			{ uuid: 'folder-1', path: 'Folder1', type: 'folder' }
		]);

		const pullSpy = vi.spyOn(orchestrator, 'pullDocument').mockResolvedValue(undefined);

		await orchestrator.runFullSync();

		expect(pullSpy).toHaveBeenCalledWith('shard-index', null, true, 0);
		expect(pullSpy).toHaveBeenCalledWith('file-1', 'File1.md', true, 0);
		expect(pullSpy).not.toHaveBeenCalledWith('folder-1', 'Folder1', expect.anything(), expect.anything());
	});

	// Audit 5
	it('5. Storage Compaction: forceSyncAndCompact calls compactSnapshot with latest state vector', async () => {
		orchestrator.setCryptoKey({} as any);
		vi.spyOn(orchestrator, 'pullDocument').mockResolvedValue(undefined);

		await orchestrator.forceSyncAndCompact('doc-compact');

		expect(remoteStoreMock.compactSnapshot).toHaveBeenCalledWith(
			'doc-compact',
			expect.anything(),
			0,
			false,
			null
		);
	});

	// Audit 6
	it('6. Narrow Mutex Locking Scope: Fetches network updates outside runExclusive', async () => {
		orchestrator.setCryptoKey({} as any);

		let mutexLockedDuringFetch = false;
		remoteStoreMock.fetchSnapshotDetails.mockImplementation(async () => {
			mutexLockedDuringFetch = (orchestrator as any).orchestratorMutex.isLocked();
			return { encryptedState: null, maxCompactedId: 0, isDeleted: false };
		});

		await orchestrator.pullDocument('doc-mutex', 'test.md');

		expect(mutexLockedDuringFetch).toBe(false);
	});

	// Audit 7
	it('7. In-Flight Instantiation Cache: Coalesces concurrent getOrCreateDoc calls', async () => {
		const docPromise1 = syncEngine.getOrCreateDoc('in-flight-doc');
		const docPromise2 = syncEngine.getOrCreateDoc('in-flight-doc');

		const [doc1, doc2] = await Promise.all([docPromise1, docPromise2]);

		expect(doc1).toBe(doc2);
	});

	// Audit 8
	it('8. In-Flight Instantiation Ref Counts: Accurately counts concurrent callers', async () => {
		const docPromise1 = syncEngine.getOrCreateDoc('ref-doc');
		const docPromise2 = syncEngine.getOrCreateDoc('ref-doc');

		await Promise.all([docPromise1, docPromise2]);

		const refCount = (syncEngine as any).refCounts.get('ref-doc');
		expect(refCount).toBe(2);
	});

	// Audit 9
	it('9. LoroSyncEngine Teardown: Clears loadingDocs on destroy()', async () => {
		syncEngine.getOrCreateDoc('slow-doc');
		expect((syncEngine as any).loadingDocs.size).toBe(1);

		syncEngine.destroy();
		expect((syncEngine as any).loadingDocs.size).toBe(0);
	});

	// Audit 10
	it('10. Mutex Memory Eviction: Evicts unused mutex lock from fileLocks Map after task completion', async () => {
		eventBus.emit('CrdtTextChanged', {
			uuid: 'doc-lock-evict',
			path: 'Evict.md',
			content: 'Data'
		});

		await new Promise(r => setTimeout(r, 50));

		const lockMap = (diskReconciler as any).fileLocks;
		expect(lockMap.has('Evict.md')).toBe(false);
	});

	// Audit 11
	it('11. Recursive Folder Path Suppression: Suppresses child paths matching oldPath/* on folder move', async () => {
		const childFile = { path: 'FolderA/Sub/Doc.md' };
		appMock.vault.getAbstractFileByPath.mockImplementation((p: string) => {
			if (p === 'FolderA') return { path: 'FolderA' };
			if (p === 'FolderA/Sub/Doc.md') return childFile;
			return null;
		});
		appMock.vault.getAllLoadedFiles.mockReturnValue([childFile]);

		const suppressedList: string[] = [];
		const suppressSpy = vi.spyOn(ObsidianDiskReconciler, 'suppressPath').mockImplementation((p) => {
			suppressedList.push(p);
			ObsidianDiskReconciler.suppressedPaths.add(p);
		});

		eventBus.emit('CrdtNodeMoved', {
			uuid: 'folder-uuid',
			oldPath: 'FolderA',
			newPath: 'FolderB'
		});

		await new Promise(r => setTimeout(r, 100));

		expect(suppressedList).toContain('FolderA');
		expect(suppressedList).toContain('FolderB');
		expect(suppressedList).toContain('FolderA/Sub/Doc.md');
		expect(suppressedList).toContain('FolderB/Sub/Doc.md');

		suppressSpy.mockRestore();
	});

	// Audit 12
	it('12. Mutex Memory Eviction on Error: Evicts mutex lock even when file operation throws', async () => {
		appMock.vault.getAbstractFileByPath.mockReturnValue({ path: 'ErrFile.md' });
		appMock.vault.read.mockRejectedValue(new Error('Read failure'));

		eventBus.emit('CrdtTextChanged', {
			uuid: 'doc-err',
			path: 'ErrFile.md',
			content: 'Content'
		});

		await new Promise(r => setTimeout(r, 50));

		const lockMap = (diskReconciler as any).fileLocks;
		expect(lockMap.has('ErrFile.md')).toBe(false);
	});

	// Audit 13
	it('13. LoroVfsController Unbinding: Unbinds LocalFile listeners on destroy()', () => {
		const offSpy = vi.spyOn(eventBus, 'off');

		vfsController.destroy();

		expect(offSpy).toHaveBeenCalledWith('LocalFileCreated', (vfsController as any).boundCreated);
		expect(offSpy).toHaveBeenCalledWith('LocalFileRenamed', (vfsController as any).boundRenamed);
		expect(offSpy).toHaveBeenCalledWith('LocalFileDeleted', (vfsController as any).boundDeleted);
	});

	// Audit 14
	it('14. LoroVfsController Re-initialization: Re-enabling plugin binds fresh listeners without duplication', async () => {
		vfsController.destroy();

		const freshVfs = new LoroVfsController(syncEngine, eventBus);
		await freshVfs.initialize();

		const listeners = (eventBus as any).emitter.all.get('LocalFileCreated') || [];
		expect(listeners.length).toBe(1);

		freshVfs.destroy();
	});

	// Audit 15
	it('15. LoroVfsController Push Schedule: Clears pushTimeout on destroy()', () => {
		(vfsController as any).scheduleLocalPush();
		expect((vfsController as any).pushTimeout).not.toBeNull();

		vfsController.destroy();
		expect((vfsController as any).pushTimeout).toBeNull();
	});

	// Audit 16
	it('16. Retry Queue Drain: Successfully flushes pendingRetries once store connection succeeds', async () => {
		orchestrator.setCryptoKey({} as any);
		remoteStoreMock.pushUpdate.mockRejectedValueOnce(new Error('Network fail'));

		await (orchestrator as any).handleLocalDeltaReadyForPush({
			documentId: 'doc-retry',
			updateBinary: new Uint8Array([5, 6]),
			path: 'retry.md'
		});

		expect((orchestrator as any).pendingRetries.length).toBe(1);

		remoteStoreMock.pushUpdate.mockResolvedValue(undefined);
		await orchestrator.runFullSync();

		expect((orchestrator as any).pendingRetries.length).toBe(0);
	});

	// Audit 17
	it('17. Disk Queue Concurrency Limit: Enforces concurrency bound on global disk reconciliations', async () => {
		let currentActive = 0;
		let maxActive = 0;

		appMock.vault.modify.mockImplementation(async () => {
			currentActive++;
			maxActive = Math.max(maxActive, currentActive);
			await new Promise(r => setTimeout(r, 20));
			currentActive--;
		});

		for (let i = 0; i < 20; i++) {
			eventBus.emit('CrdtTextChanged', {
				uuid: `doc-${i}`,
				path: `Path-${i}.md`,
				content: 'Content'
			});
		}

		await new Promise(r => setTimeout(r, 100));
		expect(maxActive).toBeLessThanOrEqual(5);
	});
});