export class LoroMigrationManager {
	public static async performLibraryMigrationCheck(): Promise<boolean> {
		let clearedYjs = false;
		try {
			const dbs = await indexedDB.databases();
			const legacyDbs = ['obsidian-crdt-sync-db', 'loro-snapshot-store-db'];
			for (const dbName of legacyDbs) {
				if (dbs.some(db => db.name === dbName)) {
					console.log(`[LoroMigrationManager] Existing legacy IndexedDB (${dbName}) detected. Forcefully purging legacy cache...`);
					await new Promise<void>((resolve, reject) => {
						const req = indexedDB.deleteDatabase(dbName);
						req.onsuccess = () => resolve();
						req.onerror = () => reject(req.error);
					});
					clearedYjs = true;
					console.log(`[LoroMigrationManager] Legacy IndexedDB (${dbName}) successfully purged.`);
				}
			}
		} catch (e) {
			console.error('[LoroMigrationManager] Database detection/deletion failed:', e);
		}
		return clearedYjs;
	}
}
