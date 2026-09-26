import { App, PluginSettingTab, Notice, SettingDefinitionItem } from 'obsidian';
import IlowSyncPlugin from './Plugin';
import { QrDisplayModal } from './Modals/QrDisplayModal';
import { QrScannerModal } from './Modals/QrScannerModal';
import { ConfirmationModal } from './Modals/ConfirmationModal';

export class SettingsTab extends PluginSettingTab {
	private tempPassword = '';

	constructor(app: App, private plugin: IlowSyncPlugin) {
		super(app, plugin);
	}

	private isNativeSyncEnabled(): boolean {
		const internalPlugins = (this.app as unknown as { internalPlugins?: { plugins?: { sync?: { enabled?: boolean } } } }).internalPlugins;
		return !!internalPlugins?.plugins?.sync?.enabled;
	}

	private refreshTab(): void {
		this.update();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const themesDir = `${this.app.vault.configDir}/themes/`;

		return [
			{
				type: 'group',
				heading: 'Connection & Security',
				items: [
					{
						name: '',
						searchable: false,
						visible: () => this.isNativeSyncEnabled(),
						render: (setting) => {
							setting.settingEl.empty();
							const warning = setting.settingEl.createDiv({ cls: 'ilow-sync-warning' });
							warning.createDiv({ text: '⚠️ Conflict Warning', cls: 'ilow-sync-warning-title' });
							warning.createEl('p', { text: 'For Ilow Sync to function correctly and avoid data corruption, please disable the official Obsidian Sync plugin in your Core Plugins settings.' });
						}
					},
					{
						name: 'Base URL',
						desc: 'Enter your backend HTTP endpoint (e.g., https://api.my-domain.com).',
						render: (setting) => {
							setting.addText((text) =>
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
						}
					},
					{
						name: 'API Key',
						desc: 'Enter the API Key used to authenticate REST and WebSocket connections.',
						render: (setting) => {
							setting.addText((text) =>
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
						}
					},
					{
						name: 'Admin API Token',
						desc: 'Enter your secure Admin API Token configured on your unified Go backend server to enable database purge/maintenance operations.',
						render: (setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('Enter admin token')
									.setValue(this.plugin.settings.adminToken || '')
									.onChange(async (value) => {
										this.plugin.settings.adminToken = value.trim();
										await this.plugin.saveSettings();
									})
							);
						}
					},
					{
						name: 'Cryptography Salt',
						desc: 'The cryptographic salt used for key derivation (Hex representation). This is automatically generated or loaded via QR.',
						render: (setting) => {
							setting
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
						}
					},
					{
						name: 'Master Password',
						desc: 'Derive the 256-bit AES-GCM Key. This is never stored on disk or shared.',
						render: (setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('Enter secure password')
									.setDisabled(this.plugin.isKeyDerived)
									.onChange((value) => {
										this.tempPassword = value;
									})
							);
							setting.addButton((btn) => {
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
						}
					},
					{
						name: 'Test Connection',
						desc: 'Verify that the backend server is reachable and configured correctly.',
						render: (setting) => {
							setting.addButton((btn) =>
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
						}
					},
					{
						name: 'Force Sync & Compact',
						desc: 'Manually trigger an absolute sync, and compact database history to save database storage space.',
						render: (setting) => {
							setting.addButton((btn) =>
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
						}
					}
				]
			},
			{
				type: 'group',
				heading: 'Extension & Theme Sync',
				items: [
					{
						name: 'Sync Plugin Settings',
						desc: 'Synchronize plugin settings (data.json files).',
						control: { type: 'toggle', key: 'syncPluginSettings' }
					},
					{
						name: 'Sync Plugin Binaries',
						desc: 'Synchronize plugin main.js, manifest.json, and styles.css files.',
						control: { type: 'toggle', key: 'syncPluginBinaries' }
					},
					{
						name: 'Sync Themes',
						desc: `Synchronize custom installed themes (${themesDir}).`,
						control: { type: 'toggle', key: 'syncThemes' }
					},
					{
						name: 'Sync Appearance & Core Settings',
						desc: 'Synchronize appearance.json, community-plugins.json, and hotkeys.json.',
						control: { type: 'toggle', key: 'syncAppearance' }
					}
				]
			},
			{
				type: 'group',
				heading: 'Multi-Device Onboarding',
				items: [
					{
						name: 'Generate Network QR Code',
						desc: 'Display a secure QR code containing Server URL, API Key, and Salt to easily onboard another device.',
						render: (setting) => {
							setting.addButton((btn) =>
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
						}
					},
					{
						name: 'Scan Network QR Code',
						desc: 'Scan a setup QR code from your other device to instantly configure database and E2EE parameters.',
						render: (setting) => {
							setting.addButton((btn) =>
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
						}
					}
				]
			},
			{
				type: 'group',
				heading: 'Maintenance & Danger Zone',
				items: [
					{
						name: 'Hard Reset Local State',
						desc: 'Wipe local IndexedDB database entirely and trigger a clean re-download of all file snapshots and updates from the remote server.',
						render: (setting) => {
							setting.addButton((btn) =>
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
						}
					},
					{
						name: 'Verify vault integrity',
						desc: 'Rebuilds every note from exactly what the server holds and reports any that differ. The status light only means the local queue drained, so this is the check to run after a long offline period or a lossy connection.',
						render: (setting) => {
							setting
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
												const pushedCount = report.pushed?.length ?? 0;
												if (report.diverged.length === 0) {
													new Notice('No diverged files found. Vault is completely up to date!');
												} else if (pushedCount === report.diverged.length) {
													new Notice(`Successfully pushed ${pushedCount} diverged file(s) to the server!`);
												} else {
													new Notice(
														`Pushed ${pushedCount} of ${report.diverged.length} diverged file(s). ` +
														`${report.diverged.length - pushedCount} failed and were queued for retry -- see the developer console.`,
														10000
													);
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
						}
					},
					{
						name: 'Purge Server Data',
						desc: 'Securely calls the unified Go backend to run a full TRUNCATE on the remote database. (Requires Admin API Token).',
						render: (setting) => {
							setting.addButton((btn) =>
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
				]
			}
		];
	}
}
