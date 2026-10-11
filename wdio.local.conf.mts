import { config as base } from './wdio.conf.mts';
// Local-only: pin to the Obsidian build already in .obsidian-cache (offline-friendly).
// Also needs NO_PROXY=localhost,127.0.0.1 if HTTP(S)_PROXY is set, or webdriver calls hang.
const cap: any = (base as any).capabilities[0];
cap['wdio:obsidianOptions'].installerVersion = '1.14.4';
cap.browserVersion = '1.14.4';
export const config = { ...base, capabilities: [cap] };
