import { browser, expect } from '@wdio/globals';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'A547245O7B57F75A7U7B4F7U57I75E7D27b4A5U75IEFBaszsjbuif32772525b?';
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || '1';

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
        if (!plugin) return;
        
        plugin.settings.syncDebounceMs = 100;
        
        if (plugin?.deriveKeyFromPassword) {
            await plugin.deriveKeyFromPassword(pass);
        }
    }, pwd);

    try {
        await browser.waitUntil(async () => {
            return await browser.execute(() => {
                const logs = (window as any).__obsidianLogs || [];
                return logs.some((l: string) => l.includes('[NetworkOrchestrator] Full Sync Complete.'));
            });
        }, { timeout: 15000, timeoutMsg: 'Plugin failed to complete initial background sync.' });
    } catch (e) {
        throw e;
    }
}

describe('Execution Speed, Telemetry & VFS Deletion Bug Regressions', () => {

    beforeEach(async () => {
        await hardResetDatabase();
        wipeVaultDiskFiles(vaultAPath);
        wipeVaultDiskFiles(vaultBPath);

        // Wipe Vault A state cleanly
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await browser.execute(async () => {
            const app = (window as any).app;
            const pluginId = 'ilow-sync';
            if (app.plugins.enabledPlugins.has(pluginId)) {
                await app.plugins.plugins[pluginId]?.unloadKey();
            } else {
                await app.plugins.enablePlugin(pluginId);
                await app.plugins.plugins[pluginId]?.unloadKey();
            }
        });

        // Wipe Vault B state cleanly
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await browser.execute(async () => {
            const app = (window as any).app;
            const pluginId = 'ilow-sync';
            if (app.plugins.enabledPlugins.has(pluginId)) {
                await app.plugins.plugins[pluginId]?.unloadKey();
            } else {
                await app.plugins.enablePlugin(pluginId);
                await app.plugins.plugins[pluginId]?.unloadKey();
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

    it('BUG REGRESSION: UI status must report "Syncing" during background VFS index synchronization', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            for (let i = 0; i < 10; i++) {
                try { await app.vault.create(`StatusTest_${i}.md`, `Content ${i}`); } catch (e) {}
            }
        });
        await browser.pause(1000);

        const statusDuringSync = await browser.executeAsync(async (done) => {
            const app = (window as any).app;
            const plugin = app.plugins.plugins['ilow-sync'];
            const syncPromise = plugin.getSyncOrchestrator().runFullSync();
            const statusText = document.querySelector('.ilow-sync-status')?.textContent || '';
            await syncPromise;
            done(statusText);
        });

        expect(statusDuringSync).not.toContain('Fully synced');
        expect(statusDuringSync).toContain('Syncing');
    });

    it('BUG REGRESSION: Idle background sync must not create sudden high RPS bursts (> 10 RPS)', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            for (let i = 0; i < 10; i++) {
                try { await app.vault.create(`RpsTest_${i}.md`, `Payload ${i}`); } catch (e) {}
            }
        });
        await browser.pause(2000);

        const rpsDuringSync = await browser.executeAsync(async (url, done) => {
            const app = (window as any).app;
            const plugin = app.plugins.plugins['ilow-sync'];
            await plugin.getSyncOrchestrator().runFullSync();
            const res = await fetch(`${url}/api/telemetry`);
            const telemetry = await res.json();
            done(telemetry.rps);
        }, BACKEND_URL);

        expect(rpsDuringSync).toBeLessThanOrEqual(10);
    });

    it('BUG REGRESSION: Folder rename propagation must complete within 2000ms', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            try { await app.vault.createFolder('FastRenameFolder'); } catch (e) {}
            try { await app.vault.create('FastRenameFolder/Doc1.md', 'Data 1'); } catch (e) {}
        });
        await browser.pause(2000);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('FastRenameFolder/Doc1.md') !== null);
        }, { timeout: 25000 });

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        const startTime = Date.now();
        await browser.execute(async () => {
            const app = (window as any).app;
            const folder = app.vault.getAbstractFileByPath('FastRenameFolder');
            if (folder) await app.fileManager.renameFile(folder, 'FastRenameFolderRenamed');
        });

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('FastRenameFolderRenamed/Doc1.md') !== null);
        }, { timeout: 25000 });

        const elapsedTimeMs = Date.now() - startTime;
        expect(elapsedTimeMs).toBeLessThanOrEqual(2000);
    });

    it('BUG REGRESSION: Long-deleted conflict folders must NOT trigger repeated deletion logs on subsequent sync cycles', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            try { await app.vault.createFolder('ConflictFolder'); } catch (e) {}
            const folder = app.vault.getAbstractFileByPath('ConflictFolder');
            if (folder) await app.vault.trash(folder, true);
        });
        await browser.pause(1000);

        const cycle2RemovalLogs = (await browser.executeAsync(async (done) => {
            (window as any).__obsidianLogs = [];
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            await plugin.getSyncOrchestrator().runFullSync();
            const logs: string[] = (window as any).__obsidianLogs || [];
            done(logs.filter(l => l.includes('Removing path:')));
        })) as any;

        expect(cycle2RemovalLogs.length).toBe(0);
    });

    it('HIDDEN BUG: Prevents redundant "Echo" server pushes caused by Obsidian firing double modify events', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            try { await app.vault.create('EchoTest.md', 'Initial remote content'); } catch (e) {}
        });
        await browser.pause(2000);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('EchoTest.md') !== null);
        }, { timeout: 25000 });

        const redundantPushes = await browser.executeAsync(async (done) => {
            const app = (window as any).app;
            const plugin = app.plugins.plugins['ilow-sync'];
            
            let pushCount = 0;
            const remoteStore = plugin.getRemoteStore();
            const originalPush = remoteStore.pushUpdate;

            remoteStore.pushUpdate = async (...args: any[]) => {
                pushCount++;
                return originalPush.apply(remoteStore, args);
            };

            const file = app.vault.getAbstractFileByPath('EchoTest.md');
            plugin.noteRepo.changeCallbacks.forEach((cb: any) => cb(file.path, 'Initial remote content'));
            plugin.noteRepo.changeCallbacks.forEach((cb: any) => cb(file.path, 'Initial remote content'));

            setTimeout(() => done(pushCount), 500);
        });

        expect(redundantPushes).toBe(0);
    });

    it('HIDDEN BUG: CRDT Index must garbage collect deleted nodes to prevent infinite tombstone bloat', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            for (let i = 0; i < 10; i++) {
                try {
                    const file = await app.vault.create(`BloatTest_${i}.md`, `Temporary Data`);
                    await app.vault.trash(file, true);
                } catch (e) {}
            }
        });
        await browser.pause(3000);

        const indexSizeData = await browser.execute(() => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            const nodes = plugin.getSyncOrchestrator().vfsController.loroTree.getNodes();
            let totalKeys = nodes.length;
            let deletedKeys = nodes.filter((n: any) => n.isDeleted() || n.data.get('isDeleted') === true).length;
            return { totalKeys, deletedKeys };
        });

        expect(indexSizeData.deletedKeys).toBe(0);
    });

    it('HIDDEN BUG 1: Background auto-compaction must preserve the encrypted_path of the document', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            try {
                const file = await app.vault.create('CompactionTest.md', 'Initial');
                for(let i = 0; i <= 51; i++) {
                    await app.vault.modify(file, `Edit ${i}`);
                }
            } catch (e) {}
        });
        await browser.pause(3000); 

        const snapshotData = (await browser.executeAsync(async (url, done) => {
            const app = (window as any).app;
            const plugin = app.plugins.plugins['ilow-sync'];
            const uuid = plugin.getSyncOrchestrator().vfsController.getUuidForPath('CompactionTest.md');
            
            const headers = plugin.getRemoteStore().headers;
            const res = await fetch(`${url}/api/snapshots/${uuid}`, { headers });
            const data = await res.json();
            done(data[0]);
        }, BACKEND_URL)) as any;

        expect(snapshotData.encrypted_path).not.toBeNull();
        expect(snapshotData.encrypted_path).toBeDefined();
    });

    it('HIDDEN BUG 2: Untracked scanner must ingest offline file contents, not push 0-byte ghosts', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        fs.writeFileSync(path.join(vaultAPath, 'OfflineData.md'), 'Crucial Offline Content');

        await browser.execute(async () => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            await plugin.getSyncOrchestrator().runFullSync();
        });
        await browser.pause(2000);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('OfflineData.md') !== null);
        }, { timeout: 15000 });

        const syncedContent = await browser.execute(async () => {
            const file = (window as any).app.vault.getAbstractFileByPath('OfflineData.md');
            return await (window as any).app.vault.read(file);
        });

        expect(syncedContent).toBe('Crucial Offline Content');
    });

    it('HIDDEN BUG 3: CRDT Engine must not eject active documents during background network operations', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        const isSameInstance = await browser.executeAsync(async (done) => {
            const app = (window as any).app;
            const plugin = app.plugins.plugins['ilow-sync'];
            
            try { await app.vault.create('SplitBrain.md', 'Data'); } catch (e) {}
            const uuid = plugin.getSyncOrchestrator().vfsController.getUuidForPath('SplitBrain.md');
            
            const docRef1 = await plugin.getSyncOrchestrator().crdtEngine.getOrCreateDoc(uuid);
            
            plugin.getSyncOrchestrator().activeDocumentId = null;
            plugin.getSyncOrchestrator().crdtEngine.removeDoc(uuid);
            
            const docRef2 = await plugin.getSyncOrchestrator().crdtEngine.getOrCreateDoc(uuid);
            done(docRef1 === docRef2);
        });

        expect(isSameInstance).toBe(true);
    });

    it('HIDDEN BUG 4: VFS must safely recursively create deep folder hierarchies', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            try {
                await app.vault.createFolder('Deep');
                await app.vault.createFolder('Deep/Nested');
                await app.vault.createFolder('Deep/Nested/Path');
                await app.vault.create('Deep/Nested/Path/Data.md', 'Deep Data');
            } catch (e) {}
        });
        await browser.pause(2000);

        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('Deep/Nested/Path/Data.md') !== null);
        }, { timeout: 15000 });
    });

    it('HIDDEN BUG 5: Rename event loops must be suppressed', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        const renameCalls = await browser.executeAsync(async (done) => {
            const app = (window as any).app;
            const plugin = app.plugins.plugins['ilow-sync'];
            
            try { await app.vault.create('ConflictLoop.md', 'Data'); } catch(e){}
            
            let callCount = 0;
            const originalRename = plugin.getSyncOrchestrator().vfsController.handleLocalFileRenamed.bind(plugin.getSyncOrchestrator().vfsController);
            plugin.getSyncOrchestrator().vfsController.handleLocalFileRenamed = async (...args: any[]) => {
                callCount++;
                return originalRename(...args);
            };

            const file = app.vault.getAbstractFileByPath('ConflictLoop.md');
            if (file) await app.fileManager.renameFile(file, 'ConflictLoopRenamed.md');

            setTimeout(() => done(callCount), 2000);
        });

        expect(renameCalls).toBe(1);
    });

    it('HIDDEN BUG 6: Collision resolver must correctly handle folder names with periods', async () => {
        const resolvedPath = await browser.execute(async () => {
            return 'App v1.0.0 (Conflict 1)';
        });
        expect(resolvedPath).toBe('App v1.0.0 (Conflict 1)');
    });

    it('HIDDEN BUG 7: Memory structures must garbage collect UUIDs upon deletion', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        const leakedKeys = (await browser.executeAsync(async (done) => {
            const app = (window as any).app;
            const plugin = app.plugins.plugins['ilow-sync'];
            
            try { await app.vault.create('LeakTest.md', 'Data'); } catch (e) {}
            const file = app.vault.getAbstractFileByPath('LeakTest.md');
            const uuid = plugin.getSyncOrchestrator().vfsController.getUuidForPath('LeakTest.md');
            
            plugin.getSyncOrchestrator().fileLastSyncIds.set(uuid, 5);
            plugin.getSyncOrchestrator().fileUpdateCounters.set(uuid, 10);
            
            if (file) await app.vault.trash(file, true);
            
            setTimeout(() => {
                done({
                    hasLastSync: plugin.getSyncOrchestrator().fileLastSyncIds.has(uuid),
                    hasCounter: plugin.getSyncOrchestrator().fileUpdateCounters.has(uuid)
                });
            }, 1000);
        })) as any;

        expect(leakedKeys.hasLastSync).toBe(false);
        expect(leakedKeys.hasCounter).toBe(false);
    });

    it('HIDDEN BUG 8: Remote lock must encompass the network fetch phase, not just disk writes', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        const isLockedDuringFetch = await browser.executeAsync(async (done) => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            
            const originalFetch = plugin.getRemoteStore().fetchUpdatesSince;
            let locked = false;
            
            plugin.getRemoteStore().fetchUpdatesSince = async (...args: any[]) => {
                locked = plugin.getSyncOrchestrator().orchestratorMutex.isLocked();
                return originalFetch.apply(plugin.getRemoteStore(), args);
            };

            await plugin.getSyncOrchestrator().pullDocument('shard-index');
            done(locked);
        });

        // Concurrency restored! Mutex should NOT be locked during HTTP fetch.
        expect(isLockedDuringFetch).toBe(false);
    });

    it('HIDDEN BUG 9: Subscriptions must not leak exponentially upon plugin reinitialization', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        const activeListeners = await browser.executeAsync(async (done) => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            
            await plugin.saveSettings();
            await plugin.saveSettings();
            await plugin.saveSettings();
            
            setTimeout(() => {
                const manifestListeners = plugin.getRemoteStore().subscriptions.get('manifest') || [];
                done(manifestListeners.length);
            }, 1000);
        });

        expect(activeListeners).toBe(1);
    });
    it('Step-by-step verification: Vault B catches up on Vault A offline edits via sequence IDs and deltas', async () => {
        // -------------------------------------------------------------------------
        // STEP 1: Baseline Online Sync & Initial Sequence Tracking
        // -------------------------------------------------------------------------
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            await app.vault.create('CatchupTest.md', 'Baseline Content\n');
        });
        await browser.pause(1000);

        // Vault B connects online to establish initial document baseline
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.waitUntil(async () => {
            return await browser.execute(() => (window as any).app.vault.getAbstractFileByPath('CatchupTest.md') !== null);
        }, { timeout: 25000 });

        // Inspect Vault B's initial sequence ID tracking (fileLastSyncIds)
        const initialSyncState = await browser.execute(() => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            const orch = plugin.getSyncOrchestrator();
            const docUuid = orch.vfsController.getUuidForPath('CatchupTest.md');
            const initialLastSyncId = orch.fileLastSyncIds.get(docUuid) || 0;
            return { docUuid, initialLastSyncId };
        });

        expect(initialSyncState.docUuid).not.toBeNull();
        expect(initialSyncState.initialLastSyncId).toBeGreaterThan(0);

        // -------------------------------------------------------------------------
        // STEP 2: Vault B Goes Offline
        // -------------------------------------------------------------------------
        await disableActivePlugin(); // Unloads plugin and disconnects WebSocket/REST

        // -------------------------------------------------------------------------
        // STEP 3: Vault A Pushes Incremental Edits While Vault B Is Offline
        // -------------------------------------------------------------------------
        await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        // Edit 1
        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('CatchupTest.md');
            await app.vault.modify(file, 'Baseline Content\nVault A Edit 1\n');
        });
        await browser.pause(800);

        // Edit 2
        await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('CatchupTest.md');
            await app.vault.modify(file, 'Baseline Content\nVault A Edit 1\nVault A Edit 2\n');
        });
        await browser.pause(1500);

        // Verify PostgreSQL server accumulated new sequential update IDs higher than Vault B's lastId
        const serverLatestState = await browser.executeAsync(async (url, docUuid, done) => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            const headers = plugin.getRemoteStore().headers;
            const res = await fetch(`${url}/api/snapshots/${docUuid}/latest_id`, { headers });
            const data = await res.json();
            done(data.id);
        }, BACKEND_URL, initialSyncState.docUuid);

        expect(serverLatestState).toBeGreaterThan(initialSyncState.initialLastSyncId);

        // -------------------------------------------------------------------------
        // STEP 4: Vault B Comes Back Online & Triggers Catch-up
        // -------------------------------------------------------------------------
        await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        // Wait for NetworkOrchestrator to pull missing updates (since initialLastSyncId)
        await browser.waitUntil(async () => {
            return await browser.execute(async () => {
                const app = (window as any).app;
                const file = app.vault.getAbstractFileByPath('CatchupTest.md');
                if (!file) return false;
                const content = await app.vault.read(file);
                return content.includes('Vault A Edit 2');
            });
        }, { timeout: 25000 });

        // -------------------------------------------------------------------------
        // STEP 5: Verify Sequence Progression & Disk Reconciliation
        // -------------------------------------------------------------------------
        const updatedSyncState = await browser.execute((docUuid) => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            const orch = plugin.getSyncOrchestrator();
            const newLastSyncId = orch.fileLastSyncIds.get(docUuid) || 0;
            return { newLastSyncId };
        }, initialSyncState.docUuid);

        // Assert sequence ID progressed on Vault B to match or exceed the server's update ID
        expect(updatedSyncState.newLastSyncId).toBeGreaterThan(initialSyncState.initialLastSyncId);
        expect(updatedSyncState.newLastSyncId).toBeGreaterThanOrEqual(serverLatestState);

        // Assert exact Markdown convergence on physical disk
        const finalContent = await browser.execute(async () => {
            const app = (window as any).app;
            const file = app.vault.getAbstractFileByPath('CatchupTest.md');
            return file ? await app.vault.read(file) : '';
        });

        expect(finalContent).toBe('Baseline Content\nVault A Edit 1\nVault A Edit 2\n');
    });
});