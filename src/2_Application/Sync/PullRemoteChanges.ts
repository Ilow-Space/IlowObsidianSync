import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { EncryptedBlob } from '@domain/ValueObjects/CryptoTypes';

export class PullRemoteChangesUseCase {
    constructor(
        private remoteStore: IRemoteStore,
        private crypto: ICryptography,
        private crdtEngine: YjsEngine,
        private noteRepo: INoteRepository
    ) {}

    public async execute(
        path: string,
        lastSyncId: number,
        key: CryptoKey,
        acquireLock: () => void,
        releaseLock: () => void
    ): Promise<{ newLastSyncId: number; appliedCount: number }> {
        const doc = await this.crdtEngine.getOrCreateDoc(path);

        let appliedCount = 0;
        let newLastSyncId = lastSyncId;

        if (lastSyncId === 0) {
            const encryptedSnapshot = await this.remoteStore.fetchSnapshot(path);
            if (encryptedSnapshot && encryptedSnapshot.ciphertext) {
                try {
                    const decryptedSnapshot = await this.crypto.decrypt(encryptedSnapshot, key);
                    await this.crdtEngine.applyUpdates(path, [decryptedSnapshot]);
                    appliedCount++;
                } catch (err) {
                    console.error(`PullRemoteChangesUseCase failed to decrypt snapshot for ${path}:`, err);
                }
            }
        }

        const remoteUpdates = await this.remoteStore.fetchUpdatesSince(path, lastSyncId);
        if (remoteUpdates.length > 0) {
            const decryptedUpdates: Uint8Array[] = [];
            for (const update of remoteUpdates) {
                try {
                    const decrypted = await this.crypto.decrypt(update.encryptedUpdate, key);
                    decryptedUpdates.push(decrypted);
                    appliedCount++;
                } catch (err) {
                    console.error(`PullRemoteChangesUseCase failed to decrypt update ID ${update.id} for ${path}:`, err);
                }
                newLastSyncId = Math.max(newLastSyncId, update.id);
            }

            if (decryptedUpdates.length > 0) {
                const updatedDoc = await this.crdtEngine.applyUpdates(path, decryptedUpdates);
                const updatedContent = updatedDoc.getText('markdown').toString();

                const localContent = await this.noteRepo.readNote(path);
                if (localContent !== updatedContent) {
                    // Acquire write lock to prevent triggering a local modify event / infinite loop
                    acquireLock();
                    try {
                        await this.noteRepo.writeNote(path, updatedContent);
                    } finally {
                        releaseLock();
                    }
                }
            }
        }

        return { newLastSyncId, appliedCount };
    }
}
