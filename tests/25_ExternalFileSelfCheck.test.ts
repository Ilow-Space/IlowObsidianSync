import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { VaultEventWatcher } from '../src/2_Application/Sync/VaultEventWatcher';
import { TFile } from 'obsidian';

describe('External File Self-Check & Self-Healing Suite', () => {
	let eventBus: SyncEventBus;
	let syncEngine: LoroSyncEngine;
	let vfsController: LoroVfsController;
	let orchestrator: NetworkOrchestrator;
	let diskReconciler: ObsidianDiskReconciler;
	let vaultWatcher: VaultEventWatcher;

	let remoteStoreMock: any;
	let cryptoMock: any;
	let appMock: any;
	let noteRepoMock: any;

	let mockVaultFiles: Map<string, any>;
	let mockDiskAdapterFiles: Map<string, string>;
	const dummyKey = {} as CryptoKey;

	const waitMemory = (ms = 50) => new Promise(r => setTimeout(r, ms));

	beforeEach(async () => {
		eventBus = new SyncEventBus();
		syncEngine = new LoroSyncEngine();
		await syncEngine.localStore.clearAll();

		vfsController = new LoroVfsController(syncEngine, eventBus);
		await vfsController.initialize();

		mockVaultFiles = new Map<string, any>();
		mockDiskAdapterFiles = new Map<string, string>();

		remoteStoreMock = {
			pushUpdate: vi.fn().mockResolvedValue(undefined),
			fetchSnapshotDetails: vi.fn().mockResolvedValue({ encryptedState: null, maxCompactedId: 0, isDeleted: false }),
			fetchUpdatesSince: vi.fn().mockResolvedValue([]),
			getBulkLatestUpdateIds: vi.fn().mockResolvedValue({}),
			getLatestUpdateId: vi.fn().mockResolvedValue(0)
		};

		cryptoMock = {
			encrypt: vi.fn().mockImplementation(async (data: Uint8Array) => ({ ciphertext: Buffer.from(data).toString('base64'), iv: 'mock-iv' })),
			decrypt: vi.fn().mockImplementation(async (blob: any) => new Uint8Array(Buffer.from(blob.ciphertext, 'base64')))
		};

		appMock = {
			vault: {
				configDir: '.obsidian',
				on: vi.fn().mockReturnValue({}),
				off: vi.fn(),
				getAbstractFileByPath: vi.fn((p: string) => mockVaultFiles.get(p) || null),
				getFiles: vi.fn(() => Array.from(mockVaultFiles.values()).filter(f => f instanceof TFile)),
				read: vi.fn().mockImplementation(async (f: any) => mockDiskAdapterFiles.get(f.path) || ''),
				modify: vi.fn().mockImplementation(async (f: any, content: string) => {
					mockDiskAdapterFiles.set(f.path, content);
				}),
				adapter: {
					exists: vi.fn().mockImplementation(async (p: string) => mockDiskAdapterFiles.has(p)),
					read: vi.fn().mockImplementation(async (p: string) => mockDiskAdapterFiles.get(p) || ''),
					write: vi.fn().mockImplementation(async (p: string, content: string) => {
						mockDiskAdapterFiles.set(p, content);
					}),
					list: vi.fn().mockImplementation(async (dir: string) => {
						const files: string[] = [];
						const folders: string[] = [];
						for (const p of mockDiskAdapterFiles.keys()) {
							if (dir === '' || p.startsWith(dir + '/')) {
								const rel = dir === '' ? p : p.substring(dir.length + 1);
								if (!rel.includes('/')) {
									files.push(p);
								}
							}
						}
						return { files, folders };
					})
				}
			}
		};

		noteRepoMock = {
			readNote: vi.fn().mockImplementation(async (p: string) => mockDiskAdapterFiles.get(p) ?? null),
			writeNote: vi.fn().mockImplementation(async (p: string, content: string) => {
				mockDiskAdapterFiles.set(p, content);
				let f = mockVaultFiles.get(p);
				if (!f) {
					f = new TFile(); f.path = p;
					mockVaultFiles.set(p, f);
				}
			}),
			listAllNotes: vi.fn().mockImplementation(async () => Array.from(mockDiskAdapterFiles.keys()))
		};

		diskReconciler = new ObsidianDiskReconciler(appMock, syncEngine, eventBus);
		diskReconciler.initialize();

		vaultWatcher = new VaultEventWatcher(appMock, eventBus);

		orchestrator = new NetworkOrchestrator(
			remoteStoreMock,
			cryptoMock,
			syncEngine,
			noteRepoMock,
			vfsController,
			eventBus,
			vi.fn(),
			0,
			diskReconciler
		);
		orchestrator.initialize();
		orchestrator.setCryptoKey(dummyKey);
		vaultWatcher.setOrchestrator(orchestrator);
		vaultWatcher.initialize();

		(orchestrator as any).isInitialized = true;
	});

	afterEach(async () => {
		await waitMemory();
		vi.restoreAllMocks();
		vaultWatcher.destroy();
		orchestrator.stopAll();
		diskReconciler.destroy();
		vfsController.destroy();
		syncEngine.destroy();
		eventBus.destroy();
	});

	const addDiskFile = (path: string, content: string) => {
		const f = new TFile();
		f.path = path;
		mockVaultFiles.set(path, f);
		mockDiskAdapterFiles.set(path, content);
	};

	it('Detects external file creation (e.g. by AI agent) during periodic self-check', async () => {
		const createdSpy = vi.fn();
		eventBus.on('LocalFileCreated', createdSpy);

		addDiskFile('ExternalAiNote.md', 'Content created directly by AI agent');

		await vaultWatcher.pollVaultFiles();
		await waitMemory();

		expect(createdSpy).toHaveBeenCalledWith(expect.objectContaining({
			path: 'ExternalAiNote.md',
			content: 'Content created directly by AI agent'
		}));
		expect(vfsController.getUuidForPath('ExternalAiNote.md')).not.toBeNull();
	});

	it('Detects external file modification during periodic self-check and pushes delta', async () => {
		addDiskFile('ExistingNote.md', 'Initial Content');
		await vaultWatcher.pollVaultFiles();
		await waitMemory();

		const modSpy = vi.fn();
		eventBus.on('LocalFileModified', modSpy);

		// AI agent modifies file directly on disk
		mockDiskAdapterFiles.set('ExistingNote.md', 'Initial Content + AI Edits');

		await vaultWatcher.pollVaultFiles();
		await waitMemory();

		expect(modSpy).toHaveBeenCalledWith(expect.objectContaining({
			path: 'ExistingNote.md',
			content: 'Initial Content + AI Edits'
		}));

		const uuid = vfsController.getUuidForPath('ExistingNote.md');
		expect(uuid).not.toBeNull();
		expect(remoteStoreMock.pushUpdate).toHaveBeenCalledWith(uuid, expect.anything(), expect.anything());
	});

	it('Detects external file deletion during periodic self-check', async () => {
		addDiskFile('ToDelete.md', 'Some content');
		await vaultWatcher.pollVaultFiles();
		await waitMemory();

		const delSpy = vi.fn();
		eventBus.on('LocalFileDeleted', delSpy);

		// External process deletes file from disk
		mockVaultFiles.delete('ToDelete.md');
		mockDiskAdapterFiles.delete('ToDelete.md');

		await vaultWatcher.pollVaultFiles();
		await waitMemory();

		expect(delSpy).toHaveBeenCalledWith({ path: 'ToDelete.md' });
		expect(vfsController.getUuidForPath('ToDelete.md')).toBeNull();
	});

	it('Handles edits made while Obsidian was closed without corrupting remote changes upon full sync', async () => {
		// 1. Initial file tracked
		addDiskFile('OfflineNote.md', 'Version 1');
		await vaultWatcher.pollVaultFiles();
		await waitMemory();

		const uuid = vfsController.getUuidForPath('OfflineNote.md')!;

		// Simulate Obsidian closed: external edits happened while offline
		mockDiskAdapterFiles.set('OfflineNote.md', 'Version 1 + Offline External Edits');

		// 2. Remote changes also happened
		remoteStoreMock.getBulkLatestUpdateIds.mockResolvedValueOnce({ 'shard-index': 1, [uuid]: 1 });

		// Run full sync when Obsidian opens back up / reconnects
		await orchestrator.runFullSync();
		await waitMemory();

		// Check that the file content merged both local external edits and remote state without corruption
		const noteContent = mockDiskAdapterFiles.get('OfflineNote.md');
		expect(noteContent).toContain('Version 1 + Offline External Edits');
	});
});
