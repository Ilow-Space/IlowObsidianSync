import { INoteRepository } from '@domain/Interfaces/INoteRepository';
import { App, TFile } from 'obsidian';
import { PluginSettings } from '@presentation/Plugin';
import { isAllowedConfigPath } from '@domain/Utils/ConfigPathFilter';
import { isBinaryPath, uint8ArrayToBase64, base64ToUint8Array } from '@domain/Utils/BinaryUtils';

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
			} catch {
				return null;
			}
			return null;
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			if (isBinaryPath(path)) {
				try {
					const arrayBuffer = await this.app.vault.readBinary(file);
					const bytes = new Uint8Array(arrayBuffer);
					return uint8ArrayToBase64(bytes);
				} catch {}
			} else {
				return await this.app.vault.read(file);
			}
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

		const isBinary = isBinaryPath(path);
		let binaryBuffer: ArrayBuffer | null = null;
		if (isBinary) {
			const bytes = base64ToUint8Array(content || '');
			binaryBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		// const isBinary = isBinaryPath(path);

		if (file instanceof TFile) {
			if (isBinary && binaryBuffer) {
				await this.app.vault.modifyBinary(file, binaryBuffer);
			} else {
				await this.app.vault.modify(file, content);
			}
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
			if (isBinary && binaryBuffer) {
				await this.app.vault.createBinary(path, binaryBuffer);
			} else {
				await this.app.vault.create(path, content);
			}
		}
	}

	public async listAllNotes(): Promise<string[]> {
		const allDiskFiles = new Set<string>();
		const configDir = this.app.vault.configDir || '.obsidian';

		try {
			const walkAdapter = async (dir: string) => {
				const res = await this.app.vault.adapter.list(dir);
				for (const filePath of res.files) {
					if (dir === configDir || dir.startsWith(configDir + '/')) {
						if (isAllowedConfigPath(filePath, configDir, this.settings)) {
							allDiskFiles.add(filePath);
						}
					} else {
						allDiskFiles.add(filePath);
					}
				}
				for (const subDir of res.folders) {
					if (subDir === configDir || subDir.startsWith(configDir + '/')) {
						if (isAllowedConfigPath(subDir, configDir, this.settings)) {
							await walkAdapter(subDir);
						}
					} else if (subDir !== '.git' && !subDir.startsWith('.git/')) {
						await walkAdapter(subDir);
					}
				}
			};
			await walkAdapter('');
		} catch (e) {
			console.error('Failed walking adapter directory:', e);
		}

		const vaultFiles = typeof this.app.vault.getFiles === 'function'
			? this.app.vault.getFiles().map(file => file.path)
			: this.app.vault.getMarkdownFiles().map(file => file.path);

		for (const f of vaultFiles) allDiskFiles.add(f);

		return Array.from(allDiskFiles);
	}

	public onNoteChange(callback: (path: string, content: string) => void): void {
		this.changeCallbacks.push(callback);
	}
}
