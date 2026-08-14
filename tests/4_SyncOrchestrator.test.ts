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

		eventBus.emit('LocalDeltaReadyForPush', {
			documentId: 'test-doc',
			updateBinary: new Uint8Array([1, 2, 3]),
			path: 'test.md'
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(remoteStoreMock.pushUpdate).toHaveBeenCalled();
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
});
