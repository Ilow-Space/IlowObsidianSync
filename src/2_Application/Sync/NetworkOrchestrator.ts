import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { LoroVfsController } from './LoroVfsController';
import { SyncEventBus } from './SyncEventBus';
import { ObsidianDiskReconciler } from './ObsidianDiskReconciler';
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

	private prePullBaselineContents = new Map<string, string>();
	constructor(
		private remoteStore: IRemoteStore,
		private crypto: ICryptography,
		private crdtEngine: LoroSyncEngine,
		private noteRepo: INoteRepository,
		private vfsController: LoroVfsController,
		private eventBus: SyncEventBus,
		private statusCallback: (status: SyncStatus, msg: string) => void,
		private debounceMs: number = 1000,
		private diskReconciler?: ObsidianDiskReconciler
	) {}

	public initialize(): void {
		this.eventBus.on('LocalDeltaReadyForPush', this.handleLocalDeltaReadyForPush.bind(this));
		this.eventBus.on('LocalFileModified', this.handleLocalFileModified.bind(this));
		this.eventBus.on('CrdtNodeCreated', this.handleRemoteNodeDiscovered.bind(this));
		
		// Garbage collect UUID tracking maps when a file is deleted locally
		this.eventBus.on('LocalFileDeleted', (payload) => {
			const documentId = this.vfsController.getUuidForPath(payload.path) || (payload as any).uuid;
			if (documentId) {
				this.fileLastSyncIds.delete(documentId);
				this.fileUpdateCounters.delete(documentId);
			}
		});
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
	    // CRITICAL FIX: Queue offline/locked edits instead of dropping them!
	    if (!this.activeKey) {
	        this.pendingRetries.push(payload);
	        return;
	    }
	
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
			// 🚨 ARCHITECTURAL FIX: Prevent Ghost Resurrections
			// Check if this path is just an old location of a file that was moved remotely,
			// but hasn't physically finished moving on the disk yet.
			const filename = payload.path.substring(payload.path.lastIndexOf('/') + 1);
			const movedMatch = this.vfsController.findMovedFileMatch(filename, payload.path);

			if (movedMatch) {
				// The file is just lagging. Use the correct UUID to apply the text update,
				// and DO NOT emit a LocalFileCreated event.
				documentId = movedMatch.uuid;
			} else {
				this.eventBus.emit('LocalFileCreated', {
					path: payload.path,
					isFolder: false,
					content: payload.content
				});
				documentId = this.vfsController.getUuidForPath(payload.path);
			}
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
		this.syncStartTime = Date.now();
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

	        // --- 1. SNAPSHOT VFS & PULL REMOTE INDEX ---
	        const indexLatest = bulkUpdates['shard-index'] || 0;
	        this.vfsController.prepareForRemoteVfsUpdate();
	        await this.pullDocument('shard-index', null, true, indexLatest);

	        if (this.hasConnectionError) {
	            throw new Error(this.lastErrorMessage || 'Sync failed');
	        }

	        this.vfsController.flushPendingPush();
	        this.vfsController.processRemoteVfsUpdates();
	        console.log('[NetworkOrchestrator] VFS Index Processed.');

			this.reconcileVfsDiskPaths();

	        // 🚨 AWAIT PHYSICAL DISK MOVES BEFORE PULLING FILE TEXT
	        if (this.diskReconciler) {
	            await this.diskReconciler.onIdle();
	        }


	        const indexRemoteLatest = bulkUpdates['shard-index'] || 0;
	        const indexLastSync = this.fileLastSyncIds.get('shard-index') || 0;
	        if (indexLastSync === 0 && indexRemoteLatest === 0) {
	            const indexDoc = await this.crdtEngine.getOrCreateDoc('shard-index');
	            const indexSnapshot = indexDoc.export({ mode: 'snapshot' });
	            if (indexSnapshot && indexSnapshot.length > 0) {
	                await this.handleLocalDeltaReadyForPush({ documentId: 'shard-index', updateBinary: indexSnapshot, path: null });
	            }
	        }

	        // --- 2. PULL DOCUMENT TEXT ---
	       const activeFiles = this.vfsController.getActiveFiles().filter(file => file.type !== 'folder');
	        
	        // 🚨 CAPTURE PRE-PULL BASELINE CONTENT
	        this.prePullBaselineContents.clear();
	        for (const file of activeFiles) {
	            const doc = await this.crdtEngine.getOrCreateDoc(file.uuid);
	            this.prePullBaselineContents.set(file.uuid, doc.getText('markdown').toString());
	        }

	        const limit = pLimit(20);
	        const pullPromises = activeFiles.map(file =>
	            limit(async () => {
	                if (this.hasConnectionError) return;
	                const latestRemoteId = bulkUpdates[file.uuid] || 0;
	                await this.pullDocument(file.uuid, file.path, true, latestRemoteId);
	            })
	        );
	        await Promise.all(pullPromises);

	        if (this.diskReconciler) {
	            await this.diskReconciler.onIdle();
	        }

	        console.log('[NetworkOrchestrator] 🟢 REMOTE CHANGES PULLED AND SETTLED. Now ingesting and pushing local offline state...');

	        // --- 3. INGEST LOCAL OFFLINE MODIFICATIONS AND CREATIONS ---
	        await this.ingestLocalOfflineNotes(bulkUpdates);

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

	private reconcileVfsDiskPaths(): void {
		if (!this.diskReconciler) return;
		const app = (this.diskReconciler as any).app;
		if (!app?.vault?.getFiles) return;

		const activeFiles = this.vfsController.getActiveFiles().filter(f => f.type !== 'folder');
		const allVaultFiles = app.vault.getFiles();

		for (const file of activeFiles) {
			const existsAtTargetPath = allVaultFiles.some((f: any) => f.path === file.path);
			if (!existsAtTargetPath) {
				const filename = file.path.substring(file.path.lastIndexOf('/') + 1);
				const localMatch = allVaultFiles.find((f: any) => f.name === filename);
				
				if (localMatch && localMatch.path !== file.path) {
					// 🚨 PRE-SETTLEMENT MOVE EMISSION: Fire CrdtNodeMoved BEFORE remote changes settle
					this.eventBus.emit('CrdtNodeMoved', {
						uuid: file.uuid,
						oldPath: localMatch.path,
						newPath: file.path
					});
				}
			}
		}
	}

	private async ingestLocalOfflineNotes(bulkUpdates: Record<string, number>): Promise<void> {
	    const localPaths = typeof this.noteRepo.listAllNotes === 'function' ? await this.noteRepo.listAllNotes() : [];
	    const limit = pLimit(10);
	    await Promise.all(localPaths.map(path => limit(() => this.processSingleLocalPath(path, bulkUpdates))));
	}

	private async resolveDocumentIdForLocalPath(path: string): Promise<{ documentId: string | null; isRemotelyDeleted: boolean }> {
		let documentId = this.vfsController.getUuidForPath(path);
		if (documentId) return { documentId, isRemotelyDeleted: false };

		const filename = path.substring(path.lastIndexOf('/') + 1);
		if (this.vfsController.isFilenameDeletedRemotely(filename, path)) {
			this.eventBus.emit('CrdtNodeSoftDeleted', { uuid: '', path });
			return { documentId: null, isRemotelyDeleted: true };
		}

		const movedMatch = this.vfsController.findMovedFileMatch(filename, path);
		if (movedMatch) {
			this.eventBus.emit('CrdtNodeMoved', {
				uuid: movedMatch.uuid,
				oldPath: path,
				newPath: movedMatch.path
			});
			return { documentId: movedMatch.uuid, isRemotelyDeleted: false };
		}

		return { documentId: null, isRemotelyDeleted: false };
	}

	private async handleUntrackedLocalFile(path: string, localContent: string, bulkUpdates: Record<string, number>): Promise<void> {
		this.eventBus.emit('LocalFileCreated', {
			path,
			isFolder: false,
			content: localContent
		});
		this.vfsController.flushPendingPush();
		const documentId = this.vfsController.getUuidForPath(path);
		if (!documentId) return;

		let updateBinary = await this.crdtEngine.handleLocalChange(documentId, localContent);
		if (!updateBinary && localContent.length > 0) {
			const remoteLatestId = bulkUpdates[documentId] || 0;
			const lastSyncId = this.fileLastSyncIds.get(documentId) || 0;
			if (lastSyncId === 0 && remoteLatestId === 0) {
				const doc = await this.crdtEngine.getOrCreateDoc(documentId);
				updateBinary = doc.export({ mode: 'snapshot' });
			}
		}
		if (updateBinary && updateBinary.length > 0) {
			await this.handleLocalDeltaReadyForPush({ documentId, updateBinary, path });
		}
	}

	private async reconcileExistingLocalFile(documentId: string, path: string, localContent: string): Promise<void> {
		const doc = await this.crdtEngine.getOrCreateDoc(documentId);
		const crdtContent = doc.getText('markdown').toString();
		if (localContent === crdtContent) return;

		// 🚨 BASELINE CHECK: If local disk matches the CRDT state BEFORE the remote pull,
		// the user did NOT edit this note offline. Simply update disk with remote edits and DO NOT push!
		const baselineContent = this.prePullBaselineContents.get(documentId);
		if (baselineContent !== undefined && localContent.trim() === baselineContent.trim()) {
			await this.noteRepo.writeNote(path, crdtContent);
			return;
		}

		if (crdtContent.length > 0 && crdtContent.includes(localContent.trim())) {
			await this.noteRepo.writeNote(path, crdtContent);
			return;
		}

		let contentToApply = localContent;
		if (crdtContent.length > 0 && !localContent.includes(crdtContent.trim())) {
			contentToApply = `${localContent.trim()}\n${crdtContent.trim()}\n`;
		}
		const updateBinary = await this.crdtEngine.handleLocalChange(documentId, contentToApply);
		if (updateBinary) {
			await this.handleLocalDeltaReadyForPush({ documentId, updateBinary, path });
		}
	}

	private async processSingleLocalPath(path: string, bulkUpdates: Record<string, number>): Promise<void> {
		const localContent = await this.noteRepo.readNote(path);
		if (localContent === null) return;

		// 🚨 TIMESTAMP GUARD: If file was touched by our Reconciler during this sync session,
		// do not treat it as an offline user edit.
		const abstractFile = (this.diskReconciler as any)?.app?.vault?.getAbstractFileByPath(path);
		const fileMtime = (abstractFile as any)?.stat?.mtime || 0;
		if (fileMtime >= this.syncStartTime - 1000) {
			return; // Skip ingesting reconciler-written files
		}

		const { documentId, isRemotelyDeleted } = await this.resolveDocumentIdForLocalPath(path);
		if (isRemotelyDeleted) return;

		if (!documentId) {
			await this.handleUntrackedLocalFile(path, localContent, bulkUpdates);
		} else {
			await this.reconcileExistingLocalFile(documentId, path, localContent);
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

			// 1. NETWORK FETCH OUTSIDE MUTEX (Restores Concurrency!)
			try {
				const currentLastId = this.fileLastSyncIds.get(documentId) || 0;
				[details, updates] = await Promise.all([
					this.remoteStore.fetchSnapshotDetails(documentId),
					this.remoteStore.fetchUpdatesSince(documentId, currentLastId)
				]);

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

			// 2. DISK WRITES INSIDE MUTEX (Maintains Thread Safety!)
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

					if (documentId === 'shard-index') {
						this.vfsController.processRemoteVfsUpdates();
					} else if (path) {
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
		
	        let encryptedPath = null;
	        const path = this.vfsController.getPathForUuid(documentId);
	        if (path) {
	            const pathBytes = new TextEncoder().encode(path);
	            encryptedPath = await this.crypto.encrypt(pathBytes, this.activeKey);
	        }
		
	        await this.remoteStore.compactSnapshot(documentId, newState, maxId, false, encryptedPath);
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