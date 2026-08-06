
import { Plugin, Notice, TFile, TAbstractFile, WorkspaceLeaf, TFolder } from 'obsidian';
import { SettingsTab } from './SettingsTab';
import { WebCryptoService } from '@infrastructure/Crypto/WebCryptoService';
import { PostgresRemoteStore } from '@infrastructure/Postgres/PostgresRemoteStore';
import { ObsidianNoteRepository } from '@infrastructure/Obsidian/ObsidianNoteRepository';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { SyncOrchestrator, SyncStatus } from '@application/Sync/SyncOrchestrator';
import { IndexManager } from '@application/Sync/IndexManager';
import { SyncSidebarView, SYNC_SIDEBAR_VIEW_TYPE } from './Views/SyncSidebarView';

interface PluginSettings {
    serverUrl: string;
    headers: Record<string, string>;
    salt: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
    serverUrl: '',
    headers: {},
    salt: ''
};

export default class MyPlugin extends Plugin {
    public settings!: PluginSettings;
    public cryptoService!: WebCryptoService;
    private noteRepo!: ObsidianNoteRepository;
    private yjsEngine!: YjsEngine;
    private remoteStore: PostgresRemoteStore | null = null;
    private syncOrchestrator: SyncOrchestrator | null = null;
    private indexManager: IndexManager | null = null;
    private derivedKey: CryptoKey | null = null;
    private statusBarItem!: HTMLElement;

    get isKeyDerived(): boolean {
        return this.derivedKey !== null;
    }

    async onload() {
        console.log('Loading Obsidian CRDT Sync Plugin');

        await this.loadSettings();

        this.cryptoService = new WebCryptoService();
        this.noteRepo = new ObsidianNoteRepository(this.app);
        this.yjsEngine = new YjsEngine();

        // Ensure salt is initialized if missing
        if (!this.settings.salt) {
            this.settings.salt = this.cryptoService.generateSalt();
            await this.saveSettings();
        }

        this.noteRepo.onNoteChange(async (path, content) => {
            if (this.syncOrchestrator) {
                await this.syncOrchestrator.handleLocalChange(path, content);
            }
        });

        // Register Sidebar View
        this.registerView(
            SYNC_SIDEBAR_VIEW_TYPE,
            (leaf) => new SyncSidebarView(leaf, this)
        );

        // Status Bar Setup
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass('crdt-sync-status');
        this.statusBarItem.addClass('mod-clickable');
        this.updateStatusBar('offline', 'Disconnected');
        this.statusBarItem.onClickEvent(() => {
            this.activateSidebar();
        });

        // Ribbon Icon Setup
        this.addRibbonIcon('folder-sync', 'CRDT Sync History', () => {
            this.activateSidebar();
        });

        this.initializeSyncOrchestrator();

        // Auto-load persisted key from secure secret storage
        try {
            const keyData = await (this.app as any).secretStorage.getSecret('crdt-master-key');
            if (keyData) {
                this.updateStatusBar('syncing', 'Loading key...');
                this.derivedKey = await this.cryptoService.importKey(keyData);

                if (this.syncOrchestrator && this.indexManager) {
                    this.syncOrchestrator.setCryptoKey(this.derivedKey);
                    this.runBackgroundBootstrap().catch(console.error);
                }
            }
        } catch (err) {
            console.error('Failed to auto-load persisted sync key:', err);
            this.updateStatusBar('error', 'Failed to load key');
        }

        // Add settings tab
        this.addSettingTab(new SettingsTab(this.app, this));

        // Register workspace & vault event listeners
        this.registerEvent(
            this.app.workspace.on('file-open', async (file: TFile | null) => {
                if (file && file.extension === 'md' && this.syncOrchestrator) {
                    await this.syncOrchestrator.handleFileOpen(file.path);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('create', async (file: TAbstractFile) => {
                if (!this.indexManager) return;
                if (file instanceof TFile && file.extension === 'md') {
                    await this.indexManager.handleFileCreate(file.path);
                } else if (file instanceof TFolder) {
                    await this.indexManager.handleFolderCreate(file.path);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', async (file: TAbstractFile, oldPath: string) => {
                if (!this.indexManager) return;
                if (file instanceof TFile && file.extension === 'md') {
                    await this.indexManager.handleFileRename(oldPath, file.path);
                } else if (file instanceof TFolder) {
                    await this.indexManager.handleFolderRename(oldPath, file.path);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', async (file: TAbstractFile) => {
                if (file instanceof TFile && file.extension === 'md' && this.indexManager) {
                    await this.indexManager.handleFileDelete(file.path);
                }
            })
        );

        this.registerInterval(
            window.setInterval(async () => {
                if (this.isKeyDerived && this.indexManager) {
                    await this.indexManager.syncIndex(true); // ⚡ Pass true here
                }
            }, 10000) 
        );
    }

    async onunload() {
        console.log('Unloading Obsidian CRDT Sync Plugin');
        if (this.syncOrchestrator) {
            this.syncOrchestrator.stopAll();
        }
        if (this.remoteStore) {
            this.remoteStore.disconnect();
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

    public getSyncOrchestrator(): SyncOrchestrator | null {
        return this.syncOrchestrator;
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

            // Save the derived key securely to native secret storage
            const exportedKey = await this.cryptoService.exportKey(this.derivedKey);
            await (this.app as any).secretStorage.setSecret('crdt-master-key', exportedKey);

            if (this.syncOrchestrator && this.indexManager) {
                this.syncOrchestrator.setCryptoKey(this.derivedKey);
                this.runBackgroundBootstrap().catch(console.error);
            }
        } catch (err) {
            console.error('Error deriving master key:', err);
            throw err;
        }
    }

    private async runBackgroundBootstrap() {
    if (!this.indexManager || !this.syncOrchestrator || !this.remoteStore) return;
    
    this.updateStatusBar('syncing', 'Bootstrapping index...');
    try {
        await this.indexManager.initialize();
        await this.indexManager.syncIndex(true);
        
        // ⚡ FIX: Subscribe global root index to real-time updates
        const INDEX_DOC_ID = 'root-index';
        this.remoteStore.subscribeToUpdates(INDEX_DOC_ID, () => {
            this.indexManager?.syncIndex(true).catch(console.error);
        });

        await this.indexManager.runCompletenessCheck();
        
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            await this.syncOrchestrator.handleFileOpen(activeFile.path);
        }
        
        this.updateStatusBar('synced', 'Fully synced');
    } catch (err) {
        this.updateStatusBar('error', 'Bootstrap failed');
        console.error('Background bootstrap failed:', err);
    }
}

    public async unloadKey(): Promise<void> {
        this.derivedKey = null;
        if (this.syncOrchestrator) {
            this.syncOrchestrator.setCryptoKey(null);
            this.syncOrchestrator.stopAll();
        }
        this.updateStatusBar('offline', 'Disconnected');

        try {
            await (this.app as any).secretStorage.deleteSecret('crdt_master_key');
        } catch (err) {
            console.error('Failed to remove persisted sync key:', err);
        }
    }

    private initializeSyncOrchestrator() {
        if (this.syncOrchestrator) {
            this.syncOrchestrator.stopAll();
        }
        
        if (this.remoteStore) {
            this.remoteStore.disconnect();
        }

        if (this.settings.serverUrl) {
            this.remoteStore = new PostgresRemoteStore(this.settings.serverUrl, this.settings.headers);
            
            // Derive WebSocket URL and connect realtime listener
            const socketUrl = this.settings.serverUrl.replace(/^http/i, 'ws');
            this.remoteStore.connectWebSocket(socketUrl);

            this.syncOrchestrator = new SyncOrchestrator(
                this.remoteStore,
                this.cryptoService,
                this.yjsEngine,
                this.noteRepo,
                (status, msg) => this.updateStatusBar(status, msg)
            );
            this.indexManager = new IndexManager(this.app, this.yjsEngine, this.syncOrchestrator);
            this.syncOrchestrator.setIndexManager(this.indexManager);

            if (this.derivedKey) {
                this.syncOrchestrator.setCryptoKey(this.derivedKey);
            }
        } else {
            this.remoteStore = null;
            this.syncOrchestrator = null;
            this.indexManager = null;
        }
    }
}

