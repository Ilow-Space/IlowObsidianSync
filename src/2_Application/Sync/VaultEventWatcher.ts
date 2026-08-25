import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { SyncEventBus } from './SyncEventBus';
import { ObsidianDiskReconciler } from './ObsidianDiskReconciler';
import { NetworkOrchestrator } from './NetworkOrchestrator';
import { PluginSettings } from '@presentation/Plugin';
import { isAllowedConfigPath } from '@domain/Utils/ConfigPathFilter';
import { isBinaryPath, uint8ArrayToBase64 } from '@domain/Utils/BinaryUtils';

export class VaultEventWatcher {
	private activeListeners: Array<{ eventName: string; ref: any }> = [];
	private orchestrator: NetworkOrchestrator | null = null;
	private configPollTimer: any = null;
	private knownConfigContents = new Map<string, string>();

	constructor(
		private app: App,
		private eventBus: SyncEventBus,
		private settings?: PluginSettings
	) {}

	public setOrchestrator(orchestrator: NetworkOrchestrator): void {
		this.orchestrator = orchestrator;
	}

	private shouldIgnore(path: string): boolean {
		if (ObsidianDiskReconciler.suppressedPaths.has(path)) return true;
		if (this.orchestrator && (this.orchestrator as any).isSyncingFull) return true;
		const configDir = this.app.vault.configDir || '.obsidian';
		if (!isAllowedConfigPath(path, configDir, this.settings)) return true;
		return false;
	}

	private async readTFileContent(file: TFile): Promise<string> {
		if (isBinaryPath(file.path)) {
			try {
				if (this.app.vault.adapter && await this.app.vault.adapter.exists(file.path)) {
					let arrayBuffer = await this.app.vault.adapter.readBinary(file.path);
					if (arrayBuffer.byteLength === 0) {
						await new Promise(r => setTimeout(r, 50));
						arrayBuffer = await this.app.vault.adapter.readBinary(file.path);
					}
					const bytes = new Uint8Array(arrayBuffer);
					return uint8ArrayToBase64(bytes);
				}
			} catch (e) {}
		}
		return await this.app.vault.read(file);
	}

	public initialize(): void {
		const onCreate = this.app.vault.on('create', (file: TAbstractFile) => {
			if (this.shouldIgnore(file.path)) return;

			const isFolder = file instanceof TFolder || (file as any).children !== undefined;
			if (file instanceof TFile) {
				this.readTFileContent(file).then((content) => {
					if (this.shouldIgnore(file.path)) return;

					this.eventBus.emit('LocalFileCreated', {
						path: file.path,
						isFolder,
						content
					});
					this.eventBus.emit('LocalFileModified', {
						path: file.path,
						content
					});
				}).catch(() => {
					if (this.shouldIgnore(file.path)) return;
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
			if (this.shouldIgnore(file.path) || this.shouldIgnore(oldPath)) return;

			this.eventBus.emit('LocalFileRenamed', {
				oldPath,
				newPath: file.path
			});
		});

		const onDelete = this.app.vault.on('delete', (file: TAbstractFile) => {
			if (this.shouldIgnore(file.path)) return;

			this.eventBus.emit('LocalFileDeleted', {
				path: file.path,
				uuid: (file as any).uuid
			});
		});

		const onModify = this.app.vault.on('modify', (file: TAbstractFile) => {
			if (this.shouldIgnore(file.path)) return;

			if (file instanceof TFile) {
				this.readTFileContent(file).then((content) => {
					if (this.shouldIgnore(file.path)) return;

					this.eventBus.emit('LocalFileModified', {
						path: file.path,
						content
					});
				}).catch(() => {});
			}
		});

		this.activeListeners.push(
			{ eventName: 'create', ref: onCreate },
			{ eventName: 'rename', ref: onRename },
			{ eventName: 'delete', ref: onDelete },
			{ eventName: 'modify', ref: onModify }
		);

		this.configPollTimer = setInterval(() => {
			this.pollConfigFiles().catch(() => {});
		}, 2000);
	}

	private async pollConfigFiles(): Promise<void> {
		if (this.orchestrator && (this.orchestrator as any).isSyncingFull) return;
		const configDir = this.app.vault.configDir || '.obsidian';
		try {
			if (!this.app.vault.adapter || !(await this.app.vault.adapter.exists(configDir))) return;
			const allowedFiles: string[] = [];
			const walk = async (dir: string) => {
				const res = await this.app.vault.adapter.list(dir);
				for (const f of res.files) {
					if (isAllowedConfigPath(f, configDir, this.settings)) {
						allowedFiles.push(f);
					}
				}
				for (const sub of res.folders) {
					if (isAllowedConfigPath(sub, configDir, this.settings)) {
						await walk(sub);
					}
				}
			};
			await walk(configDir);

			for (const path of allowedFiles) {
				if (this.shouldIgnore(path)) continue;
				try {
					const content = await this.app.vault.adapter.read(path);
					const prev = this.knownConfigContents.get(path);
					if (prev === undefined) {
						this.knownConfigContents.set(path, content);
						this.eventBus.emit('LocalFileCreated', { path, isFolder: false, content });
					} else if (prev !== content) {
						this.knownConfigContents.set(path, content);
						this.eventBus.emit('LocalFileModified', { path, content });
					}
				} catch (e) {}
			}
		} catch (e) {}
	}

	public destroy(): void {
		if (this.configPollTimer) {
			clearInterval(this.configPollTimer);
			this.configPollTimer = null;
		}
		for (const listener of this.activeListeners) {
			this.app.vault.off(listener.eventName as any, listener.ref);
		}
		this.activeListeners = [];
		this.knownConfigContents.clear();
	}
}
