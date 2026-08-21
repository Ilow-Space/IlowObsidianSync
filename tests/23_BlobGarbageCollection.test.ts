import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { PostgresRemoteStore } from '../src/3_Infrastructure/Postgres/PostgresRemoteStore';
import * as obsidian from 'obsidian';

describe('Client-Assisted Server-Side Garbage Collection Suite', () => {
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
			deleteSnapshot: vi.fn().mockResolvedValue(undefined),
			uploadBlobManifest: vi.fn().mockResolvedValue(undefined)
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

	it('Extracts active blob hashes from LoroVfsController loroTree nodes', () => {
		const tree = vfsController.loroTree;
		const node1 = tree.createNode();
		node1.data.set('uuid', 'node-1');
		node1.data.set('type', 'file');
		node1.data.set('filename', 'image1.png');
		node1.data.set('blob_hash', 'sha256-hash-1111');
		node1.data.set('isDeleted', false);

		const node2 = tree.createNode();
		node2.data.set('uuid', 'node-2');
		node2.data.set('type', 'file');
		node2.data.set('filename', 'image2.png');
		node2.data.set('blob_hash', 'sha256-hash-2222');
		node2.data.set('isDeleted', false);

		const node3 = tree.createNode();
		node3.data.set('uuid', 'node-3');
		node3.data.set('type', 'file');
		node3.data.set('filename', 'image3.png');
		node3.data.set('blob_hash', 'sha256-hash-3333');
		node3.data.set('isDeleted', true);

		const activeHashes = vfsController.getActiveBlobHashes();
		expect(activeHashes).toContain('sha256-hash-1111');
		expect(activeHashes).toContain('sha256-hash-2222');
		expect(activeHashes).not.toContain('sha256-hash-3333');
	});

	it('Uploads active blob manifest at completion of runFullSync()', async () => {
		const dummyKey = {} as any;
		orchestrator.setCryptoKey(dummyKey);

		const tree = vfsController.loroTree;
		const node = tree.createNode();
		node.data.set('uuid', 'asset-node-1');
		node.data.set('type', 'file');
		node.data.set('filename', 'attachment.pdf');
		node.data.set('blob_hash', 'abc123hash');
		node.data.set('isDeleted', false);

		await orchestrator.runFullSync();

		expect(remoteStoreMock.uploadBlobManifest).toHaveBeenCalledWith(['abc123hash']);
	});

	it('PostgresRemoteStore sends POST request to /api/blobs/manifest with X-Vault-Alias-ID header', async () => {
		const requestUrlSpy = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({ status: 200, json: { status: 'manifest_received' } } as any);

		const store = new PostgresRemoteStore('http://localhost:3001', 'api-key-123');
		store.setVaultAliasId('vault-alias-xyz');

		await store.uploadBlobManifest(['hash-1', 'hash-2']);

		expect(requestUrlSpy).toHaveBeenCalledWith({
			url: 'http://localhost:3001/api/blobs/manifest',
			method: 'POST',
			headers: expect.objectContaining({
				'Content-Type': 'application/json',
				'X-API-Key': 'api-key-123',
				'X-Vault-Alias-ID': 'vault-alias-xyz'
			}),
			body: JSON.stringify({ active_hashes: ['hash-1', 'hash-2'] }),
			throw: false
		});
	});
});
