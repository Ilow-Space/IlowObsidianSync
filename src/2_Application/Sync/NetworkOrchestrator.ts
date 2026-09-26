import { IRemoteStore, SnapshotDetails } from '@domain/Interfaces/IRemoteStore';
import { ICryptography } from '@domain/Interfaces/ICryptography';
import { CRDTUpdate } from '@domain/Entities/Models';
import { EncryptedBlob } from '@domain/ValueObjects/CryptoTypes';
import { LoroDoc } from 'loro-crdt';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';
import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { LoroVfsController } from './LoroVfsController';
import { SyncEventBus } from './SyncEventBus';
import { ObsidianDiskReconciler } from './ObsidianDiskReconciler';
import { Mutex } from 'async-mutex';
import { backOff } from 'exponential-backoff';
import pLimit from 'p-limit';
import { isBinaryPath, base64ToUint8Array, uint8ArrayToBase64 } from '@domain/Utils/BinaryUtils';

export type SyncStatus = 'synced' | 'syncing' | 'error' | 'offline';

export type VaultIntegrityReport = {
	/** Documents compared against the server. */
	checked: number;
	/** Paths whose local content does not match what the server holds. */
	diverged: string[];
	/** Paths the server could not be asked about. */
	unreachable: string[];
};

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
	private syncStartTime = 0;

	private activeTasks = new Set<string>();
	private statusIdleTimer: ReturnType<typeof setTimeout> | null = null;
	private lastPingMs: number | null = null;

	private hasConnectionError = false;
	private lastErrorMessage = '';
	private isSyncingFull = false;

	/**
	 * Documents whose last push failed. Their delta chain on the server is broken,
	 * so the next push for them must be a full snapshot rather than a delta. Mirrors
	 * the durable outbox table so the repair survives a restart.
	 */
	private unackedDocs = new Set<string>();
	/** Documents a sweep could not fetch, so "synced" is not yet true. */
	private pendingDocs = new Set<string>();

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
		this.eventBus.on('LocalDeltaReadyForPush', (p) => { void this.handleLocalDeltaReadyForPush(p); });
		this.eventBus.on('LocalFileModified', (p) => { void this.handleLocalFileModified(p); });
		this.eventBus.on('LocalFileCreated', (p) => { void this.handleLocalFileCreated(p); });
		this.eventBus.on('CrdtNodeCreated', (p) => { void this.handleRemoteNodeDiscovered(p); });
		
		// Garbage collect UUID tracking maps when a file is deleted locally
		this.eventBus.on('LocalFileDeleted', (payload) => {
			const documentId = payload.uuid || this.vfsController.getUuidForPath(payload.path);
			if (documentId) {
				this.fileLastSyncIds.delete(documentId);
				this.fileUpdateCounters.delete(documentId);
			}
		});

		this.eventBus.on('CrdtNodeSoftDeleted', (payload) => {
			const documentId = payload.uuid || this.vfsController.getUuidForPath(payload.path);
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
			window.clearTimeout(this.statusIdleTimer);
			this.statusIdleTimer = null;
		}

		if (this.activeTasks.size > 0) {
			this.statusCallback('syncing', `Syncing ${this.activeTasks.size} files...`);
		} else {
			this.statusIdleTimer = window.setTimeout(() => {
				this.statusCallback('synced', 'Fully synced');
			}, 1000) as unknown as ReturnType<typeof setTimeout>;
		}
	}

	private async handleLocalDeltaReadyForPush(payload: LocalDeltaReadyForPush): Promise<void> {
	    if (!this.activeKey) {
	        this.pendingRetries.push(payload);
	        await this.markUnacked(payload.documentId, payload.path ?? null);
	        return;
	    }

	    this.addActiveTask(payload.path || 'System Index');

	    try {
	        // A document with a broken chain cannot be repaired by another delta:
	        // the server is missing ops this delta depends on, and Loro would park
	        // it unapplied. Send the whole state instead, which depends on nothing.
	        let binary = payload.updateBinary;
	        if (this.unackedDocs.has(payload.documentId)) {
	            binary = await this.crdtEngine.exportSnapshot(payload.documentId);
	        }

	        const encryptedUpdate = await this.crypto.encrypt(binary, this.activeKey);
	        let encryptedPath = null;
	        if (payload.path) {
	            const pathBytes = new TextEncoder().encode(payload.path);
	            encryptedPath = await this.crypto.encrypt(pathBytes, this.activeKey);
	        }

	        await this.remoteStore.pushUpdate(payload.documentId, encryptedUpdate, encryptedPath);
	        await this.markAcked(payload.documentId);
	        this.clearConnectionErrorIfSettled();

	        if (payload.documentId !== 'shard-index') {
	            const count = (this.fileUpdateCounters.get(payload.documentId) || 0) + 1;
	            this.fileUpdateCounters.set(payload.documentId, count);
	            if (count >= 50) {
	                this.fileUpdateCounters.set(payload.documentId, 0);
	                void this.forceSyncAndCompact(payload.documentId).catch(() => {});
	            }
	        }
	    } catch (err) {
			console.error('[NetworkOrchestrator] Failed to push local delta:', err);
	        this.hasConnectionError = true;
	        this.lastErrorMessage = 'Connection failed';
	        this.pendingRetries.push(payload);
	        await this.markUnacked(payload.documentId, payload.path ?? null);
	    } finally {
	        this.removeActiveTask(payload.path || 'System Index');
	    }
	}

	private async markUnacked(documentId: string, path: string | null): Promise<void> {
		this.unackedDocs.add(documentId);
		try {
			await this.crdtEngine.localStore.markUnacked(documentId, path);
		} catch (err) {
			console.error('[NetworkOrchestrator] Failed to persist outbox entry:', err);
		}
	}

	private async markAcked(documentId: string): Promise<void> {
		if (!this.unackedDocs.delete(documentId)) return;
		try {
			await this.crdtEngine.localStore.clearUnacked(documentId);
		} catch (err) {
			console.error('[NetworkOrchestrator] Failed to clear outbox entry:', err);
		}
	}

	/**
	 * Clears the error light only when nothing is still outstanding. A success on
	 * one document says nothing about documents a previous sweep never fetched.
	 */
	private clearConnectionErrorIfSettled(): void {
		if (this.pendingDocs.size === 0 && this.unackedDocs.size === 0) {
			this.hasConnectionError = false;
		}
	}

	/** Documents known to be out of sync with the server right now. */
	public getPendingDocuments(): string[] {
		return Array.from(new Set([...this.pendingDocs, ...this.unackedDocs]));
	}

	/** Resends full state for every document whose chain is known to be broken. */
	private async flushOutbox(): Promise<void> {
		let entries: Array<{ documentId: string; path: string | null }> = [];
		try {
			entries = await this.crdtEngine.localStore.listUnacked();
		} catch (err) {
			console.error('[NetworkOrchestrator] Failed to read outbox:', err);
		}

		for (const entry of entries) {
			this.unackedDocs.add(entry.documentId);
		}

		for (const documentId of Array.from(this.unackedDocs)) {
			if (!this.activeKey) return;
			const stored = entries.find(e => e.documentId === documentId);
			const path = stored?.path ?? this.vfsController.getPathForUuid(documentId) ?? null;
			try {
				const snapshot = await this.crdtEngine.exportSnapshot(documentId);
				if (!snapshot || snapshot.length === 0) {
					await this.markAcked(documentId);
					continue;
				}
				await this.handleLocalDeltaReadyForPush({ documentId, updateBinary: snapshot, path });
			} catch (err) {
				console.error(`[NetworkOrchestrator] Failed to flush outbox entry ${documentId}:`, err);
			}
		}
	}

	private async safeWriteNote(path: string, content: string): Promise<void> {
		ObsidianDiskReconciler.suppressPath(path);
		try {
			await this.noteRepo.writeNote(path, content);
		} finally {
			ObsidianDiskReconciler.unsuppressPath(path, 1500);
		}
	}

	private async handleLocalFileCreated(payload: { path: string; isFolder: boolean; content?: string }): Promise<void> {
		if (this.isSyncingFull || ObsidianDiskReconciler.suppressedPaths.has(payload.path)) return;
		if (payload.isFolder) return;

		let documentId = this.vfsController.getUuidForPath(payload.path);
		if (!documentId) return;

		if (payload.content !== undefined) {
			await this.handleLocalFileModified({ path: payload.path, content: payload.content });
		}
	}

	private async handleLocalFileModified(payload: { path: string; content: string }): Promise<void> {
		if (this.isSyncingFull || ObsidianDiskReconciler.suppressedPaths.has(payload.path)) return;

		let documentId = this.vfsController.getUuidForPath(payload.path);
    
		if (!documentId) {
			const filename = payload.path.substring(payload.path.lastIndexOf('/') + 1);
			const movedMatch = this.vfsController.findMovedFileMatch(filename, payload.path);

			if (movedMatch) {
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

		// --- NEW DECOUPLED BINARY UPLOAD LOGIC ---
		if (isBinaryPath(payload.path)) {
			const rawBytes = base64ToUint8Array(payload.content);
			const hash = await this.crypto.hashData(rawBytes);

			// Check if the current VFS node already has this hash to prevent redundant uploads
			const currentHash = this.vfsController.getBlobHashForUuid(documentId);
			if (currentHash === hash) return;

			this.addActiveTask(payload.path);
			try {
				if (this.activeKey) {
					const encrypted = await this.crypto.encrypt(rawBytes, this.activeKey);
					const payloadBytes = new TextEncoder().encode(JSON.stringify(encrypted));
					await this.remoteStore.uploadBlob(hash, payloadBytes);

					// Link the newly uploaded blob to the VFS tree
					this.vfsController.setBlobHashForUuid(documentId, hash);
				}
			} catch (err) {
				console.error('[NetworkOrchestrator] Failed to upload binary blob:', err);
				this.hasConnectionError = true;
				this.lastErrorMessage = 'Blob upload failed';
			} finally {
				this.removeActiveTask(payload.path);
			}
			return;
		}

		const updateBinary = await this.crdtEngine.handleLocalChange(documentId, payload.content, false);
		if (updateBinary) {
			await this.handleLocalDeltaReadyForPush({ documentId, updateBinary, path: payload.path });
		}
	}

	private async reconcileExistingLocalFile(documentId: string, path: string, localContent: string, bulkUpdates: Record<string, number> = {}): Promise<void> {
		// --- NEW DECOUPLED BINARY OFFLINE INGESTION ---
		if (isBinaryPath(path)) {
			const rawBytes = base64ToUint8Array(localContent);
			const localHash = await this.crypto.hashData(rawBytes);
			const currentHash = this.vfsController.getBlobHashForUuid(documentId);

			if (currentHash === localHash) return;

			this.addActiveTask(path);
			try {
				if (this.activeKey) {
					const encrypted = await this.crypto.encrypt(rawBytes, this.activeKey);
					const payloadBytes = new TextEncoder().encode(JSON.stringify(encrypted));
					await this.remoteStore.uploadBlob(localHash, payloadBytes);
					this.vfsController.setBlobHashForUuid(documentId, localHash);
				}
			} catch (err) {
				console.error('[NetworkOrchestrator] Failed to upload offline binary blob:', err);
			} finally {
				this.removeActiveTask(path);
			}
			return;
		}

		const doc = await this.crdtEngine.getOrCreateDoc(documentId);
		const crdtContent = doc.getText('markdown').toString();
		const normLocal = localContent.replace(/\r\n/g, '\n');
		const normCrdt = crdtContent.replace(/\r\n/g, '\n');
    
		if (normLocal === normCrdt) {
			const lastSyncId = this.fileLastSyncIds.get(documentId) || 0;
			const remoteLatestId = bulkUpdates[documentId] || 0;
			if (lastSyncId === 0 && remoteLatestId === 0) {
				const snapshotBytes = doc.export({ mode: 'snapshot' });
				if (snapshotBytes && snapshotBytes.length > 0) {
					await this.handleLocalDeltaReadyForPush({ documentId, updateBinary: snapshotBytes, path });
				}
			}
			return;
		}

		const baselineContent = this.prePullBaselineContents.get(documentId);
		const normBaseline = baselineContent !== undefined ? baselineContent.replace(/\r\n/g, '\n').trim() : undefined;
		if (normBaseline !== undefined && normLocal.trim() === normBaseline) {
			await this.safeWriteNote(path, crdtContent);
			return;
		}

		if (normCrdt.length > 0 && normCrdt.includes(normLocal.trim())) {
			await this.safeWriteNote(path, crdtContent);
			return;
		}

		let contentToApply = localContent;
		if (normCrdt.length > 0 && !normLocal.includes(normCrdt.trim())) {
			if (path.endsWith('.json')) {
				contentToApply = localContent;
			} else {
				contentToApply = `${localContent.trim()}\n${crdtContent.trim()}\n`;
			}
		}
		const updateBinary = await this.crdtEngine.handleLocalChange(documentId, contentToApply, false);
		if (updateBinary) {
			await this.handleLocalDeltaReadyForPush({ documentId, updateBinary, path });
		}
	}

	public async runFullSync(): Promise<void> {
		if (!this.activeKey || this.isSyncingFull) return;
		this.isSyncingFull = true;
		this.syncStartTime = Date.now();
		this.addActiveTask('System Index');

		try {
			if (this.pendingRetries.length > 0) {
				const retries = [...this.pendingRetries];
				this.pendingRetries = [];
				for (const retryItem of retries) {
					await this.handleLocalDeltaReadyForPush(retryItem);
				}
			}

			// Repair any document whose chain broke, including in an earlier session.
			await this.flushOutbox();

			// A failed bulk fetch must not read as "every document is current".
			// getBulkLatestUpdateIds returns null when the request did not succeed,
			// and null means "unknown", which falls back to per-document checks.
			let bulkUpdates: Record<string, number> | null = null;
			try {
				bulkUpdates = await this.remoteStore.getBulkLatestUpdateIds();
			} catch (e: unknown) {
				void e;
				console.warn('[NetworkOrchestrator] Bulk fetch failed, falling back to sequential checks.');
			}
			const knownRemoteId = (documentId: string): number | undefined =>
				bulkUpdates ? bulkUpdates[documentId] ?? 0 : undefined;

			this.vfsController.prepareForRemoteVfsUpdate();
			await this.pullDocument('shard-index', null, true, knownRemoteId('shard-index'));

			if (this.hasConnectionError) {
				throw new Error(this.lastErrorMessage || 'Sync failed');
			}

			this.vfsController.flushPendingPush();
			this.vfsController.processRemoteVfsUpdates();

			this.reconcileVfsDiskPaths();

			if (this.diskReconciler) {
				await this.diskReconciler.onIdle();
			}

			const indexRemoteLatest = knownRemoteId('shard-index') ?? 0;
			const indexLastSync = this.fileLastSyncIds.get('shard-index') || 0;
			if (indexLastSync === 0 && indexRemoteLatest === 0) {
				const indexDoc = await this.crdtEngine.getOrCreateDoc('shard-index');
				const indexSnapshot = indexDoc.export({ mode: 'snapshot' });
				if (indexSnapshot && indexSnapshot.length > 0) {
					await this.handleLocalDeltaReadyForPush({ documentId: 'shard-index', updateBinary: indexSnapshot, path: null });
				}
			}

			// --- 2. PULL DOCUMENT TEXT & BLOBS DECOUPLED ---
			const activeFiles = this.vfsController.getActiveFiles().filter(file => file.type !== 'folder');
			const textFiles = activeFiles.filter(f => !isBinaryPath(f.path));
			const binaryFiles = activeFiles.filter(f => isBinaryPath(f.path));

			this.prePullBaselineContents.clear();
			for (const file of textFiles) {
				const doc = await this.crdtEngine.getOrCreateDoc(file.uuid);
				this.prePullBaselineContents.set(file.uuid, doc.getText('markdown').toString());
			}

			// Pull Text CRDTs.
			//
			// Every document is attempted and its outcome recorded. The previous
			// shared abort flag meant one failure silently cancelled every document
			// that had not started yet, leaving a partially pulled vault that
			// nothing tracked and nothing retried.
			this.pendingDocs.clear();
			const limit = pLimit(20);
			const pullPromises = textFiles.map(file =>
				limit(async () => {
					const pulled = await this.pullDocument(file.uuid, file.path, true, knownRemoteId(file.uuid));
					if (!pulled) this.pendingDocs.add(file.uuid);
				})
			);
			await Promise.all(pullPromises);

			// Download Decoupled Binary Blobs (Safely guarded for test mocks)
			if (typeof this.remoteStore.downloadBlob === 'function') {
				const blobLimit = pLimit(5);
				const blobPromises = binaryFiles.map(file => blobLimit(async () => {
					if (this.hasConnectionError) return;
					const expectedHash = this.vfsController.getBlobHashForUuid(file.uuid);
					if (!expectedHash) return;

					const localBase64 = await this.noteRepo.readNote(file.path);
					if (localBase64) {
						const localBytes = base64ToUint8Array(localBase64);
						let localHash = '';
						if (typeof this.crypto.hashData === 'function') {
							localHash = await this.crypto.hashData(localBytes);
						}
						if (localHash && localHash === expectedHash) return;
					}

					this.addActiveTask(file.path);
					try {
						const encryptedBytes = await this.remoteStore.downloadBlob(expectedHash);
						if (encryptedBytes && this.activeKey) {
							const payloadJson = new TextDecoder().decode(encryptedBytes);
							const encryptedBlob = JSON.parse(payloadJson) as EncryptedBlob;
							const decryptedBytes = await this.crypto.decrypt(encryptedBlob, this.activeKey);
							const base64ToWrite = uint8ArrayToBase64(decryptedBytes);
							await this.safeWriteNote(file.path, base64ToWrite);
						}
					} catch (err) {
						console.error(`[NetworkOrchestrator] Failed to download blob for ${file.path}:`, err);
					} finally {
						this.removeActiveTask(file.path);
					}
				}));
				await Promise.all(blobPromises);
			}

			if (this.diskReconciler) {
				await this.diskReconciler.onIdle();
			}

			for (const file of textFiles) {
				const doc = await this.crdtEngine.getOrCreateDoc(file.uuid);
				this.prePullBaselineContents.set(file.uuid, doc.getText('markdown').toString());
			}

			await this.ingestLocalOfflineNotes(bulkUpdates ?? {});

			if (this.diskReconciler) {
				await this.diskReconciler.onIdle();
			}

			// The server treats this list as the set of blobs worth keeping, so
			// publishing it from an incomplete view asks it to delete attachments
			// this device simply failed to learn about. Only a clean sweep may.
			const sweepWasComplete = this.pendingDocs.size === 0 && !this.hasConnectionError;
			if (sweepWasComplete) {
				try {
					const activeHashes = this.vfsController.getActiveBlobHashes();
					if (typeof this.remoteStore.uploadBlobManifest === 'function') {
						await this.remoteStore.uploadBlobManifest(activeHashes);
					}
				} catch (manifestErr) {
					console.warn('[NetworkOrchestrator] Failed to upload active blob manifest:', manifestErr);
				}
			} else {
				console.warn(`[NetworkOrchestrator] Skipping blob manifest upload: ${this.pendingDocs.size} document(s) unresolved.`);
			}

			this.isInitialized = sweepWasComplete;
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
		const reconcilerWithApp = this.diskReconciler as unknown as { app?: { vault?: { getFiles?: () => Array<{ path: string; name: string }> } } };
		const app = reconcilerWithApp.app;
		if (!app?.vault?.getFiles) return;

		const activeFiles = this.vfsController.getActiveFiles().filter(f => f.type !== 'folder');
		const allVaultFiles = app.vault.getFiles();

		for (const file of activeFiles) {
			const existsAtTargetPath = allVaultFiles.some(f => f.path === file.path);
			if (!existsAtTargetPath) {
				const filename = file.path.substring(file.path.lastIndexOf('/') + 1);
				const localMatch = allVaultFiles.find(f => f.name === filename);

				if (localMatch && localMatch.path !== file.path) {
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

		let updateBinary = await this.crdtEngine.handleLocalChange(documentId, localContent, isBinaryPath(path));
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

	private async processSingleLocalPath(path: string, bulkUpdates: Record<string, number>): Promise<void> {
		const localContent = await this.noteRepo.readNote(path);
		if (localContent === null) return;

		const { documentId, isRemotelyDeleted } = await this.resolveDocumentIdForLocalPath(path);
		if (isRemotelyDeleted) return;

		if (!documentId) {
			await this.handleUntrackedLocalFile(path, localContent, bulkUpdates);
		} else {
			await this.reconcileExistingLocalFile(documentId, path, localContent, bulkUpdates);
		}
	}

	/**
	 * Fetches a document. Returns false when the document could not be brought up
	 * to date, so callers can record it as outstanding rather than assume success.
	 */
	public async pullDocument(documentId: string, path: string | null = null, isSilent: boolean = false, knownLatestRemoteId?: number): Promise<boolean> {
		if (!this.activeKey) return false;

		const lastId = this.fileLastSyncIds.get(documentId) || 0;

		// A bulk id of 0 for a document we have already synced past is impossible:
		// ids only grow. It means the bulk response was wrong or incomplete, so fall
		// back to asking about this document directly instead of skipping it.
		const bulkIdIsTrustworthy = knownLatestRemoteId !== undefined && !(knownLatestRemoteId === 0 && lastId > 0);

		if (bulkIdIsTrustworthy && lastId > 0) {
			if (knownLatestRemoteId <= lastId) return true;
		} else if (lastId > 0) {
			try {
				const latestRemoteId = await this.remoteStore.getLatestUpdateId(documentId);
				if (latestRemoteId <= lastId) return true;
			} catch {
				this.hasConnectionError = true;
				this.lastErrorMessage = 'Connection failed';
				this.triggerStatusUpdate();
				return false;
			}
		}

		const taskName = path || 'System Index';
		if (!isSilent) this.addActiveTask(taskName);

		try {
			const start = performance.now();
			let details: { encryptedState: EncryptedBlob | null; maxCompactedId: number; isDeleted: boolean } | null = null;
			let updates: Array<{ id: number; encryptedUpdate: EncryptedBlob }> = [];
			const decryptedUpdates: Uint8Array[] = [];

			try {
				const currentLastId = this.fileLastSyncIds.get(documentId) || 0;
				[details, updates] = await Promise.all([
					this.remoteStore.fetchSnapshotDetails(documentId),
					this.remoteStore.fetchUpdatesSince(documentId, currentLastId)
				]);

				for (const update of updates) {
					const decBytes = await this.crypto.decrypt(update.encryptedUpdate, this.activeKey);
					decryptedUpdates.push(decBytes);
				}
			} catch (err: unknown) {
				this.hasConnectionError = true;
				this.lastErrorMessage = err instanceof Error ? err.message : 'Connection failed';
				return false;
			}

			// A tombstone still carries its pre-delete base state. Merging it back
			// into the local CRDT is what lets a deleted note reappear later.
			if (details?.isDeleted) {
				this.fileLastSyncIds.delete(documentId);
				return true;
			}

			await this.orchestratorMutex.runExclusive(async () => {
				const currentLastId = this.fileLastSyncIds.get(documentId) || 0;

				if (details && currentLastId < details.maxCompactedId) {
					let offlineContent: string | null = null;
					if (path) {
						offlineContent = await this.noteRepo.readNote(path);
					}

					if (details.encryptedState && this.activeKey) {
						const decryptedBytes = await this.crypto.decrypt(details.encryptedState, this.activeKey);
						await this.crdtEngine.applyUpdates(documentId, [decryptedBytes]);
					}

					this.fileLastSyncIds.set(documentId, details.maxCompactedId);

					if (path && offlineContent !== null) {
						await this.crdtEngine.handleLocalChange(documentId, offlineContent, isBinaryPath(path));
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
				this.pendingDocs.delete(documentId);
				this.clearConnectionErrorIfSettled();
			});

			return true;
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

		backOff(establishConnection, retryOptions as unknown as Parameters<typeof backOff>[1]).catch((e: unknown) => {
			console.error('[NetworkOrchestrator] Permanent WebSocket Connection Failure:', e);
		});
	}

	public stopAll() {
		for (const unsubscribe of this.activeSubscriptions.values()) unsubscribe();
		this.activeSubscriptions.clear();

		if (this.statusIdleTimer) {
			window.clearTimeout(this.statusIdleTimer);
			this.statusIdleTimer = null;
		}

		this.fileLastSyncIds.clear();
		this.fileUpdateCounters.clear();
		this.pendingRetries = [];
		// unackedDocs is deliberately NOT cleared: it mirrors the durable outbox,
		// and dropping it here is what used to lose an in-flight edit on unload.

		this.activeTasks.clear();
		this.hasConnectionError = false;
		this.isSyncingFull = false;
		this.isInitialized = false;
		this.triggerStatusUpdate();
	}

	public async forceSyncAndCompact(documentId: string): Promise<void> {
	    // Compaction replaces the server's base state and deletes the update rows it
	    // claims to have merged. Doing that from a document we failed to refresh
	    // destroys whatever other devices wrote that this one never saw.
	    const refreshed = await this.pullDocument(documentId);
	    if (!refreshed) {
	        console.warn(`[NetworkOrchestrator] Skipping compaction of ${documentId}: refresh failed.`);
	        return;
	    }
	    if (this.unackedDocs.has(documentId)) {
	        console.warn(`[NetworkOrchestrator] Skipping compaction of ${documentId}: local changes are unacknowledged.`);
	        return;
	    }
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

	/**
	 * Forcefully pushes local content for a list of paths/documentIds to the server store
	 * to repair diverged or unsynced files.
	 */
	public async pushDivergedFiles(paths: string[]): Promise<number> {
		if (!this.activeKey || paths.length === 0) return 0;
		let count = 0;
		for (const path of paths) {
			const localContent = await this.noteRepo.readNote(path);
			if (localContent === null) continue;

			let documentId = this.vfsController.getUuidForPath(path);
			if (!documentId) {
				this.eventBus.emit('LocalFileCreated', {
					path,
					isFolder: false,
					content: localContent
				});
				this.vfsController.flushPendingPush();
				documentId = this.vfsController.getUuidForPath(path);
			}

			if (!documentId) continue;

			if (isBinaryPath(path)) {
				const rawBytes = base64ToUint8Array(localContent);
				const hash = await this.crypto.hashData(rawBytes);
				const encrypted = await this.crypto.encrypt(rawBytes, this.activeKey);
				const payloadBytes = new TextEncoder().encode(JSON.stringify(encrypted));
				await this.remoteStore.uploadBlob(hash, payloadBytes);
				this.vfsController.setBlobHashForUuid(documentId, hash);
				count++;
			} else {
				const updateBinary = await this.crdtEngine.handleLocalChange(documentId, localContent, false);
				if (updateBinary) {
					await this.handleLocalDeltaReadyForPush({ documentId, updateBinary, path });
					count++;
				} else {
					const snapshot = await this.crdtEngine.exportSnapshot(documentId);
					if (snapshot && snapshot.length > 0) {
						await this.handleLocalDeltaReadyForPush({ documentId, updateBinary: snapshot, path });
						count++;
					}
				}
			}
		}
		return count;
	}

	/**
	 * Rebuilds each document from exactly what the server holds and compares it to
	 * local content, so "synced" can be answered with evidence instead of with an
	 * empty task queue. Returns the documents that do not match.
	 * If autoRepair is true, automatically pushes local versions of diverged files to the server.
	 */
	public async verifyVaultIntegrity(autoRepair = false): Promise<VaultIntegrityReport> {
		const report: VaultIntegrityReport = { checked: 0, diverged: [], unreachable: [] };
		if (!this.activeKey) return report;

		const files = this.vfsController.getActiveFiles().filter(f => f.type !== 'folder' && !isBinaryPath(f.path));
		const limit = pLimit(10);

		await Promise.all(files.map(file => limit(async () => {
			let details: SnapshotDetails | null = null;
			let updates: CRDTUpdate[] = [];
			try {
				[details, updates] = await Promise.all([
					this.remoteStore.fetchSnapshotDetails(file.uuid),
					this.remoteStore.fetchUpdatesSince(file.uuid, 0)
				]);
			} catch {
				report.unreachable.push(file.path);
				return;
			}

			report.checked += 1;

			const remoteDoc = new LoroDoc();
			remoteDoc.getText('markdown');
			try {
				if (details?.encryptedState && this.activeKey) {
					remoteDoc.import(await this.crypto.decrypt(details.encryptedState, this.activeKey));
				}
				for (const update of updates) {
					if (!this.activeKey) break;
					remoteDoc.import(await this.crypto.decrypt(update.encryptedUpdate, this.activeKey));
				}
				remoteDoc.commit();
			} catch {
				report.diverged.push(file.path);
				return;
			}

			const localContent = await this.noteRepo.readNote(file.path);
			if (localContent === null) return;

			const normRemote = remoteDoc.getText('markdown').toString().replace(/\r\n/g, '\n');
			const normLocal = localContent.replace(/\r\n/g, '\n');
			if (normRemote !== normLocal) {
				report.diverged.push(file.path);
			}
		})));

		// Anything the server has not acknowledged is diverged by definition.
		for (const documentId of this.unackedDocs) {
			const path = this.vfsController.getPathForUuid(documentId);
			if (path && !report.diverged.includes(path)) report.diverged.push(path);
		}

		if (autoRepair && report.diverged.length > 0) {
			await this.pushDivergedFiles(report.diverged);
		}

		return report;
	}

	public async deleteRemoteSnapshot(documentId: string): Promise<void> {
		this.fileLastSyncIds.delete(documentId);
		this.fileUpdateCounters.delete(documentId);
		this.vfsController.rebuildCache();

		if (!this.activeKey) return;
		try {
			await this.remoteStore.deleteSnapshot(documentId);
			await this.crdtEngine.localStore.deleteDocumentState(documentId);
		} catch (e: unknown) {
			// Ignore remote snapshot deletion errors
			void e;
		}
	}
}
