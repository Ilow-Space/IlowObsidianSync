export class LoroMigrationManager {
	public static async performLibraryMigrationCheck(): Promise<boolean> {
		let clearedYjs = false;
		try {
			const dbs = await indexedDB.databases();
			const hasYjsDb = dbs.some(db => db.name === 'obsidian-crdt-sync-db');
			if (hasYjsDb) {
				console.log('[LoroMigrationManager] Existing legacy Yjs IndexedDB detected. Forcefully purging legacy cache...');
				await new Promise<void>((resolve, reject) => {
					const req = indexedDB.deleteDatabase('obsidian-crdt-sync-db');
					req.onsuccess = () => resolve();
					req.onerror = () => reject(req.error);
				});
				clearedYjs = true;
				console.log('[LoroMigrationManager] Legacy Yjs IndexedDB successfully purged.');
			}
		} catch (e) {
			console.error('[LoroMigrationManager] Database detection/deletion failed:', e);
		}
		return clearedYjs;
	}
}
