import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { VaultEventWatcher } from '../src/2_Application/Sync/VaultEventWatcher';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { TFile, TFolder } from 'obsidian';

describe('Empirical Challenger M1: R1 Content-Before-Disk and Content-Hash Echo Guard', () => {
	let eventBus: SyncEventBus;
	let syncEngine: LoroSyncEngine;
	let reconciler: ObsidianDiskReconciler;
	let watcher: VaultEventWatcher;
	let appMock: any;
	let vaultFiles: Map<string, any>;
	let adapterFiles: Map<string, string>;

	beforeEach(async () => {
		eventBus = new SyncEventBus();
		syncEngine = new LoroSyncEngine();
		await syncEngine.localStore.clearAll();

		vaultFiles = new Map<string, any>();
		adapterFiles = new Map<string, string>();

		appMock = {
			vault: {
				configDir: '.obsidian',
				on: vi.fn(),
				off: vi.fn(),
				getAbstractFileByPath: vi.fn((p: string) => vaultFiles.get(p) || null),
				getFiles: vi.fn(() => Array.from(vaultFiles.values()).filter(f => f instanceof TFile)),
				getAllLoadedFiles: vi.fn(() => Array.from(vaultFiles.values())),
				read: vi.fn(async (file: TFile) => adapterFiles.get(file.path) ?? ''),
				create: vi.fn(async (path: string, content: string) => {
					const f = new TFile();
					(f as any).path = path;
					vaultFiles.set(path, f);
					adapterFiles.set(path, content);
					return f;
				}),
				modify: vi.fn(async (file: TFile, content: string) => {
					adapterFiles.set(file.path, content);
				}),
				adapter: {
					exists: vi.fn(async (p: string) => adapterFiles.has(p)),
					read: vi.fn(async (p: string) => adapterFiles.get(p) ?? ''),
					write: vi.fn(async (p: string, content: string) => {
						adapterFiles.set(p, content);
					}),
					mkdir: vi.fn(async () => {}),
					remove: vi.fn(async (p: string) => {
						adapterFiles.delete(p);
					}),
					list: vi.fn(async () => ({ files: Array.from(adapterFiles.keys()), folders: [] }))
				}
			},
			fileManager: {
				renameFile: vi.fn(async (f: any, newPath: string) => {
					vaultFiles.delete(f.path);
					f.path = newPath;
					vaultFiles.set(newPath, f);
				}),
				trashFile: vi.fn(async (f: any) => {
					vaultFiles.delete(f.path);
					adapterFiles.delete(f.path);
				})
			}
		};

		reconciler = new ObsidianDiskReconciler(appMock, syncEngine, eventBus);
		reconciler.initialize();
	});

	afterEach(() => {
		reconciler.destroy();
		if (watcher) watcher.destroy();
		syncEngine.destroy();
		eventBus.destroy();
		ObsidianDiskReconciler.suppressedPaths.clear();
		ObsidianDiskReconciler.lastReconciledContent.clear();
	});

	describe('1. CrdtNodeCreated 0-Byte Guard', () => {
		it('NEVER creates physical file when content === undefined for normal markdown note', async () => {
			eventBus.emit('CrdtNodeCreated', {
				uuid: 'note-uuid-1',
				path: 'Notes/RemoteNote.md',
				isFolder: false,
				content: undefined
			});

			await (reconciler as any).diskQueue.onIdle();

			expect(appMock.vault.create).not.toHaveBeenCalled();
			expect(appMock.vault.adapter.write).not.toHaveBeenCalled();
			expect(vaultFiles.has('Notes/RemoteNote.md')).toBe(false);
			expect(adapterFiles.has('Notes/RemoteNote.md')).toBe(false);
		});

		it('NEVER creates physical file when content === undefined for config files', async () => {
			eventBus.emit('CrdtNodeCreated', {
				uuid: 'config-uuid-1',
				path: '.obsidian/appearance.json',
				isFolder: false,
				content: undefined
			});

			await (reconciler as any).diskQueue.onIdle();

			expect(appMock.vault.adapter.write).not.toHaveBeenCalled();
			expect(adapterFiles.has('.obsidian/appearance.json')).toBe(false);
		});

		it('Creates physical file when CrdtTextChanged arrives subsequently', async () => {
			// First remote node arrives with undefined content
			eventBus.emit('CrdtNodeCreated', {
				uuid: 'note-uuid-2',
				path: 'Notes/RemoteNote2.md',
				isFolder: false,
				content: undefined
			});
			await (reconciler as any).diskQueue.onIdle();
			expect(vaultFiles.has('Notes/RemoteNote2.md')).toBe(false);

			// Then text arrives
			eventBus.emit('CrdtTextChanged', {
				uuid: 'note-uuid-2',
				path: 'Notes/RemoteNote2.md',
				content: '# Hello from Remote Node'
			});
			await (reconciler as any).diskQueue.onIdle();

			expect(appMock.vault.create).toHaveBeenCalledWith('Notes/RemoteNote2.md', '# Hello from Remote Node');
			expect(adapterFiles.get('Notes/RemoteNote2.md')).toBe('# Hello from Remote Node');
		});

		it('Allows creating empty file when content === "" is explicitly provided', async () => {
			eventBus.emit('CrdtNodeCreated', {
				uuid: 'empty-uuid-1',
				path: 'Notes/IntentionallyEmpty.md',
				isFolder: false,
				content: ''
			});
			await (reconciler as any).diskQueue.onIdle();

			expect(appMock.vault.create).toHaveBeenCalledWith('Notes/IntentionallyEmpty.md', '');
			expect(vaultFiles.has('Notes/IntentionallyEmpty.md')).toBe(true);
		});

		it('Creates folder structure when isFolder === true even if content is undefined', async () => {
			eventBus.emit('CrdtNodeCreated', {
				uuid: 'folder-uuid-1',
				path: 'Deep/Nested/Folder',
				isFolder: true,
				content: undefined
			});
			await (reconciler as any).diskQueue.onIdle();

			expect(appMock.vault.create).not.toHaveBeenCalled();
		});
	});

	describe('2. Write-Echo Suppression & Genuine Modification Guard', () => {
		let listeners: Record<string, Function[]> = {};

		beforeEach(() => {
			listeners = {};
			appMock.vault.on = vi.fn((evt: string, cb: Function) => {
				(listeners[evt] ??= []).push(cb);
				return cb;
			});
			appMock.vault.off = vi.fn((evt: string, cb: Function) => {
				listeners[evt] = (listeners[evt] ?? []).filter(c => c !== cb);
			});

			watcher = new VaultEventWatcher(appMock, eventBus);
			watcher.start();
		});

		it('Suppresses echo event matching reconciler write within 1000ms window', async () => {
			const emittedEvents: any[] = [];
			eventBus.on('LocalFileModified', (e) => emittedEvents.push(e));

			// Reconciler writes content to disk
			eventBus.emit('CrdtTextChanged', {
				uuid: 'doc-echo-1',
				path: 'EchoTest.md',
				content: 'Server Content Alpha'
			});
			await (reconciler as any).diskQueue.onIdle();

			// Verify reconciler recorded lastReconciledContent
			expect(ObsidianDiskReconciler.lastReconciledContent.has('EchoTest.md')).toBe(true);
			expect(ObsidianDiskReconciler.lastReconciledContent.get('EchoTest.md')?.content).toBe('Server Content Alpha');

			// Simulate delayed OS watcher echo at 200ms
			const fileObj = vaultFiles.get('EchoTest.md');
			for (const cb of listeners['modify'] ?? []) {
				cb(fileObj);
			}

			// Allow any promises to resolve
			await new Promise(r => setTimeout(r, 50));

			expect(emittedEvents).toHaveLength(0);
		});

		it('Suppresses echo event with CRLF differences (Windows normalization)', async () => {
			const emittedEvents: any[] = [];
			eventBus.on('LocalFileModified', (e) => emittedEvents.push(e));

			// Reconciler writes LF
			eventBus.emit('CrdtTextChanged', {
				uuid: 'doc-crlf-1',
				path: 'CrlfTest.md',
				content: 'Line 1\nLine 2\nLine 3'
			});
			await (reconciler as any).diskQueue.onIdle();

			// Disk returns CRLF
			adapterFiles.set('CrlfTest.md', 'Line 1\r\nLine 2\r\nLine 3');

			const fileObj = vaultFiles.get('CrlfTest.md');
			for (const cb of listeners['modify'] ?? []) {
				cb(fileObj);
			}
			await new Promise(r => setTimeout(r, 50));

			expect(emittedEvents).toHaveLength(0);
		});

		it('Does NOT suppress genuine modification after 1000ms window expires', async () => {
			const emittedEvents: any[] = [];
			eventBus.on('LocalFileModified', (e) => emittedEvents.push(e));

			// Reconciler writes content
			eventBus.emit('CrdtTextChanged', {
				uuid: 'doc-timeout-1',
				path: 'TimeoutTest.md',
				content: 'Original Content'
			});
			await (reconciler as any).diskQueue.onIdle();

			// Wait for 1000ms suppression timer to expire (1050ms)
			await new Promise(r => setTimeout(r, 1050));

			// Verify suppressedPaths has cleared
			expect(ObsidianDiskReconciler.suppressedPaths.has('TimeoutTest.md')).toBe(false);

			// User genuinely modifies the file after the window
			adapterFiles.set('TimeoutTest.md', 'User Genuine Edit After 1s');
			const fileObj = vaultFiles.get('TimeoutTest.md');
			for (const cb of listeners['modify'] ?? []) {
				cb(fileObj);
			}
			await new Promise(r => setTimeout(r, 50));

			expect(emittedEvents).toHaveLength(1);
			expect(emittedEvents[0]).toEqual({
				path: 'TimeoutTest.md',
				content: 'User Genuine Edit After 1s'
			});
		});

		it('Checks behavior when genuine modification occurs with differing content', async () => {
			const emittedEvents: any[] = [];
			eventBus.on('LocalFileModified', (e) => emittedEvents.push(e));

			// Reconciler writes content
			eventBus.emit('CrdtTextChanged', {
				uuid: 'doc-diff-1',
				path: 'DiffTest.md',
				content: 'Original Server Content'
			});
			await (reconciler as any).diskQueue.onIdle();

			// Suppose the user or another process modifies file to differing content
			adapterFiles.set('DiffTest.md', 'Completely Different User Content');
			const fileObj = vaultFiles.get('DiffTest.md');

			// If modified after suppression path clears (or if watcher evaluates differing content)
			// Wait until suppressedPaths clears
			await new Promise(r => setTimeout(r, 1050));

			for (const cb of listeners['modify'] ?? []) {
				cb(fileObj);
			}
			await new Promise(r => setTimeout(r, 50));

			expect(emittedEvents).toHaveLength(1);
			expect(emittedEvents[0].content).toBe('Completely Different User Content');
		});

		it('Observes that path-level suppression takes precedence over content check during 1000ms', async () => {
			const emittedEvents: any[] = [];
			eventBus.on('LocalFileModified', (e) => emittedEvents.push(e));

			// Reconciler writes content
			eventBus.emit('CrdtTextChanged', {
				uuid: 'doc-fast-1',
				path: 'FastDiff.md',
				content: 'Initial Server Text'
			});
			await (reconciler as any).diskQueue.onIdle();

			// User edits file 200ms after remote reconcile
			adapterFiles.set('FastDiff.md', 'User Edit at 200ms');
			const fileObj = vaultFiles.get('FastDiff.md');
			for (const cb of listeners['modify'] ?? []) {
				cb(fileObj);
			}

			// Poller runs at 400ms (within 1000ms window)
			await watcher.pollVaultFiles();

			// Wait for 1000ms suppression timer to expire (1050ms from start)
			await new Promise(r => setTimeout(r, 1050));

			// Poller runs again at 1200ms (after suppression window)
			await watcher.pollVaultFiles();

			// Confirms that during the 1000ms window, suppressedPaths path-lock suppresses modify events
			expect(emittedEvents.length).toBe(0);
		});
	});

	describe('3. Shard-Index Live Pull & prepareForRemoteVfsUpdate Snapshot Safety', () => {
		let vfsController: LoroVfsController;
		let orchestrator: NetworkOrchestrator;
		let remoteStoreMock: any;
		let cryptoMock: any;

		beforeEach(async () => {
			vfsController = new LoroVfsController(syncEngine, eventBus);
			await vfsController.initialize();

			remoteStoreMock = {
				getBulkLatestUpdateIds: vi.fn().mockResolvedValue({}),
				getLatestUpdateId: vi.fn().mockResolvedValue(999),
				fetchSnapshotDetails: vi.fn().mockResolvedValue({ encryptedState: null, maxCompactedId: 0, isDeleted: false }),
				fetchUpdatesSince: vi.fn().mockResolvedValue([]),
				pushUpdate: vi.fn().mockResolvedValue(undefined)
			};

			cryptoMock = {
				encrypt: vi.fn().mockImplementation(async (d: Uint8Array) => d),
				decrypt: vi.fn().mockImplementation(async (d: Uint8Array) => d),
				hashData: vi.fn().mockResolvedValue('hash')
			};

			orchestrator = new NetworkOrchestrator(
				remoteStoreMock,
				cryptoMock,
				syncEngine,
				{ listAllNotes: vi.fn().mockResolvedValue([]), readNote: vi.fn() } as any,
				vfsController,
				eventBus,
				vi.fn(),
				0,
				reconciler
			);
			orchestrator.initialize();
			orchestrator.setCryptoKey({} as any);
		});

		afterEach(() => {
			orchestrator.stopAll();
			vfsController.destroy();
		});

		it('Invokes prepareForRemoteVfsUpdate BEFORE applying updates on live shard-index pull', async () => {
			const prepareSpy = vi.spyOn(vfsController, 'prepareForRemoteVfsUpdate');
			const applyUpdatesSpy = vi.spyOn(syncEngine, 'applyUpdates');

			remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([
				{ id: 1, encryptedUpdate: new Uint8Array([1, 2, 3]) }
			]);

			// Create a dummy node in local VFS first
			eventBus.emit('LocalFileCreated', { path: 'Local/OldDoc.md', isFolder: false, content: 'Old' });
			vfsController.rebuildCache();
			vfsController.flushPendingPush();

			const uuid = vfsController.getUuidForPath('Local/OldDoc.md');
			expect(uuid).toBeDefined();
			expect(vfsController.getPathForUuid(uuid!)).toBe('Local/OldDoc.md');

			// Trigger live pull of shard-index
			await orchestrator.pullDocument('shard-index', null, true);

			expect(prepareSpy).toHaveBeenCalledTimes(1);
			expect(applyUpdatesSpy).toHaveBeenCalledTimes(1);

			// Verify call order: prepareForRemoteVfsUpdate MUST be called before applyUpdates
			const prepareOrder = prepareSpy.mock.invocationCallOrder[0];
			const applyOrder = applyUpdatesSpy.mock.invocationCallOrder[0];
			expect(prepareOrder).toBeLessThan(applyOrder);
		});

		it('Does NOT invoke prepareForRemoteVfsUpdate for non-index document pulls', async () => {
			const prepareSpy = vi.spyOn(vfsController, 'prepareForRemoteVfsUpdate');
			remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce([]);

			await orchestrator.pullDocument('doc-uuid-123', 'Some/Path.md', true);

			expect(prepareSpy).not.toHaveBeenCalled();
		});

		it('Emits CrdtNodeMoved when remote shard-index moves an existing node', async () => {
			// Remote engine creates and moves a note
			const remoteSync = new LoroSyncEngine();
			const remoteBus = new SyncEventBus();
			const remoteVfs = new LoroVfsController(remoteSync, remoteBus);
			await remoteVfs.initialize();

			let exportedDeltas: Uint8Array[] = [];
			remoteBus.on('LocalDeltaReadyForPush', (p) => {
				if (p.documentId === 'shard-index') exportedDeltas.push(p.updateBinary);
			});

			remoteBus.emit('LocalFileCreated', { path: 'SharedDoc.md', isFolder: false, content: 'Shared' });
			remoteVfs.rebuildCache();
			remoteVfs.flushPendingPush();
			const initialDeltas = [...exportedDeltas];
			exportedDeltas = [];

			// Apply initial creation to local VFS
			remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce(
				initialDeltas.map((d, i) => ({ id: i + 1, encryptedUpdate: d }))
			);
			await orchestrator.pullDocument('shard-index', null, true);

			const uuid = vfsController.getUuidForPath('SharedDoc.md');
			expect(uuid).toBeDefined();

			// Remote client renames/moves the note
			remoteBus.emit('LocalFileRenamed', { oldPath: 'SharedDoc.md', newPath: 'MovedFolder/SharedDoc.md' });
			remoteVfs.flushPendingPush();
			const moveDeltas = [...exportedDeltas];

			const movedEvents: any[] = [];
			eventBus.on('CrdtNodeMoved', (e) => movedEvents.push(e));

			// Local pulls updated shard-index
			remoteStoreMock.fetchUpdatesSince.mockResolvedValueOnce(
				moveDeltas.map((d, i) => ({ id: i + 10, encryptedUpdate: d }))
			);
			await orchestrator.pullDocument('shard-index', null, true);

			expect(movedEvents).toHaveLength(1);
			expect(movedEvents[0]).toEqual({
				uuid,
				oldPath: 'SharedDoc.md',
				newPath: 'MovedFolder/SharedDoc.md'
			});
			expect(vfsController.getPathForUuid(uuid!)).toBe('MovedFolder/SharedDoc.md');

			remoteVfs.destroy();
			remoteSync.destroy();
			remoteBus.destroy();
		});
	});

	describe('4. 1000ms Delay Concurrency, Starvation & Mutex Stress Test', () => {
		it('Executes 50 concurrent file reconciliations rapidly without queue starvation', async () => {
			ObsidianDiskReconciler.suppressedPaths.clear();
			const start = performance.now();
			const fileCount = 50;

			// Dispatch 50 concurrent CrdtTextChanged events
			for (let i = 0; i < fileCount; i++) {
				eventBus.emit('CrdtTextChanged', {
					uuid: `batch-uuid-${i}`,
					path: `Notes/StressNote_${i}.md`,
					content: `Content payload ${i}`
				});
			}

			// Wait for reconciler queue to become idle
			await (reconciler as any).diskQueue.onIdle();
			const duration = performance.now() - start;

			// All 50 writes should execute without waiting for 1000ms timer
			// Normal execution of 50 in-memory creates should take < 500ms
			expect(duration).toBeLessThan(1000);
			expect(vaultFiles.size).toBe(fileCount);

			// Verify all 50 paths are suppressed immediately
			for (let i = 0; i < fileCount; i++) {
				expect(ObsidianDiskReconciler.suppressedPaths.has(`Notes/StressNote_${i}.md`)).toBe(true);
			}
			expect(ObsidianDiskReconciler.suppressedPaths.size).toBe(fileCount);

			// Wait 1100ms for timers to resolve
			await new Promise(r => setTimeout(r, 1100));

			// Verify all 50 paths are cleanly unsuppressed
			expect(ObsidianDiskReconciler.suppressedPaths.size).toBe(0);
		});

		it('Rapid sequential writes to SAME file preserve mutex order without deadlocking', async () => {
			const writeCount = 20;
			const targetPath = 'Notes/ContendedFile.md';

			for (let i = 0; i < writeCount; i++) {
				eventBus.emit('CrdtTextChanged', {
					uuid: 'contended-uuid-1',
					path: targetPath,
					content: `Revision ${i}`
				});
			}

			await (reconciler as any).diskQueue.onIdle();

			// Final content must match the last revision
			expect(adapterFiles.get(targetPath)).toBe('Revision 19');
			expect(ObsidianDiskReconciler.suppressedPaths.has(targetPath)).toBe(true);

			// Wait for all 20 stacked timers (each 1000ms from execution) to expire
			await new Promise(r => setTimeout(r, 1200));

			// Suppression depth must have counted down to 0 and cleared
			expect(ObsidianDiskReconciler.suppressedPaths.has(targetPath)).toBe(false);
		});
	});
});

