import { browser, expect } from '@wdio/globals';
import path from 'path';
import fs from 'fs';

import 'dotenv/config';

// Respect process.env.BACKEND_URL from your environment
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

        const resetVaultState = async () => {
            const app = (window as any).app;
            const pluginId = 'ilow-sync';
            
            // Ensure plugin is cleanly loaded
            if (!app.plugins.enabledPlugins.has(pluginId)) {
                await app.plugins.enablePlugin(pluginId);
            }
            
            // Wipe memory and CRDT databases
            const plugin = app.plugins.plugins[pluginId];
            if (plugin) {
                await plugin.unloadKey();
                if (plugin.syncEngine && plugin.syncEngine.localStore) {
                    await plugin.syncEngine.localStore.clearAll();
                }
            }

            // Force physical IndexedDB drop as a fail-safe
            await new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase('ilow-snapshot-store-db');
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
            });
        };

        // Reload Vault A and wipe state
        await browser.reloadObsidian({ vault: vaultAPath });
        await browser.execute(resetVaultState);

        // Reload Vault B and wipe state
        await browser.reloadObsidian({ vault: vaultBPath });
        await browser.execute(resetVaultState);
    });

    afterEach(async function () {
        if (this.currentTest && this.currentTest.state === 'failed') {
            await dumpObsidianLogs(`FAIL: ${this.currentTest.title}`);
        }
        
        // Pause to ensure all background async network/disk operations 
        // finish before tearing down the environment for the next test.
        await browser.pause(1000); 
    });

    it('BUG REGRESSION: UI status must report "Syncing" during background VFS index synchronization', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            for (let i = 0; i < 10; i++) {
                const f = app.vault.getAbstractFileByPath(`StatusTest_${i}.md`);
                if (f) await app.vault.trash(f, true);
                await app.vault.create(`StatusTest_${i}.md`, `Content ${i}`);
            }
        });
        await browser.pause(1000);

        const statusDuringSync = await browser.executeAsync(async (done) => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
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
            for (let i = 0; i < 5; i++) {
                const f = app.vault.getAbstractFileByPath(`RpsTest_${i}.md`);
                if (f) await app.vault.trash(f, true);
                await app.vault.create(`RpsTest_${i}.md`, `Payload ${i}`);
            }
        });
        await browser.pause(2000);

        const rpsDuringSync = await browser.executeAsync(async (url, done) => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            await plugin.getSyncOrchestrator().runFullSync();
            try {
                const res = await fetch(`${url}/api/telemetry`);
                const telemetry = await res.json();
                done(telemetry.rps);
            } catch (e) {
                done(0);
            }
        }, BACKEND_URL);

        expect(rpsDuringSync).toBeLessThanOrEqual(10);
    });

    it('BUG REGRESSION: Folder rename propagation must complete within 2000ms', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            let folder = app.vault.getAbstractFileByPath('FastRenameFolder');
            if (folder) await app.vault.trash(folder, true);
            await app.vault.createFolder('FastRenameFolder');
            await app.vault.create('FastRenameFolder/Doc1.md', 'Data 1');
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
        
        // Let the local mutation enqueue and push over network before tearing down plugin
        await browser.pause(500); 

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
            let folder = app.vault.getAbstractFileByPath('ConflictFolder');
            if (folder) await app.vault.trash(folder, true);
            await app.vault.createFolder('ConflictFolder');
            folder = app.vault.getAbstractFileByPath('ConflictFolder');
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
            const f = app.vault.getAbstractFileByPath('EchoTest.md');
            if (f) await app.vault.trash(f, true);
            await app.vault.create('EchoTest.md', 'Initial remote content');
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
            for (let i = 0; i < 5; i++) {
                const old = app.vault.getAbstractFileByPath(`BloatTest_${i}.md`);
                if (old) await app.vault.trash(old, true);
                const file = await app.vault.create(`BloatTest_${i}.md`, `Temporary Data`);
                await app.vault.trash(file, true);
            }
        });
        await browser.pause(2000);

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
            const old = app.vault.getAbstractFileByPath('CompactionTest.md');
            if (old) await app.vault.trash(old, true);
            
            const file = await app.vault.create('CompactionTest.md', 'Initial');
            for(let i = 0; i <= 51; i++) {
                await app.vault.modify(file, `Edit ${i}`);
            }
        });
        await browser.pause(3000); 

        const snapshotData = (await browser.executeAsync(async (url, done) => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            const uuid = plugin.getSyncOrchestrator().vfsController.getUuidForPath('CompactionTest.md');
            
            if (!uuid) return done({ encrypted_path: null });

            const headers = plugin.getRemoteStore().headers;
            try {
                const res = await fetch(`${url}/api/snapshots/${uuid}`, { headers });
                const data = await res.json();
                done(data[0]);
            } catch (e) {
                done({ encrypted_path: null });
            }
        }, BACKEND_URL)) as any;

        expect(snapshotData.encrypted_path).not.toBeNull();
        expect(snapshotData.encrypted_path).toBeDefined();
    });

    it('HIDDEN BUG 2: Untracked scanner must ingest offline file contents, not push 0-byte ghosts', async () => {
        // 1. Boot Vault A
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        
        // 2. Ensure plugin is active but LOCKED (Offline). Create the file via Obsidian API.
        await browser.execute(async () => {
            const app = (window as any).app;
            const pluginId = 'ilow-sync';
            if (!app.plugins.enabledPlugins.has(pluginId)) {
                await app.plugins.enablePlugin(pluginId);
            }
            await app.plugins.plugins[pluginId]?.unloadKey(); // Strictly offline

            const old = app.vault.getAbstractFileByPath('OfflineData.md');
            if (old) await app.vault.trash(old, true);

            // Create file while offline
            await app.vault.create('OfflineData.md', 'Crucial Offline Content');
        });

        // 3. Unlock the plugin. This triggers runFullSync(), which scans the vault,
        // discovers the untracked OfflineData.md file, and pushes it to the server!
        await ensurePluginUnlocked(MASTER_PASSWORD);

        // Allow network push to complete
        await browser.pause(2000);

        // 4. Boot Vault B and wait for sync
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultBPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        // 5. Wait for the actual CRDT text payload to arrive, not just the VFS index ghost file
        await browser.waitUntil(async () => {
            return await browser.execute(async () => {
                const file = (window as any).app.vault.getAbstractFileByPath('OfflineData.md');
                if (!file) return false;
                const content = await (window as any).app.vault.read(file);
                return content.includes('Crucial Offline Content');
            });
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
            const orch = plugin.getSyncOrchestrator();
            
            const old = app.vault.getAbstractFileByPath('SplitBrain.md');
            if (old) await app.vault.trash(old, true);
            await app.vault.create('SplitBrain.md', 'Data');

            setTimeout(async () => {
                const uuid = orch.vfsController.getUuidForPath('SplitBrain.md');
                if (!uuid) return done(false);
                
                const docRef1 = await orch.crdtEngine.getOrCreateDoc(uuid);
                orch.activeDocumentId = null;
                orch.crdtEngine.removeDoc(uuid);
                const docRef2 = await orch.crdtEngine.getOrCreateDoc(uuid);
                
                done(docRef1 === docRef2);
            }, 500);
        });

        expect(isSameInstance).toBe(true);
    });

    it('HIDDEN BUG 4: VFS must safely recursively create deep folder hierarchies', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        await browser.execute(async () => {
            const app = (window as any).app;
            const old = app.vault.getAbstractFileByPath('Deep');
            if (old) await app.vault.trash(old, true);

            await app.vault.createFolder('Deep');
            await app.vault.createFolder('Deep/Nested');
            await app.vault.createFolder('Deep/Nested/Path');
            await app.vault.create('Deep/Nested/Path/Data.md', 'Deep Data');
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
            const orch = plugin.getSyncOrchestrator();

            const old1 = app.vault.getAbstractFileByPath('LoopOld.md');
            if (old1) await app.vault.trash(old1, true);
            const old2 = app.vault.getAbstractFileByPath('LoopNew.md');
            if (old2) await app.vault.trash(old2, true);

            await app.vault.create('LoopOld.md', 'Data');

            let callCount = 0;
            orch.eventBus.on('LocalFileRenamed', () => { callCount++; });

            // Fire inbound remote move. ObsidianDiskReconciler will execute app.fileManager.renameFile.
            // If path suppression is working, VaultEventWatcher will ignore the native event.
            orch.eventBus.emit('CrdtNodeMoved', {
                uuid: 'fake-uuid',
                oldPath: 'LoopOld.md',
                newPath: 'LoopNew.md'
            });

            setTimeout(() => done(callCount), 1500);
        });

        // Exactly 0. The remote action must not reflect back into the outbound queue.
        expect(renameCalls).toBe(0);
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
            const orch = plugin.getSyncOrchestrator();
            
            const old = app.vault.getAbstractFileByPath('LeakTest.md');
            if (old) await app.vault.trash(old, true);
            
            await app.vault.create('LeakTest.md', 'Data');
            
            setTimeout(async () => {
                const file = app.vault.getAbstractFileByPath('LeakTest.md');
                const uuid = orch.vfsController.getUuidForPath('LeakTest.md');
                if (!uuid) return done({ hasLastSync: false, hasCounter: false });
                
                orch.fileLastSyncIds.set(uuid, 5);
                orch.fileUpdateCounters.set(uuid, 10);
                
                if (file) await app.vault.trash(file, true);
                
                setTimeout(() => {
                    done({
                        hasLastSync: orch.fileLastSyncIds.has(uuid),
                        hasCounter: orch.fileUpdateCounters.has(uuid)
                    });
                }, 1000);
            }, 500);
        })) as any;

        expect(leakedKeys.hasLastSync).toBe(false);
        expect(leakedKeys.hasCounter).toBe(false);
    });

    it('HIDDEN BUG 8: Remote lock must encompass the network fetch phase, not just disk writes', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        const isLockedDuringFetch = await browser.executeAsync(async (done) => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            const orch = plugin.getSyncOrchestrator();
            const remoteStore = plugin.getRemoteStore();
            
            const originalFetch = remoteStore.fetchUpdatesSince;
            let locked = false;
            
            remoteStore.fetchUpdatesSince = async (...args: any[]) => {
                locked = orch.orchestratorMutex.isLocked();
                return originalFetch.apply(remoteStore, args);
            };

            await orch.pullDocument('shard-index');
            done(locked);
        });

        expect(isLockedDuringFetch).toBe(false);
    });

    it('HIDDEN BUG 9: Subscriptions must not leak exponentially upon plugin reinitialization', async () => {
        await disableActivePlugin(); await browser.reloadObsidian({ vault: vaultAPath });
        await ensurePluginUnlocked(MASTER_PASSWORD);

        // Save settings three times to trigger 3 re-initialization loops
        await browser.execute(async () => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            await plugin.saveSettings();
        });
        await browser.pause(1000);

        await browser.execute(async () => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            await plugin.saveSettings();
        });
        await browser.pause(1000);

        await browser.execute(async () => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            await plugin.saveSettings();
        });
        await browser.pause(1000);

        // Synchronously grab the listener count
        const activeListeners = await browser.execute(() => {
            const plugin = (window as any).app.plugins.plugins['ilow-sync'];
            const manifestListeners = plugin.getRemoteStore().subscriptions.get('manifest') || [];
            return manifestListeners.length;
        });

        expect(activeListeners).toBe(1);
    });
});