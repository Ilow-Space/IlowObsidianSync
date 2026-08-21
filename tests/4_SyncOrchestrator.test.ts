import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';

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
			writeNote: vi.fn().mockResolvedValue(undefined),
			listAllNotes: vi.fn().mockResolvedValue([])
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
		expect(duration).toBeLessThan(100);
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
});
