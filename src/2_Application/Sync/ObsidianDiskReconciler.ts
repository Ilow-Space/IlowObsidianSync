import { App, TFile } from 'obsidian';
import { Mutex } from 'async-mutex';
import PQueue from 'p-queue';
import { SyncEventBus } from './SyncEventBus';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';

export class ObsidianDiskReconciler {
	private fileLocks = new Map<string, Mutex>();
	private diskQueue = new PQueue({ concurrency: 5 });
	public static suppressedPaths = new Set<string>();

	constructor(
		private app: App,
		private syncEngine: LoroSyncEngine,
		private eventBus: SyncEventBus
	) {}

	public initialize(): void {
		this.eventBus.on('CrdtNodeCreated', this.handleCrdtNodeCreated.bind(this));
		this.eventBus.on('CrdtNodeMoved', this.handleCrdtNodeMoved.bind(this));
		this.eventBus.on('CrdtNodeSoftDeleted', this.handleCrdtNodeSoftDeleted.bind(this));
		this.eventBus.on('CrdtTextChanged', this.handleCrdtTextChanged.bind(this));
	}

	public static suppressPath(path: string): void {
		ObsidianDiskReconciler.suppressedPaths.add(path);
	}

	public static unsuppressPath(path: string): void {
		setTimeout(() => {
			ObsidianDiskReconciler.suppressedPaths.delete(path);
		}, 50);
	}

	private getFileMutex(path: string): Mutex {
		let mutex = this.fileLocks.get(path);
		if (!mutex) {
			mutex = new Mutex();
			this.fileLocks.set(path, mutex);
		}
		return mutex;
	}

	private releaseFileMutex(path: string) {
		const mutex = this.fileLocks.get(path);
		if (mutex && !mutex.isLocked()) {
			this.fileLocks.delete(path);
		}
	}

	private async ensureFolderExists(path: string): Promise<void> {
		if (!path || path === '/') return;
		const parts = path.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const folder = this.app.vault.getAbstractFileByPath(current);
			if (!folder) {
				try { await this.app.vault.createFolder(current); } catch (e) {}
			}
		}
	}

	private resolveConflictPath(targetPath: string): string {
		let counter = 1;
		const extIdx = targetPath.lastIndexOf('.');
		const base = extIdx > 0 ? targetPath.substring(0, extIdx) : targetPath;
		const ext = extIdx > 0 ? targetPath.substring(extIdx) : '';
		let resolvedPath = targetPath;
	    
		while (this.app.vault.getAbstractFileByPath(resolvedPath)) {
			resolvedPath = `${base} (Conflict ${counter})${ext}`;
			counter++;
		}
		return resolvedPath;
	}

	private getPathsToSuppress(oldPath: string, newPath: string): string[] {
		const paths = [oldPath, newPath];
		const prefix = oldPath.endsWith('/') ? oldPath : oldPath + '/';
		const allFiles = (this.app.vault as any).getAllLoadedFiles ? (this.app.vault as any).getAllLoadedFiles() : [];
	    
		for (const f of allFiles) {
			if (f.path && f.path.startsWith(prefix)) {
				paths.push(f.path);
				const suffix = f.path.substring(oldPath.length);
				paths.push(newPath + suffix);
			}
		}
		return paths;
	}

	private async handleCrdtNodeCreated(payload: { uuid: string; path: string; isFolder: boolean; content?: string }): Promise<void> {
		return this.diskQueue.add(async () => {
			const mutex = this.getFileMutex(payload.path);
			try {
				await mutex.runExclusive(async () => {
					let targetPath = payload.path;
					let existing = this.app.vault.getAbstractFileByPath(targetPath);
					let isConflict = false;

					if (existing) {
						// 🚨 PATH COLLISION SELF-HEALING: Compare identical texts and purge dupe node
						if (!payload.isFolder) {
							const diskContent = await this.app.vault.read(existing as any).catch(() => null);
							if (diskContent === (payload.content || '')) {
							    this.eventBus.emit('RebalancePathUuid' as any, { remoteUuid: payload.uuid, path: targetPath });
							    return; // Content is identical, abort file creation
							}
						}

						isConflict = true;
						targetPath = this.resolveConflictPath(targetPath);
					}

					ObsidianDiskReconciler.suppressPath(targetPath);
					try {
						if (payload.isFolder) {
							await this.ensureFolderExists(targetPath);
						} else {
							const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
							if (parentPath && parentPath !== targetPath) {
								await this.ensureFolderExists(parentPath);
							}
							await this.app.vault.create(targetPath, payload.content || '');
						}

						if (isConflict) {
							setTimeout(() => {
								this.eventBus.emit('LocalFileRenamed', {
									oldPath: payload.path,
									newPath: targetPath
								});
							}, 50);
						}
					} catch (e) {
						console.error('[ObsidianDiskReconciler] Failed to create file/folder:', e);
					} finally {
						ObsidianDiskReconciler.unsuppressPath(targetPath);
					}
				});
			} finally {
				this.releaseFileMutex(payload.path);
			}
		});
	}

	private async handleCrdtNodeMoved(payload: { uuid: string; oldPath: string; newPath: string }): Promise<void> {
		console.log(`[Reconciler Inbound Move Received] UUID: ${payload.uuid} | "${payload.oldPath}" -> "${payload.newPath}"`);
		return this.diskQueue.add(async () => {
			const oldMutex = this.getFileMutex(payload.oldPath);
			const newMutex = this.getFileMutex(payload.newPath);
	        
			try {
				await oldMutex.runExclusive(async () => {
					await newMutex.runExclusive(async () => {
						const file = this.app.vault.getAbstractFileByPath(payload.oldPath);
	                    
						if (!file) {
							let targetPath = payload.newPath;
							let targetExists = this.app.vault.getAbstractFileByPath(targetPath);
						    
							// If old path is missing but file is already at new path, it was a cascading rename.
							if (targetExists) return; 

							const doc = await this.syncEngine.getOrCreateDoc(payload.uuid);
							const content = doc.getText('markdown').toString();
							this.syncEngine.removeDoc(payload.uuid);
										
							if (targetExists) {
								targetPath = this.resolveConflictPath(targetPath);
							}

							ObsidianDiskReconciler.suppressPath(targetPath);
							try {
								const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
								if (parentPath && parentPath !== targetPath) {
									await this.ensureFolderExists(parentPath);
								}
								await this.app.vault.create(targetPath, content || '');
							} catch (e) {
								console.error('[ObsidianDiskReconciler] Failed to rehydrate missing moved file:', e);
							} finally {
								ObsidianDiskReconciler.unsuppressPath(targetPath);
							}
							return;
						}

						let targetPath = payload.newPath;
						let targetExists = this.app.vault.getAbstractFileByPath(targetPath);

						if (targetExists && targetExists.path !== payload.oldPath) {
							if ((targetExists as any).stat?.size === 0) {
								try { await this.app.vault.trash(targetExists, true); } catch (e) {}
							} else {
								// 🚨 PATH COLLISION SELF-HEALING FOR MOVES
								const doc = await this.syncEngine.getOrCreateDoc(payload.uuid);
								const incomingContent = doc.getText('markdown').toString();
								const diskContent = await this.app.vault.read(targetExists as any).catch(() => null);
                                
								if (diskContent === incomingContent) {
								    this.eventBus.emit('RebalancePathUuid' as any, { remoteUuid: payload.uuid, path: targetPath });
								    return;
								}

								targetPath = this.resolveConflictPath(targetPath);
								setTimeout(() => {
									this.eventBus.emit('LocalFileRenamed', {
										oldPath: payload.newPath,
										newPath: targetPath
									});
								}, 50);
							}
						}

						const pathsToSuppress = this.getPathsToSuppress(payload.oldPath, targetPath);
						for (const p of pathsToSuppress) ObsidianDiskReconciler.suppressPath(p);

						try {
							const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
							if (parentPath && parentPath !== targetPath) {
								await this.ensureFolderExists(parentPath);
							}
							await this.app.fileManager.renameFile(file, targetPath);
						} catch (e) {
							console.error('[ObsidianDiskReconciler] Failed to rename file:', e);
						} finally {
							setTimeout(() => {
								for (const p of pathsToSuppress) ObsidianDiskReconciler.unsuppressPath(p);
							}, 1000);
						}
					});
				});
			} finally {
				this.releaseFileMutex(payload.newPath);
				this.releaseFileMutex(payload.oldPath);
			}
		});
	}

	private async handleCrdtNodeSoftDeleted(payload: { uuid: string; path: string }): Promise<void> {
		return this.diskQueue.add(async () => {
			const mutex = this.getFileMutex(payload.path);
			try {
				await mutex.runExclusive(async () => {
					const file = this.app.vault.getAbstractFileByPath(payload.path);
					if (!file) return;

					ObsidianDiskReconciler.suppressPath(payload.path);
					try {
						try {
							await this.app.vault.trash(file, true);
						} catch (e) {
							await this.app.vault.trash(file, false);
						}
					} catch (e) {
						console.error('[ObsidianDiskReconciler] Failed to trash file:', e);
					} finally {
						ObsidianDiskReconciler.unsuppressPath(payload.path);
					}
				});
			} finally {
				this.releaseFileMutex(payload.path);
			}
		});
	}

	private async handleCrdtTextChanged(payload: { uuid: string; path: string; content: string }): Promise<void> {
		return this.diskQueue.add(async () => {
			const mutex = this.getFileMutex(payload.path);
			try {
				await mutex.runExclusive(async () => {
					const file = this.app.vault.getAbstractFileByPath(payload.path);
					if (file && file instanceof TFile) {
						try {
							const currentDiskContent = await this.app.vault.read(file);
							if (currentDiskContent !== payload.content) {
								ObsidianDiskReconciler.suppressPath(payload.path);
								await this.app.vault.modify(file, payload.content);
							}
						} catch (e) {
							console.error('[ObsidianDiskReconciler] Failed to write text:', e);
						} finally {
							ObsidianDiskReconciler.unsuppressPath(payload.path);
						}
					}
				});
			} finally {
				this.releaseFileMutex(payload.path);
			}
		});
	}

	public async onIdle(): Promise<void> {
		await this.diskQueue.onIdle();
	}

	public destroy(): void {
		this.fileLocks.clear();
	}
}