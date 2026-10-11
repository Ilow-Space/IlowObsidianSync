import { ICryptography } from '@domain/Interfaces/ICryptography';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { isBinaryPath, base64ToUint8Array } from '@domain/Utils/BinaryUtils';

/** path -> sha256 of the file's real bytes on disk. */
export type PhysicalTree = Record<string, string>;
export type TreeDiff = { onlyHere: string[]; onlyThere: string[]; differ: string[] };
export type PeerCheckReport = {
	status: 'match' | 'mismatch' | 'no-peers';
	rounds: number;
	/** Peers still differing after the last round (empty unless status is 'mismatch'). */
	peers: Array<{ deviceId: string } & TreeDiff>;
};

export const PEER_PROBE_DOC = 'peer-probe';
const PEER_REQUEST_MAX_AGE_MS = 2 * 60 * 1000;

export function diffTrees(here: PhysicalTree, there: PhysicalTree): TreeDiff {
	const onlyHere = Object.keys(here).filter(p => !(p in there));
	const onlyThere = Object.keys(there).filter(p => !(p in here));
	const differ = Object.keys(here).filter(p => p in there && here[p] !== there[p]);
	return { onlyHere, onlyThere, differ };
}

const isEmptyDiff = (d: TreeDiff) => d.onlyHere.length + d.onlyThere.length + d.differ.length === 0;

/**
 * Online devices ask each other for the tree that is really on their disk and compare it 1:1.
 * The only transport is the existing server: a request is an encrypted update on `peer-probe`
 * (the WebSocket wakes online peers), replies go to a per-request `peer-reply-<nonce>` document.
 * On a mismatch both sides heal toward the server and the requester re-checks.
 * Hidden/config paths are excluded: they legitimately differ per device.
 */
export class PeerTreeCheck {
	public static isPeerDoc(documentId: string): boolean {
		return documentId.startsWith('peer-');
	}

	private lastProbeId: number | null = null;
	private answered = new Set<string>();
	public readonly deviceId = crypto.randomUUID();

	constructor(
		private remote: IRemoteStore,
		private cryptoSvc: ICryptography,
		private repo: INoteRepository,
		private getKey: () => CryptoKey | null,
		private heal: () => Promise<void>
	) {}

	public async buildTree(): Promise<PhysicalTree> {
		const tree: PhysicalTree = {};
		for (const path of await this.repo.listAllNotes()) {
			if (path.startsWith('.') || path.includes('/.')) continue;
			const content = await this.repo.readNote(path);
			if (content === null) continue;
			const bytes = isBinaryPath(path)
				? base64ToUint8Array(content)
				: new TextEncoder().encode(content.replace(/\r\n/g, '\n'));
			tree[path] = await this.cryptoSvc.hashData(bytes);
		}
		return tree;
	}

	private async seal(obj: unknown) {
		const key = this.getKey();
		if (!key) throw new Error('Unlock the vault first.');
		return this.cryptoSvc.encrypt(new TextEncoder().encode(JSON.stringify(obj)), key);
	}

	private async open<T>(blob: Parameters<ICryptography['decrypt']>[0]): Promise<T> {
		const key = this.getKey();
		if (!key) throw new Error('Unlock the vault first.');
		return JSON.parse(new TextDecoder().decode(await this.cryptoSvc.decrypt(blob, key))) as T;
	}

	/** Responder side: call for every realtime notification; ignores everything but probes. */
	public async onNotification(documentId: string): Promise<void> {
		if (documentId !== PEER_PROBE_DOC || !this.getKey()) return;
		try {
			const since = this.lastProbeId ?? Math.max(0, (await this.remote.getLatestUpdateId(PEER_PROBE_DOC)) - 1);
			const updates = await this.remote.fetchUpdatesSince(PEER_PROBE_DOC, since);
			for (const u of updates) {
				this.lastProbeId = Math.max(this.lastProbeId ?? 0, u.id);
				const req = await this.open<{ nonce: string; from: string; ts: number; tree: PhysicalTree }>(u.encryptedUpdate);
				if (req.from === this.deviceId || this.answered.has(req.nonce) || Date.now() - req.ts > PEER_REQUEST_MAX_AGE_MS) continue;
				this.answered.add(req.nonce);
				const mine = await this.buildTree();
				await this.remote.pushUpdate(`peer-reply-${req.nonce}`, await this.seal({ from: this.deviceId, tree: mine }));
				if (!isEmptyDiff(diffTrees(mine, req.tree))) void this.heal().catch(() => undefined);
			}
		} catch (err) {
			console.error('[PeerTreeCheck] Failed to answer a peer probe:', err);
		}
	}

	private async collectReplies(nonce: string, waitMs: number): Promise<Map<string, PhysicalTree>> {
		const replies = new Map<string, PhysicalTree>();
		const doc = `peer-reply-${nonce}`;
		const started = Date.now();
		let lastNew = 0;
		let lastId = 0;
		while (Date.now() - started < waitMs) {
			await new Promise(r => setTimeout(r, 300));
			const updates = await this.remote.fetchUpdatesSince(doc, lastId).catch(() => []);
			for (const u of updates) {
				lastId = Math.max(lastId, u.id);
				const reply = await this.open<{ from: string; tree: PhysicalTree }>(u.encryptedUpdate);
				replies.set(reply.from, reply.tree);
				lastNew = Date.now();
			}
			if (replies.size > 0 && Date.now() - lastNew > 1500) break;
		}
		await this.remote.deleteSnapshot(doc).catch(() => undefined);
		return replies;
	}

	public async check(opts: { waitMs?: number; rounds?: number; settleMs?: number } = {}): Promise<PeerCheckReport> {
		const { waitMs = 6000, rounds = 3, settleMs = 2500 } = opts;
		let report: PeerCheckReport = { status: 'no-peers', rounds: 0, peers: [] };
		for (let round = 1; round <= rounds; round++) {
			const mine = await this.buildTree();
			const nonce = crypto.randomUUID();
			await this.remote.pushUpdate(PEER_PROBE_DOC, await this.seal({ nonce, from: this.deviceId, ts: Date.now(), tree: mine }));
			const replies = await this.collectReplies(nonce, waitMs);

			const peers = [...replies].map(([deviceId, tree]) => ({ deviceId, ...diffTrees(mine, tree) }));
			const bad = peers.filter(p => !isEmptyDiff(p));
			if (peers.length === 0) return { status: 'no-peers', rounds: round, peers: [] };
			if (bad.length === 0) return { status: 'match', rounds: round, peers: [] };

			report = { status: 'mismatch', rounds: round, peers: bad };
			if (round < rounds) {
				await this.heal();
				await new Promise(r => setTimeout(r, settleMs));
			}
		}
		return report;
	}
}
