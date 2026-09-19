import Dexie, { Table } from 'dexie';
import { CryptoUtils } from '../Crypto/CryptoUtils';

export interface IDBDocumentSnapshot {
	documentId: string;
	stateHex: string;
}

/**
 * A document whose last push to the server did not complete. Loro deltas are
 * causally chained, so a lost delta leaves every later delta unappliable on the
 * server: the recovery is to resend the document's whole state, not the lost
 * bytes. This table is what makes that survive a restart.
 */
export interface IDBOutboxEntry {
	documentId: string;
	path: string | null;
	failedAt: number;
}

export class LoroSnapshotStore extends Dexie {
	public snapshots!: Table<IDBDocumentSnapshot, string>;
	public outbox!: Table<IDBOutboxEntry, string>;

	constructor() {
		super('ilow-snapshot-store-db');
		this.version(1).stores({
			snapshots: 'documentId'
		});
		this.version(2).stores({
			snapshots: 'documentId',
			outbox: 'documentId'
		});
	}

	public async markUnacked(documentId: string, path: string | null): Promise<void> {
		await this.outbox.put({ documentId, path, failedAt: Date.now() });
	}

	public async clearUnacked(documentId: string): Promise<void> {
		await this.outbox.delete(documentId);
	}

	public async listUnacked(): Promise<IDBOutboxEntry[]> {
		return await this.outbox.toArray();
	}

	public async saveDocumentState(documentId: string, stateVector: Uint8Array): Promise<void> {
		const hex = CryptoUtils.bufToHex(stateVector);
		await this.snapshots.put({ documentId, stateHex: hex });
	}

	public async loadDocumentState(documentId: string): Promise<Uint8Array | null> {
		const row = await this.snapshots.get(documentId);
		if (row && row.stateHex) {
			return CryptoUtils.hexToBuf(row.stateHex);
		}
		return null;
	}

	public async deleteDocumentState(documentId: string): Promise<void> {
		await this.snapshots.delete(documentId);
	}

	public async clearAll(): Promise<void> {
		await this.snapshots.clear();
	}
}
