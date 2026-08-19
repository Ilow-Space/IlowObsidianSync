import { defineConfig } from '@wdio/config';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

import 'dotenv/config'; 

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'A547245O7B57F75A7U7B4F7U57I75E7D27b4A5U75IEFBaszsjbuif32772525b?';
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || '1';

const cacheDir = path.resolve('.obsidian-cache');
const pluginPath = path.join(process.cwd(), 'dist').replace(/\\/g, '/');
const vaultAPath = path.join(process.cwd(), 'test', 'vaults', 'vaultA').replace(/\\/g, '/');
const vaultBPath = path.join(process.cwd(), 'test', 'vaults', 'vaultB').replace(/\\/g, '/');

let pluginId = 'ilow-sync';
const manifestPath = path.join(pluginPath, 'manifest.json');
if (fs.existsSync(manifestPath)) {
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.id) pluginId = manifest.id;
    } catch (e) {}
}

const sharedSettings = {
    serverUrl: BACKEND_URL,
    postgrestUrl: BACKEND_URL,
    adminToken: ADMIN_TOKEN,
    salt: '973c0f939ca2c4db1750589044bbccd8'
};

[vaultAPath, vaultBPath].forEach(vPath => {
    const obsDir = path.join(vPath, '.obsidian');
    const pluginDir = path.join(obsDir, 'plugins', pluginId);
    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });

    fs.writeFileSync(path.join(obsDir, 'app.json'), JSON.stringify({ enableCommunityPlugins: true }));
    fs.writeFileSync(path.join(obsDir, 'community-plugins.json'), JSON.stringify([pluginId]));
    fs.writeFileSync(path.join(obsDir, 'core-plugins.json'), JSON.stringify({ "sync": false }));
    fs.writeFileSync(path.join(pluginDir, 'data.json'), JSON.stringify(sharedSettings, null, 2));
});

export const config = defineConfig({
    runner: 'local',
    logLevel: 'error',
    cacheDir: cacheDir,
    
    onPrepare: function () {
        if (process.platform === 'win32') {
            try {
                execSync('taskkill /F /IM Obsidian.exe /IM chromedriver.exe /T', { stdio: 'ignore' });
            } catch (e) {}
        }
    },

    // Automatically drain and print Obsidian's browser console logs after each test
    // @ts-ignore
    afterEach: async function (test: any, context: any, { error }: any) {
        try {
            const logs = await browser.getLogs('browser');
            if (logs && logs.length > 0) {
                console.log(`\n--- OBSIDIAN CONSOLE LOGS [${(test as any).title}] ---`);
                logs.forEach(log => {
                    // Filter out noise and render clean output
                    // @ts-ignore
                    if (!log.message.includes('SafeAreaInsetBottom')) {
                        // @ts-ignore
                        console.log(`[${log.level}] ${log.message}`);
                    }
                });
                console.log(`----------------------------------------------------\n`);
            }
        } catch (e) {
            // Logging not supported or empty
        }
    },

    specs: [
        './test/specs/**/*.e2e.ts'
    ],
    
    maxInstances: 1,
    capabilities: [{
        browserName: 'obsidian',
        browserVersion: 'latest',
        // Enable full console log capturing in ChromeDriver
        'goog:loggingPrefs': {
            browser: 'ALL'
        },
        'wdio:obsidianOptions': {
            installerVersion: 'latest',
            plugins: [pluginPath],
            vault: vaultAPath
        }
    }] as any,
    
    services: ['obsidian'],
    framework: 'mocha',
    reporters: ['spec'],
    
    mochaOpts: {
        ui: 'bdd',
        timeout: 120000 
    }
});