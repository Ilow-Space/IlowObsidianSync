import * as Y from 'yjs';
import { CryptoUtils } from '../Crypto/CryptoUtils';

export class LocalHistoryStore {
    private dbName = 'obsidian-crdt-sync-db';
    private storeName = 'document-history';
    private dbPromise: Promise<IDBDatabase> | null = null;

    private getDB(): Promise<IDBDatabase> {
        if (this.dbPromise) return this.dbPromise;

        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
        });

        return this.dbPromise;
    }

    public async saveDocumentState(path: string, stateVector: Uint8Array): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const hex = CryptoUtils.bufToHex(stateVector);
            const request = store.put(hex, path);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    public async loadDocumentState(path: string): Promise<Uint8Array | null> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.get(path);
            request.onsuccess = () => {
                const hex = request.result;
                if (hex && typeof hex === 'string') {
                    resolve(CryptoUtils.hexToBuf(hex));
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    public async deleteDocumentState(path: string): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.delete(path);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}
