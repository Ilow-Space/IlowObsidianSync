import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { App, TFile } from 'obsidian';

export class ObsidianNoteRepository implements INoteRepository {
	public changeCallbacks: Array<(path: string, content: string) => void> = [];

	constructor(private app: App) {}

	public async readNote(path: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return await this.app.vault.read(file);
		}
		return null;
	}

	public async writeNote(path: string, content: string): Promise<void> {
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
		return this.app.vault.getMarkdownFiles().map(file => file.path);
	}

	public onNoteChange(callback: (path: string, content: string) => void): void {
		this.changeCallbacks.push(callback);
	}
}