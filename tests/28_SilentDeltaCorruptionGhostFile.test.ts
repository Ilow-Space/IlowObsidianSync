import { describe, it, expect, vi } from 'vitest';
import { FakeVaultServer } from './helpers/FakeVaultServer';
import { LoroDoc } from 'loro-crdt';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';

/**
 * Reproduces a live incident: one device's vault has a folder ("ILOW") that
 * another device, even after a full local wipe and re-sync, never receives --
 * while both devices agree their local shard-index watermark exactly matches
 * the server's, and no error is ever shown.
 *
 * Root cause traced live (production DB inspection + browser console checks
 * across two real devices) to LoroSyncEngine.applyUpdates: each delta in a
 * pulled batch is imported in its own try/catch (added for
 * "BUG REGRESSION: applyUpdates must gracefully handle corrupted binary
 * updates without crashing" in 2_CrdtEngine.test.ts), which correctly stops a
 * bad delta from crashing the app -- but NetworkOrchestrator.pullDocument
 * still advances fileLastSyncIds to the batch's max id regardless of which
 * deltas actually imported. Once the watermark passes a corrupted delta,
 * fetchUpdatesSince(docId, watermark) never returns it again: the loss is
 * silent (no error, no unacked entry) and permanent through every existing
 * recovery path (Verify, Push Diverged Files, Hard Reset Local, even a fresh
 * runFullSync from an empty local doc).
 */
async function buildHarness() {
	const server = new FakeVaultServer();
	const eventBus = new SyncEventBus();
	const syncEngine = new LoroSyncEngine();
	// localStore is backed by fake-indexeddb, which persists across a fresh
	// `new LoroSyncEngine()` within the same test run -- without this, a doc
	// saved by an earlier test in this file is silently reloaded here.
	await syncEngine.localStore.clearAll();
	const vfsController = new LoroVfsController(syncEngine, eventBus);

	const remoteStoreMock = {
		getBulkLatestUpdateIds: vi.fn(async () => server.latestIds()),
		getLatestUpdateId: vi.fn(async (documentId: string) => server.latestIds()[documentId] ?? 0),
		fetchSnapshotDetails: vi.fn(async (documentId: string) => server.snapshots.get(documentId) ?? null),
		fetchSnapshot: vi.fn(async () => null),
		fetchUpdatesSince: vi.fn(async (documentId: string, since: number) =>
			server.updatesSince(documentId, since).map(u => ({
				id: u.id,
				documentId: u.documentId,
				encryptedUpdate: u.encryptedUpdate
			}))
		),
		pushUpdate: vi.fn(async (documentId: string, update: any) => { server.push(documentId, update as Uint8Array); }),
		compactSnapshot: vi.fn(async (documentId: string, state: any, maxId: number, isDeleted: boolean) => {
			server.compact(documentId, state as Uint8Array, maxId, isDeleted);
		}),
		deleteSnapshot: vi.fn(async () => {}),
		fetchManifest: vi.fn(async () => []),
		uploadBlobManifest: vi.fn(async () => {}),
		uploadBlob: vi.fn(async () => {}),
		downloadBlob: vi.fn(async () => null)
	};

	const cryptoMock = {
		encrypt: vi.fn(async (data: Uint8Array) => data),
		decrypt: vi.fn(async (data: Uint8Array) => data),
		hashData: vi.fn(async () => 'stub-hash')
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

function folderNames(vfsController: LoroVfsController): string[] {
	return vfsController.getActiveFiles().filter(f => f.type === 'folder').map(f => f.path);
}

describe('Ghost File: a corrupted shard-index delta is silently and permanently dropped', () => {
	it('THEORY 1 -- pullDocument advances the watermark past a delta that failed to import', async () => {
		const { server, vfsController, orchestrator, syncEngine } = await buildHarness();
		await vfsController.initialize();

		// Origin device's real tree: a valid "Before" folder, then the delta that
		// is about to get corrupted in transit (adding "ILOW"), then a later valid
		// delta (adding "After") on the same causal chain.
		const originDoc = new LoroDoc();
		const originTree = originDoc.getTree('vault-tree');

		const beforeNode = originTree.createNode();
		beforeNode.data.set('uuid', 'folder-before');
		beforeNode.data.set('filename', 'Before');
		beforeNode.data.set('type', 'folder');
		originDoc.commit();
		server.push('shard-index', new Uint8Array(originDoc.export({ mode: 'update' })));

		const versionBeforeIlow = originDoc.version();
		const ilowNode = originTree.createNode();
		ilowNode.data.set('uuid', 'folder-ilow');
		ilowNode.data.set('filename', 'ILOW');
		ilowNode.data.set('type', 'folder');
		originDoc.commit();
		// This is what actually reaches the server for the ILOW-adding delta: not
		// the real export, but corrupted bytes. How it got corrupted (encryption
		// bug, bit rot, truncated upload) is irrelevant to what happens next.
		void versionBeforeIlow;
		server.push('shard-index', new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]));

		const versionAfterIlow = originDoc.version();
		const afterNode = originTree.createNode();
		afterNode.data.set('uuid', 'folder-after');
		afterNode.data.set('filename', 'After');
		afterNode.data.set('type', 'folder');
		originDoc.commit();
		server.push('shard-index', new Uint8Array(originDoc.export({ mode: 'update', from: versionAfterIlow })));

		expect(server.updates.map(u => u.id)).toEqual([1, 2, 3]);

		// The other device pulls the whole batch in one round trip.
		const ok = await orchestrator.pullDocument('shard-index', null, false);

		expect(ok).toBe(true);
		// FINDING: the watermark advances to the batch max (3), not to the last
		// delta that actually imported (1) or anywhere reflecting the skip. This
		// stays true even after the fix below -- watermark correctness was never
		// the point; a corrupted delta is unrecoverable through the normal path
		// regardless, so there's nothing to gain by refusing to advance past it.
		expect((orchestrator as any).fileLastSyncIds.get('shard-index')).toBe(3);
		// FIXED: this no longer stays silent. unackedDocs is still empty --
		// nothing here is a retriable network failure -- but hasConnectionError is
		// now set specifically because LoroSyncEngine.applyUpdates reported a
		// failed import, via NetworkOrchestrator.reportImportFailure. Before this
		// fix, the device believed itself fully, successfully synced.
		expect((orchestrator as any).hasConnectionError).toBe(true);
		expect((orchestrator as any).getCorruptedDocuments()).toContain('shard-index');
		expect((orchestrator as any).unackedDocs.has('shard-index')).toBe(false);

		// FINDING (worse than expected): "After" is ALSO missing, even though its
		// own delta imported without any second error being logged. Loro parks a
		// delta whose causal dependency is missing rather than throwing (see
		// FakeVaultServer.materializeRemote's comment) -- since "After" was
		// exported relative to the version right after the corrupted op, on the
		// SAME peer's causal chain, it silently never applies either. The damage
		// radius of one corrupted delta is everything the origin peer built on top
		// of it from that point on, not just that one entry.
		const names = folderNames(vfsController);
		expect(names).toContain('Before');
		expect(names).not.toContain('After');
		expect(names).not.toContain('ILOW');

		syncEngine.removeDoc('shard-index');
	});

	it('THEORY 2 -- the loss is permanent: no existing recovery path (fresh full sync from empty) gets it back', async () => {
		const { server, vfsController, orchestrator, syncEngine } = await buildHarness();
		await vfsController.initialize();

		const originDoc = new LoroDoc();
		const originTree = originDoc.getTree('vault-tree');
		const ilowNode = originTree.createNode();
		ilowNode.data.set('uuid', 'folder-ilow');
		ilowNode.data.set('filename', 'ILOW');
		ilowNode.data.set('type', 'folder');
		originDoc.commit();
		server.push('shard-index', new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

		const versionAfter = originDoc.version();
		const afterNode = originTree.createNode();
		afterNode.data.set('uuid', 'folder-after');
		afterNode.data.set('filename', 'After');
		afterNode.data.set('type', 'folder');
		originDoc.commit();
		server.push('shard-index', new Uint8Array(originDoc.export({ mode: 'update', from: versionAfter })));

		// First pull: exactly the "Hard Reset Local State" scenario -- a brand new
		// local doc (nothing cached), a full fresh pull straight from the server.
		await orchestrator.pullDocument('shard-index', null, false);
		expect(folderNames(vfsController)).not.toContain('ILOW');
		syncEngine.removeDoc('shard-index');

		// Simulate the user's exact repro: re-run the pull again (what "Hard Reset
		// Local State" and the periodic self-heal sweep both boil down to).
		const secondAttempt = await orchestrator.pullDocument('shard-index', null, false);
		expect(secondAttempt).toBe(true);
		expect((orchestrator as any).fileLastSyncIds.get('shard-index')).toBe(2);
		// fetchUpdatesSince(docId, 2) is empty -- there is nothing left to fetch,
		// by design, because the watermark already claims everything is in.
		expect(server.updatesSince('shard-index', 2)).toHaveLength(0);
		expect(folderNames(vfsController)).not.toContain('ILOW');

		syncEngine.removeDoc('shard-index');
	});

	it('WORKAROUND -- a plain re-pull still fails even after the origin compacts; force:true is required', async () => {
		const { server, vfsController, orchestrator, syncEngine } = await buildHarness();
		await vfsController.initialize();

		const originDoc = new LoroDoc();
		const originTree = originDoc.getTree('vault-tree');
		const ilowNode = originTree.createNode();
		ilowNode.data.set('uuid', 'folder-ilow');
		ilowNode.data.set('filename', 'ILOW');
		ilowNode.data.set('type', 'folder');
		originDoc.commit();
		server.push('shard-index', new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

		// Confirm the loss first.
		await orchestrator.pullDocument('shard-index', null, false);
		expect(folderNames(vfsController)).not.toContain('ILOW');
		syncEngine.removeDoc('shard-index');

		// The origin device pushes a full snapshot of ITS current local state
		// (which correctly has ILOW, since it never lost it locally) instead of an
		// incremental delta -- exactly what forceSyncAndCompact does, and what a
		// device can be made to do on demand without any new code. It reports the
		// same id (1) this device already has, because that is the id this
		// device's own watermark claims to have finished -- and that is exactly
		// the number the origin device is compacting away.
		server.compact(
			'shard-index',
			new Uint8Array(originDoc.export({ mode: 'snapshot' })),
			server.latestIds()['shard-index'],
			false
		);

		// FINDING: a plain pull is not enough. pullDocument's own cheap
		// short-circuit (getLatestUpdateId(...) <= lastId -> return true) exits
		// before ever reaching the fixed maxCompactedId<=currentLastId branch,
		// because the compaction's id and this device's watermark are identical.
		const plainRetry = await orchestrator.pullDocument('shard-index', null, false);
		expect(plainRetry).toBe(true);
		expect(folderNames(vfsController)).not.toContain('ILOW');

		// The initial corrupted pull (above) already flagged shard-index via
		// reportImportFailure -- confirm the alarm is live before recovering.
		expect((orchestrator as any).getCorruptedDocuments()).toContain('shard-index');

		// The fix: force:true bypasses that short-circuit entirely, so the
		// (now-fixed) maxCompactedId<=currentLastId branch is actually reached.
		const forced = await orchestrator.pullDocument('shard-index', null, false, undefined, true);
		expect(forced).toBe(true);
		expect(folderNames(vfsController)).toContain('ILOW');

		// And once a clean import actually succeeds, the alarm clears itself --
		// this device does not stay flagged as corrupted forever over a problem
		// that is now fixed.
		expect((orchestrator as any).getCorruptedDocuments()).not.toContain('shard-index');
		expect((orchestrator as any).hasConnectionError).toBe(false);

		syncEngine.removeDoc('shard-index');
	});
});
