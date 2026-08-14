import { App } from 'obsidian';

export class VfsCollisionResolver {
	constructor(private app: App) {}

	public async resolveCollision(
		path: string,
		seenPaths: Set<string>,
		safeExists: (p: string) => Promise<boolean>,
		isFolder = false
	): Promise<string> {
		let collisionCount = 1;
		let newPath = '';
		const extMatch = !isFolder ? path.match(/(\.[a-zA-Z][a-zA-Z0-9]{1,4})$/) : null;
		const ext = extMatch ? extMatch[0] : '';
		const base = extMatch ? path.slice(0, -ext.length) : path;

		do {
			newPath = `${base} (Conflict ${collisionCount})${ext}`;
			collisionCount++;
		} while (seenPaths.has(newPath) || !!this.app.vault.getAbstractFileByPath(newPath) || await safeExists(newPath));

		return newPath;
	}

	public resolveRenameCollision(
		newPath: string,
		isPathTaken: (p: string) => boolean,
		isFolder = false
	): string {
		let collisionCount = 1;
		let finalPath = newPath;
		const extMatch = !isFolder ? newPath.match(/(\.[a-zA-Z][a-zA-Z0-9]{1,4})$/) : null;
		const ext = extMatch ? extMatch[0] : '';
		const base = extMatch ? newPath.slice(0, -ext.length) : newPath;

		do {
			finalPath = `${base} (${collisionCount})${ext}`;
			collisionCount++;
		} while (isPathTaken(finalPath));

		return finalPath;
	}
}
