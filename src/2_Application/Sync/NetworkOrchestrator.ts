import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { LoroVfsController } from './LoroVfsController';
import { SyncEventBus } from './SyncEventBus';
import { Mutex } from 'async-mutex';
import { backOff } from 'exponential-backoff';

export type SyncStatus = 'synced' | 'syncing' | 'error' | 'offline';

export class NetworkOrchestrator {
	private activeKey: CryptoKey | null = null;
	private fileLastSyncIds = new Map<string, number>();
	private fileUpdateCounters = new Map<string, number>();
	private activeSubscriptions = new Map<string, () => void>();
	private isInitialized = false;

	private activeTasks = new Set<string>();
	private statusIdleTimer: ReturnType<typeof setTimeout> | null = null;
	private lastPingMs: number | null = null;

	private hasConnectionError = false;
	private lastErrorMessage = '';
	private isSyncingFull = false;

	private activePath: string | null = null;
	private activeDocumentId: string | null = null;
	private orchestratorMutex = new Mutex();

	constructor(
		private remoteStore: IRemoteStore,
		private crypto: ICryptography,
		private crdtEngine: LoroSyncEngine,
		private noteRepo: INoteRepository,
		private vfsController: LoroVfsController,
		private eventBus: SyncEventBus,
		private statusCallback: (status: SyncStatus, msg: string) => void,
		private debounceMs: number = 1000
	) {}

	public initialize(): void {
		this.eventBus.on('LocalDeltaReadyForPush', this.handleLocalDeltaReadyForPush.bind(this));
		this.eventBus.on('LocalFileModified', this.handleLocalFileModified.bind(this));
	}

	public getRemoteStore(): IRemoteStore { return this.remoteStore; }
	public getActiveKey(): CryptoKey | null { return this.activeKey; }
	public getCrypto(): ICryptography { return this.crypto; }
	public setCryptoKey(key: CryptoKey | null) {
		this.activeKey = key;
		this.hasConnectionError = false;
		this.triggerStatusUpdate();
	}

	public isSyncInitialized(): boolean {
		return this.isInitialized;
	}

	private addActiveTask(taskName: string) {
		this.activeTasks.add(taskName);
		this.triggerStatusUpdate();
	}

	private removeActiveTask(taskName: string) {
		this.activeTasks.delete(taskName);
		this.triggerStatusUpdate();
	}

	private triggerStatusUpdate() {
		if (!this.activeKey) {
			this.statusCallback('offline', 'Disconnected');
			return;
		}

		if (this.hasConnectionError) {
			this.statusCallback('error', this.lastErrorMessage || 'Connection Error');
			return;
		}

		if (this.statusIdleTimer) {
			clearTimeout(this.statusIdleTimer);
			this.statusIdleTimer = null;
		}

		if (this.activeTasks.size > 0) {
			this.statusCallback('syncing', `Syncing ${this.activeTasks.size} files...`);
		} else {
			this.statusIdleTimer = setTimeout(() => {
				this.statusCallback('synced', 'Fully synced');
			}, 1000);
		}
	}

	private async handleLocalDeltaReadyForPush(payload: { documentId: string; updateBinary: Uint8Array; path?: string | null }): Promise<void> {
		if (!this.activeKey) return;

		this.addActiveTask(payload.path || 'System Index');
		try {
			const encryptedUpdate = await this.crypto.encrypt(payload.updateBinary, this.activeKey);
			let encryptedPath = null;
			if (payload.path) {
				const pathBytes = new TextEncoder().encode(payload.path);
				encryptedPath = await this.crypto.encrypt(pathBytes, this.activeKey);
			}

			await this.remoteStore.pushUpdate(payload.documentId, encryptedUpdate, encryptedPath);
			this.hasConnectionError = false;
		} catch (err) {
			this.hasConnectionError = true;
			this.lastErrorMessage = 'Connection failed';
		} finally {
			this.removeActiveTask(payload.path || 'System Index');
		}
	}

	private async handleLocalFileModified(payload: { path: string; content: string }): Promise<void> {
		if (!this.activeKey || !this.isInitialized) return;

		const documentId = this.vfsController.getUuidForPath(payload.path);
		if (!documentId) return;

		const updateBinary = await this.crdtEngine.handleLocalChange(documentId, payload.content);
		if (updateBinary) {
			await this.handleLocalDeltaReadyForPush({
				documentId,
				updateBinary,
				path: payload.path
			});
		}
	}

	public async runFullSync(): Promise<void> {
		if (!this.activeKey || this.isSyncingFull) return;
		this.isSyncingFull = true;
		this.addActiveTask('System Index');

		try {
			console.log('[NetworkOrchestrator] Starting VFS Index Sync...');

			let bulkUpdates: Record<string, number> = {};
			try {
				bulkUpdates = await this.remoteStore.getBulkLatestUpdateIds();
			} catch (e) {
				console.warn('[NetworkOrchestrator] Bulk fetch failed, falling back to sequential checks.');
			}

			const indexLatest = bulkUpdates['shard-index'] || 0;
			await this.pullDocument('shard-index', null, true, indexLatest);

			if (this.hasConnectionError) {
				throw new Error(this.lastErrorMessage || 'Sync failed');
			}

			this.vfsController.rebuildCache();

			const activeFiles = this.vfsController.getActiveFiles();
			for (const file of activeFiles) {
				if (this.hasConnectionError) break;

				const latestRemoteId = bulkUpdates[file.uuid] || 0;
				await this.pullDocument(file.uuid, file.path, true, latestRemoteId);
			}

			this.isInitialized = true;
			console.log('[NetworkOrchestrator] Full Sync Complete.');
		} catch (error) {
			console.error('[NetworkOrchestrator] Sync failed:', error);
			this.hasConnectionError = true;
			this.lastErrorMessage = 'Sync failed';
		} finally {
			this.removeActiveTask('System Index');
			this.isSyncingFull = false;
		}
	}

	public async pullDocument(documentId: string, path: string | null = null, isSilent: boolean = false, knownLatestRemoteId?: number): Promise<void> {
		if (!this.activeKey) return;

		const lastId = this.fileLastSyncIds.get(documentId) || 0;

		if (knownLatestRemoteId !== undefined && lastId > 0) {
			if (knownLatestRemoteId <= lastId) return;
		} else if (lastId > 0) {
			try {
				const latestRemoteId = await this.remoteStore.getLatestUpdateId(documentId);
				if (latestRemoteId <= lastId) return;
			} catch (err) {
				this.hasConnectionError = true;
				this.lastErrorMessage = 'Connection failed';
				this.triggerStatusUpdate();
				return;
			}
		}

		const taskName = path || 'System Index';
		if (!isSilent) this.addActiveTask(taskName);

		await this.orchestratorMutex.runExclusive(async () => {
			const start = performance.now();
			try {
				const details = await this.remoteStore.fetchSnapshotDetails(documentId);
				if (details && lastId < details.maxCompactedId) {
					console.log(`[NetworkOrchestrator] Lagging client detected for ${documentId}. Initiating snapshot rehydration...`);

					let offlineContent: string | null = null;
					if (path) {
						offlineContent = await this.noteRepo.readNote(path);
					}

					await this.crdtEngine.localStore.deleteDocumentState(documentId);
					this.crdtEngine.forceEjectDoc(documentId);

					if (details.encryptedState) {
						const decryptedBytes = await this.crypto.decrypt(details.encryptedState, this.activeKey!);
						await this.crdtEngine.applyUpdates(documentId, [decryptedBytes]);
					}

					this.fileLastSyncIds.set(documentId, details.maxCompactedId);

					if (path && offlineContent !== null) {
						await this.crdtEngine.handleLocalChange(documentId, offlineContent);
					}
				}

				const currentLastId = this.fileLastSyncIds.get(documentId) || 0;
				const updates = await this.remoteStore.fetchUpdatesSince(documentId, currentLastId);
				const decryptedUpdates: Uint8Array[] = [];

				for (const update of updates) {
					const decBytes = await this.crypto.decrypt(update.encryptedUpdate, this.activeKey!);
					decryptedUpdates.push(decBytes);
				}

				if (decryptedUpdates.length > 0) {
					await this.crdtEngine.applyUpdates(documentId, decryptedUpdates);
					const maxId = Math.max(...updates.map(u => u.id));
					this.fileLastSyncIds.set(documentId, maxId);

					if (documentId !== 'shard-index' && path) {
						const doc = await this.crdtEngine.getOrCreateDoc(documentId);
						this.eventBus.emit('CrdtTextChanged', {
							uuid: documentId,
							path,
							content: doc.getText('markdown').toString()
						});
					}
				}

				this.lastPingMs = Math.round(performance.now() - start);
				this.hasConnectionError = false;
			} catch (err) {
				console.error('[NetworkOrchestrator] pullDocument failed for ' + documentId + ':', err);
				this.hasConnectionError = true;
				this.lastErrorMessage = 'Connection failed';
			}
		});

		if (!isSilent) this.removeActiveTask(taskName);
	}

	public connectWebSocket(wssUrl: string) {
		const retryOptions = {
			jitter: 'full',
			startingDelay: 1000,
			maxDelay: 30000,
			numOfAttempts: Infinity
		};

		const establishConnection = async () => {
			this.remoteStore.connectWebSocket(wssUrl);
		};

		backOff(establishConnection, retryOptions as any).catch((e) => {
			console.error('[NetworkOrchestrator] Permanent WebSocket Connection Failure:', e);
		});
	}

	public stopAll() {
		for (const unsubscribe of this.activeSubscriptions.values()) unsubscribe();
		this.activeSubscriptions.clear();

		if (this.statusIdleTimer) {
			clearTimeout(this.statusIdleTimer);
			this.statusIdleTimer = null;
		}

		this.activeTasks.clear();
		this.hasConnectionError = false;
		this.isSyncingFull = false;
		this.isInitialized = false;
		this.triggerStatusUpdate();
	}

	public async deleteRemoteSnapshot(documentId: string): Promise<void> {
		this.fileLastSyncIds.delete(documentId);
		this.fileUpdateCounters.delete(documentId);
		this.vfsController.rebuildCache();

		if (!this.activeKey) return;
		try {
			await this.remoteStore.deleteSnapshot(documentId);
			await this.crdtEngine.localStore.deleteDocumentState(documentId);
		} catch (err) {}
	}
}
