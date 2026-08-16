import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { LoroDoc } from 'loro-crdt';

describe('NetworkOrchestrator & Sync Tests', () => {
	let eventBus: SyncEventBus;
	let syncEngine: LoroSyncEngine;
	let vfsController: LoroVfsController;
	let orchestrator: NetworkOrchestrator;

	let remoteStoreMock: any;
	let cryptoMock: any;
	let noteRepoMock: any;

	beforeEach(async () => {
		eventBus = new SyncEventBus();
		syncEngine = new LoroSyncEngine();
		await syncEngine.localStore.clearAll();

		vfsController = new LoroVfsController(syncEngine, eventBus);
		await vfsController.initialize();

		remoteStoreMock = {
			getBulkLatestUpdateIds: vi.fn().mockResolvedValue({}),
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
			writeNote: vi.fn().mockResolvedValue(undefined)
		};

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

	it('Publishes update to server when LocalDeltaReadyForPush is emitted', async () => {
		const dummyKey = {} as any;
		orchestrator.setCryptoKey(dummyKey);
		(orchestrator as any).isInitialized = true;

		eventBus.emit('LocalDeltaReadyForPush', {
			documentId: 'test-doc',
			updateBinary: new Uint8Array([1, 2, 3]),
			path: 'test.md'
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(remoteStoreMock.pushUpdate).toHaveBeenCalled();
	});

	it('PERF REGRESSION: runFullSync must pull documents concurrently, not sequentially', async () => {
		const dummyKey = {} as any;
		orchestrator.setCryptoKey(dummyKey);

		// Mock 50 active files
		const mockFiles = Array.from({ length: 50 }).map((_, i) => ({ uuid: `doc-${i}`, path: `path-${i}.md`, type: 'file' }));
		vfsController.getActiveFiles = vi.fn().mockReturnValue(mockFiles as any);

		// Mock pullDocument to take exactly 10ms
		const pullSpy = vi.spyOn(orchestrator, 'pullDocument').mockImplementation(async () => {
			return new Promise(resolve => setTimeout(resolve, 10));
		});

		const start = performance.now();
		await orchestrator.runFullSync();
		const duration = performance.now() - start;

		// 50 files * 10ms sequentially = ~500ms. With concurrency 20, it should take ~30ms.
		expect(duration).toBeLessThan(150);
	});

	it('PERF REGRESSION: pullDocument must garbage collect LoroDocs when finished if not actively open', async () => {
		const dummyKey = {} as any;
		orchestrator.setCryptoKey(dummyKey);
		orchestrator['activeDocumentId'] = 'doc-1'; // UI has doc-1 open

		// Simulate background sync pulling updates for doc-2 and doc-3
		remoteStoreMock.fetchSnapshotDetails.mockResolvedValue({ encryptedState: new Uint8Array([1]), maxCompactedId: 10, isDeleted: false });

		await orchestrator.pullDocument('doc-2', 'Folder/doc-2.md', true);
		await orchestrator.pullDocument('doc-3', 'Folder/doc-3.md', true);

		// activeDocs should ONLY contain 'doc-1' (if loaded) or be empty. It should NOT retain doc-2 or doc-3.
		const engineActiveDocs = (syncEngine as any).activeDocs;
		expect(engineActiveDocs.has('doc-2')).toBe(false);
		expect(engineActiveDocs.has('doc-3')).toBe(false);
	});

	it('Executes safe rehydration on lagging clients without wiping offline edits', async () => {
		const dummyKey = {} as any;
		orchestrator.setCryptoKey(dummyKey);

		remoteStoreMock.fetchSnapshotDetails.mockResolvedValueOnce({
			encryptedState: new Uint8Array([4, 5, 6]),
			maxCompactedId: 10,
			isDeleted: false
		});

		await orchestrator.pullDocument('test-doc', 'test.md');

		expect(noteRepoMock.readNote).toHaveBeenCalledWith('test.md');
	});
	it('PERF REGRESSION: pullDocument must safely merge snapshots without ejecting active LoroDocs', async () => {
		const dummyKey = {} as any;
		orchestrator.setCryptoKey(dummyKey);
        
		// Spy on the engine to ensure we NEVER call forceEjectDoc
		const ejectSpy = vi.spyOn(syncEngine, 'forceEjectDoc');

		remoteStoreMock.fetchSnapshotDetails.mockResolvedValueOnce({
			encryptedState: new Uint8Array([4, 5, 6]), // Will be mocked to valid by cryptoMock
			maxCompactedId: 10,
			isDeleted: false
		});

		await orchestrator.pullDocument('test-doc', 'test.md');

		// The orchestrator must seamlessly merge, preserving local offline state without wiping the doc instance
		expect(ejectSpy).not.toHaveBeenCalled();
	});
	it('CONTINUITY REGRESSION: Propagates offline actions when lagging storage reconnects', async () => {
		const dummyKey = {} as any;
		orchestrator.setCryptoKey(dummyKey);

		// 1. Simulate the remote store having advanced past the local state (Compacted state)
		remoteStoreMock.fetchSnapshotDetails.mockResolvedValueOnce({
			encryptedState: new Uint8Array([4, 5, 6]),
			maxCompactedId: 25, // Client is lagging (local lastId defaults to 0)
			isDeleted: false
		});

		// 2. Simulate the user having offline local edits that haven't been pushed yet
		noteRepoMock.readNote.mockResolvedValueOnce('Crucial offline edits made while lagging');

		// 3. Set up a listener to catch the delta push triggered by the rehydration merge
		const pushPromise = new Promise<void>((resolve) => {
			eventBus.on('LocalDeltaReadyForPush', (payload) => {
				expect(payload.documentId).toBe('lagging-doc');
				resolve();
			});
		});

		// 4. Trigger the pull (simulate the lagging user coming online and syncing)
		await orchestrator.pullDocument('lagging-doc', 'lagging-path.md');

		// 5. Ensure the offline state was successfully read, merged, and emitted for propagation
		await pushPromise;
		await new Promise(resolve => setTimeout(resolve, 50)); // Allow the async event handler and mutex to flush

		// Verify the exact sequence of continuity events to guarantee no data loss
		expect(noteRepoMock.readNote).toHaveBeenCalledWith('lagging-path.md');
		expect(remoteStoreMock.pushUpdate).toHaveBeenCalled();
	});

describe('VFS Ghost File & Cache Synchronization Bugs', () => {
	
	it('VFS GHOST BUG 1: runFullSync must safely emit remote tree diffs instead of synchronously swallowing them', async () => {
		const dummyKey = {} as any;
		orchestrator.setCryptoKey(dummyKey);

		// 1. Initial State: The lagging device has a file tracked at 'TargetGhost.md'
		eventBus.emit('LocalFileCreated', { path: 'TargetGhost.md', isFolder: false });
		await new Promise(r => setTimeout(r, 100)); // wait for local debounce
		
		const fileUuid = vfsController.getUuidForPath('TargetGhost.md');
		expect(fileUuid).not.toBeNull();

		// 2. Remote State: Another device moved the file to 'MovedGhost.md'
		// We safely fetch the public doc instance via getOrCreateDoc
		const localShardIndex = await syncEngine.getOrCreateDoc('shard-index');
		const remoteDoc = new LoroDoc();
		remoteDoc.import(localShardIndex.export({ mode: 'snapshot' }));
		
		const remoteTree = remoteDoc.getTree('vault-tree');
		const nodeToMove = remoteTree.getNodes().find(n => n.data.get('uuid') === fileUuid);
		nodeToMove!.data.set('filename', 'MovedGhost.md');
		remoteDoc.commit();

		const updateBytes = remoteDoc.export({ mode: 'update', from: localShardIndex.version() });
		
		// Inject the remote update into the mock network response
		remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([
			{ id: 1, documentId: 'shard-index', encryptedUpdate: updateBytes, createdAt: '2023-01-01' }
		]);
		cryptoMock.decrypt.mockResolvedValueOnce(updateBytes);

		const moveSpy = vi.fn();
		eventBus.on('CrdtNodeMoved', moveSpy);

		// 3. Trigger full sync (simulating app startup when the lagging device connects)
		await orchestrator.runFullSync();
		
		// 4. Give the VFS debouncer (50ms) time to flush
		await new Promise(r => setTimeout(r, 100)); 

		// 5. ASSERTION: The move event must NOT be swallowed. 
		expect(moveSpy).toHaveBeenCalledOnce();
		expect(moveSpy).toHaveBeenCalledWith(expect.objectContaining({
			uuid: fileUuid,
			oldPath: 'TargetGhost.md',
			newPath: 'MovedGhost.md'
		}));
	});

	it('VFS GHOST BUG 2: Edits to orphaned physical files must not silently fail due to untracked paths', async () => {
		const dummyKey = {} as any;
		orchestrator.setCryptoKey(dummyKey);

		// 1. Emulate a silently swallowed VFS move where the disk wasn't updated
		eventBus.emit('LocalFileCreated', { path: 'OrphanedDiskFile.md', isFolder: false });
		await new Promise(r => setTimeout(r, 100));
		
		const fileUuid = vfsController.getUuidForPath('OrphanedDiskFile.md');
		
		// Manually force a cache rebuild mimicking the buggy runFullSync behavior
		const localShardIndex = await syncEngine.getOrCreateDoc('shard-index');
		const targetNode = localShardIndex.getTree('vault-tree').getNodes().find(n => n.data.get('uuid') === fileUuid);
		
		targetNode!.data.set('filename', 'NewSyncedPath.md');
		localShardIndex.commit();
		vfsController.rebuildCache(); // <--- The problematic synchronous call

		const pushSpy = vi.spyOn(eventBus, 'emit');

		// 2. The user edits the orphaned ghost file left behind on their disk
		eventBus.emit('LocalFileModified', { path: 'OrphanedDiskFile.md', content: 'Ghost Edit' });
		await new Promise(r => setTimeout(r, 100));

		// 3. ASSERTION: The orchestrator must successfully identify and push the edit.
		const wasPushed = pushSpy.mock.calls.some(call => {
			const eventName = call[0];
			const payload = call[1] as any; // Cast to bypass the union type strictness
			// Check the path, because the orphaned file correctly received a BRAND NEW UUID
			return eventName === 'LocalDeltaReadyForPush' && payload.path === 'OrphanedDiskFile.md';
		});
		
		expect(wasPushed).toBe(true);
	});
});
});


