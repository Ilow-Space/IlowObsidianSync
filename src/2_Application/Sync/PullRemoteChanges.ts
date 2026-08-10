import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { gunzipSync } from 'fflate';

function decompress(data: Uint8Array): Uint8Array {
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
        return gunzipSync(data);
    }
    return data;
}

export class PullRemoteChangesUseCase {
    constructor(
        private remoteStore: IRemoteStore,
        private crypto: ICryptography,
        private crdtEngine: YjsEngine,
        private noteRepo: INoteRepository,
        private registerRemoteWrite?: (path: string, content: string) => void
    ) {}

    public async execute(
        documentId: string,
        path: string | null,
        lastSyncId: number,
        key: CryptoKey,
        acquireLock: () => void,
        releaseLock: () => void
    ): Promise<{ newLastSyncId: number; appliedCount: number }> {
        let appliedCount = 0;
        let newLastSyncId = lastSyncId;
        let didApplyChanges = false;

        // 1. Process Baseline Snapshot (if we have no local history)
        if (lastSyncId === 0) {
            const encryptedSnapshot = await this.remoteStore.fetchSnapshot(documentId);
            if (encryptedSnapshot && encryptedSnapshot.ciphertext) {
                try {
                    const decryptedSnapshot = await this.crypto.decrypt(encryptedSnapshot, key);
                    const decompressed = decompress(decryptedSnapshot);
                    if (decompressed.length > 0) {
                        await this.crdtEngine.applyUpdates(documentId, [decompressed]);
                        appliedCount++;
                        didApplyChanges = true; // ⚡ FLAG: Content was updated!
                    }
                } catch (err) {
                    console.error(`PullRemoteChangesUseCase failed to decrypt snapshot for ${documentId}:`, err);
                }
            }
        }

        // 2. Process Delta Updates
        const remoteUpdates = await this.remoteStore.fetchUpdatesSince(documentId, lastSyncId);
        if (remoteUpdates.length > 0) {
            const decryptedUpdates: Uint8Array[] = [];
            for (const update of remoteUpdates) {
                try {
                    const decrypted = await this.crypto.decrypt(update.encryptedUpdate, key);
                    const decompressed = decompress(decrypted);
                    if (decompressed.length > 0) {
                        decryptedUpdates.push(decompressed);
                        appliedCount++;
                    }
                } catch (err) {
                    console.error(`PullRemoteChangesUseCase failed to decrypt update ID ${update.id} for ${documentId}:`, err);
                }
                newLastSyncId = Math.max(newLastSyncId, update.id);
            }

            if (decryptedUpdates.length > 0) {
                await this.crdtEngine.applyUpdates(documentId, decryptedUpdates);
                didApplyChanges = true; // ⚡ FLAG: Content was updated!
            }
        }

        // 3. ⚡ FIX: Safely Write ALL applied changes to the hard drive
        if (didApplyChanges && path && !documentId.startsWith('shard-')) {
            const doc = await this.crdtEngine.getOrCreateDoc(documentId);
            const updatedContent = doc.getText('markdown').toString();
            const localContent = await this.noteRepo.readNote(path);
            
            if (localContent !== updatedContent) {
                acquireLock();
                try {
                    if (this.registerRemoteWrite) {
                        this.registerRemoteWrite(path, updatedContent);
                    }
                    await this.noteRepo.writeNote(path, updatedContent);
                } catch (writeErr) {
                    console.error(`Failed to write updated content to disk for ${path}:`, writeErr);
                } finally {
                    releaseLock();
                }
            }
        }

        return { newLastSyncId, appliedCount };
    }
}