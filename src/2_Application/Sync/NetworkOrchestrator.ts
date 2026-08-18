import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { LoroVfsController } from './LoroVfsController';
import { SyncEventBus } from './SyncEventBus';
import { Mutex } from 'async-mutex';
import { backOff } from 'exponential-backoff';
import pLimit from 'p-limit';

export type SyncStatus = 'synced' | 'syncing' | 'error' | 'offline';

export type LocalDeltaReadyForPush = {
	documentId: string;
	updateBinary: Uint8Array;
	path?: string | null;
};

export class NetworkOrchestrator {
	private activeKey: CryptoKey | null = null;
	private fileLastSyncIds = new Map<string, number>();
	private fileUpdateCounters = new Map<string, number>();
	private activeSubscriptions = new Map<string, () => void>();
	private pendingRetries: LocalDeltaReadyForPush[] = [];
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
		this.eventBus.on('CrdtNodeCreated', this.handleRemoteNodeDiscovered.bind(this));
	}

	private async handleRemoteNodeDiscovered(payload: { uuid: string; path: string; isFolder: boolean }): Promise<void> {
		if (payload.isFolder || !this.activeKey || !this.isInitialized) return;
		await this.pullDocument(payload.uuid, payload.path, true);
	}

	public getRemoteStore(): IRemoteStore { return this.remoteStore; }
	public getActiveKey(): CryptoKey | null { return this.activeKey; }
	public getCrypto(): ICryptography { return this.crypto; }
	public setCryptoKey(key: CryptoKey | null) {
		this.activeKey = key;
		this.hasConnectionError = false;
		this.triggerStatusUpdate();
	}

	public setActiveDocumentId(docId: string | null): void {
		this.activeDocumentId = docId;
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

	public getActiveSyncPaths(): string[] {
		return Array.from(this.activeTasks);
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

	private async handleLocalDeltaReadyForPush(payload: LocalDeltaReadyForPush): Promise<void> {
		if (!this.activeKey) return;

		this.addActiveTask(payload.path || 'System Index');

		try {
			const encryptedUpdate = await this.crypto.encrypt(payload.updateBinary, this.activeKey!);
			let encryptedPath = null;
			if (payload.path) {
				const pathBytes = new TextEncoder().encode(payload.path);
				encryptedPath = await this.crypto.encrypt(pathBytes, this.activeKey!);
			}

			await this.remoteStore.pushUpdate(payload.documentId, encryptedUpdate, encryptedPath);
			this.hasConnectionError = false;
		} catch (err) {
			this.hasConnectionError = true;
			this.lastErrorMessage = 'Connection failed';
			this.pendingRetries.push(payload);
		} finally {
			this.removeActiveTask(payload.path || 'System Index');
		}
	}

	private async handleLocalFileModified(payload: { path: string; content: string }): Promise<void> {

		let documentId = this.vfsController.getUuidForPath(payload.path);
		if (!documentId) {
			this.eventBus.emit('LocalFileCreated', {
				path: payload.path,
				isFolder: false,
				content: payload.content
			});
			documentId = this.vfsController.getUuidForPath(payload.path);
		}
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

			if (this.pendingRetries.length > 0) {
				const retries = [...this.pendingRetries];
				this.pendingRetries = [];
				for (const retryItem of retries) {
					await this.handleLocalDeltaReadyForPush(retryItem);
				}
			}

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

			this.vfsController.processRemoteVfsUpdates();

			const activeFiles = this.vfsController.getActiveFiles().filter(file => file.type !== 'folder');
			const limit = pLimit(20);
			const pullPromises = activeFiles.map(file =>
				limit(async () => {
					if (this.hasConnectionError) return;
					const latestRemoteId = bulkUpdates[file.uuid] || 0;
					await this.pullDocument(file.uuid, file.path, true, latestRemoteId);
				})
			);
			await Promise.all(pullPromises);

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

		try {
			const start = performance.now();
			let details: { encryptedState: any; maxCompactedId: number; isDeleted: boolean } | null = null;
			let updates: any[] = [];
			const decryptedUpdates: Uint8Array[] = [];

			try {
				details = await this.remoteStore.fetchSnapshotDetails(documentId);
				const currentLastId = this.fileLastSyncIds.get(documentId) || 0;
				updates = await this.remoteStore.fetchUpdatesSince(documentId, currentLastId);

				for (const update of updates) {
					const decBytes = await this.crypto.decrypt(update.encryptedUpdate, this.activeKey!);
					decryptedUpdates.push(decBytes);
				}
			} catch (err) {
				console.error('[NetworkOrchestrator] pullDocument network fetch failed for ' + documentId + ':', err);
				this.hasConnectionError = true;
				this.lastErrorMessage = 'Connection failed';
				return;
			}

			await this.orchestratorMutex.runExclusive(async () => {
				const currentLastId = this.fileLastSyncIds.get(documentId) || 0;

				if (details && currentLastId < details.maxCompactedId) {
					console.log(`[NetworkOrchestrator] Lagging client detected for ${documentId}. Initiating snapshot rehydration...`);

					let offlineContent: string | null = null;
					if (path) {
						offlineContent = await this.noteRepo.readNote(path);
					}

					if (details.encryptedState) {
						const decryptedBytes = await this.crypto.decrypt(details.encryptedState, this.activeKey!);
						await this.crdtEngine.applyUpdates(documentId, [decryptedBytes]);
					}

					this.fileLastSyncIds.set(documentId, details.maxCompactedId);

					if (path && offlineContent !== null) {
						await this.crdtEngine.handleLocalChange(documentId, offlineContent);
					}
				}

				if (decryptedUpdates.length > 0) {
					const doc = await this.crdtEngine.applyUpdates(documentId, decryptedUpdates);
					const maxId = Math.max(...updates.map(u => u.id));
					this.fileLastSyncIds.set(documentId, maxId);

					if (documentId !== 'shard-index' && path) {
						this.eventBus.emit('CrdtTextChanged', {
							uuid: documentId,
							path,
							content: doc.getText('markdown').toString()
						});
					}
				}

				this.lastPingMs = Math.round(performance.now() - start);
				this.hasConnectionError = false;
			});
		} finally {
			if (documentId !== this.activeDocumentId && documentId !== 'shard-index') {
				this.crdtEngine.removeDoc(documentId);
			}
			if (!isSilent) this.removeActiveTask(taskName);
		}
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

		this.fileLastSyncIds.clear();
		this.fileUpdateCounters.clear();
		this.pendingRetries = [];

		this.activeTasks.clear();
		this.hasConnectionError = false;
		this.isSyncingFull = false;
		this.isInitialized = false;
		this.triggerStatusUpdate();
	}

	public async forceSyncAndCompact(documentId: string): Promise<void> {
		await this.pullDocument(documentId);
		if (!this.activeKey) return;
		const doc = await this.crdtEngine.getOrCreateDoc(documentId);
		try {
			const snapshotBytes = doc.export({ mode: 'snapshot' });
			const newState = await this.crypto.encrypt(snapshotBytes, this.activeKey);
			const maxId = this.fileLastSyncIds.get(documentId) || 0;
			await this.remoteStore.compactSnapshot(documentId, newState, maxId, false);
		} finally {
			this.crdtEngine.removeDoc(documentId);
		}
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