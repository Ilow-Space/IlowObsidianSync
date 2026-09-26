
import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { SyncEventBus } from './SyncEventBus';
import { ObsidianDiskReconciler } from './ObsidianDiskReconciler';
import { NetworkOrchestrator } from './NetworkOrchestrator';
import { PluginSettings } from '@presentation/Plugin';
import { isAllowedConfigPath } from '@domain/Utils/ConfigPathFilter';
import { isBinaryPath, uint8ArrayToBase64 } from '@domain/Utils/BinaryUtils';

export class VaultEventWatcher {
	private activeListeners: Array<{ eventName: 'create' | 'rename' | 'delete' | 'modify'; ref: (...data: unknown[]) => unknown }> = [];
	private orchestrator: NetworkOrchestrator | null = null;
	private pollTimer: number | null = null;
	private knownDiskFiles = new Map<string, string>();

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
		if (this.orchestrator && (this.orchestrator as unknown as { isSyncingFull?: boolean }).isSyncingFull) return true;
		const configDir = this.app.vault.configDir;
		if (!isAllowedConfigPath(path, configDir, this.settings)) return true;
		return false;
	}

	private async readTFileContent(file: TFile): Promise<string> {
		if (isBinaryPath(file.path)) {
			for (let i = 0; i < 3; i++) {
				try {
					if (this.app.vault.adapter && await this.app.vault.adapter.exists(file.path)) {
						const arrayBuffer = await this.app.vault.adapter.readBinary(file.path);
						if (arrayBuffer.byteLength > 0) {
							return uint8ArrayToBase64(new Uint8Array(arrayBuffer));
						}
						// A create event can fire before a large paste has finished
						// flushing to disk. That is not an exception -- adapter.exists
						// and readBinary both succeed, just with 0 bytes -- so it must
						// feed back into this loop's own retries rather than returning
						// immediately, or a slow disk turns into a permanently empty
						// upload with no error anywhere.
					}
				} catch {
					// fall through to the shared backoff below
				}
				await new Promise(r => window.setTimeout(r, 150));
			}
			console.warn(`[VaultEventWatcher] Gave up reading ${file.path} after 3 attempts -- read 0 bytes every time.`);
			return '';
		}
		return await this.app.vault.read(file);
	}

	private async readFileContent(path: string): Promise<string | null> {
		const configDir = this.app.vault.configDir;
		if (configDir && path.startsWith(configDir)) {
			try {
				if (this.app.vault.adapter && await this.app.vault.adapter.exists(path)) {
					return await this.app.vault.adapter.read(path);
				}
			} catch {
				return null;
			}
			return null;
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return await this.readTFileContent(file);
		}

		if (isBinaryPath(path)) {
			try {
				if (this.app.vault.adapter && await this.app.vault.adapter.exists(path)) {
					const arrayBuffer = await this.app.vault.adapter.readBinary(path);
					const bytes = new Uint8Array(arrayBuffer);
					return uint8ArrayToBase64(bytes);
				}
			} catch {
				return null;
			}
		} else {
			try {
				if (this.app.vault.adapter && await this.app.vault.adapter.exists(path)) {
					return await this.app.vault.adapter.read(path);
				}
			} catch {
				return null;
			}
		}

		return null;
	}

	private async listAllDiskPaths(): Promise<string[]> {
		const allDiskFiles = new Set<string>();
		const configDir = this.app.vault.configDir;

		try {
			if (this.app.vault.adapter) {
				const walkAdapter = async (dir: string) => {
					const res = await this.app.vault.adapter.list(dir);
					for (const filePath of res.files) {
						if (isAllowedConfigPath(filePath, configDir, this.settings)) {
							allDiskFiles.add(filePath);
						}
					}
					for (const subDir of res.folders) {
						if (isAllowedConfigPath(subDir, configDir, this.settings)) {
							await walkAdapter(subDir);
						} else if (!subDir.startsWith('.git') && !subDir.includes('/.')) {
							await walkAdapter(subDir);
						}
					}
				};
				await walkAdapter('');
			}
		} catch {
			// Suppress adapter walking errors
		}

		if (typeof this.app.vault.getFiles === 'function') {
			for (const file of this.app.vault.getFiles()) {
				if (isAllowedConfigPath(file.path, configDir, this.settings)) {
					allDiskFiles.add(file.path);
				}
			}
		}

		return Array.from(allDiskFiles);
	}

	public initialize(): void {
		const onCreate = this.app.vault.on('create', (file: TAbstractFile) => {
			if (this.shouldIgnore(file.path)) return;

			const isFolder = file instanceof TFolder || (file as unknown as { children?: unknown }).children !== undefined;
			if (file instanceof TFile) {
				void this.readTFileContent(file).then((content) => {
					if (this.shouldIgnore(file.path)) return;
					this.knownDiskFiles.set(file.path, content);

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

			const oldContent = this.knownDiskFiles.get(oldPath);
			this.knownDiskFiles.delete(oldPath);
			if (oldContent !== undefined) {
				this.knownDiskFiles.set(file.path, oldContent);
			}

			this.eventBus.emit('LocalFileRenamed', {
				oldPath,
				newPath: file.path
			});
		});

		const onDelete = this.app.vault.on('delete', (file: TAbstractFile) => {
			if (this.shouldIgnore(file.path)) return;

			this.knownDiskFiles.delete(file.path);

			this.eventBus.emit('LocalFileDeleted', {
				path: file.path,
				uuid: (file as unknown as { uuid?: string }).uuid
			});
		});

		const onModify = this.app.vault.on('modify', (file: TAbstractFile) => {
			if (this.shouldIgnore(file.path)) return;

			if (file instanceof TFile) {
				void this.readTFileContent(file).then((content) => {
					if (this.shouldIgnore(file.path)) return;
					this.knownDiskFiles.set(file.path, content);

					this.eventBus.emit('LocalFileModified', {
						path: file.path,
						content
					});
				}).catch(() => {});
			}
		});

		this.activeListeners.push(
			{ eventName: 'create', ref: onCreate as unknown as (...data: unknown[]) => unknown },
			{ eventName: 'rename', ref: onRename as unknown as (...data: unknown[]) => unknown },
			{ eventName: 'delete', ref: onDelete as unknown as (...data: unknown[]) => unknown },
			{ eventName: 'modify', ref: onModify as unknown as (...data: unknown[]) => unknown }
		);

		this.pollVaultFiles().catch(() => {});

		this.pollTimer = window.setInterval(() => {
			this.pollVaultFiles().catch(() => {});
		}, 2000);
	}

	public async pollVaultFiles(): Promise<void> {
		if (this.orchestrator && (this.orchestrator as unknown as { isSyncingFull?: boolean }).isSyncingFull) return;

		try {
			const diskPaths = await this.listAllDiskPaths();
			const currentPathSet = new Set(diskPaths);

			for (const [knownPath] of Array.from(this.knownDiskFiles.entries())) {
				if (!currentPathSet.has(knownPath)) {
					if (this.shouldIgnore(knownPath)) continue;

					this.knownDiskFiles.delete(knownPath);
					this.eventBus.emit('LocalFileDeleted', { path: knownPath });
				}
			}

			for (const path of diskPaths) {
				if (this.shouldIgnore(path)) {
					if (ObsidianDiskReconciler.suppressedPaths.has(path)) {
						const content = await this.readFileContent(path);
						if (content !== null) {
							this.knownDiskFiles.set(path, content);
						}
					}
					continue;
				}

				const prevContent = this.knownDiskFiles.get(path);
				const content = await this.readFileContent(path);
				if (content === null) continue;

				if (prevContent === undefined) {
					this.knownDiskFiles.set(path, content);
					this.eventBus.emit('LocalFileCreated', { path, isFolder: false, content });
					this.eventBus.emit('LocalFileModified', { path, content });
				} else if (prevContent !== content) {
					this.knownDiskFiles.set(path, content);
					this.eventBus.emit('LocalFileModified', { path, content });
				}
			}
		} catch {
			// Suppress polling errors
		}
	}

	public destroy(): void {
		if (this.pollTimer) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		for (const listener of this.activeListeners) {
			this.app.vault.off(listener.eventName, listener.ref);
		}
		this.activeListeners = [];
		this.knownDiskFiles.clear();
	}
}

