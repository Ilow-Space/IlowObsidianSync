import { describe, it, expect, vi, afterEach } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { createHash } from 'node:crypto';
import { CryptoUtils } from '../src/3_Infrastructure/Crypto/CryptoUtils';
import { FakeVaultServer } from './helpers/FakeVaultServer';

const remoteRegistry = new Map<string, any>();

class MemStore {
	private snaps = new Map<string, Uint8Array>();
	private outbox = new Map<string, { documentId: string; path: string | null; failedAt: number }>();
	async markUnacked(documentId: string, path: string | null) {
		this.outbox.set(documentId, { documentId, path, failedAt: Date.now() });
	}
	async clearUnacked(documentId: string) { this.outbox.delete(documentId); }
	async listUnacked() { return Array.from(this.outbox.values()); }
	async saveDocumentState(id: string, s: Uint8Array) { this.snaps.set(id, s); }
	async loadDocumentState(id: string) { return this.snaps.get(id) ?? null; }
	async deleteDocumentState(id: string) { this.snaps.delete(id); }
	async clearAll() { this.snaps.clear(); this.outbox.clear(); }
	close() {}
}

vi.mock('@infrastructure/Crdt/LoroSnapshotStore', () => ({
	LoroSnapshotStore: class {
		private inner = new MemStore();
		markUnacked(id: string, p: string | null) { return this.inner.markUnacked(id, p); }
		clearUnacked(id: string) { return this.inner.clearUnacked(id); }
		listUnacked() { return this.inner.listUnacked(); }
		saveDocumentState(id: string, s: Uint8Array) { return this.inner.saveDocumentState(id, s); }
		loadDocumentState(id: string) { return this.inner.loadDocumentState(id); }
		deleteDocumentState(id: string) { return this.inner.deleteDocumentState(id); }
		clearAll() { return this.inner.clearAll(); }
		close() { this.inner.close(); }
	}
}));

vi.mock('@infrastructure/Crdt/LoroMigrationManager', () => ({
	LoroMigrationManager: {
		performLibraryMigrationCheck: async () => {}
	}
}));

vi.mock('@infrastructure/Crypto/WebCryptoService', () => ({
	WebCryptoService: class {
		static clearCachedKeys() {}
		generateSalt() { return 'test-salt'; }
		async importKey(_raw: string) { return { kind: 'fake-key' } as unknown as CryptoKey; }
		async exportKey(_key: CryptoKey) { return 'exported-fake-key'; }
		async deriveKey(_pw: string, _salt: string) { return { kind: 'fake-key' } as unknown as CryptoKey; }
		async getVaultAliasId(_key: CryptoKey) { return 'vault-alias-1'; }
		async encrypt(data: Uint8Array) { return data; }
		async decrypt(data: any) {
			return data instanceof Uint8Array ? data : Uint8Array.from(Object.values(data));
		}
		async hashData(data: Uint8Array) {
			return createHash('sha256').update(data).digest('hex');
		}
	}
}));

vi.mock('@infrastructure/Postgres/PostgresRemoteStore', () => ({
	PostgresRemoteStore: class {
		public onServerVersion: (() => void) | null = null;
		private delegate: any;
		constructor(serverUrl: string) {
			this.delegate = remoteRegistry.get(serverUrl);
			if (this.delegate) {
				this.delegate.boundStore = this;
			}
		}
		setVaultAliasId(_id: string) {}
		connectWebSocket(_url: string) {}
		disconnect() {}
		subscribeToUpdates(docId: string, cb: (id: string, action?: string) => void) {
			return this.delegate.subscribeToUpdates(docId, cb);
		}
		getBulkLatestUpdateIds() { return this.delegate.getBulkLatestUpdateIds(); }
		getLatestUpdateId(id: string) { return this.delegate.getLatestUpdateId(id); }
		fetchSnapshotDetails(id: string) { return this.delegate.fetchSnapshotDetails(id); }
		fetchUpdatesSince(id: string, since: number) { return this.delegate.fetchUpdatesSince(id, since); }
		pushUpdate(id: string, u: Uint8Array, encPath?: unknown) { return this.delegate.pushUpdate(id, u, encPath); }
		compactSnapshot(id: string, s: Uint8Array, upTo: number) { return this.delegate.compactSnapshot(id, s, upTo); }
		deleteSnapshot(id: string) { return this.delegate.deleteSnapshot(id); }
		fetchManifest() { return this.delegate.fetchManifest(); }
		uploadBlobManifest(hashes: string[]) { return this.delegate.uploadBlobManifest(hashes); }
		uploadBlob(h: string, b: Uint8Array) { return this.delegate.uploadBlob(h, b); }
		downloadBlob(h: string) { return this.delegate.downloadBlob(h); }
	}
}));

import IlowSyncPlugin from '../src/4_Presentation/Plugin';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let nextDeviceSeq = 1;

interface DeviceOptions {
	fsDelayMs?: number;
	netLatencyMs?: number;
	hasKeyOnBoot?: boolean;
	debounceMs?: number;
}

class RealObsidianDevice {
	online = false;
	disk = new Map<string, string>();
	folders = new Set<string>();
	writes: Array<{ op: string; path: string; content: string }> = [];
	pushCountByDoc = new Map<string, number>();

	plugin!: IlowSyncPlugin;
	app: any;
	remote: any;
	boundStore: any = null;

	private files = new Map<string, TFile>();
	private folderObjs = new Map<string, TFolder>();
	private listeners: Record<string, Array<(...args: any[]) => void>> = {
		create: [], modify: [], rename: [], delete: []
	};
	private workspaceListeners: Record<string, Array<(...args: any[]) => any>> = {
		'file-open': []
	};
	private manifestSubscribers: Array<(docId: string, action?: string) => void> = [];
	private timers = new Set<ReturnType<typeof setTimeout>>();
	public serverUrl: string;

	public fsDelayMs: number;
	public netLatencyMs: number;
	private hasKeyOnBoot: boolean;
	private debounceMs: number;

	constructor(private server: FakeVaultServer, opts: DeviceOptions = {}) {
		this.fsDelayMs = opts.fsDelayMs ?? 80;
		this.netLatencyMs = opts.netLatencyMs ?? 20;
		this.hasKeyOnBoot = opts.hasKeyOnBoot ?? true;
		this.debounceMs = opts.debounceMs ?? 40;
		this.serverUrl = `http://fake-server-${nextDeviceSeq++}.internal`;
		remoteRegistry.set(this.serverUrl, this);
		((server as any).realDevices ??= []).push(this);
	}

	private mkFile(p: string): TFile {
		let f = this.files.get(p);
		if (!f) {
			f = new TFile();
			(f as any).path = p;
			(f as any).name = p.split('/').pop() ?? p;
			(f as any).extension = p.includes('.') ? p.split('.').pop() : '';
			this.files.set(p, f);
		}
		const parts = p.split('/');
		if (parts.length > 1) {
			let cur = '';
			for (const part of parts.slice(0, -1)) {
				cur = cur ? `${cur}/${part}` : part;
				this.mkFolder(cur);
			}
		}
		return f;
	}

	private mkFolder(p: string): TFolder {
		this.folders.add(p);
		let fld = this.folderObjs.get(p);
		if (!fld) {
			fld = new TFolder();
			(fld as any).path = p;
			(fld as any).name = p.split('/').pop() ?? p;
			(fld as any).children = [];
			this.folderObjs.set(p, fld);
		}
		return fld;
	}

	private emitFs(event: 'create' | 'modify' | 'rename' | 'delete', ...args: any[]) {
		const fire = () => {
			for (const cb of [...(this.listeners[event] ?? [])]) {
				cb(...args);
			}
		};
		if (this.fsDelayMs <= 0) {
			fire();
		} else {
			const t = setTimeout(() => {
				this.timers.delete(t);
				fire();
			}, this.fsDelayMs);
			this.timers.add(t);
		}
	}

	seedPreBootFile(path: string, content: string) {
		if (!path.startsWith('.obsidian/')) {
			this.mkFile(path);
		}
		this.disk.set(path, content);
	}

	async userWriteFile(path: string, content: string) {
		const existed = this.disk.has(path);
		this.disk.set(path, content);
		if (path.startsWith('.obsidian/')) {
			return;
		}
		const f = this.mkFile(path);
		this.emitFs(existed ? 'modify' : 'create', f);
	}

	async userRenameFile(oldPath: string, newPath: string) {
		const content = this.disk.get(oldPath) ?? '';
		this.disk.delete(oldPath);
		this.files.delete(oldPath);
		this.disk.set(newPath, content);
		const f = this.mkFile(newPath);
		this.emitFs('rename', f, oldPath);
	}

	async userDeleteFile(path: string) {
		this.disk.delete(path);
		const f = this.files.get(path) ?? this.mkFile(path);
		this.files.delete(path);
		this.emitFs('delete', f);
	}

	async openFileInWorkspace(path: string) {
		const f = this.files.get(path) ?? this.mkFile(path);
		for (const cb of this.workspaceListeners['file-open'] ?? []) {
			await cb(f);
		}
	}

	async boot() {
		const vault = {
			configDir: '.obsidian',
			on: (evt: string, cb: (...args: any[]) => void) => {
				(this.listeners[evt] ??= []).push(cb);
				return cb;
			},
			off: (evt: string, cb: (...args: any[]) => void) => {
				this.listeners[evt] = (this.listeners[evt] ?? []).filter(c => c !== cb);
			},
			getAbstractFileByPath: (p: string) => this.files.get(p) ?? this.folderObjs.get(p) ?? null,
			getFiles: () => Array.from(this.files.values()),
			getAllLoadedFiles: () => [...this.files.values(), ...this.folderObjs.values()],
			getMarkdownFiles: () => Array.from(this.files.values()).filter(f => f.path.endsWith('.md')),
			create: async (p: string, c: string) => {
				this.writes.push({ op: 'create', path: p, content: c });
				this.mkFile(p);
				this.disk.set(p, c);
			},
			modify: async (f: any, c: string) => {
				this.writes.push({ op: 'modify', path: f.path, content: c });
				this.disk.set(f.path, c);
			},
			read: async (f: any) => this.disk.get(f.path) ?? '',
			createFolder: async (p: string) => { this.mkFolder(p); },
			createBinary: async (p: string, buf: ArrayBuffer) => {
				const b64 = Buffer.from(buf).toString('base64');
				this.writes.push({ op: 'createBinary', path: p, content: b64 });
				this.mkFile(p);
				this.disk.set(p, b64);
			},
			modifyBinary: async (f: any, buf: ArrayBuffer) => {
				const b64 = Buffer.from(buf).toString('base64');
				this.writes.push({ op: 'modifyBinary', path: f.path, content: b64 });
				this.disk.set(f.path, b64);
			},
			readBinary: async (f: any) => {
				const b = Buffer.from(this.disk.get(f.path) ?? '', 'base64');
				return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
			},
			trash: async (f: any) => {
				this.writes.push({ op: 'trash', path: f.path, content: '' });
				this.files.delete(f.path);
				this.disk.delete(f.path);
			},
			adapter: {
				exists: async (p: string) => this.disk.has(p) || this.files.has(p) || this.folders.has(p),
				read: async (p: string) => this.disk.get(p) ?? '',
				write: async (p: string, c: string) => {
					this.writes.push({ op: 'adapter.write', path: p, content: c });
					this.disk.set(p, c);
				},
				readBinary: async (p: string) => {
					const b = Buffer.from(this.disk.get(p) ?? '', 'base64');
					return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
				},
				mkdir: async (p: string) => { this.mkFolder(p); },
				list: async (dir: string) => {
					const prefix = dir ? (dir.endsWith('/') ? dir : `${dir}/`) : '';
					const files: string[] = [];
					const folders: string[] = [];
					for (const p of this.disk.keys()) {
						if (!prefix || p.startsWith(prefix)) {
							const rel = prefix ? p.slice(prefix.length) : p;
							if (!rel.includes('/')) files.push(p);
						}
					}
					for (const f of this.folders) {
						if (!prefix || f.startsWith(prefix)) {
							const rel = prefix ? f.slice(prefix.length) : f;
							if (rel && !rel.includes('/')) folders.push(f);
						}
					}
					return { files, folders };
				}
			}
		};

		const fileManager = {
			renameFile: async (f: any, newPath: string) => {
				const content = this.disk.get(f.path) ?? '';
				this.writes.push({ op: 'renameFile', path: `${f.path}->${newPath}`, content });
				this.files.delete(f.path);
				this.disk.delete(f.path);
				f.path = newPath;
				f.name = newPath.split('/').pop();
				this.files.set(newPath, f);
				this.disk.set(newPath, content);
			},
			trashFile: async (f: any) => {
				this.writes.push({ op: 'trashFile', path: f.path, content: '' });
				this.files.delete(f.path);
				this.disk.delete(f.path);
			}
		};

		const workspace = {
			on: (evt: string, cb: (...args: any[]) => any) => {
				(this.workspaceListeners[evt] ??= []).push(cb);
				return cb;
			},
			off: (evt: string, cb: (...args: any[]) => any) => {
				this.workspaceListeners[evt] = (this.workspaceListeners[evt] ?? []).filter(c => c !== cb);
			},
			getLeavesOfType: () => [],
			getRightLeaf: () => null,
			revealLeaf: async () => {}
		};

		const secretStorage = {
			getSecret: async (key: string) => {
				if (key === 'ilow-master-key' && this.hasKeyOnBoot) return 'dummy-stored-key';
				return null;
			},
			setSecret: async (_key: string, _val: string) => {},
			deleteSecret: async (_key: string) => {}
		};

		this.app = { vault, fileManager, workspace, secretStorage };
		this.plugin = new IlowSyncPlugin(this.app);
		this.plugin.loadData = async () => ({
			serverUrl: this.serverUrl,
			apiKey: 'key',
			salt: 'salt',
			syncDebounceMs: this.debounceMs,
			syncPluginSettings: true,
			syncPluginBinaries: false,
			syncThemes: true,
			syncAppearance: true
		});
		await this.plugin.onload();
	}

	subscribeToUpdates(_docId: string, cb: (id: string, action?: string) => void) {
		this.manifestSubscribers.push(cb);
		return () => {
			this.manifestSubscribers = this.manifestSubscribers.filter(c => c !== cb);
		};
	}

	getBulkLatestUpdateIds() {
		if (!this.online) return {};
		return this.server.latestIds();
	}

	getLatestUpdateId(id: string) {
		if (!this.online) throw new Error('offline');
		return this.server.latestIds()[id] ?? 0;
	}

	fetchSnapshotDetails(id: string) {
		if (!this.online) throw new Error('offline');
		return this.server.snapshots.get(id) ?? null;
	}

	fetchUpdatesSince(id: string, since: number) {
		if (!this.online) throw new Error('offline');
		return this.server.updatesSince(id, since);
	}

	pushUpdate(id: string, u: Uint8Array, encPath?: unknown) {
		if (!this.online) throw new Error('offline');
		this.pushCountByDoc.set(id, (this.pushCountByDoc.get(id) ?? 0) + 1);
		this.server.push(id, u);
		if (encPath) {
			((this.server as any).paths ??= new Map()).set(id, encPath);
		}
		for (const dev of (this.server as any).realDevices as RealObsidianDevice[]) {
			if (dev !== this && dev.online) {
				setTimeout(() => {
					for (const cb of dev.manifestSubscribers) cb(id);
				}, dev.netLatencyMs);
			}
		}
	}

	compactSnapshot() {}
	deleteSnapshot() {}
	fetchManifest() {
		if (!this.online) throw new Error('offline');
		const paths: Map<string, unknown> = (this.server as any).paths ?? new Map();
		return Object.keys(this.server.latestIds()).filter(id => id !== 'shard-index').map(id => ({
			document_id: id,
			encrypted_path: paths.has(id) ? CryptoUtils.stringToHex(JSON.stringify(paths.get(id))) : undefined,
			is_deleted: this.server.snapshots.get(id)?.isDeleted ?? false,
			updated_at: ''
		}));
	}
	uploadBlobManifest() {}
	uploadBlob(h: string, b: Uint8Array) {
		if (!this.online) throw new Error('offline');
		this.server.blobs.set(h, b);
	}
	downloadBlob(h: string) {
		if (!this.online) throw new Error('offline');
		return this.server.blobs.get(h) ?? null;
	}

	async goOnline() {
		this.online = true;
		const orch = this.plugin.getSyncOrchestrator();
		if (orch && this.plugin.isKeyDerived) {
			await orch.runFullSync();
		}
	}

	goOffline() {
		this.online = false;
	}

	destroy() {
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
		this.plugin.onunload();
		remoteRegistry.delete(this.serverUrl);
	}
}

describe('RealEnvironmentConvergence: E2E Production Bug Exposure', () => {
	let server: FakeVaultServer;
	let devices: RealObsidianDevice[] = [];

	afterEach(() => {
		for (const d of devices) d.destroy();
		devices = [];
		ObsidianDiskReconciler.suppressedPaths.clear();
	});

	it('Scenario 1: Pre-existing vault onboarding on Device B produces zero conflict copies and zero 0-byte stubs', async () => {
		server = new FakeVaultServer();

		const devA = new RealObsidianDevice(server, { fsDelayMs: 60, netLatencyMs: 20 });
		devices.push(devA);
		await devA.boot();
		await devA.goOnline();

		await devA.userWriteFile('ExistingNote.md', 'Line 1 from DevA\nLine 2');
		await devA.userWriteFile('Untouched.md', 'Original content');
		await delay(300);

		// Device B already has ExistingNote.md locally (e.g. from git or initial copy)
		const devB = new RealObsidianDevice(server, { fsDelayMs: 60, netLatencyMs: 20 });
		devices.push(devB);
		devB.seedPreBootFile('ExistingNote.md', 'Line 1 from DevA\nLine 2\nLocal addition on DevB');
		devB.seedPreBootFile('Untouched.md', 'Original content');

		await devB.boot();
		await devB.goOnline();
		await delay(600);

		// Bug check 1: zero conflict copies created
		const conflictFiles = Array.from(devB.disk.keys()).filter(p => p.toLowerCase().includes('conflict'));
		expect(conflictFiles, `Unexpected conflict files: ${conflictFiles.join(', ')}`).toEqual([]);

		// Bug check 2: ExistingNote was merged cleanly without 0-byte blanking
		const existingContent = devB.disk.get('ExistingNote.md') ?? '';
		expect(existingContent.length).toBeGreaterThan(0);
		expect(existingContent).toContain('Line 1 from DevA');
		expect(existingContent).toContain('Local addition on DevB');

		// Bug check 3: no write was empty string
		const emptyWrites = devB.writes.filter(w => w.path === 'ExistingNote.md' && w.content === '');
		expect(emptyWrites).toHaveLength(0);
	});

	it('Scenario 2: Pre-unlock background poller race does not mint premature UUIDs or overwrite server state', async () => {
		server = new FakeVaultServer();

		const devA = new RealObsidianDevice(server, { fsDelayMs: 60, netLatencyMs: 20 });
		devices.push(devA);
		await devA.boot();
		await devA.goOnline();
		await devA.userWriteFile('Secret.md', 'Top Secret Remote Content');
		await delay(300);

		// Device B starts WITHOUT key (locked UI)
		const devB = new RealObsidianDevice(server, { hasKeyOnBoot: false, fsDelayMs: 60, netLatencyMs: 20 });
		devices.push(devB);
		devB.seedPreBootFile('Secret.md', 'Stale Local Content');
		await devB.boot();
		devB.online = true;

		// Let watcher poll run multiple times before unlock
		await delay(2500);

		// Device B must not have pushed anything while locked
		expect(devB.pushCountByDoc.size).toBe(0);

		// User now unlocks with password
		await devB.plugin.deriveKeyFromPassword('correct-horse-battery-staple');
		await delay(800);

		const conflictFiles = Array.from(devB.disk.keys()).filter(p => p.toLowerCase().includes('conflict'));
		expect(conflictFiles).toEqual([]);
		expect(devB.disk.get('Secret.md')).toBeDefined();
	});

	it('Scenario 3: Live WebSocket notification with delayed OS watcher echo never blanks or ping-pongs', async () => {
		server = new FakeVaultServer();

		const devA = new RealObsidianDevice(server, { fsDelayMs: 50, netLatencyMs: 30 });
		const devB = new RealObsidianDevice(server, { fsDelayMs: 150, netLatencyMs: 30 }); // 150ms OS delay!
		devices.push(devA, devB);

		await devA.boot();
		await devB.boot();
		await devA.goOnline();
		await devB.goOnline();
		await delay(200);

		const pushesBefore = devB.pushCountByDoc.get('shard-index') ?? 0;

		// DevA writes a live note
		await devA.userWriteFile('LiveNote.md', 'Live note content 12345');
		await delay(800);

		// DevB should have received LiveNote.md with full content
		expect(devB.disk.get('LiveNote.md')).toBe('Live note content 12345');
		
		// And DevB's delayed watcher must NOT have written 0 bytes at any point during sync
		const blankWrites = devB.writes.filter(w => w.path === 'LiveNote.md' && w.content === '');
		expect(blankWrites, 'DevB wrote empty content to LiveNote.md during remote sync').toHaveLength(0);

		// And DevB's delayed watcher must NOT echo-push LiveNote back to server
		const vfsB = devB.plugin.getVfsController()!;
		const liveUuid = vfsB.getUuidForPath('LiveNote.md');
		expect(liveUuid).toBeDefined();
		const echoPushes = devB.pushCountByDoc.get(liveUuid!) ?? 0;
		expect(echoPushes, 'DevB echo-pushed remote file back to server').toBe(0);
	});

	it('Scenario 4: Concurrent offline same-path .md creation converges deterministically to 1 file with merged content', async () => {
		server = new FakeVaultServer();

		const devA = new RealObsidianDevice(server, { fsDelayMs: 40 });
		const devB = new RealObsidianDevice(server, { fsDelayMs: 40 });
		devices.push(devA, devB);

		await devA.boot();
		await devB.boot();

		// Both devices offline create Daily/2026-10-31.md independently
		await devA.userWriteFile('Daily/2026-10-31.md', '# Daily Note\nDev A entry');
		await devB.userWriteFile('Daily/2026-10-31.md', '# Daily Note\nDev B entry');
		await delay(100);

		// DevA goes online and pushes
		await devA.goOnline();
		await delay(300);

		// DevB goes online and syncs
		await devB.goOnline();
		await delay(600);

		// DevA receives DevB updates
		await devA.plugin.getSyncOrchestrator()?.runFullSync();
		await delay(400);

		// Assertions: 0 conflict files on either device
		const conflictsA = Array.from(devA.disk.keys()).filter(p => p.includes('conflict') || p.includes('Conflict'));
		const conflictsB = Array.from(devB.disk.keys()).filter(p => p.includes('conflict') || p.includes('Conflict'));
		expect(conflictsA).toEqual([]);
		expect(conflictsB).toEqual([]);

		// Both devices converged to identical content with both entries
		const finalA = devA.disk.get('Daily/2026-10-31.md');
		const finalB = devB.disk.get('Daily/2026-10-31.md');
		expect(finalA).toBeDefined();
		expect(finalA).toBe(finalB);
		expect(finalA).toContain('Dev A entry');
		expect(finalA).toContain('Dev B entry');
	});

	it('Scenario 5: Same-basename multi-folder isolation prevents cross-folder UUID hijacking', async () => {
		server = new FakeVaultServer();

		const devA = new RealObsidianDevice(server, { fsDelayMs: 40 });
		devices.push(devA);
		await devA.boot();
		await devA.goOnline();

		// Create files with identical basenames across different folders
		await devA.userWriteFile('ProjA/Untitled.md', 'Content Project A');
		await devA.userWriteFile('ProjB/Untitled.md', 'Content Project B');
		await devA.userWriteFile('ProjA/README.md', 'Readme A');
		await devA.userWriteFile('ProjB/README.md', 'Readme B');
		await devA.userWriteFile('.obsidian/plugins/plugA/data.json', '{"a": 1}');
		await devA.userWriteFile('.obsidian/plugins/plugB/data.json', '{"b": 2}');
		await delay(400);

		const vfsA = devA.plugin.getVfsController()!;
		const uuidA1 = vfsA.getUuidForPath('ProjA/Untitled.md');
		const uuidA2 = vfsA.getUuidForPath('ProjB/Untitled.md');
		const uuidR1 = vfsA.getUuidForPath('ProjA/README.md');
		const uuidR2 = vfsA.getUuidForPath('ProjB/README.md');

		expect(uuidA1).toBeDefined();
		expect(uuidA2).toBeDefined();
		expect(uuidA1).not.toBe(uuidA2);
		expect(uuidR1).not.toBe(uuidR2);

		// Device B syncs
		const devB = new RealObsidianDevice(server, { fsDelayMs: 40 });
		devices.push(devB);
		await devB.boot();
		await devB.goOnline();
		await delay(600);

		expect(devB.disk.get('ProjA/Untitled.md')).toBe('Content Project A');
		expect(devB.disk.get('ProjB/Untitled.md')).toBe('Content Project B');
		expect(devB.disk.get('ProjA/README.md')).toBe('Readme A');
		expect(devB.disk.get('ProjB/README.md')).toBe('Readme B');

		const conflictsB = Array.from(devB.disk.keys()).filter(p => p.toLowerCase().includes('conflict'));
		expect(conflictsB).toEqual([]);
	});

	it('Scenario 6: workspace file-open event resolves UUID before calling pullDocument', async () => {
		server = new FakeVaultServer();

		const devA = new RealObsidianDevice(server, { fsDelayMs: 40 });
		devices.push(devA);
		await devA.boot();
		await devA.goOnline();

		await devA.userWriteFile('Notes/MyNote.md', 'Initial note');
		await delay(300);

		const orch = devA.plugin.getSyncOrchestrator()!;
		const pullDocSpy = vi.spyOn(orch, 'pullDocument');

		await devA.openFileInWorkspace('Notes/MyNote.md');
		await delay(50);

		expect(pullDocSpy).toHaveBeenCalled();
		const calledDocId = pullDocSpy.mock.calls[0][0];
		// Document ID passed must be the UUID (not raw path 'Notes/MyNote.md')
		expect(calledDocId).not.toBe('Notes/MyNote.md');
		const vfs = devA.plugin.getVfsController()!;
		expect(calledDocId).toBe(vfs.getUuidForPath('Notes/MyNote.md'));
	});
});
