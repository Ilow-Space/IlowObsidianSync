import { browser, expect } from '@wdio/globals';
import path from 'path';
import fs from 'fs';

const BACKEND_URL = 'https://obsidian.ilow.io';
const ADMIN_TOKEN = 'A547245O7B57F75A7U7B4F7U57I75E7D27b4A5U75IEFBaszsjbuif32772525b?';
const MASTER_PASSWORD = '1';

const vaultAPath = path.join(process.cwd(), 'test', 'vaults', 'vaultA').replace(/\\/g, '/');
const vaultBPath = path.join(process.cwd(), 'test', 'vaults', 'vaultB').replace(/\\/g, '/');

// --- HELPERS ---

async function validateServerManifest() {
    return await browser.executeAsync(async (url, done) => {
        try {
            const res = await fetch(`${url}/api/vault/manifest`);
            const data = await res.json();
            done(data);
        } catch (e) {
            done({ error: String(e) });
        }
    }, BACKEND_URL);
}

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

// --- TEST SUITE ---

describe('Realtime Multi-Vault CRDT Synchronization', () => {

    beforeEach(async () => {
        await hardResetDatabase();
        wipeVaultDiskFiles(vaultAPath);
        wipeVaultDiskFiles(vaultBPath);
        
        // Ensure browser IndexedDB is wiped so local CRDT history doesn't leak between tests
        await browser.executeAsync((done) => {
            const req = indexedDB.deleteDatabase('obsidian-crdt-sync-db');
            req.onsuccess = () => done(true);
            req.onerror = () => done(false);
            req.onblocked = () => done(false);
        });
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

    // 1. Basic Create & Sync
    it('Propagates file creation and exact text content from Vault A to Vault B', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();

        await browser.execute(async () => {
            const app = (window as any).app;
            await app.vault.create('SyncNote.md', 'Hello Realtime Peer Sync!');
        });

        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();

        await browser.waitUntil(async () => {
            return await browser.execute(async () => {
                const app = (window as any).app;
                const file = app.vault.getAbstractFileByPath('SyncNote.md');
                if (!file) return false;
                const content = await app.vault.read(file);
                return content === 'Hello Realtime Peer Sync!';
            });
        }, { timeout: 25000 });

        const fileContent = await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('SyncNote.md');
            return file ? await app.vault.read(file) : '';
        });

        expect(fileContent).toBe('Hello Realtime Peer Sync!');
    });

    // 2. Folder Rename
    it('Propagates folder renames without deleting nested files or spawning duplicates', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();

        await browser.execute(async () => {
            const app = (window as any).app;
            await app.vault.createFolder('Docs');
            await app.vault.create('Docs/Guide.md', '# Multi-Vault Guide\nPreserved content.');
        });

        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const app = (window as any).app;
                return app.vault.getAbstractFileByPath('Docs/Guide.md') !== null;
            });
        }, { timeout: 25000 });

        // Rename folder on Vault B
        await browser.execute(async () => {
            const app = (window as any).app;
            const folder = app.vault.getAbstractFileByPath('Docs');
            if (folder) await app.fileManager.renameFile(folder, 'ArchivedDocs');
        });

        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const app = (window as any).app;
                return app.vault.getAbstractFileByPath('ArchivedDocs/Guide.md') !== null &&
                       app.vault.getAbstractFileByPath('Docs/Guide.md') === null;
            });
        }, { timeout: 25000 });

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

    // 3. Deep Nested File Creation and Middle Folder Rename
    it('Handles deep nested file creation and parent folder rename without ghosts or duplicates', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();
        
        await browser.execute(async () => {
            const app = (window as any).app;
            await app.vault.createFolder('L1');
            await app.vault.createFolder('L1/L2');
            await app.vault.createFolder('L1/L2/L3');
            await app.vault.create('L1/L2/L3/DeepNote.md', 'Deep content');
        });
        await browser.pause(3000);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();
        
        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                return (window as any).app.vault.getAbstractFileByPath('L1/L2/L3/DeepNote.md') !== null;
            });
        }, { timeout: 25000 });

        // Rename the middle folder in Vault A
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();
        
        await browser.execute(async () => {
            const app = (window as any).app;
            const folder = app.vault.getAbstractFileByPath('L1/L2');
            await app.fileManager.renameFile(folder, 'L1/RenamedL2');
        });
        await browser.pause(3000);

        // Verify Vault B
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();
        
        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const app = (window as any).app;
                return app.vault.getAbstractFileByPath('L1/RenamedL2/L3/DeepNote.md') !== null;
            });
        }, { timeout: 25000 });

        const vaultBState = await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('L1/RenamedL2/L3/DeepNote.md');
            return {
                ghostL2: app.vault.getAbstractFileByPath('L1/L2') !== null,
                ghostFile: app.vault.getAbstractFileByPath('L1/L2/L3/DeepNote.md') !== null,
                content: file ? await app.vault.read(file) : ''
            };
        });

        expect(vaultBState.ghostL2).toBe(false);
        expect(vaultBState.ghostFile).toBe(false);
        expect(vaultBState.content).toBe('Deep content');
    });

    // 4. File Create and Rename (Rapid Sequence)
    it('Handles rapid file creation and immediate rename accurately', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();

        await browser.execute(async () => {
            const app = (window as any).app;
            const file = await app.vault.create('Temp.md', '');
            // Rename immediately before debounce triggers sync
            await app.fileManager.renameFile(file, 'Final.md');
            await app.vault.modify(file, 'Final content');
        });
        
        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                return (window as any).app.vault.getAbstractFileByPath('Final.md') !== null;
            });
        }, { timeout: 25000 });

        const vaultBState = await browser.execute(async () => {
            const app = (window as any).app;
            const tempExists = app.vault.getAbstractFileByPath('Temp.md') !== null;
            const finalFile = app.vault.getAbstractFileByPath('Final.md');
            const content = finalFile ? await app.vault.read(finalFile) : '';
            return { tempExists, content };
        });

        expect(vaultBState.tempExists).toBe(false);
        expect(vaultBState.content).toBe('Final content');
    });

    // 5. Nested File Rename
    it('Propagates nested file renames accurately', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();

        await browser.execute(async () => {
            const app = (window as any).app;
            await app.vault.createFolder('Project');
            await app.vault.create('Project/FileA.md', 'Data');
        });
        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                return (window as any).app.vault.getAbstractFileByPath('Project/FileA.md') !== null;
            });
        }, { timeout: 25000 });

        // Rename file on Vault A
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();

        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('Project/FileA.md');
            await app.fileManager.renameFile(file, 'Project/FileB.md');
        });
        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                return (window as any).app.vault.getAbstractFileByPath('Project/FileB.md') !== null;
            });
        }, { timeout: 25000 });

        const vaultBState = await browser.execute(() => {
            const app = (window as any).app;
            return {
                aExists: app.vault.getAbstractFileByPath('Project/FileA.md') !== null,
                bExists: app.vault.getAbstractFileByPath('Project/FileB.md') !== null,
            };
        });

        expect(vaultBState.aExists).toBe(false);
        expect(vaultBState.bExists).toBe(true);
    });

    // 6. Cross-Vault Bidirectional Rename
    it('Handles bidirectional file renames across vaults', async () => {
        // Vault A creates file
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();
        await browser.execute(async () => {
            const app = (window as any).app;
            await app.vault.create('Shared.md', 'Shared text');
        });
        await browser.pause(2500);

        // Vault B receives and renames file
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked();
        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                return (window as any).app.vault.getAbstractFileByPath('Shared.md') !== null;
            });
        }, { timeout: 25000 });

        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('Shared.md');
            await app.fileManager.renameFile(file, 'MovedShared.md');
        });
        await browser.pause(2500);

        // Vault A receives rename
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked();
        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const app = (window as any).app;
                return app.vault.getAbstractFileByPath('MovedShared.md') !== null && 
                       app.vault.getAbstractFileByPath('Shared.md') === null;
            });
        }, { timeout: 25000 });

        const vaultAState = await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('MovedShared.md');
            const content = file ? await app.vault.read(file) : '';
            return {
                oldExists: app.vault.getAbstractFileByPath('Shared.md') !== null,
                content
            };
        });

        expect(vaultAState.oldExists).toBe(false);
        expect(vaultAState.content).toBe('Shared text');
    });


    // -------------------------------------------------------------------------
    // HEAVY INTEGRITY & EDGE CASE TESTS
    // -------------------------------------------------------------------------

    // 5. Offline File Creation Collision (Path Conflict)
    it('Resolves offline path collisions by preserving both files via conflict renaming', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        // Vault A creates a file online
        await browser.execute(async () => {
            await (window as any).app.vault.create('Collision.md', 'Vault A Content');
        });
        await browser.pause(2500);

        // Vault B creates a file with the EXACT same name while offline
        fs.writeFileSync(path.join(vaultBPath, 'Collision.md'), 'Vault B Offline Content');

        // Vault B boots up, tracks its local file, then pulls Vault A's file
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        try {
            await browser.waitUntil(async () => {
                return await browser.execute(() => {
                    const files = (window as any).app.vault.getFiles().map((f: any) => f.path);
                    return files.includes('Collision (Conflict 1).md');
                });
            }, { timeout: 25000, timeoutMsg: 'Vault B failed to generate conflict file.' });
        } catch (err) {
            await dumpObsidianLogs('Vault B Collision Error');
            throw err;
        }

        const state = await browser.execute(async () => {
            const app = (window as any).app;
            const f1 = app.vault.getAbstractFileByPath('Collision.md');
            const f2 = app.vault.getAbstractFileByPath('Collision (Conflict 1).md');
            return {
                f1Content: f1 ? await app.vault.read(f1) : null,
                f2Content: f2 ? await app.vault.read(f2) : null
            };
        });

        // Ensure NO data is lost. Both distinct contents must survive.
        const contents = [state.f1Content, state.f2Content];
        expect(contents).toContain('Vault A Content');
        expect(contents).toContain('Vault B Offline Content');
    });

    // 6. Offline Folder Merging
    it('Merges offline folders gracefully without duplicating the directory', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            await app.vault.createFolder('SharedFolder');
            await app.vault.create('SharedFolder/A.md', 'File A');
        });
        await browser.pause(2500);

        // Vault B creates the same folder offline with different contents
        fs.mkdirSync(path.join(vaultBPath, 'SharedFolder'));
        fs.writeFileSync(path.join(vaultBPath, 'SharedFolder', 'B.md'), 'File B');

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const app = (window as any).app;
                return app.vault.getAbstractFileByPath('SharedFolder/A.md') !== null &&
                       app.vault.getAbstractFileByPath('SharedFolder/B.md') !== null;
            });
        }, { timeout: 25000 });

        const folders = await browser.execute(() => {
            return (window as any).app.vault.getAllLoadedFiles()
                .filter((f: any) => !f.extension)
                .map((f: any) => f.path);
        });

        expect(folders).toContain('SharedFolder');
        expect(folders).not.toContain('SharedFolder (Conflict 1)');
    });

    // 7. Deep Folder Cascade Deletion
    it('Cascades deletion through deeply nested folders efficiently', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            await app.vault.createFolder('Level1');
            await app.vault.createFolder('Level1/Level2');
            await app.vault.create('Level1/Level2/Deep.md', 'Deep');
        });
        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('Level1/Level2/Deep.md') !== null);
        }, { timeout: 25000 });

        // Delete top level folder on A
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.execute(async () => {
            const app = (window as any).app;
            const folder = app.vault.getAbstractFileByPath('Level1');
            await app.vault.trash(folder, true);
        });
        await browser.pause(2500);

        // Vault B should prune the entire tree
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('Level1') === null);
        }, { timeout: 25000 });

        const bFiles = await browser.execute(() => (window as any).app.vault.getAllLoadedFiles().map((f: any) => f.path));
        expect(bFiles).not.toContain('Level1/Level2/Deep.md');
        expect(bFiles).not.toContain('Level1/Level2');
    });

    // 8. Re-creating a Deleted File Path (Resurrection)
    it('Allows recreating a file at a previously deleted path without ghosting', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        // Create and delete
        await browser.execute(async () => {
            const app = (window as any).app;
            const file = await app.vault.create('Ghost.md', 'Original');
            await app.vault.trash(file, true);
        });
        await browser.pause(1000);

        // Recreate with new content
        await browser.execute(async () => {
            await (window as any).app.vault.create('Ghost.md', 'Resurrected');
        });
        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('Ghost.md') !== null);
        }, { timeout: 25000 });

        const content = await browser.execute(async () => {
            const file = (window as any).app.vault.getAbstractFileByPath('Ghost.md');
            return await (window as any).app.vault.read(file);
        });

        expect(content).toBe('Resurrected');
    });

    // 9. Empty File Hydration
    it('Syncs completely empty files seamlessly', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            await (window as any).app.vault.create('Empty.md', '');
        });
        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('Empty.md') !== null);
        }, { timeout: 25000 });

        const content = await browser.execute(async () => {
            const file = (window as any).app.vault.getAbstractFileByPath('Empty.md');
            return await (window as any).app.vault.read(file);
        });

        expect(content).toBe('');
    });

    // 10. Edit vs Delete Conflict (Offline)
    it('Prioritizes remote deletion over offline local edits to maintain consistency', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            await (window as any).app.vault.create('ConflictDelete.md', 'Base');
        });
        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('ConflictDelete.md') !== null);
        }, { timeout: 25000 });

        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.execute(async () => {
            const file = (window as any).app.vault.getAbstractFileByPath('ConflictDelete.md');
            await (window as any).app.vault.trash(file, true);
        });
        await browser.pause(2500);

        fs.writeFileSync(path.join(vaultBPath, 'ConflictDelete.md'), 'Offline Edit');

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        // FIX: Await physical deletion directly via Node's fs module
        await browser.waitUntil(async () => {
            return !fs.existsSync(path.join(vaultBPath, 'ConflictDelete.md'));
        }, { timeout: 25000, timeoutMsg: 'File was not physically deleted by Phase 1' });

        const exists = fs.existsSync(path.join(vaultBPath, 'ConflictDelete.md'));
        expect(exists).toBe(false);
    });

    // 11. Case-Sensitivity Rename
    it('Accurately tracks case-only renames (Mac/Windows compatibility)', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            await (window as any).app.vault.create('case.md', 'Data');
        });
        await browser.pause(2500);

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('case.md') !== null);
        }, { timeout: 25000 });

        // A performs case-only rename
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.execute(async () => {
            const file = (window as any).app.vault.getAbstractFileByPath('case.md');
            await (window as any).app.fileManager.renameFile(file, 'Case.md');
        });
        await browser.pause(2500);

        // B should apply the new casing
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('Case.md') !== null);
        }, { timeout: 25000 });

        const files = await browser.execute(() => (window as any).app.vault.getFiles().map((f:any)=>f.path));
        expect(files).toContain('Case.md');
        expect(files).not.toContain('case.md');
        expect(files).not.toContain('Case (Conflict 1).md');
    });

    // 12. Move Offline File Out of Remotely Deleted Folder
    it('Preserves offline files moved out of a remotely deleted directory', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            await (window as any).app.vault.createFolder('DropZone');
            await (window as any).app.vault.create('DropZone/KeepMe.md', 'Vital Data');
        });
        await browser.pause(2500);

        // A deletes the folder
        await browser.execute(async () => {
            const folder = (window as any).app.vault.getAbstractFileByPath('DropZone');
            await (window as any).app.vault.trash(folder, true);
        });
        await browser.pause(2500);

        // B offline creates the file at the root instead (simulating a move out of the folder)
        fs.writeFileSync(path.join(vaultBPath, 'KeepMe.md'), 'Vital Data');

        // B boots. 'DropZone' is deleted by sync, but 'KeepMe.md' at root should be tracked as a new file.
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const app = (window as any).app;
                // Wait until background sync logic finishes processing the index
                const logs = (window as any).__obsidianLogs || [];
                return logs.some((l: string) => l.includes('[SyncOrchestrator] Full Sync Complete.'));
            });
        }, { timeout: 25000 });

        const state = await browser.execute(() => {
            const app = (window as any).app;
            return {
                dropZoneExists: app.vault.getAbstractFileByPath('DropZone') !== null,
                keepMeExists: app.vault.getAbstractFileByPath('KeepMe.md') !== null
            };
        });

        expect(state.dropZoneExists).toBe(false);
        expect(state.keepMeExists).toBe(true);
    });

    // 13. High-Volume Batch Creation
    it('Handles rapid multi-file creation without dropping data', async () => {
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            for(let i = 1; i <= 5; i++) {
                await app.vault.create(`Batch${i}.md`, `Content ${i}`);
            }
        });
        await browser.pause(3000); // Give debounce timers time to flush all 5

        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const app = (window as any).app;
                return app.vault.getAbstractFileByPath('Batch5.md') !== null;
            });
        }, { timeout: 25000 });

        const files = await browser.execute(() => (window as any).app.vault.getFiles().map((f:any)=>f.path));
        expect(files).toContain('Batch1.md');
        expect(files).toContain('Batch2.md');
        expect(files).toContain('Batch3.md');
        expect(files).toContain('Batch4.md');
        expect(files).toContain('Batch5.md');
    });

    // 14. Bidirectional Content Edits (CRDT Convergence)
    it('Converges sequential cross-vault content edits without data loss', async () => {
        // A creates
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.execute(async () => {
            await (window as any).app.vault.create('Collab.md', 'Base');
        });
        await browser.pause(2500);

        // B appends
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.waitUntil(async () => await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('Collab.md') !== null), { timeout: 25000 });
        
        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('Collab.md');
            await app.vault.modify(file, 'Base EditB');
        });
        await browser.pause(2500);

        // A appends
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.waitUntil(async () => {
            return await browser.execute(async () => {
                const file = (window as any).app.vault.getAbstractFileByPath('Collab.md');
                const content = await (window as any).app.vault.read(file);
                return content === 'Base EditB';
            });
        }, { timeout: 25000 });

        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('Collab.md');
            await app.vault.modify(file, 'Base EditB EditA');
        });
        await browser.pause(2500);

        // Verify B gets final state
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);
        await browser.waitUntil(async () => {
            return await browser.execute(async () => {
                const file = (window as any).app.vault.getAbstractFileByPath('Collab.md');
                const content = await (window as any).app.vault.read(file);
                return content === 'Base EditB EditA';
            });
        }, { timeout: 25000 });

        const finalContent = await browser.execute(async () => {
            const file = (window as any).app.vault.getAbstractFileByPath('Collab.md');
            return await (window as any).app.vault.read(file);
        });

        expect(finalContent).toBe('Base EditB EditA');
    });
});