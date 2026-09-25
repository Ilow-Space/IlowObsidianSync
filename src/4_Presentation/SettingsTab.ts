import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import IlowSyncPlugin from './Plugin';
import { QrDisplayModal } from './Modals/QrDisplayModal';
import { QrScannerModal } from './Modals/QrScannerModal';
import { ConfirmationModal } from './Modals/ConfirmationModal';

import { SettingDefinitionItem } from 'obsidian';

export class SettingsTab extends PluginSettingTab {
	private tempPassword = '';

	constructor(app: App, private plugin: IlowSyncPlugin) {
		super(app, plugin);
	}

	public getSettingDefinitions(): SettingDefinitionItem[] {
		const themesDir = `${this.app.vault.configDir}/themes/`;
		return [
			{
				type: 'group',
				name: 'Connection & Security',
				items: [
					{ name: 'Base URL', description: 'Enter your backend HTTP endpoint (e.g., https://api.my-domain.com).' },
					{ name: 'API Key', description: 'Enter the API Key used to authenticate REST and WebSocket connections.' },
					{ name: 'Admin API Token', description: 'Enter your secure Admin API Token configured on your unified Go backend server to enable database purge/maintenance operations.' },
					{ name: 'Cryptography Salt', description: 'The cryptographic salt used for key derivation (Hex representation). This is automatically generated or loaded via QR.' },
					{ name: 'Master Password', description: 'Derive the 256-bit AES-GCM Key. This is never stored on disk or shared.' },
					{ name: 'Test Connection', description: 'Verify that the backend server is reachable and configured correctly.' },
					{ name: 'Force Sync & Compact', description: 'Manually trigger an absolute sync, and compact database history to save database storage space.' }
				]
			},
			{
				type: 'group',
				name: 'Extension & Theme Sync',
				items: [
					{ name: 'Sync Plugin Settings', description: 'Synchronize plugin settings (data.json files).' },
					{ name: 'Sync Plugin Binaries', description: 'Synchronize plugin main.js, manifest.json, and styles.css files.' },
					{ name: 'Sync Themes', description: `Synchronize custom installed themes (${themesDir}).` },
					{ name: 'Sync Appearance & Core Settings', description: 'Synchronize appearance.json, community-plugins.json, and hotkeys.json.' }
				]
			},
			{
				type: 'group',
				name: 'Multi-Device Onboarding',
				items: [
					{ name: 'Generate Network QR Code', description: 'Display a secure QR code containing Server URL, API Key, and Salt to easily onboard another device.' },
					{ name: 'Scan Network QR Code', description: 'Scan a setup QR code from your other device to instantly configure database and E2EE parameters.' }
				]
			},
			{
				type: 'group',
				name: 'Maintenance & Danger Zone',
				items: [
					{ name: 'Hard Reset Local State', description: 'Wipe local IndexedDB database entirely and trigger a clean re-download of all file snapshots and updates from the remote server.' },
					{ name: 'Verify vault integrity', description: 'Rebuilds every note from exactly what the server holds and reports any that differ. The status light only means the local queue drained, so this is the check to run after a long offline period or a lossy connection.' },
					{ name: 'Purge Server Data', description: 'Securely calls the unified Go backend to run a full TRUNCATE on the remote database. (Requires Admin API Token).' }
				]
			}
		];
	}

	public display(): void {
		this.render(this.containerEl);
	}

	private refreshTab(): void {
		const tab = this as unknown as { update?: () => void };
		if (typeof tab.update === 'function') {
			tab.update();
		} else {
			this.render(this.containerEl);
		}
	}

	render(containerEl: HTMLElement): void {
		containerEl.empty();

		new Setting(containerEl).setName('Connection & Security').setHeading();

		const internalPlugins = (this.app as unknown as { internalPlugins?: { plugins?: { sync?: { enabled?: boolean } } } }).internalPlugins;
		const nativeSyncEnabled = internalPlugins?.plugins?.sync?.enabled;
		if (nativeSyncEnabled) {
			const warning = containerEl.createDiv({ cls: 'ilow-sync-warning' });
			warning.createDiv({ text: '⚠️ Conflict Warning', cls: 'ilow-sync-warning-title' });
			warning.createEl('p', { text: 'For Ilow Sync to function correctly and avoid data corruption, please disable the official Obsidian Sync plugin in your Core Plugins settings.' });
		}

		// Server URL
		new Setting(containerEl)
			.setName('Base URL')
			.setDesc('Enter your backend HTTP endpoint (e.g., https://api.my-domain.com).')
			.addText((text) =>
				text
					.setPlaceholder('https://...')
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						let cleanUrl = value.trim().replace(/\/$/, '');
						if (cleanUrl.startsWith('http://')) {
							cleanUrl = cleanUrl.replace('http://', 'https://');
						}
						this.plugin.settings.serverUrl = cleanUrl;
						await this.plugin.saveSettings();
					})
			);

		// Single API Key Input
		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Enter the API Key used to authenticate REST and WebSocket connections.')
			.addText((text) =>
				text
					.setPlaceholder('Enter your API key')
					.setValue(this.plugin.settings.apiKey || '')
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
						if (this.plugin.getRemoteStore()) {
							this.plugin.getRemoteStore()?.setApiKey(value.trim());
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
						this.plugin.settings.adminToken = value.trim();
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
					.setDestructive()
					.onClick(() => {
						new ConfirmationModal(
							this.app,
							'Regenerate Salt',
							'Warning: Regenerating the salt will change your encryption key. You will lose access to any previously encrypted data in the remote database unless they are re-encrypted.',
							'Regenerate Salt',
							async () => {
								this.plugin.settings.salt = this.plugin.cryptoService.generateSalt();
								await this.plugin.saveSettings();
								this.refreshTab();
								new Notice('New salt generated! Please set your Master Password to derive the new key.');
							}
						).open();
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
					.onChange((value) => {
						this.tempPassword = value;
					})
			)
			.addButton((btn) => {
				if (this.plugin.isKeyDerived) {
					btn.setButtonText('Unload Key')
						.setDestructive()
						.onClick(async () => {
							await this.plugin.unloadKey();
							this.refreshTab();
							new Notice('Master key unloaded from memory and disk.');
						});
				} else {
					btn.setButtonText('Derive Key')
						.setCta()
						.onClick(async () => {
							const pwd = this.tempPassword;
							if (!pwd) {
								new Notice('Please enter a password first');
								return;
							}
							try {
								await this.plugin.deriveKeyFromPassword(pwd);
								this.refreshTab();
								new Notice('Key derived successfully! Sync is now active.');
							} catch {
								new Notice('Failed to derive key. See console.');
							}
						});
				}
			});

		// Test Connection Button
		new Setting(containerEl)
			.setName('Test Connection')
			.setDesc('Verify that the backend server is reachable and configured correctly.')
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
							new Notice('Connection test successful!');
						} else {
							new Notice('Connection failed. Please check your URL and API Key.');
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
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`Compaction failed: ${msg}`);
						}
					})
			);

		new Setting(containerEl).setName('Extension & Theme Sync').setHeading();

		// Sync Plugin Settings
		new Setting(containerEl)
			.setName('Sync Plugin Settings')
			.setDesc('Synchronize plugin settings (data.json files).')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncPluginSettings)
					.onChange((value) => {
						this.plugin.settings.syncPluginSettings = value;
						void this.plugin.saveSettings();
					})
			);

		// Sync Plugin Binaries
		new Setting(containerEl)
			.setName('Sync Plugin Binaries')
			.setDesc('Synchronize plugin main.js, manifest.json, and styles.css files.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncPluginBinaries)
					.onChange(async (value) => {
						this.plugin.settings.syncPluginBinaries = value;
						await this.plugin.saveSettings();
					})
			);

		const themesDir = `${this.app.vault.configDir}/themes/`;
		// Sync Themes
		new Setting(containerEl)
			.setName('Sync Themes')
			.setDesc(`Synchronize custom installed themes (${themesDir}).`)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncThemes)
					.onChange(async (value) => {
						this.plugin.settings.syncThemes = value;
						await this.plugin.saveSettings();
					})
			);

		// Sync Appearance & Core Settings
		new Setting(containerEl)
			.setName('Sync Appearance & Core Settings')
			.setDesc('Synchronize appearance.json, community-plugins.json, and hotkeys.json.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncAppearance)
					.onChange(async (value) => {
						this.plugin.settings.syncAppearance = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName('Multi-Device Onboarding').setHeading();

		// Generate Setup QR Code
		new Setting(containerEl)
			.setName('Generate Network QR Code')
			.setDesc('Display a secure QR code containing Server URL, API Key, and Salt to easily onboard another device.')
			.addButton((btn) =>
				btn.setButtonText('Show QR Code')
					.onClick(() => {
						if (!this.plugin.settings.salt) {
							new Notice('Please generate/load a salt first.');
							return;
						}
						const payload = {
							serverUrl: this.plugin.settings.serverUrl,
							apiKey: this.plugin.settings.apiKey,
							salt: this.plugin.settings.salt
						};
						const modal = new QrDisplayModal(this.app, 'ilow-sync://' + btoa(JSON.stringify(payload)));
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
						const modal = new QrScannerModal(this.app, (text) => {
							if (!text.startsWith('ilow-sync://')) {
								new Notice('Invalid QR code format.');
								return;
							}
							try {
								const base64 = text.replace('ilow-sync://', '');
								const parsed = JSON.parse(atob(base64)) as { serverUrl?: string; apiKey?: string; salt?: string };
								if (parsed.serverUrl && parsed.apiKey !== undefined && parsed.salt) {
									this.plugin.settings.serverUrl = parsed.serverUrl;
									this.plugin.settings.apiKey = parsed.apiKey;
									this.plugin.settings.salt = parsed.salt;
									void this.plugin.saveSettings().then(() => {
										this.refreshTab();
										new Notice('Network settings loaded! Enter your Master Password to derive your key.');
									});
								} else {
									new Notice('QR payload is missing required configuration parameters.');
								}
							} catch {
								new Notice('Failed to parse QR code setup configuration.');
							}
						});
						modal.open();
					})
			);

		new Setting(containerEl).setName('Maintenance & Danger Zone').setHeading();

		// Hard Reset Local State
		new Setting(containerEl)
			.setName('Hard Reset Local State')
			.setDesc('Wipe local IndexedDB database entirely and trigger a clean re-download of all file snapshots and updates from the remote server.')
			.addButton((btn) =>
				btn
					.setButtonText('Hard Reset Local State')
					.setDestructive()
					.onClick(() => {
						new ConfirmationModal(
							this.app,
							'Hard Reset Local State',
							'Are you sure you want to hard reset local state? This will wipe your local CRDT database cache and re-download all documents from the server.',
							'Hard Reset Local State',
							async () => {
								try {
									if (this.plugin.getSyncOrchestrator()) {
										this.plugin.getSyncOrchestrator()?.stopAll();
									}
									await new Promise<void>((resolve, reject) => {
										const req = window.indexedDB.deleteDatabase('ilow-snapshot-store-db');
										req.onsuccess = () => resolve();
										req.onerror = () => reject(req.error || new Error('Failed to delete database'));
										req.onblocked = () => resolve();
									});
									new Notice('Local state hard reset successful! Initiating fresh re-sync...');

									if (this.plugin.isKeyDerived && this.plugin.getSyncOrchestrator()) {
										await this.plugin.getVfsController()?.initialize();
										await this.plugin.getSyncOrchestrator()?.runFullSync();
										new Notice('Local re-sync completed successfully!');
									}
								} catch (err: unknown) {
									const msg = err instanceof Error ? err.message : String(err);
									new Notice(`Hard reset failed: ${msg}`);
								}
							}
						).open();
					})
			);

		// Verify Vault Integrity
		new Setting(containerEl)
			.setName('Verify vault integrity')
			.setDesc('Rebuilds every note from exactly what the server holds and reports any that differ. The status light only means the local queue drained, so this is the check to run after a long offline period or a lossy connection.')
			.addButton((button) =>
				button
					.setButtonText('Verify')
					.onClick(async () => {
						const orchestrator = this.plugin.getSyncOrchestrator();
						if (!orchestrator || !this.plugin.isKeyDerived) {
							new Notice('Connect and unlock the vault before verifying.');
							return;
						}

						button.setDisabled(true);
						button.setButtonText('Verifying...');
						try {
							const report = await orchestrator.verifyVaultIntegrity();
							if (report.diverged.length === 0 && report.unreachable.length === 0) {
								new Notice(`All ${report.checked} document(s) match the server.`);
							} else {
								const preview = report.diverged.slice(0, 5).join('\n');
								console.warn('[Ilow Sync] Documents out of sync:', report);
								new Notice(
									`${report.diverged.length} document(s) differ from the server` +
									(report.unreachable.length > 0 ? `, ${report.unreachable.length} unreachable` : '') +
									(preview ? `:\n${preview}` : '') +
									'\nSee the developer console for the full list.',
									10000
								);
							}
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`Verification failed: ${msg}`);
						} finally {
							button.setDisabled(false);
							button.setButtonText('Verify');
						}
					})
			)
			.addButton((button) =>
				button
					.setButtonText('Push Diverged Files')
					.setCta()
					.onClick(async () => {
						const orchestrator = this.plugin.getSyncOrchestrator();
						if (!orchestrator || !this.plugin.isKeyDerived) {
							new Notice('Connect and unlock the vault before repairing.');
							return;
						}

						button.setDisabled(true);
						button.setButtonText('Pushing...');
						try {
							const report = await orchestrator.verifyVaultIntegrity(true);
							if (report.diverged.length === 0) {
								new Notice('No diverged files found. Vault is completely up to date!');
							} else {
								new Notice(`Successfully pushed ${report.diverged.length} diverged file(s) to the server!`);
							}
						} catch (err: unknown) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`Pushing diverged files failed: ${msg}`);
						} finally {
							button.setDisabled(false);
							button.setButtonText('Push Diverged Files');
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
					.setDestructive()
					.onClick(() => {
						const token = this.plugin.settings.adminToken;
						if (!token) {
							new Notice('Please configure your Admin API Token first!');
							return;
						}
						new ConfirmationModal(
							this.app,
							'Purge Server Data',
							'WARNING: Are you absolutely sure you want to purge all data on the remote server? This action will permanently delete all snapshots and updates and cannot be undone!',
							'Purge Server Data',
							async () => {
								try {
									const store = this.plugin.getRemoteStore();
									if (!store) {
										new Notice('Connection info incomplete');
										return;
									}
									await store.truncateServer(token);
									new Notice('Remote server data successfully purged! The server is now at a clean slate.');
								} catch (err: unknown) {
									const msg = err instanceof Error ? err.message : String(err);
									new Notice(`Purge failed: ${msg}`);
								}
							}
						).open();
					})
			);
	}
}