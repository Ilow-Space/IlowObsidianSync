import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TFile } from 'obsidian';
import { createHash } from 'node:crypto';
import { LoroDoc } from 'loro-crdt';
import { CryptoUtils } from '../src/3_Infrastructure/Crypto/CryptoUtils';
import { PeerTreeCheck } from '../src/2_Application/Sync/PeerTreeCheck';
import { FakeVaultServer, materializeRemote } from './helpers/FakeVaultServer';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';

/**
 * E2E hand-off: two registered devices, both offline. A comes online, creates
 * files, goes offline. B comes online while A stays offline and must receive
 * every file -- through the real orchestrator + disk reconciler, with a clean
 * console, and with `verifyVaultIntegrity` agreeing with what is on disk.
 */

/** Per-device in-memory Dexie stand-in: both devices must not share one IndexedDB. */
class MemStore {
	private snaps = new Map<string, Uint8Array>();
	private outbox = new Map<string, any>();
	async markUnacked(documentId: string, path: string | null) { this.outbox.set(documentId, { documentId, path, failedAt: Date.now() }); }
	async clearUnacked(documentId: string) { this.outbox.delete(documentId); }
	async listUnacked() { return Array.from(this.outbox.values()); }
	async saveDocumentState(id: string, s: Uint8Array) { this.snaps.set(id, s); }
	async loadDocumentState(id: string) { return this.snaps.get(id) ?? null; }
	async deleteDocumentState(id: string) { this.snaps.delete(id); }
	async clearAll() { this.snaps.clear(); }
	close() {}
}

class Device {
	online = false;
	disk = new Map<string, string>();
	engine = new LoroSyncEngine();
	bus = new SyncEventBus();
	vfs!: LoroVfsController;
	orch!: NetworkOrchestrator;
	seedLocal!: (path: string, content: string) => void;
	/** Every adapter-level (config) write, so a test can see if a file was ever blanked. */
	writes: Array<[string, string]> = [];
	peer!: PeerTreeCheck;
	reconciler!: ObsidianDiskReconciler;

	constructor(private server: FakeVaultServer) {
		((server as any).devices ??= []).push(this);
	}

	async start() {
		(this.engine as any).localStore = new MemStore();
		this.vfs = new LoroVfsController(this.engine, this.bus, undefined, '.obsidian');
		await this.vfs.initialize();

		const files = new Map<string, TFile>();
		const mk = (p: string) => { const f = new TFile(); (f as any).path = p; (f as any).name = p.split('/').pop(); files.set(p, f); return f; };
		this.seedLocal = (p: string, c: string) => { mk(p); this.disk.set(p, c); };
		const app: any = {
			vault: {
				configDir: '.obsidian',
				on: vi.fn(), off: vi.fn(),
				getAbstractFileByPath: (p: string) => files.get(p) ?? null,
				getFiles: () => Array.from(files.values()),
				getAllLoadedFiles: () => Array.from(files.values()),
				create: async (p: string, c: string) => { mk(p); this.disk.set(p, c); },
				createBinary: async (p: string, buf: ArrayBuffer) => { mk(p); this.disk.set(p, Buffer.from(buf).toString('base64')); },
				modifyBinary: async (f: any, buf: ArrayBuffer) => { this.disk.set(f.path, Buffer.from(buf).toString('base64')); },
				readBinary: async (f: any) => { const b = Buffer.from(this.disk.get(f.path) ?? '', 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
				createFolder: async () => {},
				modify: async (f: any, c: string) => { this.disk.set(f.path, c); },
				read: async (f: any) => this.disk.get(f.path) ?? '',
				trash: async (f: any) => { files.delete(f.path); this.disk.delete(f.path); },
				adapter: {
					exists: async (p: string) => this.disk.has(p) || files.has(p),
					read: async (p: string) => this.disk.get(p) ?? '',
					write: async (p: string, c: string) => { this.writes.push([p, c]); this.disk.set(p, c); },
					mkdir: async () => {}
				}
			},
			fileManager: {
				renameFile: async (f: any, newPath: string) => {
					const content = this.disk.get(f.path) ?? '';
					files.delete(f.path); this.disk.delete(f.path);
					f.path = newPath; f.name = newPath.split('/').pop();
					files.set(newPath, f); this.disk.set(newPath, content);
				},
				trashFile: async (f: any) => { files.delete(f.path); this.disk.delete(f.path); } }
		};

		const net = () => { if (!this.online) throw new Error('offline'); };
		const remote: any = {
			getBulkLatestUpdateIds: async () => { if (!this.online) return {}; return this.server.latestIds(); },
			getLatestUpdateId: async (id: string) => { net(); return this.server.latestIds()[id] ?? 0; },
			fetchSnapshotDetails: async (id: string) => { net(); return this.server.snapshots.get(id) ?? null; },
			fetchUpdatesSince: async (id: string, since: number) => { net(); return this.server.updatesSince(id, since); },
			pushUpdate: async (id: string, u: Uint8Array, encPath?: unknown) => {
				net(); this.server.push(id, u);
				if (encPath) ((this.server as any).paths ??= new Map()).set(id, encPath);
				// the realtime socket: every other online device hears about the update
				for (const d of (this.server as any).devices as Device[]) {
					if (d !== this && d.online && d.peer) setTimeout(() => void d.peer.onNotification(id), 0);
				}
			},
			compactSnapshot: async () => {}, deleteSnapshot: async () => {},
			fetchManifest: async () => {
				net();
				const paths: Map<string, unknown> = (this.server as any).paths ?? new Map();
				return Object.keys(this.server.latestIds()).filter(id => id !== 'shard-index').map(id => ({
					document_id: id,
					encrypted_path: paths.has(id) ? CryptoUtils.stringToHex(JSON.stringify(paths.get(id))) : undefined,
					is_deleted: this.server.snapshots.get(id)?.isDeleted ?? false,
					updated_at: ''
				}));
			}, uploadBlobManifest: async () => {},
			uploadBlob: async (h: string, b: Uint8Array) => { net(); this.server.blobs.set(h, b); },
			downloadBlob: async (h: string) => { net(); return this.server.blobs.get(h) ?? null; }
		};
		const crypto: any = { encrypt: async (d: Uint8Array) => d, decrypt: async (d: any) => (d instanceof Uint8Array ? d : Uint8Array.from(Object.values(d))), // blobs arrive JSON-wrapped
			 hashData: async (d: Uint8Array) => createHash('sha256').update(d).digest('hex') };
		const repo: any = {
			readNote: async (p: string) => this.disk.get(p) ?? null,
			writeNote: async (p: string, c: string) => { this.disk.set(p, c); },
			listAllNotes: async () => Array.from(this.disk.keys())
		};

		this.reconciler = new ObsidianDiskReconciler(app, this.engine, this.bus);
		this.reconciler.initialize();
		this.orch = new NetworkOrchestrator(remote, crypto, this.engine, repo, this.vfs, this.bus, () => {}, 1000, this.reconciler);
		this.orch.initialize();
		this.orch.setCryptoKey({} as any);
		this.peer = new PeerTreeCheck(remote, crypto, repo, () => ({} as any), () => this.orch.runIntegritySweep());
	}

	async createFile(path: string, content: string) {
		this.seedLocal(path, content);   // the file really exists in the vault, as it would after the user creates it
		if (/\.(png|pdf|jpg)$/.test(path)) {
			this.bus.emit('LocalFileCreated', { path, isFolder: false, content });
			this.vfs.flushPendingPush();
			this.bus.emit('LocalFileModified', { path, content });
			await settle(80);
			this.vfs.flushPendingPush();
			await settle();
			return;
		}
		await (this.orch as any).handleLocalFileModified({ path, content });
		this.vfs.flushPendingPush();
		await settle();
	}

	async goOnline() { this.online = true; await this.orch.runFullSync(); await settle(); }
	goOffline() { this.online = false; }

	stop() {
		this.orch.stopAll(); this.vfs.destroy(); this.engine.destroy(); this.bus.destroy();
	}
}

const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

describe('E2E: offline hand-off between two users', () => {
	let server: FakeVaultServer;
	let a: Device, b: Device;
	let errors: any[][], warns: any[][];

	beforeEach(async () => {
		errors = []; warns = [];
		vi.spyOn(console, 'error').mockImplementation((...x) => { errors.push(x); });
		vi.spyOn(console, 'warn').mockImplementation((...x) => { warns.push(x); });
		server = new FakeVaultServer();
		a = new Device(server); b = new Device(server);
		await a.start(); await b.start();   // both registered, both offline
	});

	afterEach(() => { a.stop(); b.stop(); vi.restoreAllMocks(); });

	it('B pulls every file A created, although A is offline again; verify agrees; console clean', async () => {
		await a.goOnline();
		await a.createFile('root.md', 'root data');
		await a.createFile('folder/nested.md', 'nested data\nline 2');
		await a.createFile('folder/deep/more.md', 'deep data');
		a.goOffline();

		await b.goOnline();
		await settle(100);

		expect(Object.fromEntries(b.disk)).toEqual({
			'root.md': 'root data',
			'folder/nested.md': 'nested data\nline 2',
			'folder/deep/more.md': 'deep data'
		});

		const report = await b.orch.verifyVaultIntegrity();
		expect(report.diverged).toEqual([]);
		expect(report.unreachable).toEqual([]);
		expect(report.checked).toBe(3);

		// Nothing was lost on the server either.
		expect(server.latestIds()['shard-index']).toBeGreaterThan(0);
		expect(errors).toEqual([]);
		expect(warns).toEqual([]);
	});

	it('verify must not call a file "in sync" when B knows it but it is missing on disk', async () => {
		await a.goOnline();
		await a.createFile('lost.md', 'precious');
		a.goOffline();
		await b.goOnline();
		await settle(100);
		expect(b.disk.get('lost.md')).toBe('precious');

		// The file vanishes locally (failed write, external delete while suppressed, ...)
		// while the CRDT and the watermark still say "synced".
		b.disk.delete('lost.md');

		const report = await b.orch.verifyVaultIntegrity();
		expect(report.diverged).toContain('lost.md');

		// Self-heal: the next sweep restores it from the server, with A still offline.
		await (b.orch as any).runIntegritySweep();
		await settle(100);
		expect(b.disk.get('lost.md')).toBe('precious');
	});

	it('verify covers attachments: a missing or altered image is reported and restored', async () => {
		const png = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4, 5]).toString('base64');
		await a.goOnline();
		await a.createFile('img/pic.png', png);
		a.goOffline();
		await b.goOnline();
		await settle(100);
		expect(b.disk.get('img/pic.png')).toBe(png);
		expect((await b.orch.verifyVaultIntegrity()).diverged).toEqual([]);

		b.disk.delete('img/pic.png');
		expect((await b.orch.verifyVaultIntegrity()).diverged).toContain('img/pic.png');
		await (b.orch as any).runIntegritySweep();
		await settle(100);
		expect(b.disk.get('img/pic.png')).toBe(png);

		b.disk.set('img/pic.png', Buffer.from([9, 9, 9]).toString('base64'));
		expect((await b.orch.verifyVaultIntegrity()).diverged).toContain('img/pic.png');
	});

	let serverUpdatesAtStart = 0;
	describe('stale local copy of a server file', () => {
		beforeEach(async () => {
			await a.goOnline();
			await a.createFile('notes/a.md', 'server truth');
			await a.createFile('notes/b.md', 'server b');
			a.goOffline();
			b.seedLocal('notes/a.md', 'stale local edit that must lose');
			b.seedLocal('notes/b.md', 'server b');
			b.seedLocal('notes/local-only.md', 'never uploaded');
			serverUpdatesAtStart = server.updates.length;
		});

		it('plain sync (diagnostic): what happens to a stale same-path file', async () => {
			await b.goOnline();
			await settle(150);
			console.log('PLAIN SYNC B DISK:', JSON.stringify(Object.fromEntries(b.disk)), 'ERR', errors.length);
		});

		it('forcePullServerState: server content overwrites local, no conflict copies, local-only file kept & reported', async () => {
			b.online = true;
			const res = await b.orch.forcePullServerState();
			await settle(150);

			expect(b.disk.get('notes/a.md')).toBe('server truth');
			expect(b.disk.get('notes/b.md')).toBe('server b');
			expect([...b.disk.keys()].filter(k => k.includes('Conflict'))).toEqual([]);
			expect(res.localOnly).toEqual(['notes/local-only.md']);
			expect(b.disk.get('notes/local-only.md')).toBe('never uploaded');
			expect((await b.orch.verifyVaultIntegrity()).diverged).toEqual([]);
			// the server was not modified by the force pull
			expect(server.updates.length).toBe(serverUpdatesAtStart);
			expect(errors).toEqual([]);
		});
	});

	describe('long nested paths', () => {
		const deep = Array.from({ length: 12 }, (_, i) => `level${i}-${'x'.repeat(20)}`).join('/') + '/deep note.md';
		beforeEach(async () => {
			await a.goOnline();
			await a.createFile(deep, 'deep truth');
			await a.createFile('top.md', 'top');
			a.goOffline();
		});

		it('normal pull delivers it', async () => {
			await b.goOnline();
			await settle(150);
			expect(b.disk.get(deep)).toBe('deep truth');
			expect([...b.disk.keys()].filter(k => k.includes('Conflict'))).toEqual([]);
			expect((await b.orch.verifyVaultIntegrity()).diverged).toEqual([]);
		});

		it('force pull delivers it and overwrites a stale copy, with existing parent folders', async () => {
			b.seedLocal(deep, 'stale');
			b.online = true;
			await b.orch.forcePullServerState();
			await settle(150);
			expect(b.disk.get(deep)).toBe('deep truth');
			expect([...b.disk.keys()].filter(k => k.includes('Conflict'))).toEqual([]);
		});
	});

	describe('peer tree check', () => {
		const fast = { waitMs: 2500, settleMs: 150 };

		it('reports no-peers when nobody else is online', async () => {
			await a.goOnline();
			await a.createFile('only.md', 'x');
			expect((await a.peer.check({ waitMs: 800, settleMs: 50 })).status).toBe('no-peers');
		});

		it('matches 1:1 when both online devices hold the same physical files', async () => {
			await a.goOnline();
			await a.createFile('n/one.md', 'one');
			await a.createFile('pic.png', Buffer.from([1, 2, 3, 4]).toString('base64'));
			await b.goOnline();
			await settle(150);
			const r = await a.peer.check(fast);
			expect(r).toEqual({ status: 'match', rounds: 1, peers: [] });
			expect(errors).toEqual([]);
		});

		it('on a mismatch both sides heal and a later round matches', async () => {
			await a.goOnline();
			await a.createFile('shared.md', 'v1');
			await b.goOnline();
			await settle(150);
			expect(b.disk.get('shared.md')).toBe('v1');

			b.disk.set('shared.md', 'drifted on B only');   // physical drift the sync never saw
			b.disk.delete('missing-soon.md');
			const r = await a.peer.check({ ...fast, rounds: 4 });
			await settle(150);

			expect(r.status).toBe('match');
			expect(r.rounds).toBeGreaterThan(1);
			expect(a.disk.get('shared.md')).toBe(b.disk.get('shared.md'));
			expect(errors).toEqual([]);
		});
	});

	describe('unknown server documents', () => {
		it('are downloaded, classified once, warned once, and listed by verify', async () => {
			await a.goOnline();
			const ghost = new LoroDoc();
			ghost.getText('markdown').insert(0, 'who am i');
			ghost.commit();
			server.push('ghost-doc', ghost.export({ mode: 'snapshot' }));

			await a.orch.handleUnknownDocument('ghost-doc');
			await a.orch.handleUnknownDocument('ghost-doc');

			expect(a.orch.getOrphanDocs()).toEqual([{ documentId: 'ghost-doc', kind: 'text' }]);
			expect(warns.filter(w => String(w[0]).includes('ghost-doc')).length).toBe(1);
			expect((await a.orch.verifyVaultIntegrity()).orphans).toEqual([{ documentId: 'ghost-doc', kind: 'text' }]);
		});
	});

	describe('one path = one live uuid (deterministic collision rule)', () => {
		const unexpected = () => errors.filter(e => !String(e[0]).includes('Failed to push local delta'));
		const live = (d: Device) => d.vfs.getActiveFiles()
			.map(f => `${f.type}:${f.path}=${f.uuid}`).sort();

		/** Both devices created the same path offline; sync until quiet, in both directions. */
		const syncBoth = async () => {
			await a.goOnline(); await settle(150);
			a.goOffline();
			await b.goOnline(); await settle(300);
			await a.goOnline(); await settle(300);
			for (let i = 0; i < 2; i++) {
				await b.orch.runFullSync(); await a.orch.runFullSync(); await settle(300);
			}
		};

		const LOW = '00000000-0000-4000-8000-000000000001';
		const HIGH = 'ffffffff-0000-4000-8000-000000000002';
		/** Makes the next two uuids this process mints come out in the given order: A's first, then B's. */
		const mint = (forA: string, forB: string) => {
			const q = [forA, forB];
			const real = window.crypto.randomUUID.bind(window.crypto);
			vi.spyOn(window.crypto, 'randomUUID').mockImplementation((() => q.shift() ?? real()) as any);
		};
		const orders = [['A lower', LOW, HIGH], ['B lower', HIGH, LOW]] as const;

		it.each(orders)('identical content (%s): one document survives, no conflict copy, both devices agree', async (_n, ua, ub) => {
			mint(ua, ub);
			await a.createFile('same.md', 'identical');
			await b.createFile('same.md', 'identical');
			expect([a.vfs.getUuidForPath('same.md'), b.vfs.getUuidForPath('same.md')]).toEqual([ua, ub]);
			await syncBoth();

			expect(live(a)).toEqual(live(b));
			expect(a.vfs.getActiveFiles().filter(f => f.type === 'file').map(f => f.path)).toEqual(['same.md']);
			expect(a.vfs.getUuidForPath('same.md')).toBe(LOW);
			expect([...a.disk.keys()]).toEqual(['same.md']);
			expect([...b.disk.keys()]).toEqual(['same.md']);
			expect(unexpected()).toEqual([]);
		});

		it.each(orders)('different content (%s): lowest uuid keeps the path, the other is the same named conflict copy everywhere, nothing lost', async (_n, ua, ub) => {
			mint(ua, ub);
			await a.createFile('same.md', 'from A');
			await b.createFile('same.md', 'from B');
			await syncBoth();

			expect(live(a)).toEqual(live(b));
			const copyPath = `same (conflict ${HIGH.substring(0, 6)}).md`;
			expect(a.vfs.getUuidForPath('same.md')).toBe(LOW);
			expect(a.vfs.getUuidForPath(copyPath)).toBe(HIGH);
			expect(new Set(a.disk.values())).toEqual(new Set(['from A', 'from B']));
			expect(new Map(a.disk)).toEqual(new Map(b.disk));
			expect(a.disk.size).toBe(2);
			expect(unexpected()).toEqual([]);
		});

		it('duplicate folders merge into one and keep every child', async () => {
			await a.createFile('dir/from-a.md', 'a');
			await b.createFile('dir/from-b.md', 'b');
			await syncBoth();

			expect(live(a)).toEqual(live(b));
			expect(a.vfs.getActiveFiles().filter(f => f.type === 'folder').map(f => f.path)).toEqual(['dir']);
			expect(Object.fromEntries(a.disk)).toEqual({ 'dir/from-a.md': 'a', 'dir/from-b.md': 'b' });
			expect(Object.fromEntries(b.disk)).toEqual({ 'dir/from-a.md': 'a', 'dir/from-b.md': 'b' });
			expect(unexpected()).toEqual([]);
		});
	});

	describe('documents the index lost', () => {
		const live = (d: Device) => d.vfs.getActiveFiles().map(f => `${f.type}:${f.path}=${f.uuid}`).sort();

		it('are re-indexed at their original path with the same uuid, and every device converges', async () => {
			await a.goOnline();
			await a.createFile('lost/note.md', 'precious');
			await a.createFile('plain.md', 'p');
			const uuids = { note: a.vfs.getUuidForPath('lost/note.md'), plain: a.vfs.getUuidForPath('plain.md') };
			a.goOffline();
			// every index delta the server ever received is gone: a dropped / parked index update
			server.updates = server.updates.filter(u => u.documentId !== 'shard-index');

			await b.goOnline();
			await settle(400);
			expect(b.disk.get('lost/note.md')).toBe('precious');
			expect(b.disk.get('plain.md')).toBe('p');
			expect(b.vfs.getUuidForPath('lost/note.md')).toBe(uuids.note);
			expect(b.vfs.getUuidForPath('plain.md')).toBe(uuids.plain);
			expect(server.updates.some(u => u.documentId === 'shard-index')).toBe(true);   // the repair was pushed

			await a.goOnline();
			for (let i = 0; i < 2; i++) { await a.orch.runIntegritySweep(); await b.orch.runIntegritySweep(); await settle(300); }
			expect(live(a)).toEqual(live(b));
			expect(a.vfs.getActiveFiles().filter(f => f.type === 'folder').map(f => f.path)).toEqual(['lost']);
			expect(errors.filter(e => !String(e[0]).includes('Failed to push local delta'))).toEqual([]);
		});

		it('a file deleted on purpose is not resurrected, and is reported as deleted', async () => {
			await a.goOnline();
			await a.createFile('gone.md', 'bye');
			await a.createFile('stay.md', 'here');
			a.bus.emit('LocalFileDeleted', { path: 'gone.md' });
			a.vfs.flushPendingPush();
			await settle(150);
			a.goOffline();

			await b.goOnline();
			await settle(400);
			expect(b.disk.has('gone.md')).toBe(false);
			expect(b.disk.get('stay.md')).toBe('here');
			expect(b.orch.getOrphanDocs().map(o => o.kind)).toEqual(['deleted']);
			expect(warns).toEqual([]);
		});
	});

	describe('config files', () => {
		it('a remote config node never blanks the local config file', async () => {
			await a.goOnline();
			await a.createFile('.obsidian/appearance.json', '{"from":"A"}');
			a.goOffline();
			b.seedLocal('.obsidian/appearance.json', '{"from":"B"}');

			await b.goOnline();
			await settle(400);
			expect(b.writes.filter(([p, c]) => p.endsWith('appearance.json') && c === '')).toEqual([]);
			expect(b.disk.get('.obsidian/appearance.json')).not.toBe('');
			expect(JSON.parse(b.disk.get('.obsidian/appearance.json') as string)).toBeTruthy();
		});
	});
});
