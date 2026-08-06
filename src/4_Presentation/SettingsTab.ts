import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import MyPlugin from './Plugin';
import { QrDisplayModal } from './Modals/QrDisplayModal';
import { QrScannerModal } from './Modals/QrScannerModal';

export class SettingsTab extends PluginSettingTab {
    constructor(app: App, private plugin: MyPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Obsidian CRDT Sync Settings' });

        const nativeSyncEnabled = (this.app as any).internalPlugins?.plugins?.sync?.enabled;
        if (nativeSyncEnabled) {
            const warning = containerEl.createDiv({ cls: 'crdt-sync-warning' });
            warning.style.backgroundColor = 'var(--background-modifier-error)';
            warning.style.padding = '10px';
            warning.style.borderRadius = '5px';
            warning.style.marginBottom = '15px';
            warning.createEl('h3', { text: '⚠️ Conflict Warning', cls: 'crdt-sync-warning-title' });
            warning.createEl('p', { text: 'For Obsidian CRDT Sync to function correctly and avoid data corruption, please disable the official Obsidian Sync plugin in your Core Plugins settings.' });
        }

        // PostgREST URL
        new Setting(containerEl)
            .setName('PostgREST Base URL')
            .setDesc('Enter your PostgREST HTTP endpoint (e.g., https://api.my-domain.com/rest/v1).')
            .addText((text) =>
                text
                    .setPlaceholder('https://...')
                    .setValue(this.plugin.settings.serverUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.serverUrl = value;
                        await this.plugin.saveSettings();
                    })
            );

        // Custom/Authorization Headers
        new Setting(containerEl)
            .setName('Connection Headers')
            .setDesc('Headers to pass for authorization in JSON format (e.g., {"apikey": "...", "Authorization": "Bearer ..."})')
            .addTextArea((text) =>
                text
                    .setPlaceholder('{"Authorization": "Bearer ..."}')
                    .setValue(JSON.stringify(this.plugin.settings.headers, null, 2))
                    .onChange(async (value) => {
                        try {
                            const parsed = JSON.parse(value);
                            this.plugin.settings.headers = parsed;
                            await this.plugin.saveSettings();
                        } catch (e) {
                            // Suppress invalid JSON till typed correctly
                        }
                    })
            );

        // Admin API Token
        new Setting(containerEl)
            .setName('Admin API Token')
            .setDesc('Enter your secure Admin API Token configured on your unified Go backend server to enable database purge/maintenance operations.')
            .addText((text) =>
                text
                    .setPlaceholder('Enter admin token')
                    .setValue(this.plugin.settings.adminToken || '')
                    .onChange(async (value) => {
                        this.plugin.settings.adminToken = value;
                        await this.plugin.saveSettings();
                    })
            );

        // Crypto Salt
        new Setting(containerEl)
            .setName('Cryptography Salt')
            .setDesc('The cryptographic salt used for key derivation (Hex representation). This is automatically generated or loaded via QR.')
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.salt)
                    .setDisabled(true)
            )
            .addButton((btn) =>
                btn
                    .setButtonText('Regenerate Salt')
                    .setWarning()
                    .onClick(async () => {
                        if (confirm('Warning: Regenerating the salt will change your encryption key. You will lose access to any previously encrypted data in the remote Postgres database unless they are re-encrypted.')) {
                            this.plugin.settings.salt = this.plugin.cryptoService.generateSalt();
                            await this.plugin.saveSettings();
                            this.display();
                            new Notice('New salt generated! Please set your Master Password to derive the new key.');
                        }
                    })
            );

        // Master Password (E2EE)
        new Setting(containerEl)
            .setName('Master Password')
            .setDesc('Derive the 256-bit AES-GCM Key. This is never stored on disk or shared.')
            .addText((text) =>
                text
                    .setPlaceholder('Enter secure password')
                    .setDisabled(this.plugin.isKeyDerived)
                    .onChange(async (value) => {
                        // Temp cache for derivation
                        (this as any).tempPassword = value;
                    })
            )
            .addButton((btn) => {
                if (this.plugin.isKeyDerived) {
                    btn.setButtonText('Unload Key')
                        .setWarning()
                        .onClick(async () => {
                            await this.plugin.unloadKey();
                            this.display();
                            new Notice('Master key unloaded from memory and disk.');
                        });
                } else {
                    btn.setButtonText('Derive Key')
                        .setCta()
                        .onClick(async () => {
                            const pwd = (this as any).tempPassword;
                            if (!pwd) {
                                new Notice('Please enter a password first');
                                return;
                            }
                            try {
                                await this.plugin.deriveKeyFromPassword(pwd);
                                this.display();
                                new Notice('Key derived successfully! Sync is now active.');
                            } catch (err) {
                                new Notice('Failed to derive key. See console.');
                            }
                        });
                }
            });

        // Test Connection Button
        new Setting(containerEl)
            .setName('Test Connection')
            .setDesc('Verify that the PostgREST server is reachable and configured correctly.')
            .addButton((btn) =>
                btn.setButtonText('Test')
                    .onClick(async () => {
                        const store = this.plugin.getRemoteStore();
                        if (!store) {
                            new Notice('Connection info incomplete');
                            return;
                        }
                        const ok = await store.testConnection();
                        if (ok) {
                            new Notice('PostgREST connection test successful!');
                        } else {
                            new Notice('Connection failed. Please check your URL, headers, and CORS settings.');
                        }
                    })
            );

        // Force Sync and Compact
        new Setting(containerEl)
            .setName('Force Sync & Compact')
            .setDesc('Manually trigger an absolute sync, and compact database history to save database storage space.')
            .addButton((btn) =>
                btn.setButtonText('Compact Now')
                    .onClick(async () => {
                        const file = this.app.workspace.getActiveFile();
                        if (!file) {
                            new Notice('No active file to compact');
                            return;
                        }
                        try {
                            await this.plugin.getSyncOrchestrator()?.forceSyncAndCompact(file.path);
                            new Notice(`Successfully compacted: ${file.path}`);
                        } catch (err: any) {
                            new Notice(`Compaction failed: ${err.message}`);
                        }
                    })
            );

        containerEl.createEl('h3', { text: 'Multi-Device Onboarding' });

        // Generate Setup QR Code
        new Setting(containerEl)
            .setName('Generate Network QR Code')
            .setDesc('Display a secure QR code containing Server URL, Headers, and Salt to easily onboard another device.')
            .addButton((btn) =>
                btn.setButtonText('Show QR Code')
                    .onClick(() => {
                        if (!this.plugin.settings.salt) {
                            new Notice('Please generate/load a salt first.');
                            return;
                        }
                        const payload = {
                            serverUrl: this.plugin.settings.serverUrl,
                            headers: this.plugin.settings.headers,
                            salt: this.plugin.settings.salt
                        };
                        const modal = new QrDisplayModal(this.app, 'obsidian-sync://' + btoa(JSON.stringify(payload)));
                        modal.open();
                    })
            );

        // Scan Setup QR Code
        new Setting(containerEl)
            .setName('Scan Network QR Code')
            .setDesc('Scan a setup QR code from your other device to instantly configure database and E2EE parameters.')
            .addButton((btn) =>
                btn.setButtonText('Scan QR Code')
                    .onClick(() => {
                        const modal = new QrScannerModal(this.app, async (text) => {
                            if (!text.startsWith('obsidian-sync://')) {
                                new Notice('Invalid QR code format.');
                                return;
                            }
                            try {
                                const base64 = text.replace('obsidian-sync://', '');
                                const parsed = JSON.parse(atob(base64));
                                if (parsed.serverUrl && parsed.headers && parsed.salt) {
                                    this.plugin.settings.serverUrl = parsed.serverUrl;
                                    this.plugin.settings.headers = parsed.headers;
                                    this.plugin.settings.salt = parsed.salt;
                                    await this.plugin.saveSettings();
                                    this.display();
                                    new Notice('Network settings loaded! Enter your Master Password to derive your key.');
                                } else {
                                    new Notice('QR payload is missing required configuration parameters.');
                                }
                            } catch (err) {
                                new Notice('Failed to parse QR code setup configuration.');
                            }
                        });
                        modal.open();
                    })
            );

        containerEl.createEl('h3', { text: 'Maintenance & Danger Zone' });

        // Hard Reset Local State
        new Setting(containerEl)
            .setName('Hard Reset Local State')
            .setDesc('Wipe local IndexedDB database entirely and trigger a clean re-download of all file snapshots and updates from the remote server.')
            .addButton((btn) =>
                btn
                    .setButtonText('Hard Reset Local State')
                    .setWarning()
                    .onClick(async () => {
                        if (confirm('Are you sure you want to hard reset local state? This will wipe your local CRDT database cache and re-download all documents from the server.')) {
                            try {
                                if (this.plugin.getSyncOrchestrator()) {
                                    this.plugin.getSyncOrchestrator()?.stopAll();
                                }
                                await window.indexedDB.deleteDatabase('obsidian-crdt-sync-db');
                                new Notice('Local state hard reset successful! Initiating fresh re-sync...');

                                if (this.plugin.isKeyDerived && this.plugin.getSyncOrchestrator()) {
                                    await this.plugin.indexManager?.initialize();
                                    await this.plugin.indexManager?.syncIndex(false);
                                    new Notice('Local re-sync completed successfully!');
                                }
                            } catch (err: any) {
                                new Notice(`Hard reset failed: ${err.message}`);
                            }
                        }
                    })
            );

        // Purge Server Data
        new Setting(containerEl)
            .setName('Purge Server Data')
            .setDesc('Securely calls the unified Go backend to run a full TRUNCATE on the remote database. (Requires Admin API Token).')
            .addButton((btn) =>
                btn
                    .setButtonText('Purge Server Data')
                    .setWarning()
                    .onClick(async () => {
                        const token = this.plugin.settings.adminToken;
                        if (!token) {
                            new Notice('Please configure your Admin API Token first!');
                            return;
                        }
                        if (confirm('WARNING: Are you absolutely sure you want to purge all data on the remote server? This action will permanently delete all snapshots and updates and cannot be undone!')) {
                            try {
                                const store = this.plugin.getRemoteStore();
                                if (!store) {
                                    new Notice('Connection info incomplete');
                                    return;
                                }
                                await store.truncateServer(token);
                                new Notice('Remote server data successfully purged! The server is now at a clean slate.');
                            } catch (err: any) {
                                new Notice(`Purge failed: ${err.message}`);
                            }
                        }
                    })
            );
    }
}