import Dexie, { Table } from 'dexie';
import { CryptoUtils } from '../Crypto/CryptoUtils';

export interface IDBDocumentSnapshot {
	documentId: string;
	stateHex: string;
}

export class LoroSnapshotStore extends Dexie {
	public snapshots!: Table<IDBDocumentSnapshot, string>;

	constructor() {
		super('loro-snapshot-store-db');
		this.version(1).stores({
			snapshots: 'documentId'
		});
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
