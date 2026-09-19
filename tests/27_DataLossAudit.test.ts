import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeVaultServer, makeAuthor, remoteText } from './helpers/FakeVaultServer';
import { LoroDoc } from 'loro-crdt';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { WebCryptoService } from '../src/3_Infrastructure/Crypto/WebCryptoService';

/** A standalone Loro snapshot holding `content`, as a compaction payload. */
function snapshotOf(content: string): Uint8Array {
	const doc = new LoroDoc();
	doc.getText('markdown').insert(0, content);
	doc.commit();
	return new Uint8Array(doc.export({ mode: 'snapshot' }));
}

/**
 * Where 26_SyncIntegrityAudit covers content that never arrives, this suite covers
 * content that arrives and is then destroyed, plus the trust boundaries around it.
 * Each test pins a guard that a degraded link previously walked straight through.
 */

describe('Data Loss Audit: destructive operations on a degraded link', () => {
	let server: FakeVaultServer;
	let eventBus: SyncEventBus;
	let syncEngine: LoroSyncEngine;
	let vfsController: LoroVfsController;
	let orchestrator: NetworkOrchestrator;
	let remoteStoreMock: any;
	let disk: Map<string, string>;
	let received: Map<string, string>;

	const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

	beforeEach(async () => {
		server = new FakeVaultServer();
		disk = new Map<string, string>();
		received = new Map<string, string>();

		eventBus = new SyncEventBus();
		syncEngine = new LoroSyncEngine();
		await syncEngine.localStore.clearAll();

		vfsController = new LoroVfsController(syncEngine, eventBus);
		await vfsController.initialize();

		eventBus.on('CrdtTextChanged', (payload) => {
			received.set(payload.path, payload.content);
		});

		remoteStoreMock = {
			getBulkLatestUpdateIds: vi.fn(async () => (server.failBulkIds ? {} : server.latestIds())),
			getLatestUpdateId: vi.fn(async (documentId: string) => server.latestIds()[documentId] ?? 0),
			fetchSnapshotDetails: vi.fn(async (documentId: string) => server.snapshots.get(documentId) ?? null),
			fetchSnapshot: vi.fn(async () => null),
			fetchUpdatesSince: vi.fn(async (documentId: string, since: number) => {
				if (server.latencyMs > 0) await settle(server.latencyMs);
				if (server.failUpdatesFor.has(documentId)) throw new Error('ECONNRESET: response truncated');
				return server.updatesSince(documentId, since).map(u => ({
					id: u.id,
					documentId: u.documentId,
					encryptedUpdate: u.encryptedUpdate
				}));
			}),
			pushUpdate: vi.fn(async (documentId: string, update: any) => {
				server.push(documentId, update as Uint8Array);
			}),
			compactSnapshot: vi.fn(async (documentId: string, state: any, maxId: number, isDeleted: boolean) => {
				server.compact(documentId, state as Uint8Array, maxId, isDeleted);
			}),
			deleteSnapshot: vi.fn(async (documentId: string) => { server.softDelete(documentId); }),
			fetchManifest: vi.fn(async () => []),
			uploadBlobManifest: vi.fn(async (hashes: string[]) => { server.blobManifest = hashes; }),
			uploadBlob: vi.fn(async (hash: string, data: Uint8Array) => { server.blobs.set(hash, data); }),
			downloadBlob: vi.fn(async (hash: string) => server.blobs.get(hash) ?? null)
		};

		const cryptoMock = {
			encrypt: vi.fn(async (data: Uint8Array) => data),
			decrypt: vi.fn(async (data: Uint8Array) => data),
			hashData: vi.fn(async () => 'stub-hash')
		};

		const noteRepoMock = {
			readNote: vi.fn(async (path: string) => disk.get(path) ?? null),
			writeNote: vi.fn(async (path: string, content: string) => { disk.set(path, content); }),
			listAllNotes: vi.fn(async () => Array.from(disk.keys()))
		};

		orchestrator = new NetworkOrchestrator(
			remoteStoreMock,
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
	});

	afterEach(() => {
		orchestrator.stopAll();
		vfsController.destroy();
	});

	it('BLOB WIPE: a device whose sweep aborted does not publish a truncated manifest', async () => {
		// Two attachments exist on the server, uploaded by other devices.
		server.blobs.set('hash-alpha', new Uint8Array([1]));
		server.blobs.set('hash-beta', new Uint8Array([2]));

		// This device only knows about one of them, because its own sweep hit a
		// connection error partway and the rest of the index was never resolved.
		vfsController.getActiveBlobHashes = vi.fn(() => ['hash-alpha']) as any;
		vfsController.getActiveFiles = vi.fn(() => [
			{ uuid: 'doc-broken', path: 'notes/broken.md', type: 'file' }
		]) as any;
		server.failUpdatesFor.add('doc-broken');

		await orchestrator.runFullSync();

		// The manifest upload at the tail of runFullSync is gated on the sweep having
		// resolved every document: the list is a claim about which blobs are still
		// worth keeping, and an incomplete view makes that claim falsely.
		expect((orchestrator as any).hasConnectionError).toBe(true);
		expect(remoteStoreMock.uploadBlobManifest).not.toHaveBeenCalled();

		// So the next GC cycle has nothing new to act on. Publishing from this view
		// would have deleted the other devices' attachments permanently.
		server.runBlobGarbageCollection();
		expect(server.blobs.has('hash-beta')).toBe(true);
	});

	it('STALE COMPACT: forceSyncAndCompact refuses to compact after its own pull failed', async () => {
		const authorRemote = makeAuthor(server, 'doc-shared');

		// Another device wrote, then compacted: that content now lives only in
		// `encrypted_state`, because compaction deletes the update rows it merged.
		authorRemote('work from the other device\n');
		const baseline = remoteText(server, 'doc-shared');
		const latestId = server.latestIds()['doc-shared'];
		server.compact('doc-shared', snapshotOf('work from the other device\n'), latestId, false);
		expect(remoteText(server, 'doc-shared')).toBe(baseline);

		// This device has never seen any of it, and its refresh fails.
		server.failUpdatesFor.add('doc-shared');
		await orchestrator.forceSyncAndCompact('doc-shared');

		// pullDocument now reports failure and forceSyncAndCompact declines to compact
		// from a document it could not refresh. Compacting would have replaced the
		// authoritative base snapshot with this device's empty doc, and the update
		// rows holding the other device's work are already gone.
		expect(remoteStoreMock.compactSnapshot).not.toHaveBeenCalled();
		expect(remoteText(server, 'doc-shared')).toBe(baseline);
	});

	it('RESURRECTION: a late push from a lagging device cannot revive a deleted document', async () => {
		const authorRemote = makeAuthor(server, 'doc-doomed');
		authorRemote('content that was deleted on purpose\n');

		// Device A deletes the note.
		await orchestrator.deleteRemoteSnapshot('doc-doomed');
		expect(server.snapshots.get('doc-doomed')?.isDeleted).toBe(true);

		// Device B was offline through all of that and still holds the file. It comes
		// back and pushes one queued edit for it. handlePostUpdate refuses the write
		// instead of clearing is_deleted, which is what used to make a deleted note
		// reappear on every device after a long offline period.
		expect(() => authorRemote('content that was deleted on purpose\nplus an offline edit\n'))
			.toThrow(/deleted/);

		expect(server.snapshots.get('doc-doomed')?.isDeleted).toBe(true);
		expect(server.updatesSince('doc-doomed', 0)).toHaveLength(0);
	});

	it('ZOMBIE STATE: a deleted document is not rehydrated into the local CRDT', async () => {
		const authorRemote = makeAuthor(server, 'doc-tombstone');
		authorRemote('deleted content\n');

		// Compact first, so the content lives only in `encrypted_state`, then delete.
		// handleDeleteSnapshot clears that state as well as dropping the update rows.
		server.compact('doc-tombstone', snapshotOf('deleted content\n'), server.latestIds()['doc-tombstone'], false);
		server.softDelete('doc-tombstone');
		expect(server.snapshots.get('doc-tombstone')?.isDeleted).toBe(true);

		await orchestrator.pullDocument('doc-tombstone', 'notes/tombstone.md', true);

		// pullDocument stops as soon as it sees `isDeleted` instead of merging what it
		// was handed. Both halves matter: the merged state used to sit quietly in the
		// local CRDT, waiting for any straggler push to make it live again.
		const doc = await syncEngine.getOrCreateDoc('doc-tombstone');
		const rehydrated = doc.getText('markdown').toString();
		syncEngine.removeDoc('doc-tombstone');
		expect(rehydrated).toBe('');
	});
});

describe('Data Loss Audit: write suppression', () => {
	afterEach(() => {
		ObsidianDiskReconciler.suppressedPaths.clear();
	});

	it('SUPPRESSION: overlapping writes each hold their own guard on a path', async () => {
		const path = 'notes/contended.md';

		// Two writers guard the same path: the reconciler applying a remote change
		// and NetworkOrchestrator.safeWriteNote, which expects a 1500ms guard
		// (NetworkOrchestrator.ts:177-184) against the reconciler's 20ms one.
		ObsidianDiskReconciler.suppressPath(path);
		ObsidianDiskReconciler.suppressPath(path);

		// The shorter guard expires first. It must release only its own hold: if it
		// clears the shared entry, the other writer's write comes back through
		// VaultEventWatcher as a local edit and is pushed to the server.
		ObsidianDiskReconciler.unsuppressPath(path, 0);
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(ObsidianDiskReconciler.suppressedPaths.has(path)).toBe(true);

		// Once the second writer releases too, the path is unguarded again.
		ObsidianDiskReconciler.unsuppressPath(path, 0);
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(ObsidianDiskReconciler.suppressedPaths.has(path)).toBe(false);
	});
});

describe('Data Loss Audit: key material lifetime', () => {
	const password = 'correct-horse-battery-staple';
	const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

	beforeEach(() => {
		window.sessionStorage?.clear();
		(WebCryptoService as any).derivedKeyCache?.clear?.();
	});

	it('KEY HYGIENE: the master password never reaches sessionStorage', async () => {
		const service = new WebCryptoService();
		await service.deriveKey(password, salt);

		const storedKeys = Object.keys(window.sessionStorage);
		const leaking = storedKeys.filter(key => key.includes(password));

		// deriveKey used to cache under `ilow-key-${password}:${salt}`, leaving the
		// plaintext master password in sessionStorage for the lifetime of the
		// renderer, readable by every other plugin loaded in the same window.
		expect(leaking).toEqual([]);
	});

	it('KEY HYGIENE: the derived AES key is not persisted as an exportable JWK', async () => {
		const service = new WebCryptoService();
		await service.deriveKey(password, salt);

		const values = Object.keys(window.sessionStorage).map(key => window.sessionStorage.getItem(key) ?? '');
		const jwks = values.filter(value => value.includes('"kty"') && value.includes('"k"'));

		// The key stays extractable so Plugin.ts can hand it to Obsidian's
		// secretStorage, but it is no longer mirrored into sessionStorage, which has
		// none of secretStorage's protections.
		expect(jwks).toEqual([]);
	});

	it('KEY HYGIENE: cached key material can be purged on logout', async () => {
		const service = new WebCryptoService();
		await service.deriveKey(password, salt);

		// Plugin.unloadKey() clears its own reference and deletes the secretStorage
		// entry; without this hook the static derivedKeyCache kept a usable key alive
		// until Obsidian restarted, so "log out" did not log out.
		const purge = (WebCryptoService as any).clearCachedKeys;
		expect(typeof purge).toBe('function');

		purge();
		expect((WebCryptoService as any).derivedKeyCache.size).toBe(0);
	});
});
