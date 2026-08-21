import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { App, TFile } from 'obsidian';
import { PluginSettings } from '@presentation/Plugin';
import { isAllowedConfigPath } from '@domain/Utils/ConfigPathFilter';

export class ObsidianNoteRepository implements INoteRepository {
	public changeCallbacks: Array<(path: string, content: string) => void> = [];

	constructor(
		private app: App,
		private settings?: PluginSettings
	) {}

	public async readNote(path: string): Promise<string | null> {
		const configDir = this.app.vault.configDir || '.obsidian';
		if (path.startsWith(configDir)) {
			try {
				if (await this.app.vault.adapter.exists(path)) {
					return await this.app.vault.adapter.read(path);
				}
			} catch (e) {
				return null;
			}
			return null;
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return await this.app.vault.read(file);
		}
		return null;
	}

	public async writeNote(path: string, content: string): Promise<void> {
		const configDir = this.app.vault.configDir || '.obsidian';
		if (path.startsWith(configDir)) {
			const parts = path.split('/');
			if (parts.length > 1) {
				const parentFolder = parts.slice(0, -1).join('/');
				if (!(await this.app.vault.adapter.exists(parentFolder))) {
					await this.app.vault.adapter.mkdir(parentFolder);
				}
			}
			await this.app.vault.adapter.write(path, content);
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			const parts = path.split('/');
			if (parts.length > 1) {
				const folderParts = parts.slice(0, -1);
				let current = '';
				for (const part of folderParts) {
					current = current ? `${current}/${part}` : part;
					const folder = this.app.vault.getAbstractFileByPath(current);
					if (!folder) {
						await this.app.vault.createFolder(current);
					}
				}
			}
			await this.app.vault.create(path, content);
		}
	}

	public async listAllNotes(): Promise<string[]> {
		const markdownFiles = this.app.vault.getMarkdownFiles().map(file => file.path);
		const configDir = this.app.vault.configDir || '.obsidian';

		const configFiles: string[] = [];
		try {
			const walkAdapter = async (dir: string) => {
				const res = await this.app.vault.adapter.list(dir);
				for (const filePath of res.files) {
					if (isAllowedConfigPath(filePath, configDir, this.settings)) {
						configFiles.push(filePath);
					}
				}
				for (const subDir of res.folders) {
					if (isAllowedConfigPath(subDir, configDir, this.settings)) {
						await walkAdapter(subDir);
					}
				}
			};
			if (await this.app.vault.adapter.exists(configDir)) {
				await walkAdapter(configDir);
			}
		} catch (e) {
			console.error('Failed walking adapter config directory:', e);
		}

		return [...markdownFiles, ...configFiles];
	}

	public onNoteChange(callback: (path: string, content: string) => void): void {
		this.changeCallbacks.push(callback);
	}
}