import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	FakeVaultServer,
	makeAuthor,
	remoteFilenames,
	remoteText
} from './helpers/FakeVaultServer';
import { LoroDoc } from 'loro-crdt';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { isAllowedConfigPath } from '../src/1_Domain/Utils/ConfigPathFilter';

/**
 * Exposing suite for "ghost unsynced files" after offline periods or lossy links.
 *
 * Every test here drives the real NetworkOrchestrator against a fake server that
 * mirrors the Go backend's storage semantics (append-only `vault_updates` with a
 * SERIAL id, plus a `vault_snapshots` row carrying `max_compacted_id`).
 *
 * The oracle is `materializeRemote()`: it replays exactly what the server holds
 * into a clean LoroDoc, which is precisely what a second device reconstructs in
 * `pullDocument`. An assertion on the oracle is therefore an assertion about what
 * every *other* device can actually see -- not about what the sender believes it
 * sent. That distinction is the whole point: the sender's UI says "Fully synced"
 * as soon as its local task queue drains, which is not evidence of anything.
 */

describe('Sync Integrity Audit: ghost files after packet loss', () => {
	let server: FakeVaultServer;
	let eventBus: SyncEventBus;
	let syncEngine: LoroSyncEngine;
	let vfsController: LoroVfsController;
	let orchestrator: NetworkOrchestrator;
	let remoteStoreMock: any;

	/** Content the local vault holds on disk. */
	let disk: Map<string, string>;
	/** Content delivered to this device by the sync engine, keyed by path. */
	let received: Map<string, string>;
	let statusLog: Array<{ status: string; msg: string }>;

	const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

	/** Edits a file the way VaultEventWatcher does, then drains the push queue. */
	const writeLocal = async (path: string, content: string): Promise<string> => {
		disk.set(path, content);
		await (orchestrator as any).handleLocalFileModified({ path, content });
		vfsController.flushPendingPush();
		await settle();
		return vfsController.getUuidForPath(path) as string;
	};

	beforeEach(async () => {
		server = new FakeVaultServer();
		disk = new Map<string, string>();
		received = new Map<string, string>();
		statusLog = [];

		eventBus = new SyncEventBus();
		syncEngine = new LoroSyncEngine();
		await syncEngine.localStore.clearAll();

		vfsController = new LoroVfsController(syncEngine, eventBus);
		await vfsController.initialize();

		eventBus.on('CrdtTextChanged', (payload) => {
			received.set(payload.path, payload.content);
		});

		remoteStoreMock = {
			getBulkLatestUpdateIds: vi.fn(async () => {
				// PostgresRemoteStore swallows transport failures here and returns {}
				// (PostgresRemoteStore.ts:58-65), so callers cannot tell "no updates"
				// apart from "the request never made it".
				if (server.failBulkIds) return {};
				return server.latestIds();
			}),
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
			compactSnapshot: vi.fn().mockResolvedValue(undefined),
			deleteSnapshot: vi.fn().mockResolvedValue(undefined),
			fetchManifest: vi.fn().mockResolvedValue([]),
			uploadBlobManifest: vi.fn().mockResolvedValue(undefined),
			uploadBlob: vi.fn().mockResolvedValue(undefined),
			downloadBlob: vi.fn().mockResolvedValue(null)
		};

		// Identity crypto: the audit is about which bytes reach the server, not about
		// how they are sealed. WebCryptoService is covered by 1_Cryptography.test.ts.
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
			(status, msg) => { statusLog.push({ status, msg }); },
			1000
		);
		orchestrator.initialize();
		orchestrator.setCryptoKey({} as any);
	});

	afterEach(() => {
		orchestrator.stopAll();
		vfsController.destroy();
	});

	it('GHOST FILE: a dropped push is repaired by the next push, not inherited by it', async () => {
		const documentId = await writeLocal('notes/ghost.md', 'line one\n');
		expect(remoteText(server, documentId)).toBe('line one\n');

		// A single request lost to packet loss. handleLocalChange has already advanced
		// the local doc and exported a delta `from` the pre-edit version, so this
		// delta was the only carrier of those ops.
		server.dropPushes = true;
		await writeLocal('notes/ghost.md', 'line one\nline two\n');
		server.dropPushes = false;

		// Connectivity is back. This push returns HTTP 200 and the UI shows green.
		await writeLocal('notes/ghost.md', 'line one\nline two\nline three\n');
		expect(remoteStoreMock.pushUpdate).toHaveBeenCalled();
		expect((orchestrator as any).hasConnectionError).toBe(false);

		// A delta `from` v2 would depend on ops the server never received, and Loro
		// parks such a delta unapplied: the document would be frozen at v1 for every
		// other device, for good. The document is flagged unacknowledged instead, so
		// this push carries full state and the chain is repaired.
		expect(remoteText(server, documentId)).toBe('line one\nline two\nline three\n');
	});

	it('TRUNCATED VAULT: a dropped shard-index delta does not hide the files created after it', async () => {
		await writeLocal('notes/first.md', 'first');
		expect(remoteFilenames(server)).toContain('first.md');

		// The index delta announcing second.md is lost.
		server.dropPushes = true;
		await writeLocal('notes/second.md', 'second');
		server.dropPushes = false;

		// third.md's index delta is exported from a frontier that already includes
		// second.md's tree ops, so as a delta it would depend on the lost one and be
		// parked too. The index is repaired the same way any other document is.
		await writeLocal('notes/third.md', 'third');

		// This is the "receiving device pulled only a portion of files" symptom:
		// runFullSync iterates getActiveFiles() off the index, so files missing from
		// the index are not merely stale -- they are invisible, and edits to them
		// have nowhere to go, while files already in the index keep syncing live.
		expect(remoteFilenames(server)).toEqual(
			expect.arrayContaining(['first.md', 'second.md', 'third.md'])
		);
	});

	it('DURABLE OUTBOX: an in-flight edit survives unload and is recovered by the next full sync', async () => {
		const documentId = await writeLocal('notes/outbox.md', 'v1\n');

		server.dropPushes = true;
		await writeLocal('notes/outbox.md', 'v1\nv2\n');
		server.dropPushes = false;

		// The failure is recorded in the durable outbox, not only in memory.
		expect(orchestrator.getPendingDocuments()).toContain(documentId);

		// stopAll() runs on unloadKey() and on plugin unload. It used to clear the
		// in-memory queue outright, so closing Obsidian before the next full sync
		// destroyed the only copy of the delta.
		orchestrator.stopAll();
		orchestrator.setCryptoKey({} as any);
		await orchestrator.runFullSync();

		// Reconciliation alone cannot repair this: it compares disk against the local
		// CRDT, which already contains v2, and finds them equal. Recovery has to come
		// from the outbox resending full state.
		expect(remoteText(server, documentId)).toBe('v1\nv2\n');
	});

	it('SKIPPED SWEEP: a dropped latest_ids request does not make runFullSync skip pulls', async () => {
		const authorA = makeAuthor(server, 'doc-a');
		vfsController.getActiveFiles = vi.fn(() => [{ uuid: 'doc-a', path: 'notes/a.md', type: 'file' }]) as any;

		authorA('remote v1');
		await orchestrator.runFullSync();
		expect(received.get('notes/a.md')).toBe('remote v1');

		// The newest edit is on the server...
		authorA('remote v2');
		// ...and one request is lost, so getBulkLatestUpdateIds returns {}.
		server.failBulkIds = true;
		remoteStoreMock.fetchUpdatesSince.mockClear();

		await orchestrator.runFullSync();

		// A bulk id of 0 for a document already synced past 0 is impossible: ids only
		// grow. Trusting it declared every established document current off the back
		// of one failed request, with only a console.warn to show for it, while
		// documents still at id 0 kept syncing -- which is why the vault looked alive
		// while established notes went stale.
		const pulledDocs = remoteStoreMock.fetchUpdatesSince.mock.calls.map((call: any[]) => call[0]);
		expect(pulledDocs).toContain('doc-a');
		expect(received.get('notes/a.md')).toBe('remote v2');
	});

	it('PARTIAL PULL: an incomplete sweep is not recorded as a completed sync', async () => {
		const files = Array.from({ length: 40 }, (_, i) => ({
			uuid: `doc-${i}`,
			path: `notes/${i}.md`,
			type: 'file'
		}));
		for (const file of files) makeAuthor(server, file.uuid)(`content of ${file.uuid}`);
		vfsController.getActiveFiles = vi.fn(() => files) as any;

		// One document's response is truncated mid-sweep.
		server.failUpdatesFor.add('doc-3');
		server.latencyMs = 5;

		await orchestrator.runFullSync();

		// doc-3's response genuinely fails, so it cannot be fetched. What must hold
		// is that every document is accounted for -- fetched, or recorded as still
		// outstanding -- and that a sweep with outstanding documents is not filed
		// away as a completed sync.
		const accountedFor = new Set([
			...Array.from(received.keys()),
			...orchestrator.getPendingDocuments().map(uuid => `notes/${uuid.replace('doc-', '')}.md`)
		]);
		expect(accountedFor.size).toBe(files.length);
		expect(orchestrator.isSyncInitialized()).toBe(false);
	});

	it('STICKY ERROR: an unrelated success does not clear the error while documents are outstanding', async () => {
		const files = Array.from({ length: 40 }, (_, i) => ({
			uuid: `doc-${i}`,
			path: `notes/${i}.md`,
			type: 'file'
		}));
		for (const file of files) makeAuthor(server, file.uuid)(`content of ${file.uuid}`);
		vfsController.getActiveFiles = vi.fn(() => files) as any;

		server.failUpdatesFor.add('doc-3');
		server.latencyMs = 5;
		await orchestrator.runFullSync();

		const missing = files.filter(f => !received.has(f.path));
		expect(missing.length).toBeGreaterThan(0);
		expect((orchestrator as any).hasConnectionError).toBe(true);

		// A WebSocket notification for any healthy document now arrives.
		server.failUpdatesFor.clear();
		await orchestrator.pullDocument('doc-0', 'notes/0.md', true);

		// The flag used to reset on any single success, so the sidebar returned to
		// "Fully synced" while `missing` documents had never been fetched and nothing
		// was tracking that they were outstanding.
		expect((orchestrator as any).hasConnectionError).toBe(true);
	});
});

describe('Sync Integrity Audit: verification capability', () => {
	let server: FakeVaultServer;

	beforeEach(() => {
		server = new FakeVaultServer();
	});

	it('ORACLE: replaying server state does detect divergence, so the check itself is cheap and sound', () => {
		const doc = new LoroDoc();
		const text = doc.getText('markdown');

		text.insert(0, 'synced paragraph\n');
		doc.commit();
		server.push('doc-x', new Uint8Array(doc.export({ mode: 'update' })));

		// Converged: server replay equals local content.
		expect(remoteText(server, 'doc-x')).toBe(doc.getText('markdown').toString());

		// Diverged: a local edit whose delta never reached the server.
		const beforeGap = doc.version();
		text.insert(text.length, 'unsent paragraph\n');
		doc.commit();
		void doc.export({ mode: 'update', from: beforeGap });

		expect(remoteText(server, 'doc-x')).not.toBe(doc.getText('markdown').toString());
	});

	it('VERIFY API: the orchestrator exposes a check of local content against the server', () => {
		const exposed = ['verifyVaultIntegrity', 'getPendingDocuments'].filter(
			name => typeof (NetworkOrchestrator.prototype as any)[name] === 'function'
		);

		// The other "synced" signal is activeTasks.size === 0, which only reports that
		// the local queue drained -- not that the server holds the same content.
		// Every failure above was invisible precisely because this check was missing.
		expect(exposed).toHaveLength(2);
	});


	it('SELF PLUGIN FILTER: isAllowedConfigPath ignores plugins/ilow-crdt', () => {
		const configDir = '.obsidian';
		expect(isAllowedConfigPath('.obsidian/plugins/ilow-crdt/data.json', configDir)).toBe(false);
		expect(isAllowedConfigPath('.obsidian/plugins/ilow-crdt/main.js', configDir)).toBe(false);
	});
});
