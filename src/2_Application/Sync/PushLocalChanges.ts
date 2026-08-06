
import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { EncryptedBlob } from '@domain/ValueObjects/CryptoTypes';
import * as Y from 'yjs';
import { gzipSync, gunzipSync } from 'fflate';

function decompress(data: Uint8Array): Uint8Array {
    // Magic bytes for GZIP are 0x1F and 0x8B. Fallback to raw if uncompressed.
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
        return gunzipSync(data);
    }
    return data;
}

export class PushLocalChangesUseCase {
    constructor(
        private remoteStore: IRemoteStore,
        private crypto: ICryptography,
        private crdtEngine: YjsEngine,
        private noteRepo: INoteRepository
    ) {}

    public async execute(documentId: string, localContent: string, key: CryptoKey, path?: string | null): Promise<void> {
        // 1. Inform Yjs of local text changes
        const updateBinary = await this.crdtEngine.handleLocalChange(documentId, localContent);

        // 2. If there are changes, compress, encrypt and push to remote store
        if (updateBinary && updateBinary.length > 0) {
            const compressedBinary = gzipSync(updateBinary);
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
            const compressedBinary = (updateBinary && updateBinary.length > 0) ? gzipSync(updateBinary) : new Uint8Array();
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
        // Fetches all remote updates, applies them locally to build the most up-to-date state
        // Then writes it to the snapshot and clears all remote updates up to the last fetched update ID.
        const doc = await this.crdtEngine.getOrCreateDoc(documentId);

        // Fetch snapshot and all updates to make sure we are fully synced before compacting
        const encryptedSnapshot = await this.remoteStore.fetchSnapshot(documentId);
        if (encryptedSnapshot && encryptedSnapshot.ciphertext) {
            try {
                const decryptedSnapshot = await this.crypto.decrypt(encryptedSnapshot, key);
                await this.crdtEngine.applyUpdates(documentId, [decompress(decryptedSnapshot)]);
            } catch (err) {
                console.error('Decryption of snapshot failed during compaction:', err);
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
                    decryptedUpdates.push(decompress(decrypted));
                } catch (err) {
                    console.error(`Decryption of update ${update.id} failed during compaction:`, err);
                    throw new Error(`Failed to decrypt update ${update.id} during compaction. Aborting.`);
                }
                maxId = Math.max(maxId, update.id);
            }
            if (decryptedUpdates.length > 0) {
                await this.crdtEngine.applyUpdates(documentId, decryptedUpdates);
            }
        }

        // Generate full state update to compact
        const fullStateUpdate = Y.encodeStateAsUpdate(doc);
        const compressedNewState = gzipSync(fullStateUpdate);
        const encryptedNewState = await this.crypto.encrypt(compressedNewState, key);

        let encryptedPath = null;
        if (path) {
            const encoder = new TextEncoder();
            encryptedPath = await this.crypto.encrypt(encoder.encode(path), key);
        }

        // Atomically update snapshot and delete corresponding updates
        await this.remoteStore.compactSnapshot(documentId, encryptedNewState, maxId, false, encryptedPath);
    }
}
