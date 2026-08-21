import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// Polyfill WebCrypto...
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto as any;
} else if (!globalThis.crypto.subtle) {
    globalThis.crypto.subtle = webcrypto.subtle as any;
    globalThis.crypto.getRandomValues = webcrypto.getRandomValues.bind(webcrypto) as any;
}

// Add these dummy exports to satisfy Vite's resolver and `instanceof` checks
export class App {}
export class TFile {}
export class TFolder {}
export class TAbstractFile {}

export const requestUrl = async (options: any) => {
    return { status: 200, json: {}, text: '' };
};