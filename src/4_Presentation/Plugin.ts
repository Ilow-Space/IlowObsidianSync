import { Plugin, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { SettingsTab } from './SettingsTab';
import { WebCryptoService } from '@infrastructure/Crypto/WebCryptoService';
import { PostgresRemoteStore } from '@infrastructure/Postgres/PostgresRemoteStore';
import { ObsidianNoteRepository } from '@infrastructure/Obsidian/ObsidianNoteRepository';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { SyncOrchestrator } from '@application/Sync/SyncOrchestrator';

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
    private derivedKey: CryptoKey | null = null;

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

        this.initializeSyncOrchestrator();

        // Add settings tab
        this.addSettingTab(new SettingsTab(this.app, this));

        // Register vault event listeners
        this.registerEvent(
            this.app.workspace.on('file-open', async (file: TFile | null) => {
                if (file && file.extension === 'md' && this.syncOrchestrator) {
                    await this.syncOrchestrator.handleFileOpen(file.path);
                }
            })
        );

        this.registerEvent(
            this.app.workspace.on('layout-change', async () => {
                // Periodically check active file changes/closing or switching tabs
                // Wait for any active file closing
            })
        );

        // Intercept local editor typing and forward to sync loop
        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (file instanceof TFile && file.extension === 'md' && this.syncOrchestrator) {
                    const content = await this.app.vault.read(file);
                    await this.syncOrchestrator.handleLocalChange(file.path, content);
                }
            })
        );
    }

    async onunload() {
        console.log('Unloading Obsidian CRDT Sync Plugin');
        if (this.syncOrchestrator) {
            this.syncOrchestrator.stopAll();
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

    public async deriveKeyFromPassword(password: string): Promise<void> {
        try {
            this.derivedKey = await this.cryptoService.deriveKey(password, this.settings.salt);
            if (this.syncOrchestrator) {
                this.syncOrchestrator.setCryptoKey(this.derivedKey);
                // If there's an active note, trigger standard pull/sync loop immediately
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'md') {
                    await this.syncOrchestrator.handleFileOpen(activeFile.path);
                }
            }
        } catch (err) {
            console.error('Error deriving master key:', err);
            throw err;
        }
    }

    public unloadKey(): void {
        this.derivedKey = null;
        if (this.syncOrchestrator) {
            this.syncOrchestrator.setCryptoKey(null);
            this.syncOrchestrator.stopAll();
        }
    }

    private initializeSyncOrchestrator() {
        if (this.syncOrchestrator) {
            this.syncOrchestrator.stopAll();
        }

        if (this.settings.serverUrl) {
            this.remoteStore = new PostgresRemoteStore(this.settings.serverUrl, this.settings.headers);
            this.syncOrchestrator = new SyncOrchestrator(
                this.remoteStore,
                this.cryptoService,
                this.yjsEngine,
                this.noteRepo
            );
            if (this.derivedKey) {
                this.syncOrchestrator.setCryptoKey(this.derivedKey);
            }
        } else {
            this.remoteStore = null;
            this.syncOrchestrator = null;
        }
    }
}
