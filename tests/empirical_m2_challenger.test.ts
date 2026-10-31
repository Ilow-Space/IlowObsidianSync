import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import { ObsidianDiskReconciler } from '../src/2_Application/Sync/ObsidianDiskReconciler';
import { TFile } from 'obsidian';

describe('Empirical Challenger M2: Pure CRDT Convergence & Binary Isolation', () => {
	let eventBus: SyncEventBus;
	let syncEngine: LoroSyncEngine;
	let reconciler: ObsidianDiskReconciler;
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
				createFolder: vi.fn(async () => {}),
				adapter: {
					exists: vi.fn(async (p: string) => adapterFiles.has(p)),
					read: vi.fn(async (p: string) => adapterFiles.get(p) ?? ''),
					write: vi.fn(async (p: string, content: string) => {
						adapterFiles.set(p, content);
					}),
					mkdir: vi.fn(async () => {}),
					remove: vi.fn(async (p: string) => { adapterFiles.delete(p); }),
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
		syncEngine.destroy();
		eventBus.destroy();
		ObsidianDiskReconciler.suppressedPaths.clear();
		ObsidianDiskReconciler.lastReconciledContent.clear();
	});

	describe('1. Text Collisions (.md, .json, .css) Pure CRDT Merge', () => {
		it('merges colliding .md nodes into lowest UUID winner with zero conflict files', async () => {
			const vfs = new LoroVfsController(syncEngine, eventBus);
			await vfs.initialize();

			const winnerUuid = '00000000-0000-0000-0000-000000000001';
			const loserUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
			const testPath = 'Colliding.md';

			const docWinner = await syncEngine.getOrCreateDoc(winnerUuid);
			docWinner.getText('markdown').insert(0, 'Winner Content\n');
			docWinner.commit();
			await syncEngine.localStore.saveDocumentState(winnerUuid, docWinner.export({ mode: 'snapshot' }));

			const docLoser = await syncEngine.getOrCreateDoc(loserUuid);
			docLoser.getText('markdown').insert(0, 'Loser Content\n');
			docLoser.commit();
			await syncEngine.localStore.saveDocumentState(loserUuid, docLoser.export({ mode: 'snapshot' }));

			const root = (vfs as any).loroTree;
			const n1 = root.createNode();
			n1.data.set('uuid', winnerUuid);
			n1.data.set('filename', 'Colliding.md');
			n1.data.set('type', 'file');

			const n2 = root.createNode();
			n2.data.set('uuid', loserUuid);
			n2.data.set('filename', 'Colliding.md');
			n2.data.set('type', 'file');
			(vfs as any).treeDoc.commit();

			const textChangedEvents: any[] = [];
			eventBus.on('CrdtTextChanged', (e) => textChangedEvents.push(e));

			await (vfs as any).resolvePathCollisions();

			expect(vfs.getConflictCopies()).toHaveLength(0);
			expect(vfs.getUuidForPath(testPath)).toBe(winnerUuid);
			expect(vfs.getPathForUuid(loserUuid)).toBeNull();
			expect(n2.isDeleted() || n2.data.get('isDeleted') === true).toBe(true);

			expect(textChangedEvents.length).toBeGreaterThan(0);
			const lastChange = textChangedEvents[textChangedEvents.length - 1];
			expect(lastChange.uuid).toBe(winnerUuid);
			expect(lastChange.path).toBe(testPath);
			expect(lastChange.content).toContain('Winner Content');
			expect(lastChange.content).toContain('Loser Content');

			vfs.destroy();
		});

		it('merges colliding non-config .json nodes into lowest UUID winner without conflict copies', async () => {
			const vfs = new LoroVfsController(syncEngine, eventBus);
			await vfs.initialize();

			const winnerUuid = '00000000-1111-1111-1111-111111111111';
			const loserUuid = 'ffffffff-2222-2222-2222-222222222222';
			const testPath = 'data.json';

			const docWinner = await syncEngine.getOrCreateDoc(winnerUuid);
			docWinner.getText('markdown').insert(0, '{"keyA": 1}');
			docWinner.commit();
			await syncEngine.localStore.saveDocumentState(winnerUuid, docWinner.export({ mode: 'snapshot' }));

			const docLoser = await syncEngine.getOrCreateDoc(loserUuid);
			docLoser.getText('markdown').insert(0, '{"keyB": 2}');
			docLoser.commit();
			await syncEngine.localStore.saveDocumentState(loserUuid, docLoser.export({ mode: 'snapshot' }));

			const n1 = (vfs as any).loroTree.createNode();
			n1.data.set('uuid', winnerUuid);
			n1.data.set('filename', 'data.json');
			n1.data.set('type', 'file');

			const n2 = (vfs as any).loroTree.createNode();
			n2.data.set('uuid', loserUuid);
			n2.data.set('filename', 'data.json');
			n2.data.set('type', 'file');
			(vfs as any).treeDoc.commit();

			await (vfs as any).resolvePathCollisions();

			expect(vfs.getConflictCopies()).toHaveLength(0);
			expect(vfs.getUuidForPath(testPath)).toBe(winnerUuid);
			expect(vfs.getPathForUuid(loserUuid)).toBeNull();
			expect(n2.isDeleted() || n2.data.get('isDeleted') === true).toBe(true);

			vfs.destroy();
		});

		it('merges colliding .css nodes into lowest UUID winner without conflict copies', async () => {
			const vfs = new LoroVfsController(syncEngine, eventBus);
			await vfs.initialize();

			const winnerUuid = '0000-style-win';
			const loserUuid = 'ffff-style-lose';
			const testPath = 'custom.css';

			const docWinner = await syncEngine.getOrCreateDoc(winnerUuid);
			docWinner.getText('markdown').insert(0, 'body { color: red; }');
			docWinner.commit();
			await syncEngine.localStore.saveDocumentState(winnerUuid, docWinner.export({ mode: 'snapshot' }));

			const docLoser = await syncEngine.getOrCreateDoc(loserUuid);
			docLoser.getText('markdown').insert(0, 'body { font-size: 14px; }');
			docLoser.commit();
			await syncEngine.localStore.saveDocumentState(loserUuid, docLoser.export({ mode: 'snapshot' }));

			const n1 = (vfs as any).loroTree.createNode();
			n1.data.set('uuid', winnerUuid);
			n1.data.set('filename', 'custom.css');
			n1.data.set('type', 'file');

			const n2 = (vfs as any).loroTree.createNode();
			n2.data.set('uuid', loserUuid);
			n2.data.set('filename', 'custom.css');
			n2.data.set('type', 'file');
			(vfs as any).treeDoc.commit();

			await (vfs as any).resolvePathCollisions();

			expect(vfs.getConflictCopies()).toHaveLength(0);
			expect(vfs.getUuidForPath(testPath)).toBe(winnerUuid);
			expect(vfs.getPathForUuid(loserUuid)).toBeNull();
			expect(n2.isDeleted() || n2.data.get('isDeleted') === true).toBe(true);

			vfs.destroy();
		});
	});

	describe('2. Binary Collisions Isolation', () => {
		it('drops identical binary blobs without creating conflict copies', async () => {
			const vfs = new LoroVfsController(syncEngine, eventBus);
			await vfs.initialize();

			const winnerUuid = '0000-bin-win';
			const loserUuid = 'ffff-bin-lose';
			const hash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

			const n1 = (vfs as any).loroTree.createNode();
			n1.data.set('uuid', winnerUuid);
			n1.data.set('filename', 'image.png');
			n1.data.set('type', 'file');
			n1.data.set('blob_hash', hash);

			const n2 = (vfs as any).loroTree.createNode();
			n2.data.set('uuid', loserUuid);
			n2.data.set('filename', 'image.png');
			n2.data.set('type', 'file');
			n2.data.set('blob_hash', hash);
			(vfs as any).treeDoc.commit();

			await (vfs as any).resolvePathCollisions();

			expect(vfs.getConflictCopies()).toHaveLength(0);
			expect(vfs.getUuidForPath('image.png')).toBe(winnerUuid);
			expect(n2.isDeleted() || n2.data.get('isDeleted') === true).toBe(true);

			vfs.destroy();
		});

		it('drops empty binary blobs without creating conflict copies', async () => {
			const vfs = new LoroVfsController(syncEngine, eventBus);
			await vfs.initialize();

			const winnerUuid = '0000-bin-empty-win';
			const loserUuid = 'ffff-bin-empty-lose';
			const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

			const n1 = (vfs as any).loroTree.createNode();
			n1.data.set('uuid', winnerUuid);
			n1.data.set('filename', 'empty.png');
			n1.data.set('type', 'file');
			n1.data.set('blob_hash', emptySha);

			const n2 = (vfs as any).loroTree.createNode();
			n2.data.set('uuid', loserUuid);
			n2.data.set('filename', 'empty.png');
			n2.data.set('type', 'file');
			n2.data.set('blob_hash', '');
			(vfs as any).treeDoc.commit();

			await (vfs as any).resolvePathCollisions();

			expect(vfs.getConflictCopies()).toHaveLength(0);
			expect(vfs.getUuidForPath('empty.png')).toBe(winnerUuid);
			expect(n2.isDeleted() || n2.data.get('isDeleted') === true).toBe(true);

			vfs.destroy();
		});

		it('produces deterministic (conflict <uuid6>) for distinct non-empty binary blobs', async () => {
			const vfs = new LoroVfsController(syncEngine, eventBus);
			await vfs.initialize();

			const winnerUuid = '11111111-aaaa-bbbb-cccc-dddddddddddd';
			const loserUuid = '99999999-xxxx-yyyy-zzzz-wwwwwwwwwwww';
			const hashA = '1111111111111111111111111111111111111111111111111111111111111111';
			const hashB = '2222222222222222222222222222222222222222222222222222222222222222';

			const n1 = (vfs as any).loroTree.createNode();
			n1.data.set('uuid', winnerUuid);
			n1.data.set('filename', 'graphic.png');
			n1.data.set('type', 'file');
			n1.data.set('blob_hash', hashA);

			const n2 = (vfs as any).loroTree.createNode();
			n2.data.set('uuid', loserUuid);
			n2.data.set('filename', 'graphic.png');
			n2.data.set('type', 'file');
			n2.data.set('blob_hash', hashB);
			(vfs as any).treeDoc.commit();

			await (vfs as any).resolvePathCollisions();

			expect(n2.isDeleted()).toBe(false);
			expect(n2.data.get('isDeleted')).toBeUndefined();
			expect(n2.data.get('filename')).toBe('graphic (conflict 999999).png');
			expect(n2.data.get('conflictOf')).toBe(winnerUuid);

			vfs.destroy();
		});
	});

	describe('3. ObsidianDiskReconciler Zero Conflict Copies for Text', () => {
		it('never creates (Conflict N) files on disk when resolving target conflict for text files', async () => {
			const targetPath = 'Notes/Target.md';
			const remoteUuid = 'remote-doc-123';

			const existingFile = new TFile();
			(existingFile as any).path = targetPath;
			(existingFile as any).name = 'Target.md';
			(existingFile as any).stat = { size: 100 };
			vaultFiles.set(targetPath, existingFile);
			adapterFiles.set(targetPath, 'Original Local Disk Content');

			const doc = await syncEngine.getOrCreateDoc(remoteUuid);
			doc.getText('markdown').insert(0, 'Remote Incoming Content');
			doc.commit();
			await syncEngine.localStore.saveDocumentState(remoteUuid, doc.export({ mode: 'snapshot' }));

			const rebalanceEvents: any[] = [];
			eventBus.on('RebalancePathUuid', (e) => rebalanceEvents.push(e));

			const result = await (reconciler as any).resolveTargetConflict(
				{ uuid: remoteUuid, oldPath: 'Notes/OldName.md', newPath: targetPath },
				existingFile
			);

			expect(result.rebalanced).toBe(true);
			expect(result.targetPath).toBe(targetPath);
			expect(rebalanceEvents).toEqual([{ remoteUuid, path: targetPath }]);

			const allPaths = Array.from(vaultFiles.keys());
			const conflictFiles = allPaths.filter(p => p.includes('Conflict') || p.includes('conflict'));
			expect(conflictFiles).toHaveLength(0);
		});

		it('preserves local offline additions in writeNonConfigFile when local disk already contains incoming text', async () => {
			const testFile = new TFile();
			(testFile as any).path = 'Notes/Daily.md';
			vaultFiles.set('Notes/Daily.md', testFile);
			adapterFiles.set('Notes/Daily.md', '# Heading\nIncoming Remote Line\nLocal Offline Addition');

			await (reconciler as any).writeNonConfigFile(testFile, {
				path: 'Notes/Daily.md',
				content: '# Heading\nIncoming Remote Line'
			});

			expect(appMock.vault.modify).not.toHaveBeenCalled();
			expect(adapterFiles.get('Notes/Daily.md')).toBe('# Heading\nIncoming Remote Line\nLocal Offline Addition');
		});
	});
});
