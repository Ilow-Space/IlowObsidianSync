
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
        const doc = await this.crdtEngine.getOrCreateDoc(documentId);

        let appliedCount = 0;
        let newLastSyncId = lastSyncId;

        if (lastSyncId === 0) {
            const encryptedSnapshot = await this.remoteStore.fetchSnapshot(documentId);
            if (encryptedSnapshot && encryptedSnapshot.ciphertext) {
                try {
                    const decryptedSnapshot = await this.crypto.decrypt(encryptedSnapshot, key);
                    await this.crdtEngine.applyUpdates(documentId, [decryptedSnapshot]);
                    appliedCount++;
                } catch (err) {
                    console.error(`PullRemoteChangesUseCase failed to decrypt snapshot for ${documentId}:`, err);
                }
            }
        }

        const remoteUpdates = await this.remoteStore.fetchUpdatesSince(documentId, lastSyncId);
        if (remoteUpdates.length > 0) {
            const decryptedUpdates: Uint8Array[] = [];
            for (const update of remoteUpdates) {
                try {
                    const decrypted = await this.crypto.decrypt(update.encryptedUpdate, key);
                    decryptedUpdates.push(decrypted);
                    appliedCount++;
                } catch (err) {
                    console.error(`PullRemoteChangesUseCase failed to decrypt update ID ${update.id} for ${documentId}:`, err);
                }
                newLastSyncId = Math.max(newLastSyncId, update.id);
            }

            if (decryptedUpdates.length > 0) {
                const updatedDoc = await this.crdtEngine.applyUpdates(documentId, decryptedUpdates);
                
                if (path && !documentId.startsWith('shard-')) {
                    const updatedContent = updatedDoc.getText('markdown').toString();
                    const localContent = await this.noteRepo.readNote(path);
                    
                    if (localContent !== updatedContent) {
                        // Acquire write lock to prevent triggering a local modify event / infinite loop
                        acquireLock();
                        try {
                            if (this.registerRemoteWrite) {
                                this.registerRemoteWrite(path, updatedContent);
                            }
                            await this.noteRepo.writeNote(path, updatedContent);
                        } finally {
                            releaseLock();
                        }
                    }
                }
            }
        }

        return { newLastSyncId, appliedCount };
    }
}

