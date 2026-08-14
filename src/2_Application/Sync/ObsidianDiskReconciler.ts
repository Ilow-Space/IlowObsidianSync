import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { Mutex } from 'async-mutex';
import { SyncEventBus } from './SyncEventBus';
import { LoroSyncEngine } from '@infrastructure/Crdt/LoroSyncEngine';

export class ObsidianDiskReconciler {
	private fileLocks = new Map<string, Mutex>();

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

	private getFileMutex(path: string): Mutex {
		let mutex = this.fileLocks.get(path);
		if (!mutex) {
			mutex = new Mutex();
			this.fileLocks.set(path, mutex);
		}
		return mutex;
	}

	private async handleCrdtNodeCreated(payload: { uuid: string; path: string; isFolder: boolean; content?: string }): Promise<void> {
		const mutex = this.getFileMutex(payload.path);
		await mutex.runExclusive(async () => {
			const existing = this.app.vault.getAbstractFileByPath(payload.path);
			if (existing) return;

			if (payload.isFolder) {
				try {
					await this.app.vault.createFolder(payload.path);
				} catch (e) {
					console.error('[ObsidianDiskReconciler] Failed to create folder:', e);
				}
			} else {
				try {
					const parentPath = payload.path.substring(0, payload.path.lastIndexOf('/'));
					if (parentPath && parentPath !== payload.path) {
						const parentExists = this.app.vault.getAbstractFileByPath(parentPath);
						if (!parentExists) {
							await this.app.vault.createFolder(parentPath);
						}
					}
					await this.app.vault.create(payload.path, payload.content || '');
				} catch (e) {
					console.error('[ObsidianDiskReconciler] Failed to create file:', e);
				}
			}
		});
	}

	private async handleCrdtNodeMoved(payload: { uuid: string; oldPath: string; newPath: string }): Promise<void> {
		const mutex = this.getFileMutex(payload.newPath);
		await mutex.runExclusive(async () => {
			const file = this.app.vault.getAbstractFileByPath(payload.oldPath);
			if (!file) return;

			const targetExists = this.app.vault.getAbstractFileByPath(payload.newPath);
			if (targetExists) return;

			try {
				const parentPath = payload.newPath.substring(0, payload.newPath.lastIndexOf('/'));
				if (parentPath && parentPath !== payload.newPath) {
					const parentExists = this.app.vault.getAbstractFileByPath(parentPath);
					if (!parentExists) {
						await this.app.vault.createFolder(parentPath);
					}
				}
				await this.app.fileManager.renameFile(file, payload.newPath);
			} catch (e) {
				console.error('[ObsidianDiskReconciler] Failed to rename file on disk:', e);
			}
		});
	}

	private async handleCrdtNodeSoftDeleted(payload: { uuid: string; path: string }): Promise<void> {
		const mutex = this.getFileMutex(payload.path);
		await mutex.runExclusive(async () => {
			const file = this.app.vault.getAbstractFileByPath(payload.path);
			if (!file) return;

			try {
				try {
					await this.app.vault.trash(file, true);
				} catch (e) {
					await this.app.vault.trash(file, false);
				}
			} catch (e) {
				console.error('[ObsidianDiskReconciler] Failed to trash file/folder:', e);
			}
		});
	}

	private async handleCrdtTextChanged(payload: { uuid: string; path: string; content: string }): Promise<void> {
		const mutex = this.getFileMutex(payload.path);
		await mutex.runExclusive(async () => {
			const file = this.app.vault.getAbstractFileByPath(payload.path);
			if (file && file instanceof TFile) {
				try {
					const currentDiskContent = await this.app.vault.read(file);
					if (currentDiskContent !== payload.content) {
						await this.app.vault.modify(file, payload.content);
					}
				} catch (e) {
					console.error('[ObsidianDiskReconciler] Failed to write updated text to disk:', e);
				}
			}
		});
	}

	public destroy(): void {
		this.fileLocks.clear();
	}
}
