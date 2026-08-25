import { browser, expect } from '@wdio/globals';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'A547245O7B57F75A7U7B4F7U57I75E7D27b4A5U75IEFBaszsjbuif32772525b?';
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
        const res = await fetch(`${BACKEND_URL}/api/admin/truncate`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ADMIN_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log('\n--- [DB RESET STATUS] ---', res.status, '\n');
    } catch (e) {
        console.error('\n--- [DB RESET ERROR] ---', e, '\n');
    }
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

async function ensurePluginUnlocked(pwd = MASTER_PASSWORD, wipeDb = false) {
    await browser.waitUntil(async () => {
        return await browser.execute(() => {
            const app = (window as any).app;
            return app && app.plugins && Object.keys(app.plugins.plugins).length > 0;
        });
    }, { timeout: 30000, timeoutMsg: 'Plugin failed to initialize in memory.' });

    await browser.execute(() => {
        if ((window as any).__logsAttached) return;
        (window as any).__logsAttached = true;
        (window as any).__obsidianLogs = [];

        const formatArg = (a: any) => typeof a === 'object' ? JSON.stringify(a) : String(a);
        const origLog = console.log;

        console.log = (...args: any[]) => {
            (window as any).__obsidianLogs.push(`[LOG] ${args.map(formatArg).join(' ')}`);
            origLog.apply(console, args);
        };
    });

    await browser.execute(async (pass, backendUrl) => {
        const app = (window as any).app;
        if (app.internalPlugins?.plugins?.sync?.enabled) {
            await app.internalPlugins.plugins.sync.disable();
        }
        const pluginId = Object.keys(app.plugins.plugins)[0];
        const plugin = app.plugins.plugins[pluginId];
        if (!plugin) return;

        plugin.settings.syncDebounceMs = 100;
        plugin.settings.serverUrl = backendUrl;
        await plugin.saveSettings();

        if (plugin?.deriveKeyFromPassword) {
            await plugin.deriveKeyFromPassword(pass);
        }
    }, pwd, BACKEND_URL);

    await browser.waitUntil(async () => {
        return await browser.execute(() => {
            const logs = (window as any).__obsidianLogs || [];
            return logs.some((l: string) => l.includes('[NetworkOrchestrator] Full Sync Complete.'));
        });
    }, { timeout: 15000, timeoutMsg: 'Plugin failed to complete initial background sync.' });
}

describe('Binary File Synchronization E2E Suite', () => {

    beforeEach(async () => {
        await hardResetDatabase();
        wipeVaultDiskFiles(vaultAPath);
        wipeVaultDiskFiles(vaultBPath);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await browser.execute(async () => {
            const app = (window as any).app;
            const pluginId = 'ilow-sync';
            if (!app.plugins.enabledPlugins.has(pluginId)) {
                await app.plugins.enablePlugin(pluginId);
            }
            const plugin = app.plugins.plugins[pluginId];
            if (plugin) {
                if (plugin.syncEngine && plugin.syncEngine.localStore) {
                    await plugin.syncEngine.localStore.clearAll();
                }
                await plugin.unloadKey();
            }
        });

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await browser.execute(async () => {
            const app = (window as any).app;
            const pluginId = 'ilow-sync';
            if (!app.plugins.enabledPlugins.has(pluginId)) {
                await app.plugins.enablePlugin(pluginId);
            }
            const plugin = app.plugins.plugins[pluginId];
            if (plugin) {
                if (plugin.syncEngine && plugin.syncEngine.localStore) {
                    await plugin.syncEngine.localStore.clearAll();
                }
                await plugin.unloadKey();
            }
        });
    });

    afterEach(async function () {
        if (this.currentTest && this.currentTest.state === 'failed') {
            await dumpObsidianLogs(`FAIL: ${this.currentTest.title}`);
        }

        await browser.execute(async () => {
            try {
                const app = (window as any).app;
                if (app?.plugins?.plugins['ilow-sync']) {
                    await app.plugins.disablePlugin('ilow-sync');
                }
            } catch (e) {}
        });

        await browser.pause(500);
    });

    it('Syncs binary image file across vaults and preserves byte integrity', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, true);

        // 13-byte 1x1 PNG binary payload
        const pngHex = '89504e470d0a1a0a0000000d49484452';

        await browser.execute(async (hex) => {
            const app = (window as any).app;
            const len = hex.length / 2;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            }
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            await app.vault.createBinary('sample_image.png', buffer);
        }, pngHex);

        await browser.pause(1000);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, true);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('sample_image.png') !== null);
        }, { timeout: 25000, timeoutMsg: 'Vault B failed to download binary sample_image.png' });

        const receivedHex = await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('sample_image.png');
            const buffer = await app.vault.readBinary(file);
            const bytes = new Uint8Array(buffer);
            let hex = '';
            for (let i = 0; i < bytes.length; i++) {
                hex += bytes[i].toString(16).padStart(2, '0');
            }
            return hex;
        });

        expect(receivedHex).toBe(pngHex);
    });

    it('Syncs binary file added while offline upon reconnect', async () => {
        // Vault A creates file while OFFLINE (key unloaded / disconnected)
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const app = (window as any).app;
                return app && app.plugins && Object.keys(app.plugins.plugins).length > 0;
            });
        }, { timeout: 30000 });

        const gifHex = '47494638396101000100800000ffffff';

        await browser.execute(async (hex) => {
            const app = (window as any).app;
            const len = hex.length / 2;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            }
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            await app.vault.createBinary('offline_animation.gif', buffer);
        }, gifHex);

        // Connect Vault A online
        await ensurePluginUnlocked(MASTER_PASSWORD, false);
        await browser.pause(1000);

        // Vault B connects online and receives the offline binary file
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, true);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('offline_animation.gif') !== null);
        }, { timeout: 25000, timeoutMsg: 'Vault B failed to pull binary file created offline by Vault A' });

        const receivedHex = await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('offline_animation.gif');
            const buffer = await app.vault.readBinary(file);
            const bytes = new Uint8Array(buffer);
            let hex = '';
            for (let i = 0; i < bytes.length; i++) {
                hex += bytes[i].toString(16).padStart(2, '0');
            }
            return hex;
        });

        expect(receivedHex).toBe(gifHex);
    });
});
