import { App, TAbstractFile } from 'obsidian';

export class VfsDeletionService {
	constructor(private app: App) {}

	public async executePhase1(
		toDelete: Array<[string, any]>,
		pathToUuid: Map<string, string>,
		justDeletedPaths: Set<string>,
		uuidToLastKnownPath: Map<string, string>,
		safeExists: (p: string) => Promise<boolean>
	): Promise<void> {
		console.log('[VfsDeletionService] Phase 1 toDelete items:', JSON.stringify(toDelete));
		console.log('[VfsDeletionService] Phase 1 pathToUuid entries:', Array.from(pathToUuid.entries()));
		for (const [uuid, node] of toDelete) {
			uuidToLastKnownPath.delete(uuid);

			if (pathToUuid.has(node.path)) {
				console.log('[VfsDeletionService] Skipping deletion of path mapped to active uuid:', node.path);
				continue;
			}

			const localFile = this.app.vault.getAbstractFileByPath(node.path);
			const existsOnDisk = !!localFile || await safeExists(node.path);
			if (!existsOnDisk) {
				continue;
			}

			justDeletedPaths.add(node.path);
			console.log('[VfsDeletionService] Removing path:', node.path, 'localFile exists:', !!localFile);
			await this.safeRemove(node.path, localFile, safeExists);
			console.log('[VfsDeletionService] After safeRemove, safeExists:', await safeExists(node.path));
		}
	}

	private async safeRemove(
		p: string,
		abstractFile: TAbstractFile | null,
		safeExists: (p: string) => Promise<boolean>
	): Promise<void> {
		let success = false;
		if (abstractFile) {
			success = await this.tryTrash(abstractFile);
			if (success && (await safeExists(p))) {
				success = false; // If still on disk, force physical remove fallback
			}
		}

		let attempts = 0;
		while (!success && attempts < 3) {
			if (!(await safeExists(p))) {
				success = true;
				break;
			}
			try {
				if (this.app.vault.adapter.remove) {
					await this.app.vault.adapter.remove(p);
				}
				success = true;
			} catch(e) {
				attempts++;
				await new Promise(r => window.setTimeout(r, 200));
			}
		}

		// FORCE FALLBACK PHYSICAL UNLINK IF WE ARE IN ELECTRON/NODE (CI testing environment)!
		try {
			if (typeof require !== 'undefined') {
				const fsNode = require('fs');
				const pathNode = require('path');
				const basePath = (this.app.vault.adapter as any).getBasePath ? (this.app.vault.adapter as any).getBasePath() : '';
				console.log('[VfsDeletionService] physical basePath:', basePath, 'physical file path:', pathNode.join(basePath, p));
				if (basePath) {
					const physicalPath = pathNode.join(basePath, p);
					if (fsNode.existsSync(physicalPath)) {
						fsNode.unlinkSync(physicalPath);
					}
				}
			}
		} catch (err) {}
	}

	private async tryTrash(abstractFile: TAbstractFile): Promise<boolean> {
		const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
			return Promise.race([
				promise,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
			]);
		};

		try {
			await withTimeout(this.app.vault.trash(abstractFile, true), 300);
			return true;
		} catch (e) {
			try {
				await withTimeout(this.app.vault.trash(abstractFile, false), 300);
				return true;
			} catch(e2) {
				return false;
			}
		}
	}
}
