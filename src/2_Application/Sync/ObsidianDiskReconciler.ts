import { App, TFile } from 'obsidian';
import { Mutex } from 'async-mutex';
import PQueue from 'p-queue';
import { SyncEventBus } from './SyncEventBus';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';
import { isBinaryPath, base64ToUint8Array, uint8ArrayToBase64 } from '@domain/Utils/BinaryUtils';

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

	public static unsuppressPath(path: string, delayMs = 20): void {
		setTimeout(() => {
			ObsidianDiskReconciler.suppressedPaths.delete(path);
		}, delayMs);
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

	private async ensureFolderExists(folderPath: string): Promise<void> {
		if (!folderPath || folderPath === '.' || folderPath === '/') return;
		const parts = folderPath.split('/').filter(Boolean);
		let currentPath = '';

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				try {
					await this.app.vault.createFolder(currentPath);
				} catch (e) {
					// Ignore if created concurrently or already exists in vault
				}
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

	private isConfigPath(path: string): boolean {
		const configDir = this.app.vault.configDir || '.obsidian';
		return path.startsWith(configDir);
	}

	private async readPhysicalFileContent(file: TFile): Promise<string | null> {
		if (isBinaryPath(file.path)) {
			try {
				const arrayBuffer = await this.app.vault.readBinary(file);
				return uint8ArrayToBase64(new Uint8Array(arrayBuffer));
			} catch (e) {
				return null;
			}
		}
		return await this.app.vault.read(file).catch(() => null);
	}

	private async createPhysicalFile(targetPath: string, content: string): Promise<void> {
		const parentPath = targetPath.substring(0, targetPath.lastIndexOf('/'));
		if (parentPath && parentPath !== targetPath) {
			await this.ensureFolderExists(parentPath);
		}
		const existing = this.app.vault.getAbstractFileByPath(targetPath);
		if (isBinaryPath(targetPath)) {
			const bytes = base64ToUint8Array(content || '');
			const binaryBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			if (existing instanceof TFile) {
				await this.app.vault.modifyBinary(existing, binaryBuffer);
			} else {
				await this.app.vault.createBinary(targetPath, binaryBuffer);
			}
		} else {
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, content || '');
			} else {
				await this.app.vault.create(targetPath, content || '');
			}
		}
	}

	private async modifyPhysicalFile(file: TFile, content: string): Promise<void> {
		if (isBinaryPath(file.path)) {
			const bytes = base64ToUint8Array(content || '');
			const binaryBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			await this.app.vault.modifyBinary(file, binaryBuffer);
		} else {
			await this.app.vault.modify(file, content);
		}
	}

	private async handleCrdtNodeCreated(payload: { uuid: string; path: string; isFolder: boolean; content?: string }): Promise<void> {
		return this.diskQueue.add(async () => {
			const mutex = this.getFileMutex(payload.path);
			try {
				await mutex.runExclusive(async () => {
					if (this.isConfigPath(payload.path)) {
						ObsidianDiskReconciler.suppressPath(payload.path);
						try {
							if (payload.isFolder) {
								if (!(await this.app.vault.adapter.exists(payload.path))) {
									await this.app.vault.adapter.mkdir(payload.path);
								}
							} else {
								const parts = payload.path.split('/');
								if (parts.length > 1) {
									const parentFolder = parts.slice(0, -1).join('/');
									if (!(await this.app.vault.adapter.exists(parentFolder))) {
										await this.app.vault.adapter.mkdir(parentFolder);
									}
								}
								await this.app.vault.adapter.write(payload.path, payload.content || '');
								this.triggerHotReload(payload.path);
							}
						} catch (e) {
							console.error('[ObsidianDiskReconciler] Failed to create config file/folder:', e);
						} finally {
							ObsidianDiskReconciler.unsuppressPath(payload.path, 20);
						}
						return;
					}

					let targetPath = payload.path;
					let existing = this.app.vault.getAbstractFileByPath(targetPath);
					let isConflict = false;

					if (existing) {
						if (!payload.isFolder && existing instanceof TFile) {
							const diskContent = await this.readPhysicalFileContent(existing);
							if (diskContent === (payload.content || '')) {
							    this.eventBus.emit('RebalancePathUuid' as any, { remoteUuid: payload.uuid, path: targetPath });
							    return;
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
							await this.createPhysicalFile(targetPath, payload.content || '');
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
						ObsidianDiskReconciler.unsuppressPath(targetPath, 20);
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
						if (this.isConfigPath(payload.oldPath) || this.isConfigPath(payload.newPath)) {
							ObsidianDiskReconciler.suppressPath(payload.oldPath);
							ObsidianDiskReconciler.suppressPath(payload.newPath);
							try {
								const parentFolder = payload.newPath.substring(0, payload.newPath.lastIndexOf('/'));
								if (parentFolder && !(await this.app.vault.adapter.exists(parentFolder))) {
									await this.app.vault.adapter.mkdir(parentFolder);
								}
								if (await this.app.vault.adapter.exists(payload.newPath)) {
        						    await this.app.vault.adapter.remove(payload.newPath);
        						}
								if (await this.app.vault.adapter.exists(payload.oldPath)) {
									await this.app.vault.adapter.rename(payload.oldPath, payload.newPath);
								} else {
									const doc = await this.syncEngine.getOrCreateDoc(payload.uuid);
									const content = doc.getText('markdown').toString();
									this.syncEngine.removeDoc(payload.uuid);
									await this.app.vault.adapter.write(payload.newPath, content || '');
								}
								this.triggerHotReload(payload.newPath);
							} catch (e) {
								console.error('[ObsidianDiskReconciler] Failed to move config file:', e);
							} finally {
								ObsidianDiskReconciler.unsuppressPath(payload.oldPath, 20);
								ObsidianDiskReconciler.unsuppressPath(payload.newPath, 20);
							}
							return;
						}

						const file = this.app.vault.getAbstractFileByPath(payload.oldPath);
	                    
						if (!file) {
							let targetPath = payload.newPath;
							let targetExists = this.app.vault.getAbstractFileByPath(targetPath);
						    
							if (targetExists) return; 

							const doc = await this.syncEngine.getOrCreateDoc(payload.uuid);
							const content = doc.getText('markdown').toString();
							this.syncEngine.removeDoc(payload.uuid);
										
							if (targetExists) {
								targetPath = this.resolveConflictPath(targetPath);
							}

							ObsidianDiskReconciler.suppressPath(targetPath);
							try {
								await this.createPhysicalFile(targetPath, content || '');
							} catch (e) {
								console.error('[ObsidianDiskReconciler] Failed to rehydrate missing moved file:', e);
							} finally {
								ObsidianDiskReconciler.unsuppressPath(targetPath, 20);
							}
							return;
						}

						let targetPath = payload.newPath;
						let targetExists = this.app.vault.getAbstractFileByPath(targetPath);

						if (targetExists && targetExists.path !== payload.oldPath) {
							if ((targetExists as any).stat?.size === 0) {
								try { await this.app.vault.trash(targetExists, true); } catch (e) {}
							} else {
								const doc = await this.syncEngine.getOrCreateDoc(payload.uuid);
								const incomingContent = doc.getText('markdown').toString();
								const diskContent = targetExists instanceof TFile ? await this.readPhysicalFileContent(targetExists) : null;
                                
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

							const doc = await this.syncEngine.getOrCreateDoc(payload.uuid);
							const crdtContent = doc.getText('markdown').toString();
							if (crdtContent && file instanceof TFile) {
								ObsidianDiskReconciler.suppressPath(targetPath);
								await this.modifyPhysicalFile(file, crdtContent);
								ObsidianDiskReconciler.unsuppressPath(targetPath, 20);
							}
						} catch (e) {
							console.error('[ObsidianDiskReconciler] Failed to rename file:', e);
						} finally {
	                        setTimeout(() => {
	                            for (const p of pathsToSuppress) ObsidianDiskReconciler.unsuppressPath(p, 20);
	                        }, 20);
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
					if (this.isConfigPath(payload.path)) {
						ObsidianDiskReconciler.suppressPath(payload.path);
						try {
							if (await this.app.vault.adapter.exists(payload.path)) {
								await this.app.vault.adapter.remove(payload.path);
							}
						} catch (e) {
							console.error('[ObsidianDiskReconciler] Failed to delete config file:', e);
						} finally {
							ObsidianDiskReconciler.unsuppressPath(payload.path, 20);
						}
						return;
					}

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
						ObsidianDiskReconciler.unsuppressPath(payload.path, 20);
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
					let file = this.app.vault.getAbstractFileByPath(payload.path);
					if (!file && typeof (this.app.vault as any).getFiles === 'function') {
						file = this.app.vault.getFiles().find((f: any) => f.path === payload.path) || null;
					}

					const configDir = this.app.vault.configDir || '.obsidian';
					if (payload.path.startsWith(configDir)) {
						try {
							let currentDiskContent = '';
							if (await this.app.vault.adapter.exists(payload.path)) {
								currentDiskContent = await this.app.vault.adapter.read(payload.path);
							}
							if (currentDiskContent.replace(/\r\n/g, '\n') !== payload.content.replace(/\r\n/g, '\n')) {
								ObsidianDiskReconciler.suppressPath(payload.path);
								const parts = payload.path.split('/');
								if (parts.length > 1) {
									const parentFolder = parts.slice(0, -1).join('/');
									if (!(await this.app.vault.adapter.exists(parentFolder))) {
										await this.app.vault.adapter.mkdir(parentFolder);
									}
								}
								await this.app.vault.adapter.write(payload.path, payload.content);
								this.triggerHotReload(payload.path);
							}
						} catch (e) {
							console.error('[ObsidianDiskReconciler] Failed to write config file:', e);
						} finally {
							ObsidianDiskReconciler.unsuppressPath(payload.path, 20);
						}
					} else if (file && file instanceof TFile) {
						try {
							const currentDiskContent = await this.readPhysicalFileContent(file);
							if (currentDiskContent !== payload.content) {
								ObsidianDiskReconciler.suppressPath(payload.path);
								await this.modifyPhysicalFile(file, payload.content);
							}
						} catch (e) {
							console.error('[ObsidianDiskReconciler] Failed to write binary/text content:', e);
						} finally {
							ObsidianDiskReconciler.unsuppressPath(payload.path, 20);
						}
					}
				});
			} finally {
				this.releaseFileMutex(payload.path);
			}
		});
	}

	private triggerHotReload(configFilePath: string): void {
		try {
			if (configFilePath.includes('/themes/') || configFilePath.endsWith('appearance.json')) {
				if (typeof (this.app as any).customCss?.loadManifests === 'function') {
					(this.app as any).customCss.loadManifests();
				}
			} else if (configFilePath.endsWith('data.json')) {
				const match = configFilePath.match(/plugins\/([^/]+)\/data\.json$/);
				if (match && match[1]) {
					const pluginId = match[1];
					const plugin = (this.app as any).plugins?.getPlugin(pluginId);
					if (plugin && typeof plugin.loadData === 'function') {
						plugin.loadData().catch(console.error);
					}
				}
			}
		} catch (e) {
			console.error('[ObsidianDiskReconciler] Error during hot reload trigger:', e);
		}
	}

	public async onIdle(): Promise<void> {
		await this.diskQueue.onIdle();
	}

	public destroy(): void {
		this.fileLocks.clear();
	}
}
