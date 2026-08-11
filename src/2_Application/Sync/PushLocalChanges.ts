import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import * as Y from 'yjs';
import { gzip, gunzip } from 'fflate';

function decompressAsync(data: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
            gunzip(data, (err, decompressed) => {
                if (err) reject(err);
                else resolve(decompressed);
            });
        } else {
            resolve(data);
        }
    });
}

function compressAsync(data: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        gzip(data, (err, compressed) => {
            if (err) reject(err);
            else resolve(compressed);
        });
    });
}

export class PushLocalChangesUseCase {
    constructor(
        private remoteStore: IRemoteStore,
        private crypto: ICryptography,
        private crdtEngine: YjsEngine,
        private noteRepo: INoteRepository
    ) {}

    public async execute(documentId: string, localContent: string, key: CryptoKey, path?: string | null): Promise<void> {
        const updateBinary = await this.crdtEngine.handleLocalChange(documentId, localContent);

        if (updateBinary && updateBinary.length > 0) {
            const compressedBinary = await compressAsync(updateBinary); // ASYNC
            const encryptedBlob = await this.crypto.encrypt(compressedBinary, key);

            let encryptedPath = null;
            if (path) {
                const encoder = new TextEncoder();
                encryptedPath = await this.crypto.encrypt(encoder.encode(path), key);
            }

            await this.remoteStore.pushUpdate(documentId, encryptedBlob, encryptedPath);
        }
    }

    public async pushRawUpdate(documentId: string, updateBinary: Uint8Array, key: CryptoKey, path?: string | null): Promise<void> {
        if ((updateBinary && updateBinary.length > 0) || path) {
            const compressedBinary = (updateBinary && updateBinary.length > 0) ? await compressAsync(updateBinary) : new Uint8Array();
            const encryptedBlob = await this.crypto.encrypt(compressedBinary, key);

            let encryptedPath = null;
            if (path) {
                const encoder = new TextEncoder();
                encryptedPath = await this.crypto.encrypt(encoder.encode(path), key);
            }

            await this.remoteStore.pushUpdate(documentId, encryptedBlob, encryptedPath);
        }
    }

    public async forceCompact(documentId: string, key: CryptoKey, path?: string | null): Promise<void> {
        const doc = await this.crdtEngine.getOrCreateDoc(documentId);

        const encryptedSnapshot = await this.remoteStore.fetchSnapshot(documentId);
        if (encryptedSnapshot && encryptedSnapshot.ciphertext) {
            try {
                const decryptedSnapshot = await this.crypto.decrypt(encryptedSnapshot, key);
                const decompressed = await decompressAsync(decryptedSnapshot); // ASYNC
                if (decompressed.length > 0) {
                    await this.crdtEngine.applyUpdates(documentId, [decompressed]);
                }
            } catch (err) {
                throw new Error('Failed to decrypt snapshot during compaction. Aborting.');
            }
        }

        const remoteUpdates = await this.remoteStore.fetchUpdatesSince(documentId, 0);
        let maxId = 0;
        if (remoteUpdates.length > 0) {
            const decryptedUpdates: Uint8Array[] = [];
            for (const update of remoteUpdates) {
                try {
                    const decrypted = await this.crypto.decrypt(update.encryptedUpdate, key);
                    const decompressed = await decompressAsync(decrypted); // ASYNC
                    if (decompressed.length > 0) {
                        decryptedUpdates.push(decompressed);
                    }
                } catch (err) {
                    throw new Error(`Failed to decrypt update ${update.id} during compaction. Aborting.`);
                }
                maxId = Math.max(maxId, update.id);
            }
            if (decryptedUpdates.length > 0) {
                await this.crdtEngine.applyUpdates(documentId, decryptedUpdates);
            }
        }

        const fullStateUpdate = Y.encodeStateAsUpdate(doc);
        const compressedNewState = await compressAsync(fullStateUpdate); // ASYNC
        const encryptedNewState = await this.crypto.encrypt(compressedNewState, key);

        let encryptedPath = null;
        if (path) {
            const encoder = new TextEncoder();
            encryptedPath = await this.crypto.encrypt(encoder.encode(path), key);
        }

        await this.remoteStore.compactSnapshot(documentId, encryptedNewState, maxId, false, encryptedPath);
    }
}