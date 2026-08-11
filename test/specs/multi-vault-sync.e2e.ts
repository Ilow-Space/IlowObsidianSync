import { browser, expect } from '@wdio/globals';
import path from 'path';
import fs from 'fs';

const BACKEND_URL = 'https://obsidian.ilow.io';
const ADMIN_TOKEN = 'A547245O7B57F75A7U7B4F7U57I75E7D27b4A5U75IEFBaszsjbuif32772525b?';
const MASTER_PASSWORD = '1';

const vaultAPath = path.join(process.cwd(), 'test', 'vaults', 'vaultA').replace(/\\/g, '/');
const vaultBPath = path.join(process.cwd(), 'test', 'vaults', 'vaultB').replace(/\\/g, '/');

async function hardResetDatabase() {
    await browser.execute(async (url, token) => {
        try {
            await fetch(`${url}/api/admin/purge`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Admin-Token': token,
                    'Content-Type': 'application/json'
                }
            });
        } catch (e) {}
    }, BACKEND_URL, ADMIN_TOKEN);
}

function wipeVaultDiskFiles(vPath: string) {
    if (!fs.existsSync(vPath)) return;
    const items = fs.readdirSync(vPath);
    for (const item of items) {
        if (item === '.obsidian') continue; // Preserve config folder
        const target = path.join(vPath, item);
        try {
            fs.rmSync(target, { recursive: true, force: true });
        } catch (e) {}
    }
}

async function ensurePluginUnlocked(pwd = MASTER_PASSWORD) {
    await browser.waitUntil(async () => {
        return await browser.execute(() => {
            const app = (window as any).app;
            return app && app.plugins && Object.keys(app.plugins.plugins).length > 0;
        });
    }, { timeout: 30000, timeoutMsg: 'Plugin failed to initialize in memory.' });

    await browser.execute(async (pass) => {
        const app = (window as any).app;

        if (app.internalPlugins?.plugins?.sync?.enabled) {
            await app.internalPlugins.plugins.sync.disable();
        }

        const pluginId = Object.keys(app.plugins.plugins)[0];
        const plugin = app.plugins.plugins[pluginId];
        if (!plugin) return;

        if (typeof plugin.deriveKeyFromPassword === 'function') {
            await plugin.deriveKeyFromPassword(pass);
        } else if (typeof plugin.deriveKey === 'function') {
            await plugin.deriveKey(pass);
        }

        if (typeof plugin.initializeSync === 'function') {
            await plugin.initializeSync();
        } else if (typeof plugin.startSync === 'function') {
            await plugin.startSync();
        }
    }, pwd);

    await browser.pause(1500); // Allow WebSocket handshake
}

describe('Realtime Multi-Vault CRDT Synchronization', () => {

    beforeEach(async () => {
        // 1. Wipe database state on server
        await hardResetDatabase();

        // 2. Clear local vault markdown files on disk
        wipeVaultDiskFiles(vaultAPath);
        wipeVaultDiskFiles(vaultBPath);
    });

    it('Propagates file creation and exact text content from Vault A to Vault B', async () => {
        // Step 1: Open Vault A & Create Note
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            await app.vault.create('SyncNote.md', 'Hello Realtime Peer Sync!');
        });

        await browser.pause(2500); // Allow network transmit

        // Step 2: Open Vault B & Wait for SyncNote.md
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(async () => {
                const app = (window as any).app;
                const file = app.vault.getAbstractFileByPath('SyncNote.md');
                if (!file) return false;
                const content = await app.vault.read(file);
                return content === 'Hello Realtime Peer Sync!';
            });
        }, {
            timeout: 25000,
            timeoutMsg: 'Vault B failed to receive SyncNote.md from backend'
        });

        const fileContent = await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('SyncNote.md');
            return file ? await app.vault.read(file) : '';
        });

        expect(fileContent).toBe('Hello Realtime Peer Sync!');
    });

    it('Propagates folder renames without deleting nested files or spawning (1) duplicates', async () => {
        // Step 1: Open Vault A & Safe Create Folder Structure
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            if (!app.vault.getAbstractFileByPath('Docs')) {
                await app.vault.createFolder('Docs');
            }
            if (!app.vault.getAbstractFileByPath('Docs/Guide.md')) {
                await app.vault.create('Docs/Guide.md', '# Multi-Vault Guide\nPreserved content.');
            }
        });

        await browser.pause(2500);

        // Step 2: Open Vault B & Wait for Docs/Guide.md
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const app = (window as any).app;
                const folder = app.vault.getAbstractFileByPath('Docs');
                const file = app.vault.getAbstractFileByPath('Docs/Guide.md');
                return folder !== null && file !== null;
            });
        }, {
            timeout: 25000,
            timeoutMsg: 'Vault B failed to receive Docs/Guide.md folder structure'
        });

        // Step 3: Rename folder in Vault B
        await browser.execute(async () => {
            const app = (window as any).app;
            const folder = app.vault.getAbstractFileByPath('Docs');
            if (folder) {
                await app.fileManager.renameFile(folder, 'ArchivedDocs');
            }
        });

        await browser.pause(2500);

        // Step 4: Open Vault A & Wait for folder rename propagation
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const app = (window as any).app;
                const oldFile = app.vault.getAbstractFileByPath('Docs/Guide.md');
                const newFile = app.vault.getAbstractFileByPath('ArchivedDocs/Guide.md');
                return oldFile === null && newFile !== null;
            });
        }, {
            timeout: 25000,
            timeoutMsg: 'Vault A failed to receive ArchivedDocs folder rename'
        });

        const vaultAState = await browser.execute(async () => {
            const app = (window as any).app;
            const files = app.vault.getFiles().map((f: any) => f.path);
            const file = app.vault.getAbstractFileByPath('ArchivedDocs/Guide.md');
            const content = file ? await app.vault.read(file) : '';
            return { files, content };
        });

        expect(vaultAState.files).toContain('ArchivedDocs/Guide.md');
        expect(vaultAState.files).not.toContain('ArchivedDocs/Guide (1).md');
        expect(vaultAState.files).not.toContain('Docs/Guide.md');
        expect(vaultAState.content).toBe('# Multi-Vault Guide\nPreserved content.');
    });
});