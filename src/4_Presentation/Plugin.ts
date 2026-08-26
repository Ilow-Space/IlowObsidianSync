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

export interface PluginSettings {
    serverUrl: string;
    apiKey: string;
    salt: string;
    adminToken: string;
    syncDebounceMs: number;
    syncPluginSettings: boolean;
    syncPluginBinaries: boolean;
    syncThemes: boolean;
    syncAppearance: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	serverUrl: '',
	apiKey: '',
	salt: '',
	adminToken: '',
	syncDebounceMs: 1000,
	syncPluginSettings: true,
	syncPluginBinaries: false,
	syncThemes: true,
	syncAppearance: true
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
		this.noteRepo = new ObsidianNoteRepository(this.app, this.settings);

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

		// 2. Auto-load master sync key FIRST before starting network sockets
		try {
			const keyData = await (this.app as any).secretStorage?.getSecret('ilow-master-key');
			if (keyData) {
				this.updateStatusBar('syncing', 'Loading key...');
				this.derivedKey = await this.cryptoService.importKey(keyData);
			}
		} catch (err) {
			console.error('Failed to auto-load master sync key:', err);
			this.updateStatusBar('error', 'Failed to load key');
		}

		// 3. Initialize orchestrator (derivedKey is now set, allowing vaultAliasId to be passed on connection #1)
		await this.initializeSyncOrchestrator();
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
		if (this.derivedKey) {
			this.initializeSyncOrchestrator();
		}
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
			(this.app as any).secretStorage?.setSecret('ilow-master-key', exportedKey)?.catch(() => {});

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

			this.manifestUnsubscribe = this.remoteStore.subscribeToUpdates('manifest', (docId, action) => {
				if (!docId) return;

				if (docId === 'shard-index') {
					this.networkOrchestrator?.pullDocument('shard-index', null, true).catch(console.error);
				} else {
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
			// Pass serverUrl and apiKey directly into the updated store constructor
			this.remoteStore = new PostgresRemoteStore(this.settings.serverUrl, this.settings.apiKey);
			if (this.derivedKey) {
				const vaultAliasId = await this.cryptoService.getVaultAliasId(this.derivedKey);
				this.remoteStore.setVaultAliasId(vaultAliasId);
			}

			const socketUrl = this.settings.serverUrl.replace(/^http/i, 'ws');

			const configDir = (this.app.vault as any).configDir || '.obsidian';
			this.noteRepo = new ObsidianNoteRepository(this.app, this.settings);
			this.vfsController = new LoroVfsController(this.syncEngine, this.eventBus, this.settings, configDir);
			this.diskReconciler = new ObsidianDiskReconciler(this.app, this.syncEngine, this.eventBus);
			this.vaultEventWatcher = new VaultEventWatcher(this.app, this.eventBus, this.settings);
			this.networkOrchestrator = new NetworkOrchestrator(
				this.remoteStore,
				this.cryptoService,
				this.syncEngine,
				this.noteRepo,
				this.vfsController,
				this.eventBus,
				(status, msg) => this.updateStatusBar(status, msg),
				this.settings.syncDebounceMs,
				this.diskReconciler
			);

			await this.vfsController.initialize();
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