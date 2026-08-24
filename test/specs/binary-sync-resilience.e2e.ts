import { browser, expect } from '@wdio/globals';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'A547245O7B57F75A7U7B4F7U57I75E7D27b4A5U75IEFBaszsjbuif32772525b?';
const API_KEY = process.env.API_KEY || '7d6594d84bd7baa1cd2db36863555d5c6cf0f62c9fc83acca16a3ac237d26123';
const MASTER_PASSWORD = '1';

const vaultAPath = path.join(process.cwd(), 'test', 'vaults', 'vaultA').replace(/\\/g, '/');
const vaultBPath = path.join(process.cwd(), 'test', 'vaults', 'vaultB').replace(/\\/g, '/');

async function disableActivePlugin() {
	try {
		await browser.execute(async () => {
			const app = (window as any).app;
			if (app?.plugins?.plugins['ilow-sync']) {
				await app.plugins.disablePlugin('ilow-sync');
			}
		});
	} catch (e) {}
}

async function hardResetDatabase() {
	try {
		await fetch(`${BACKEND_URL}/api/admin/truncate`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${ADMIN_TOKEN}`,
				'Content-Type': 'application/json'
			}
		});
	} catch (e) {}
}

function wipeVaultDiskFiles(vPath: string) {
	if (!fs.existsSync(vPath)) return;
	const items = fs.readdirSync(vPath);
	for (const item of items) {
		if (item === '.obsidian') continue;
		const target = path.join(vPath, item);
		try {
			fs.rmSync(target, { recursive: true, force: true });
		} catch (e) {}
	}
}

async function dumpObsidianLogs(tag: string) {
	try {
		const logs = await browser.execute(() => {
			const l = (window as any).__obsidianLogs || [];
			(window as any).__obsidianLogs = [];
			return l;
		});

		if (logs && logs.length > 0) {
			process.stdout.write(`\n--- [OBSIDIAN LOGS: ${tag}] ---\n`);
			logs.forEach((log: string) => process.stdout.write(`${log}\n`));
			process.stdout.write(`-------------------------------\n\n`);
		}
	} catch (e) {}
}

async function ensurePluginUnlocked(pwd = MASTER_PASSWORD) {
	await browser.waitUntil(async () => {
		return await browser.execute(async (pass, backendUrl, apiKey) => {
			const app = (window as any).app;
			if (!app || !app.plugins || Object.keys(app.plugins.plugins).length === 0) return false;

			if (!(window as any).__logsAttached) {
				(window as any).__logsAttached = true;
				(window as any).__obsidianLogs = [];
				const formatArg = (a: any) => typeof a === 'object' ? JSON.stringify(a) : String(a);
				const origLog = console.log;
				console.log = (...args: any[]) => {
					(window as any).__obsidianLogs.push(`[LOG] ${args.map(formatArg).join(' ')}`);
					origLog.apply(console, args);
				};
			}

			if (app.internalPlugins?.plugins?.sync?.enabled) {
				await app.internalPlugins.plugins.sync.disable();
			}
			const pluginId = Object.keys(app.plugins.plugins)[0];
			const plugin = app.plugins.plugins[pluginId];
			if (!plugin) return false;

			if (plugin.settings.serverUrl !== backendUrl || plugin.settings.apiKey !== apiKey || plugin.settings.syncDebounceMs !== 100) {
				plugin.settings.syncDebounceMs = 100;
				plugin.settings.serverUrl = backendUrl;
				plugin.settings.apiKey = apiKey;
				await plugin.saveSettings();

				if (plugin.getRemoteStore()) {
					plugin.getRemoteStore()?.setApiKey(apiKey);
				}
			}

			if (plugin?.deriveKeyFromPassword && !plugin.derivedKey) {
				await plugin.deriveKeyFromPassword(pass);
			}
			return true;
		}, pwd, BACKEND_URL, API_KEY);
	}, { timeout: 30000, interval: 50 });

	await browser.waitUntil(async () => {
		return await browser.execute(() => {
			const plugin = (window as any).app.plugins.plugins['ilow-sync'];
			return plugin && plugin.getSyncOrchestrator() && plugin.getSyncOrchestrator().isSyncInitialized();
		});
	}, { timeout: 15000, interval: 50 });
}

describe('Binary Synchronization Resilience & Edge Cases Suite', () => {
	beforeEach(async () => {
		await hardResetDatabase();
		wipeVaultDiskFiles(vaultAPath);
		wipeVaultDiskFiles(vaultBPath);

		const resetVaultState = async () => {
			const app = (window as any).app;
			const pluginId = 'ilow-sync';
			if (!app.plugins.enabledPlugins.has(pluginId)) {
				await app.plugins.enablePlugin(pluginId);
			}
			const plugin = app.plugins.plugins[pluginId];
			if (plugin) {
				await plugin.unloadKey();
				if (plugin.syncEngine?.localStore) {
					await plugin.syncEngine.localStore.clearAll();
				}
			}
		};

		await browser.reloadObsidian({ vault: vaultAPath });
		await browser.execute(resetVaultState);

		await browser.reloadObsidian({ vault: vaultBPath });
		await browser.execute(resetVaultState);
	});

	afterEach(async function () {
		if (this.currentTest && this.currentTest.state === 'failed') {
			await dumpObsidianLogs(`FAIL: ${this.currentTest.title}`);
		}
		await browser.pause(500);
	});

	it('Should sync large binary payloads (500KB+) intact without callstack or memory overflow', async () => {
		await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
		await ensurePluginUnlocked(MASTER_PASSWORD);

		const targetPath = 'large-document.pdf';
		const sizeInBytes = 512 * 1024; // 512KB
		const checksum = 42;

		await browser.execute(async (filePath, size, chk) => {
			const app = (window as any).app;
			const existing = app.vault.getAbstractFileByPath(filePath);
			if (existing) await app.vault.trash(existing, true);

			const largeBytes = new Uint8Array(size);
			for (let i = 0; i < size; i++) {
				largeBytes[i] = (i + chk) % 256;
			}
			await app.vault.createBinary(filePath, largeBytes.buffer);
		}, targetPath, sizeInBytes, checksum);

		await browser.pause(3000);

		await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
		await ensurePluginUnlocked(MASTER_PASSWORD);

		await browser.waitUntil(async () => {
			return await browser.execute((p) => (window as any).app.vault.getAbstractFileByPath(p) !== null, targetPath);
		}, { timeout: 30000, timeoutMsg: 'Vault B failed to receive large binary file' });

		await browser.pause(1500);

		const isValid = await browser.execute(async (filePath, size, chk) => {
			const app = (window as any).app;
			const file = app.vault.getAbstractFileByPath(filePath);
			if (!file) return false;
			const buffer = await app.vault.readBinary(file);
			const bytes = new Uint8Array(buffer);
			if (bytes.length !== size) return false;
			for (let i = 0; i < size; i += 4096) {
				if (bytes[i] !== (i + chk) % 256) return false;
			}
			return true;
		}, targetPath, sizeInBytes, checksum);

		expect(isValid).toBe(true);
	});

	it('Should handle rapid sequential binary file updates without corrupting data', async () => {
		await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
		await ensurePluginUnlocked(MASTER_PASSWORD);

		const targetPath = 'rapid-binary.png';

		await browser.execute(async (filePath) => {
			const app = (window as any).app;
			const existing = app.vault.getAbstractFileByPath(filePath);
			if (existing) await app.vault.trash(existing, true);

			const initial = new Uint8Array([1, 2, 3, 4, 5]);
			await app.vault.createBinary(filePath, initial.buffer);
		}, targetPath);

		await browser.pause(1000);

		// Perform rapid updates
		for (let v = 10; v <= 30; v += 10) {
			await browser.execute(async (filePath, versionVal) => {
				const app = (window as any).app;
				const file = app.vault.getAbstractFileByPath(filePath);
				const updated = new Uint8Array([versionVal, versionVal + 1, versionVal + 2, versionVal + 3]);
				await app.vault.modifyBinary(file, updated.buffer);
			}, targetPath, v);
			await browser.pause(300);
		}

		await browser.pause(2500);

		await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
		await ensurePluginUnlocked(MASTER_PASSWORD);

		await browser.waitUntil(async () => {
			return await browser.execute((p) => (window as any).app.vault.getAbstractFileByPath(p) !== null, targetPath);
		}, { timeout: 25000 });

		const finalVal = await browser.execute(async (filePath) => {
			const app = (window as any).app;
			const file = app.vault.getAbstractFileByPath(filePath);
			const buffer = await app.vault.readBinary(file);
			const bytes = new Uint8Array(buffer);
			return bytes[0];
		}, targetPath);

		expect(finalVal).toBe(30);
	});

	it('Should sync binary files nested inside deeply created folders', async () => {
		await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
		await ensurePluginUnlocked(MASTER_PASSWORD);

		const nestedPath = 'Assets/Images/Sub/diagram.png';

		await browser.execute(async (p) => {
			const app = (window as any).app;
			const parts = p.split('/');
			let current = '';
			for (let i = 0; i < parts.length - 1; i++) {
				current = current ? `${current}/${parts[i]}` : parts[i];
				if (!app.vault.getAbstractFileByPath(current)) {
					await app.vault.createFolder(current);
				}
			}

			const data = new Uint8Array([89, 80, 78, 71]);
			await app.vault.createBinary(p, data.buffer);
		}, nestedPath);

		await browser.pause(2000);

		await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
		await ensurePluginUnlocked(MASTER_PASSWORD);

		await browser.waitUntil(async () => {
			return await browser.execute((p) => (window as any).app.vault.getAbstractFileByPath(p) !== null, nestedPath);
		}, { timeout: 25000 });

		const isNestedBinaryValid = await browser.execute(async (p) => {
			const app = (window as any).app;
			const file = app.vault.getAbstractFileByPath(p);
			const buf = await app.vault.readBinary(file);
			const bytes = new Uint8Array(buf);
			return bytes.length === 4 && bytes[0] === 89 && bytes[3] === 71;
		}, nestedPath);

		expect(isNestedBinaryValid).toBe(true);
	});

	it('Should safely reconcile offline binary modifications and propagate changes on reconnect', async () => {
		// 1. Initial creation on Vault A and sync to Vault B
		await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
		await ensurePluginUnlocked(MASTER_PASSWORD);

		const binaryPath = 'offline-asset.ico';
		await browser.execute(async (p) => {
			const app = (window as any).app;
			const bytes = new Uint8Array([0, 0, 1, 0, 100]);
			await app.vault.createBinary(p, bytes.buffer);
		}, binaryPath);

		await browser.pause(2000);

		await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
		await ensurePluginUnlocked(MASTER_PASSWORD);

		await browser.waitUntil(async () => {
			return await browser.execute((p) => (window as any).app.vault.getAbstractFileByPath(p) !== null, binaryPath);
		}, { timeout: 25000 });

		// 2. Modify binary file locally in Vault A offline while sync is disabled
		await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
		await browser.execute(async (p) => {
			const app = (window as any).app;
			// Disable plugin to simulate offline edit
			if (app.plugins.plugins['ilow-sync']) {
				await app.plugins.disablePlugin('ilow-sync');
			}
			const file = app.vault.getAbstractFileByPath(p);
			const newBytes = new Uint8Array([200, 201, 202, 203]);
			await app.vault.modifyBinary(file, newBytes.buffer);
		}, binaryPath);

		await browser.pause(1000);

		// 3. Re-enable plugin in Vault A and ensure offline change is ingested and synced
		await ensurePluginUnlocked(MASTER_PASSWORD);
		await browser.pause(3000);

		// 4. Check Vault B receives the updated offline binary content
		await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
		await ensurePluginUnlocked(MASTER_PASSWORD);

		await browser.pause(2000);

		const isUpdatedContentInVaultB = await browser.execute(async (p) => {
			const app = (window as any).app;
			const file = app.vault.getAbstractFileByPath(p);
			const buf = await app.vault.readBinary(file);
			const bytes = new Uint8Array(buf);
			return bytes.length === 4 && bytes[0] === 200 && bytes[3] === 203;
		}, binaryPath);

		expect(isUpdatedContentInVaultB).toBe(true);
	});
});
