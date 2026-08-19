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

	// FIX: Safely and recursively generates deep subfolders
	private async ensureFolderExists(path: string): Promise<void> {
		if (!path || path === '/') return;
		const parts = path.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const folder = this.app.vault.getAbstractFileByPath(current);
			if (!folder) {
				try {
					await this.app.vault.createFolder(current);
				} catch (e) {}
			}
		}
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
						isConflict = true;
						let counter = 1;
						const extIdx = payload.path.lastIndexOf('.');
						const hasExt = extIdx > 0 && !payload.isFolder;
						const base = hasExt ? payload.path.substring(0, extIdx) : payload.path;
						const ext = hasExt ? payload.path.substring(extIdx) : '';

						while (existing) {
							targetPath = `${base} (Conflict ${counter})${ext}`;
							existing = this.app.vault.getAbstractFileByPath(targetPath);
							counter++;
						}
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
	        const mutex = this.getFileMutex(payload.newPath);
	        try {
	            await mutex.runExclusive(async () => {
	                const file = this.app.vault.getAbstractFileByPath(payload.oldPath);
	                if (!file) {
					    // Source file is missing from disk; rehydrate/create it at the new destination path
					    const content = await this.crdtEngine.getDocText(payload.uuid);
					    await this.handleCrdtNodeCreated({
					        uuid: payload.uuid,
					        path: payload.newPath,
					        isFolder: false,
					        content: content || ''
					    });
					    return;
					}

	                let targetPath = payload.newPath;
	                let targetExists = this.app.vault.getAbstractFileByPath(targetPath);

	                // Handle collision if target already exists instead of silent return
	                if (targetExists && targetExists.path !== payload.oldPath) {
	                    if ((targetExists as any).stat?.size === 0) {
	                        // Trash 0-byte ghost files occupying the path
	                        await this.app.vault.trash(targetExists, true);
	                    } else {
	                        // Generate conflict path if target is a legitimate file
	                        let counter = 1;
	                        const extIdx = targetPath.lastIndexOf('.');
	                        const base = extIdx > 0 ? targetPath.substring(0, extIdx) : targetPath;
	                        const ext = extIdx > 0 ? targetPath.substring(extIdx) : '';
	                        while (this.app.vault.getAbstractFileByPath(targetPath)) {
	                            targetPath = `${base} (Conflict ${counter})${ext}`;
	                            counter++;
	                        }
	                    }
	                }

	                const pathsToSuppress = [payload.oldPath, targetPath];
	                const prefix = payload.oldPath.endsWith('/') ? payload.oldPath : payload.oldPath + '/';
	                const allFiles = (this.app.vault as any).getAllLoadedFiles ? (this.app.vault as any).getAllLoadedFiles() : [];
				
	                for (const f of allFiles) {
	                    if (f.path && f.path.startsWith(prefix)) {
	                        pathsToSuppress.push(f.path);
	                        const suffix = f.path.substring(payload.oldPath.length);
	                        pathsToSuppress.push(targetPath + suffix);
	                    }
	                }

	                for (const p of pathsToSuppress) {
	                    ObsidianDiskReconciler.suppressPath(p);
	                }

	                try {
	                    const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
	                    if (parentPath && parentPath !== targetPath) {
	                        await this.ensureFolderExists(parentPath);
	                    }
	                    await this.app.fileManager.renameFile(file, targetPath);
	                } catch (e) {
	                    console.error('[ObsidianDiskReconciler] Failed to rename file:', e);
	                } finally {
	                    // Delay unsuppression so Obsidian finishes dispatching internal rename events
	                    setTimeout(() => {
	                        for (const p of pathsToSuppress) {
	                            ObsidianDiskReconciler.unsuppressPath(p);
	                        }
	                    }, 150);
	                }
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

	public destroy(): void {
		this.fileLocks.clear();
	}
}