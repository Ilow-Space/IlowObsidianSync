import { LoroDoc } from 'loro-crdt';

/**
 * In-memory stand-in for the Go backend, mirroring its storage semantics so that
 * client-side tests can assert on what other devices would actually see.
 *
 * Every method documents the handler in `backend/main.go` it models. Where the
 * backend does something surprising (resurrecting soft-deleted rows, keeping a
 * stale base snapshot after a delete), this mirrors it faithfully rather than
 * doing the sensible thing -- the point is to reproduce production behaviour.
 */

export interface ServerUpdate {
	id: number;
	documentId: string;
	encryptedUpdate: Uint8Array;
}

export interface ServerSnapshot {
	encryptedState: Uint8Array | null;
	maxCompactedId: number;
	isDeleted: boolean;
}

export class FakeVaultServer {
	public updates: ServerUpdate[] = [];
	public snapshots = new Map<string, ServerSnapshot>();
	/** Last active-hash list accepted by POST /api/blobs/manifest. */
	public blobManifest: string[] | null = null;
	/** Content-addressed blob store, keyed by hash. */
	public blobs = new Map<string, Uint8Array>();

	/** Simulates the lossy link: POST /api/updates never reaches the server. */
	public dropPushes = false;
	/** Simulates a dropped GET /api/vault/latest_ids. */
	public failBulkIds = false;
	/** Document ids whose GET /api/snapshots/{id}/updates fails. */
	public failUpdatesFor = new Set<string>();
	/** Per-request latency, so concurrency effects are observable. */
	public latencyMs = 0;

	private seq = 0;

	/** Models handlePostUpdate. */
	public push(documentId: string, encryptedUpdate: Uint8Array): void {
		if (this.dropPushes) throw new Error('ECONNRESET: request dropped in flight');

		const existing = this.snapshots.get(documentId);
		if (existing) {
			// The upsert no longer clears is_deleted, and a push aimed at a deleted
			// row is refused outright so a straggler cannot resurrect the document.
			if (existing.isDeleted) throw new Error('HTTP 409: document is deleted');
		} else {
			this.snapshots.set(documentId, { encryptedState: null, maxCompactedId: 0, isDeleted: false });
		}

		this.seq += 1;
		this.updates.push({ id: this.seq, documentId, encryptedUpdate });
	}

	/**
	 * Models handlePostCompact, including its refusal to move max_compacted_id
	 * backwards: a client whose own refresh failed reports a lower id than the row
	 * already holds, and honouring that would delete work it never saw.
	 */
	public compact(documentId: string, encryptedState: Uint8Array, maxId: number, isDeleted: boolean): void {
		const existing = this.snapshots.get(documentId);
		if (existing && maxId < existing.maxCompactedId) {
			throw new Error('HTTP 409: stale compaction refused');
		}
		this.snapshots.set(documentId, { encryptedState, maxCompactedId: maxId, isDeleted });
		this.updates = this.updates.filter(u => !(u.documentId === documentId && u.id <= maxId));
	}

	/**
	 * Models handleDeleteSnapshot: the row is soft deleted, its updates dropped,
	 * and the base state cleared. Leaving `encrypted_state` behind let a later pull
	 * merge the tombstone's content straight back into a client's CRDT.
	 */
	public softDelete(documentId: string): void {
		const snap = this.snapshots.get(documentId);
		if (snap) {
			snap.isDeleted = true;
			snap.encryptedState = null;
			snap.maxCompactedId = 0;
		}
		this.updates = this.updates.filter(u => u.documentId !== documentId);
	}

	/** Models handleGetBulkLatestUpdateIDs: GREATEST(max_compacted_id, MAX(u.id)). */
	public latestIds(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const [documentId, snap] of this.snapshots.entries()) {
			out[documentId] = snap.maxCompactedId;
		}
		for (const u of this.updates) {
			out[u.documentId] = Math.max(out[u.documentId] ?? 0, u.id);
		}
		return out;
	}

	public updatesSince(documentId: string, since: number): ServerUpdate[] {
		return this.updates.filter(u => u.documentId === documentId && u.id > since);
	}

	/**
	 * Models runBlobGarbageCollection. The server now unions every manifest inside
	 * the retention window, so this only ever sees the union; a device that never
	 * published (because its sweep was incomplete) contributes nothing.
	 */
	public runBlobGarbageCollection(): void {
		if (this.blobManifest === null || this.blobManifest.length === 0) return;
		const active = new Set(this.blobManifest);
		for (const hash of Array.from(this.blobs.keys())) {
			if (!active.has(hash)) this.blobs.delete(hash);
		}
	}
}

/** Replays server state into a clean doc: what another device reconstructs. */
export function materializeRemote(server: FakeVaultServer, documentId: string, container: 'text' | 'tree'): LoroDoc {
	const doc = new LoroDoc();
	if (container === 'text') doc.getText('markdown');
	else doc.getTree('vault-tree');

	const snap = server.snapshots.get(documentId);
	if (snap?.encryptedState) {
		try { doc.import(snap.encryptedState); } catch { /* unappliable state */ }
	}
	for (const update of server.updatesSince(documentId, 0)) {
		// Loro parks updates whose causal dependencies are missing instead of
		// throwing, which is why a gap is silent rather than loud.
		try { doc.import(update.encryptedUpdate); } catch { /* unappliable delta */ }
	}
	doc.commit();
	return doc;
}

export function remoteText(server: FakeVaultServer, documentId: string): string {
	return materializeRemote(server, documentId, 'text').getText('markdown').toString();
}

/** Filenames another device would find in the replayed shard-index. */
export function remoteFilenames(server: FakeVaultServer): string[] {
	const tree = materializeRemote(server, 'shard-index', 'tree').getTree('vault-tree');
	const names: string[] = [];
	for (const node of tree.getNodes()) {
		try {
			if (node.isDeleted() || node.data.get('isDeleted') === true) continue;
			const filename = node.data.get('filename');
			if (typeof filename === 'string' && filename) names.push(filename);
		} catch { /* skip unreadable node */ }
	}
	return names;
}

/** A second device authoring straight into the server. */
export function makeAuthor(server: FakeVaultServer, documentId: string): (content: string) => void {
	const doc = new LoroDoc();
	doc.getText('markdown');
	return (content: string) => {
		const from = doc.version();
		const text = doc.getText('markdown');
		if (text.length > 0) text.delete(0, text.length);
		text.insert(0, content);
		doc.commit();
		server.push(documentId, new Uint8Array(doc.export({ mode: 'update', from })));
	};
}
