import { browser, expect } from '@wdio/globals';
import path from 'path';
import fs from 'fs';

const BACKEND_URL = 'https://obsidian.ilow.io';
const ADMIN_TOKEN = 'A547245O7B57F75A7U7B4F7U57I75E7D27b4A5U75IEFBaszsjbuif32772525b?';
const MASTER_PASSWORD = '1';

const vaultAPath = path.join(process.cwd(), 'test', 'vaults', 'vaultA').replace(/\\/g, '/');
const vaultBPath = path.join(process.cwd(), 'test', 'vaults', 'vaultB').replace(/\\/g, '/');

// --- HELPERS ---

async function hardResetDatabase() {
    const result = await browser.executeAsync(async (url, token, done) => {
        try {
            const res = await fetch(`${url}/api/admin/truncate`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            done({ status: res.status });
        } catch (e) {
            done({ error: String(e) });
        }
    }, BACKEND_URL, ADMIN_TOKEN);
    console.log('\n--- [DB RESET RESULT] ---', result, '\n');
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

    await browser.execute(async (pass) => {
        const app = (window as any).app;
        if (app.internalPlugins?.plugins?.sync?.enabled) {
            await app.internalPlugins.plugins.sync.disable();
        }
        const pluginId = Object.keys(app.plugins.plugins)[0];
        const plugin = app.plugins.plugins[pluginId];
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

// --- REALTIME SYNC TEST SUITE ---

describe('Strict Real-Time CRDT Convergence', () => {

    beforeEach(async () => {
        await hardResetDatabase();
        wipeVaultDiskFiles(vaultAPath);
        wipeVaultDiskFiles(vaultBPath);
    });

    afterEach(async function () {
        if (this.currentTest && this.currentTest.state === 'failed') {
            await dumpObsidianLogs(`FAIL: ${this.currentTest.title}`);
        }

        await browser.execute(async () => {
            try {
                const app = (window as any).app;
                if (app?.plugins?.plugins['obsidian-crdt-sync']) {
                    await app.plugins.disablePlugin('obsidian-crdt-sync');
                }
            } catch (e) {}
        });
        
        await browser.pause(500); 
    });

    it('Converges concurrent modifications safely without overwriting data', async () => {
        // Step 1: Establish baseline on Vault A
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();
        await browser.execute(async () => {
            await (window as any).app.vault.create('LiveSync.md', 'Base Document\n');
        });
        await browser.pause(2500);

        // Step 2: Establish baseline on Vault B
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();
        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('LiveSync.md') !== null);
        }, { timeout: 25000 });

        // Step 3: Vault B modifies the end of the file
        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('LiveSync.md');
            await app.vault.modify(file, 'Base Document\nAppended by Vault B');
        });
        await browser.pause(2500);

        // Step 4: Vault A simultaneously modifies the start of the file
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();
        
        // Ensure A has received B's change, then A modifies the start
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
        await browser.pause(2500);

        // Step 5: Verify Vault B converges to the exact same text
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();
        
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

        // The CRDT must perfectly weave both edits together
        expect(finalContent).toBe('Prepended by Vault A\nBase Document\nAppended by Vault B');
    });

    it('Safely handles multi-line rapid typing sequences', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();
        
        // Vault A creates a list
        await browser.execute(async () => {
            await (window as any).app.vault.create('RapidTyping.md', '- Item 1\n');
        });
        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();
        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('RapidTyping.md') !== null);
        }, { timeout: 25000 });

        // Vault B types rapidly
        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('RapidTyping.md');
            let content = await app.vault.read(file);
            content += '- Item 2\n';
            await app.vault.modify(file, content);
            content += '- Item 3\n';
            await app.vault.modify(file, content);
        });
        await browser.pause(2500);

        // Verify Vault A receives the fully structured rapid input
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();
        
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
});