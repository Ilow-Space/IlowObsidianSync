import { browser, expect } from '@wdio/globals';
import path from 'path';
import fs from 'fs';

import 'dotenv/config'; // Loads variables from .env into process.env

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

    // Patch console.log to capture background sync logs
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

    await browser.execute(async (pass) => {
        const app = (window as any).app;
        if (app.internalPlugins?.plugins?.sync?.enabled) {
            await app.internalPlugins.plugins.sync.disable();
        }
        const pluginId = Object.keys(app.plugins.plugins)[0];
        const plugin = app.plugins.plugins[pluginId];
        if (!plugin) return;

        plugin.settings.syncDebounceMs = 100;

        if (plugin?.deriveKeyFromPassword) {
            await plugin.deriveKeyFromPassword(pass);
        }
    }, pwd);

    await browser.waitUntil(async () => {
        return await browser.execute(() => {
            const logs = (window as any).__obsidianLogs || [];
            return logs.some((l: string) => l.includes('[SyncOrchestrator] Full Sync Complete.'));
        });
    }, { timeout: 15000, timeoutMsg: 'Plugin failed to complete initial background sync.' });
}

describe('Strict Real-Time CRDT Convergence', () => {

    beforeEach(async () => {
        await hardResetDatabase();
        wipeVaultDiskFiles(vaultAPath);
        wipeVaultDiskFiles(vaultBPath);

        // 1. Wipe Vault A cleanly using clearAll() and unloadKey()
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await browser.execute(async () => {
            const app = (window as any).app;
            const pluginId = 'ilow-sync';
            if (app.plugins.enabledPlugins.has(pluginId)) {
                const plugin = app.plugins.plugins[pluginId];
                if (plugin) {
                    if (plugin.yjsEngine && plugin.yjsEngine.localStore) {
                        await plugin.yjsEngine.localStore.clearAll();
                    }
                    await plugin.unloadKey();
                }
            } else {
                await app.plugins.enablePlugin(pluginId);
                const plugin = app.plugins.plugins[pluginId];
                if (plugin) {
                    if (plugin.yjsEngine && plugin.yjsEngine.localStore) {
                        await plugin.yjsEngine.localStore.clearAll();
                    }
                    await plugin.unloadKey();
                }
            }
        });

        // 2. Wipe Vault B cleanly using clearAll() and unloadKey()
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await browser.execute(async () => {
            const app = (window as any).app;
            const pluginId = 'ilow-sync';
            if (app.plugins.enabledPlugins.has(pluginId)) {
                const plugin = app.plugins.plugins[pluginId];
                if (plugin) {
                    if (plugin.yjsEngine && plugin.yjsEngine.localStore) {
                        await plugin.yjsEngine.localStore.clearAll();
                    }
                    await plugin.unloadKey();
                }
            } else {
                await app.plugins.enablePlugin(pluginId);
                const plugin = app.plugins.plugins[pluginId];
                if (plugin) {
                    if (plugin.yjsEngine && plugin.yjsEngine.localStore) {
                        await plugin.yjsEngine.localStore.clearAll();
                    }
                    await plugin.unloadKey();
                }
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

    it('Converges concurrent modifications safely without overwriting data', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, true);
        await browser.execute(async () => {
            await (window as any).app.vault.create('LiveSync.md', 'Base Document\n');
        });
        await browser.pause(800);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, true);
        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('LiveSync.md') !== null);
        }, { timeout: 25000 });

        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('LiveSync.md');
            await app.vault.modify(file, 'Base Document\nAppended by Vault B');
        });
        await browser.pause(800);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, false);
        
        await browser.waitUntil(async () => {
            return await browser.execute(async () => {
                const file = (window as any).app.vault.getAbstractFileByPath('LiveSync.md');
                const content = await (window as any).app.vault.read(file);
                return content.includes('Appended by Vault B');
            });
        }, { timeout: 25000 });

        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('LiveSync.md');
            const current = await app.vault.read(file);
            await app.vault.modify(file, 'Prepended by Vault A\n' + current);
        });
        await browser.pause(800);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, false);
        
        await browser.waitUntil(async () => {
            return await browser.execute(async () => {
                const file = (window as any).app.vault.getAbstractFileByPath('LiveSync.md');
                const content = await (window as any).app.vault.read(file);
                return content.includes('Prepended by Vault A');
            });
        }, { timeout: 25000 });

        const finalContent = await browser.execute(async () => {
            const file = (window as any).app.vault.getAbstractFileByPath('LiveSync.md');
            return await (window as any).app.vault.read(file);
        });

        expect(finalContent).toBe('Prepended by Vault A\nBase Document\nAppended by Vault B');
    });

    it('Safely handles multi-line rapid typing sequences', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, true);
        
        await browser.execute(async () => {
            await (window as any).app.vault.create('RapidTyping.md', '- Item 1\n');
        });
        await browser.pause(800);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, true);
        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('RapidTyping.md') !== null);
        }, { timeout: 25000 });

        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('RapidTyping.md');
            let content = await app.vault.read(file);
            content += '- Item 2\n';
            await app.vault.modify(file, content);
            content += '- Item 3\n';
            await app.vault.modify(file, content);
        });
        await browser.pause(800);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, false);
        
        await browser.waitUntil(async () => {
            return await browser.execute(async () => {
                const file = (window as any).app.vault.getAbstractFileByPath('RapidTyping.md');
                const content = await (window as any).app.vault.read(file);
                return content.includes('Item 3');
            });
        }, { timeout: 25000 });

        const finalContent = await browser.execute(async () => {
            const file = (window as any).app.vault.getAbstractFileByPath('RapidTyping.md');
            return await (window as any).app.vault.read(file);
        });

        expect(finalContent).toBe('- Item 1\n- Item 2\n- Item 3\n');
    });

    it('Propagates file edits in real-time and measures propagation latency', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, true);

        await browser.execute(async () => {
            await (window as any).app.vault.create('LatencyTest.md', 'Initial Content');
        });
        await browser.pause(500);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, true);

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                return (window as any).app.vault.getAbstractFileByPath('LatencyTest.md') !== null;
            });
        }, { timeout: 25000 });

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, false);

        const updatedText = 'Initial Content\n[REALTIME EDIT PROPAGATION TEST PASS]';
        const startTime = Date.now();

        await browser.execute(async (text) => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('LatencyTest.md');
            await app.vault.modify(file, text);
        }, updatedText);

        await browser.pause(500);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD, false);

        await browser.waitUntil(async () => {
            return await browser.execute(async (expected) => {
                const app = (window as any).app;
                const file = app.vault.getAbstractFileByPath('LatencyTest.md');
                if (!file) return false;
                const content = await app.vault.read(file);
                return content === expected;
            }, updatedText);
        }, { timeout: 25000, timeoutMsg: 'Vault B failed to receive real-time edit propagation' });

        const endTime = Date.now();
        const propagationTimeMs = endTime - startTime;

        console.log(`\n==================================================`);
        console.log(`⏱️ REAL-TIME PROPAGATION TIME: ${propagationTimeMs} ms`);
        console.log(`==================================================\n`);

        expect(propagationTimeMs).toBeLessThan(10000);
    });
});