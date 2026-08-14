import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { YjsEngine } from '@infrastructure/Crdt/YjsEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { gunzip } from 'fflate';

// ASYNC DECOMPRESSION HELPER
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
		acquireLock();
		try {
			let appliedCount = 0;
			let newLastSyncId = lastSyncId;
			let didApplyChanges = false;

			// 1. Fetch server snapshot details first to determine compaction boundary
			const snapshotDetails = await this.remoteStore.fetchSnapshotDetails(documentId);

			const serverCompactedMaxId = snapshotDetails ? snapshotDetails.maxCompactedId : 0;
			const isLagging = lastSyncId > 0 && lastSyncId < serverCompactedMaxId;

			// 2. Initial Sync (lastSyncId === 0) or lagging (lastSyncId < serverCompactedMaxId)
			if (lastSyncId === 0 || isLagging) {
				if (isLagging) {
					console.warn(`[PullRemoteChanges] Client lagging behind compaction boundary for ${documentId}. localLastSyncId=${lastSyncId}, serverCompactedMaxId=${serverCompactedMaxId}. Performing full snapshot rehydration.`);
				}

				if (snapshotDetails && snapshotDetails.encryptedState && !snapshotDetails.isDeleted) {
					try {
						const decryptedSnapshot = await this.crypto.decrypt(snapshotDetails.encryptedState, key);
						const decompressed = await decompressAsync(decryptedSnapshot); // ASYNC
						if (decompressed.length > 0) {
							if (isLagging) {
								// OVERWRITE local Yjs instance state entirely to prevent CRDT conflicts during rehydration
								await this.crdtEngine.localStore.deleteDocumentState(documentId);
								this.crdtEngine.forceEjectDoc(documentId); // eject doc reference from active and fallback caches
							}
							await this.crdtEngine.applyUpdates(documentId, [decompressed]);
							appliedCount++;
							didApplyChanges = true;
							newLastSyncId = serverCompactedMaxId; // fast-forward to snapshot threshold
						}
					} catch (err) {
						console.error(`PullRemoteChangesUseCase failed to decrypt snapshot for ${documentId}:`, err);
					}
				}
			}

			// 3. Fetch remaining incremental deltas generated post-compaction
			const remoteUpdates = await this.remoteStore.fetchUpdatesSince(documentId, newLastSyncId);
			if (remoteUpdates.length > 0) {
				const decryptedUpdates: Uint8Array[] = [];
				for (const update of remoteUpdates) {
					try {
						const decrypted = await this.crypto.decrypt(update.encryptedUpdate, key);
						const decompressed = await decompressAsync(decrypted); // ASYNC
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
					didApplyChanges = true;
				}
			}

			if (didApplyChanges && path && !documentId.startsWith('shard-')) {
				const doc = await this.crdtEngine.getOrCreateDoc(documentId);
				const updatedContent = doc.getText('markdown').toString();
				const localContent = await this.noteRepo.readNote(path);

				if (localContent !== updatedContent) {
					if (this.registerRemoteWrite) {
						this.registerRemoteWrite(path, updatedContent);
					}
					try {
						await this.noteRepo.writeNote(path, updatedContent);
					} catch (writeErr) {
						console.error(`Failed to write updated content to disk for ${path}:`, writeErr);
					}
				}
			}

			return { newLastSyncId, appliedCount };
		} finally {
			releaseLock();
		}
	}
}
