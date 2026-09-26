import { describe, it, expect, vi } from 'vitest';
import { FakeVaultServer } from './helpers/FakeVaultServer';
import { LoroDoc } from 'loro-crdt';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';

/**
 * The read-side race (VaultEventWatcher.readTFileContent, fixed in
 * tests/29_BinaryPasteEmptyReadRace.test.ts) is one way an empty buffer can
 * reach the upload path. This is the second line of defense: even if
 * something upstream ever hands NetworkOrchestrator an empty payload for a
 * binary file -- a future regression, a different race, a genuinely
 * zero-byte file some other tool created -- nothing previously checked
 * before hashing, uploading and recording it as if it were the file's real
 * content. A live incident confirmed exactly this via the server's blob
 * store: a file's recorded hash was e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855,
 * the well-known SHA-256 of an empty input, uploaded and accepted as valid.
 */
async function buildHarness() {
	const server = new FakeVaultServer();
	const eventBus = new SyncEventBus();
	const syncEngine = new LoroSyncEngine();
	await syncEngine.localStore.clearAll();
	const vfsController = new LoroVfsController(syncEngine, eventBus);
	await vfsController.initialize();

	const remoteStoreMock = {
		getBulkLatestUpdateIds: vi.fn(async () => server.latestIds()),
		getLatestUpdateId: vi.fn(async (documentId: string) => server.latestIds()[documentId] ?? 0),
		fetchSnapshotDetails: vi.fn(async (documentId: string) => server.snapshots.get(documentId) ?? null),
		fetchSnapshot: vi.fn(async () => null),
		fetchUpdatesSince: vi.fn(async (documentId: string, since: number) =>
			server.updatesSince(documentId, since).map(u => ({ id: u.id, documentId: u.documentId, encryptedUpdate: u.encryptedUpdate }))
		),
		pushUpdate: vi.fn(async (documentId: string, update: any) => { server.push(documentId, update as Uint8Array); }),
		compactSnapshot: vi.fn(async () => {}),
		deleteSnapshot: vi.fn(async () => {}),
		fetchManifest: vi.fn(async () => []),
		uploadBlobManifest: vi.fn(async () => {}),
		uploadBlob: vi.fn(async (hash: string, data: Uint8Array) => { server.blobs.set(hash, data); }),
		downloadBlob: vi.fn(async (hash: string) => server.blobs.get(hash) ?? null)
	};

	const cryptoMock = {
		encrypt: vi.fn(async (data: Uint8Array) => data),
		decrypt: vi.fn(async (data: Uint8Array) => data),
		hashData: vi.fn(async (data: Uint8Array) => {
			// A real SHA-256 would work too, but a length-tagged stub keeps the
			// assertions readable and still distinguishes "no bytes" from "some
			// bytes" -- the only distinction this guard cares about.
			return `stub-hash-len-${data.length}`;
		})
	};

	const noteRepoMock = {
		readNote: vi.fn(async () => null),
		writeNote: vi.fn(async () => {}),
		listAllNotes: vi.fn(async () => [])
	};

	const orchestrator = new NetworkOrchestrator(
		remoteStoreMock as any,
		cryptoMock as any,
		syncEngine,
		noteRepoMock as any,
		vfsController,
		eventBus,
		vi.fn(),
		1000
	);
	orchestrator.initialize();
	orchestrator.setCryptoKey({} as any);

	return { server, eventBus, syncEngine, vfsController, orchestrator, remoteStoreMock };
}

/** Registers a binary file node in the VFS tree so getUuidForPath resolves. */
function registerBinaryNode(vfsController: LoroVfsController, uuid: string, path: string): void {
	const doc = (vfsController as any).treeDoc as LoroDoc;
	const tree = doc.getTree('vault-tree');
	const node = tree.createNode();
	node.data.set('uuid', uuid);
	node.data.set('filename', path.split('/').pop());
	node.data.set('type', 'file');
	doc.commit();
	vfsController.rebuildCache();
}

describe('Zero-Byte Binary Upload Guard: an empty read must not be committed as real content', () => {
	it('refuses to upload or record a hash for empty binary content', async () => {
		const { vfsController, orchestrator, remoteStoreMock, eventBus, syncEngine } = await buildHarness();
		const uuid = 'img-empty-uuid';
		registerBinaryNode(vfsController, uuid, 'Assets/pasted.png');

		eventBus.emit('LocalFileModified', { path: 'Assets/pasted.png', content: '' });
		await new Promise(resolve => setTimeout(resolve, 20));

		expect(remoteStoreMock.uploadBlob).not.toHaveBeenCalled();
		expect(vfsController.getBlobHashForUuid(uuid)).toBeNull();

		orchestrator.stopAll();
		syncEngine.destroy();
	});

	it('still uploads and records the hash for genuine, non-empty content', async () => {
		const { vfsController, orchestrator, remoteStoreMock, eventBus, syncEngine } = await buildHarness();
		const uuid = 'img-real-uuid';
		registerBinaryNode(vfsController, uuid, 'Assets/pasted.png');

		// Base64 for a few real bytes -- content doesn't need to be a real PNG,
		// only non-empty once decoded.
		eventBus.emit('LocalFileModified', { path: 'Assets/pasted.png', content: 'aGVsbG8=' });
		await new Promise(resolve => setTimeout(resolve, 20));

		expect(remoteStoreMock.uploadBlob).toHaveBeenCalledTimes(1);
		expect(vfsController.getBlobHashForUuid(uuid)).toBe('stub-hash-len-5');

		orchestrator.stopAll();
		syncEngine.destroy();
	});

	it('does not re-upload when the content has not actually changed', async () => {
		const { vfsController, orchestrator, remoteStoreMock, eventBus, syncEngine } = await buildHarness();
		const uuid = 'img-unchanged-uuid';
		registerBinaryNode(vfsController, uuid, 'Assets/pasted.png');

		eventBus.emit('LocalFileModified', { path: 'Assets/pasted.png', content: 'aGVsbG8=' });
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(remoteStoreMock.uploadBlob).toHaveBeenCalledTimes(1);

		eventBus.emit('LocalFileModified', { path: 'Assets/pasted.png', content: 'aGVsbG8=' });
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(remoteStoreMock.uploadBlob).toHaveBeenCalledTimes(1);

		orchestrator.stopAll();
		syncEngine.destroy();
	});
});
