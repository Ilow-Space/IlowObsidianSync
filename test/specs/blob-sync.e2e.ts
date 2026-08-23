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

describe('Binary Blob Sync Operations', () => {
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
        await browser.pause(1000);
    });

    it('Should successfully sync a binary file (e.g., image) from Vault A to Vault B intact', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            const existing = app.vault.getAbstractFileByPath('test-image.png');
            if (existing) await app.vault.trash(existing, true);

            const fakeImageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
            await app.vault.createBinary('test-image.png', fakeImageBytes.buffer);
        });
        
        await browser.pause(2000);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('test-image.png') !== null);
        }, { timeout: 25000, timeoutMsg: 'Vault B did not receive the binary file via VFS index' });

        await browser.pause(1500);

        const binaryMatch = await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('test-image.png');
            const arrayBuffer = await app.vault.readBinary(file);
            const bytes = new Uint8Array(arrayBuffer);
            
            const expected = [137, 80, 78, 71, 13, 10, 26, 10];
            if (bytes.length !== expected.length) return false;
            for (let i = 0; i < expected.length; i++) {
                if (bytes[i] !== expected[i]) return false;
            }
            return true;
        });

        expect(binaryMatch).toBe(true);
    });

    it('Should correctly rename a binary file without corrupting its contents', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            const existing = app.vault.getAbstractFileByPath('photo.jpg');
            if (existing) await app.vault.trash(existing, true);

            const bytes = new Uint8Array([255, 216, 255, 224]);
            await app.vault.createBinary('photo.jpg', bytes.buffer);
        });
        await browser.pause(2000);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('photo.jpg') !== null);
        }, { timeout: 25000 });

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('photo.jpg');
            await app.fileManager.renameFile(file, 'renamed-photo.jpg');
        });
        await browser.pause(2000);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('renamed-photo.jpg') !== null);
        }, { timeout: 25000, timeoutMsg: 'Vault B did not process the rename of the binary file' });

        const isContentIntact = await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('renamed-photo.jpg');
            const arrayBuffer = await app.vault.readBinary(file);
            return new Uint8Array(arrayBuffer)[0] === 255;
        });

        expect(isContentIntact).toBe(true);
    });
});
