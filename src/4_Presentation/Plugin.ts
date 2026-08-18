import { Plugin, Notice, TFile, TAbstractFile, WorkspaceLeaf, TFolder } from 'obsidian';
import { SettingsTab } from './SettingsTab';
import { WebCryptoService } from '@infrastructure/Crypto/WebCryptoService';
import { PostgresRemoteStore } from '@infrastructure/Postgres/PostgresRemoteStore';
import { ObsidianNoteRepository } from '@infrastructure/Obsidian/ObsidianNoteRepository';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';
import { LoroMigrationManager } from '@infrastructure/Crdt/LoroMigrationManager';
import { NetworkOrchestrator, SyncStatus } from '@application/Sync/NetworkOrchestrator';
import { SyncEventBus } from '@application/Sync/SyncEventBus';
import { VaultEventWatcher } from '@application/Sync/VaultEventWatcher';
import { LoroVfsController } from '@application/Sync/LoroVfsController';
import { ObsidianDiskReconciler } from '@application/Sync/ObsidianDiskReconciler';
import { SyncSidebarView, SYNC_SIDEBAR_VIEW_TYPE } from './Views/SyncSidebarView';

interface PluginSettings {
    serverUrl: string;
    headers: Record<string, string>;
    salt: string;
    adminToken: string;
    syncDebounceMs: number;
}

const DEFAULT_SETTINGS: PluginSettings = {
	serverUrl: '',
	headers: {},
	salt: '',
	adminToken: '',
	syncDebounceMs: 1000
};

export default class MyPlugin extends Plugin {
	public settings!: PluginSettings;
	public cryptoService!: WebCryptoService;
	private noteRepo!: ObsidianNoteRepository;
	private remoteStore: PostgresRemoteStore | null = null;

	// New Reactive Stack
	private eventBus!: SyncEventBus;
	private syncEngine!: LoroSyncEngine;
	private vfsController: LoroVfsController | null = null;
	private diskReconciler: ObsidianDiskReconciler | null = null;
	private vaultEventWatcher: VaultEventWatcher | null = null;
	private networkOrchestrator: NetworkOrchestrator | null = null;

	private derivedKey: CryptoKey | null = null;
	private statusBarItem!: HTMLElement;
	private isBootstrapping = false;
	private manifestUnsubscribe: (() => void) | null = null;

	get isKeyDerived(): boolean {
		return this.derivedKey !== null;
	}

	async onload() {
		console.log('Loading Ilow Sync Plugin (Loro Reactive VFS Edition)');

		// 1. Perform Yjs -> Loro Migration schema check and purge on boot
		await LoroMigrationManager.performLibraryMigrationCheck();

		await this.loadSettings();

		this.eventBus = new SyncEventBus();
		this.syncEngine = new LoroSyncEngine();
		this.cryptoService = new WebCryptoService();
		this.noteRepo = new ObsidianNoteRepository(this.app);

		// Ensure salt is initialized if missing
		if (!this.settings.salt) {
			this.settings.salt = this.cryptoService.generateSalt();
			await this.saveSettings();
		}

		// Register Sidebar View
		this.registerView(
			SYNC_SIDEBAR_VIEW_TYPE,
			(leaf) => new SyncSidebarView(leaf, this)
		);

		// Status Bar Setup
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass('ilow-sync-status');
		this.statusBarItem.addClass('mod-clickable');
		this.updateStatusBar('offline', 'Disconnected');
		this.statusBarItem.onClickEvent(() => {
			this.activateSidebar();
		});

		// Ribbon Icon Setup
		this.addRibbonIcon('folder-sync', 'Ilow Sync History', () => {
			this.activateSidebar();
		});

		this.initializeSyncOrchestrator();

		// Auto-load master sync key from secret storage
		try {
			const keyData = await (this.app as any).secretStorage.getSecret('ilow-master-key');
			if (keyData) {
				this.updateStatusBar('syncing', 'Loading key...');
				this.derivedKey = await this.cryptoService.importKey(keyData);

				if (this.remoteStore) {
					const vaultAliasId = await this.cryptoService.getVaultAliasId(this.derivedKey);
					this.remoteStore.setVaultAliasId(vaultAliasId);
				}

				if (this.networkOrchestrator) {
					this.networkOrchestrator.setCryptoKey(this.derivedKey);
					this.runBackgroundBootstrap().catch(console.error);
				}
			}
		} catch (err) {
			console.error('Failed to auto-load master sync key:', err);
			this.updateStatusBar('error', 'Failed to load key');
		}

		// Add settings tab
		this.addSettingTab(new SettingsTab(this.app, this));

		// Register file open hook
		this.registerEvent(
			this.app.workspace.on('file-open', async (file: TFile | null) => {
				if (file && file.extension === 'md' && this.networkOrchestrator) {
					await this.networkOrchestrator.pullDocument(file.path);
				}
			})
		);
	}

	onunload() {
		console.log('Unloading Ilow Sync Plugin');
		if (this.manifestUnsubscribe) {
			this.manifestUnsubscribe();
			this.manifestUnsubscribe = null;
		}
		if (this.vaultEventWatcher) {
			this.vaultEventWatcher.destroy();
		}
		if (this.vfsController) {
			this.vfsController.destroy();
		}
		if (this.diskReconciler) {
			this.diskReconciler.destroy();
		}
		if (this.networkOrchestrator) {
			this.networkOrchestrator.stopAll();
		}
		if (this.remoteStore) {
			this.remoteStore.disconnect();
		}
		if (this.eventBus) {
			this.eventBus.destroy();
		}
		if (this.syncEngine) {
			this.syncEngine.destroy();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.initializeSyncOrchestrator();
	}

	public getRemoteStore(): PostgresRemoteStore | null {
		return this.remoteStore;
	}

	public getSyncOrchestrator(): NetworkOrchestrator | null {
		return this.networkOrchestrator;
	}

	public updateStatusBar(status: SyncStatus, msg: string) {
		let icon = '🔴';
		if (status === 'synced') icon = '🟢';
		else if (status === 'syncing') icon = '🟡';
        
		this.statusBarItem.setText(`${icon} ${msg}`);
	}

	public async activateSidebar() {
		const { workspace } = this.app;
        
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(SYNC_SIDEBAR_VIEW_TYPE);
        
		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				leaf = rightLeaf;
				await leaf.setViewState({ type: SYNC_SIDEBAR_VIEW_TYPE, active: true });
			}
		}
        
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	public async deriveKeyFromPassword(password: string): Promise<void> {
		try {
			this.derivedKey = await this.cryptoService.deriveKey(password, this.settings.salt);

			const exportedKey = await this.cryptoService.exportKey(this.derivedKey);
			await (this.app as any).secretStorage.setSecret('ilow-master-key', exportedKey);

			await this.initializeSyncOrchestrator();

			if (this.networkOrchestrator) {
				this.networkOrchestrator.setCryptoKey(this.derivedKey);
				this.runBackgroundBootstrap().catch(console.error);
			}
		} catch (err) {
			console.error('Error deriving master key:', err);
			throw err;
		}
	}

	private async runBackgroundBootstrap() {
		if (this.isBootstrapping) return;
		if (!this.vfsController || !this.networkOrchestrator || !this.remoteStore) return;
        
		this.isBootstrapping = true;
		this.updateStatusBar('syncing', 'Bootstrapping VFS index...');
		try {
			await this.vfsController.initialize();

			if (this.manifestUnsubscribe) {
				this.manifestUnsubscribe();
			}

			// REWRITTEN: Abandon full-sync polling. React instantly to precise WS broadcasts.
			this.manifestUnsubscribe = this.remoteStore.subscribeToUpdates('manifest', (docId, action) => {
				if (!docId) return;

				if (docId === 'shard-index') {
					// Pull just the index. (This will emit CrdtNodeCreated, triggering Task 1!)
					this.networkOrchestrator?.pullDocument('shard-index', null, true).catch(console.error);
				} else {
					// Pull just the specific file that changed
					(async () => {
						let path = this.vfsController!.getPathForUuid(docId);
						if (!path) {
							await this.networkOrchestrator?.pullDocument('shard-index', null, true);
							path = this.vfsController!.getPathForUuid(docId);
						}
						if (path) {
							await this.networkOrchestrator?.pullDocument(docId, path, true);
						}
					})().catch(console.error);
				}
			});

			await this.networkOrchestrator.runFullSync();

			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && activeFile.extension === 'md') {
				await this.networkOrchestrator.pullDocument(activeFile.path);
			}

			this.updateStatusBar('synced', 'Fully synced');
		} catch (err) {
			this.updateStatusBar('error', 'Bootstrap failed');
			console.error('Background bootstrap failed:', err);
		} finally {
			this.isBootstrapping = false;
		}
	}

	public async unloadKey(): Promise<void> {
		this.derivedKey = null;
		if (this.networkOrchestrator) {
			this.networkOrchestrator.setCryptoKey(null);
			this.networkOrchestrator.stopAll();
		}
		this.updateStatusBar('offline', 'Disconnected');

		try {
			await (this.app as any).secretStorage.deleteSecret('ilow-master-key');
		} catch (err) {
			console.error('Failed to remove master sync key:', err);
		}
	}

	private async initializeSyncOrchestrator() {
		if (this.manifestUnsubscribe) {
			this.manifestUnsubscribe();
			this.manifestUnsubscribe = null;
		}
		if (this.vaultEventWatcher) {
			this.vaultEventWatcher.destroy();
			this.vaultEventWatcher = null;
		}
		if (this.vfsController) {
			this.vfsController.destroy();
			this.vfsController = null;
		}
		if (this.diskReconciler) {
			this.diskReconciler.destroy();
			this.diskReconciler = null;
		}
		if (this.networkOrchestrator) {
			this.networkOrchestrator.stopAll();
			this.networkOrchestrator = null;
		}
		if (this.remoteStore) {
			this.remoteStore.disconnect();
			this.remoteStore = null;
		}

		if (this.settings.serverUrl) {
			this.remoteStore = new PostgresRemoteStore(this.settings.serverUrl, this.settings.headers);
			if (this.derivedKey) {
				const vaultAliasId = await this.cryptoService.getVaultAliasId(this.derivedKey);
				this.remoteStore.setVaultAliasId(vaultAliasId);
			}

			const socketUrl = this.settings.serverUrl.replace(/^http/i, 'ws');

			this.vfsController = new LoroVfsController(this.syncEngine, this.eventBus);
			this.diskReconciler = new ObsidianDiskReconciler(this.app, this.syncEngine, this.eventBus);
			this.vaultEventWatcher = new VaultEventWatcher(this.app, this.eventBus);
			this.networkOrchestrator = new NetworkOrchestrator(
				this.remoteStore,
				this.cryptoService,
				this.syncEngine,
				this.noteRepo,
				this.vfsController,
				this.eventBus,
				(status, msg) => this.updateStatusBar(status, msg),
				this.settings.syncDebounceMs
			);

			this.vfsController.initialize();
			this.diskReconciler.initialize();
			this.vaultEventWatcher.initialize();
			this.networkOrchestrator.initialize();
			this.networkOrchestrator.connectWebSocket(socketUrl);

			if (this.derivedKey) {
				this.networkOrchestrator.setCryptoKey(this.derivedKey);
				this.runBackgroundBootstrap().catch(console.error);
			}
		}
	}
}
