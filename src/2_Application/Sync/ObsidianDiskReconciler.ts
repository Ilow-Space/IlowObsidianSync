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
		}, 600);
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
					const existing = this.app.vault.getAbstractFileByPath(payload.path);
					if (existing) return;

					ObsidianDiskReconciler.suppressPath(payload.path);
					try {
						if (payload.isFolder) {
							await this.ensureFolderExists(payload.path);
						} else {
							const parentPath = payload.path.substring(0, payload.path.lastIndexOf('/'));
							if (parentPath && parentPath !== payload.path) {
								await this.ensureFolderExists(parentPath);
							}
							await this.app.vault.create(payload.path, payload.content || '');
						}
					} catch (e) {
						console.error('[ObsidianDiskReconciler] Failed to create file/folder:', e);
					} finally {
						ObsidianDiskReconciler.unsuppressPath(payload.path);
					}
				});
			} finally {
				this.releaseFileMutex(payload.path);
			}
		});
	}

	private async handleCrdtNodeMoved(payload: { uuid: string; oldPath: string; newPath: string }): Promise<void> {
		return this.diskQueue.add(async () => {
			const mutex = this.getFileMutex(payload.newPath);
			try {
				await mutex.runExclusive(async () => {
					const file = this.app.vault.getAbstractFileByPath(payload.oldPath);
					if (!file) return;

					const targetExists = this.app.vault.getAbstractFileByPath(payload.newPath);
					if (targetExists) return;

					const pathsToSuppress = [payload.oldPath, payload.newPath];
					const prefix = payload.oldPath.endsWith('/') ? payload.oldPath : payload.oldPath + '/';
					const allFiles = (this.app.vault as any).getAllLoadedFiles ? (this.app.vault as any).getAllLoadedFiles() : [];
					for (const f of allFiles) {
						if (f.path && f.path.startsWith(prefix)) {
							pathsToSuppress.push(f.path);
							const suffix = f.path.substring(payload.oldPath.length);
							pathsToSuppress.push(payload.newPath + suffix);
						}
					}

					for (const p of pathsToSuppress) {
						ObsidianDiskReconciler.suppressPath(p);
					}

					try {
						const parentPath = payload.newPath.substring(0, payload.newPath.lastIndexOf('/'));
						if (parentPath && parentPath !== payload.newPath) {
							await this.ensureFolderExists(parentPath);
						}
						await this.app.fileManager.renameFile(file, payload.newPath);
					} catch (e) {
						console.error('[ObsidianDiskReconciler] Failed to rename file:', e);
					} finally {
						for (const p of pathsToSuppress) {
							ObsidianDiskReconciler.unsuppressPath(p);
						}
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