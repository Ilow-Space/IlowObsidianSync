import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { SyncEventBus } from './SyncEventBus';

export class VaultEventWatcher {
	private activeListeners: Array<{ eventName: string; ref: any }> = [];

	constructor(
		private app: App,
		private eventBus: SyncEventBus
	) {}

	public initialize(): void {
		const onCreate = this.app.vault.on('create', (file: TAbstractFile) => {
			const isFolder = file instanceof TFolder || (file as any).children !== undefined;
			if (file instanceof TFile) {
				this.app.vault.read(file).then((content) => {
					this.eventBus.emit('LocalFileCreated', {
						path: file.path,
						isFolder,
						content
					});
				}).catch((e) => {
					console.error('[VaultEventWatcher] Failed to read newly created file:', e);
					this.eventBus.emit('LocalFileCreated', {
						path: file.path,
						isFolder
					});
				});
			} else {
				this.eventBus.emit('LocalFileCreated', {
					path: file.path,
					isFolder
				});
			}
		});

		const onRename = this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			this.eventBus.emit('LocalFileRenamed', {
				oldPath,
				newPath: file.path
			});
		});

		const onDelete = this.app.vault.on('delete', (file: TAbstractFile) => {
			this.eventBus.emit('LocalFileDeleted', {
				path: file.path
			});
		});

		const onModify = this.app.vault.on('modify', (file: TAbstractFile) => {
			if (file instanceof TFile) {
				this.app.vault.read(file).then((content) => {
					this.eventBus.emit('LocalFileModified', {
						path: file.path,
						content
					});
				}).catch((e) => {
					console.error('[VaultEventWatcher] Failed to read modified file:', e);
				});
			}
		});

		this.activeListeners.push(
			{ eventName: 'create', ref: onCreate },
			{ eventName: 'rename', ref: onRename },
			{ eventName: 'delete', ref: onDelete },
			{ eventName: 'modify', ref: onModify }
		);
	}

	public destroy(): void {
		for (const listener of this.activeListeners) {
			this.app.vault.off(listener.eventName as any, listener.ref);
		}
		this.activeListeners = [];
	}
}
