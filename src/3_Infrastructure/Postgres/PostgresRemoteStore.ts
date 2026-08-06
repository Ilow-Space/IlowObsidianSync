
import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { EncryptedBlob } from '@domain/ValueObjects/CryptoTypes';
import { CRDTUpdate } from '@domain/Entities/Models';
import { CryptoUtils } from '../Crypto/CryptoUtils';
import { requestUrl } from 'obsidian';

export class PostgresRemoteStore implements IRemoteStore {
    private serverUrl: string;
    private headers: Record<string, string>;

    constructor(serverUrl: string, headers: Record<string, string>) {
        this.serverUrl = serverUrl.replace(/\/$/, ''); // strip trailing slash
        this.headers = {
            'Content-Type': 'application/json',
            ...headers
        };
    }

    public async testConnection(): Promise<boolean> {
        try {
            const res = await requestUrl({
                url: `${this.serverUrl}/vault_snapshots?limit=1`,
                method: 'GET',
                headers: this.headers,
                throw: false
            });
            return res.status >= 200 && res.status < 300;
        } catch (err) {
            console.error('PostgresRemoteStore connection test failed:', err);
            return false;
        }
    }

    public async getLatestUpdateId(documentId: string): Promise<number> {
        try {
            const url = `${this.serverUrl}/vault_updates?document_id=eq.${encodeURIComponent(documentId)}&select=id&order=id.desc&limit=1`;
            const res = await requestUrl({
                url: url,
                method: 'GET',
                headers: this.headers,
                throw: false
            });

            if (res.status >= 200 && res.status < 300) {
                const data = res.json;
                if (Array.isArray(data) && data.length > 0) {
                    return data[0].id;
                }
            }
            return 0; // No updates exist
        } catch (err) {
            console.error(`getLatestUpdateId failed for ${documentId}:`, err);
            return 0;
        }
    }

    public async fetchSnapshot(documentId: string): Promise<EncryptedBlob | null> {
    try {
        const url = `${this.serverUrl}/vault_snapshots?document_id=eq.${encodeURIComponent(documentId)}`;
        const res = await requestUrl({
            url: url,
            method: 'GET',
            headers: this.headers,
            throw: false // ⚡ Changed from throw to throw
        });

        if (res.status === 404) return null;
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Failed to fetch snapshot: ${res.status}`);
        }

        const data = res.json;
        if (Array.isArray(data) && data.length > 0) {
            const row = data[0];
            if (!row.encrypted_state) return null;

            const rawJson = CryptoUtils.hexToString(row.encrypted_state);
            return JSON.parse(rawJson) as EncryptedBlob;
        }
        return null;
    } catch (err) {
        console.error(`fetchSnapshot failed for ${documentId}:`, err);
        return null; // Gracefully return null on network disconnect/failure
    }
}

    public async fetchUpdatesSince(documentId: string, lastId: number): Promise<CRDTUpdate[]> {
        let allUpdates: CRDTUpdate[] = [];
        let offset = 0;
        const limit = 500;

        try {
            while (true) {
                const url = `${this.serverUrl}/vault_updates?document_id=eq.${encodeURIComponent(documentId)}&id=gt.${lastId}&order=id.asc`;
                const res = await requestUrl({
                    url: url,
                    method: 'GET',
                    headers: {
                        ...this.headers,
                        'Range-Unit': 'items',
                        'Range': `${offset}-${offset + limit - 1}`
                    },
                    throw: false
                });

                if (res.status < 200 || res.status >= 300) {
                    throw new Error(`Failed to fetch updates: ${res.status}`);
                }

                const data = res.json;
                if (Array.isArray(data)) {
                    const parsed = data.map((row: any) => {
                        const rawJson = CryptoUtils.hexToString(row.encrypted_update);
                        const blob = JSON.parse(rawJson) as EncryptedBlob;
                        return {
                            id: row.id,
                            documentId: row.document_id,
                            encryptedUpdate: blob,
                            createdAt: row.created_at
                        };
                    });
                    allUpdates = allUpdates.concat(parsed);

                    if (data.length < limit) {
                        break;
                    }
                    offset += limit;
                } else {
                    break;
                }
            }
            return allUpdates;
        } catch (err) {
            console.error(`fetchUpdatesSince failed for ${documentId}:`, err);
            return [];
        }
    }

    public async pushUpdate(documentId: string, update: EncryptedBlob): Promise<void> {
        try {
            const snapshotCheckUrl = `${this.serverUrl}/vault_snapshots?document_id=eq.${encodeURIComponent(documentId)}`;
            const snapshotCheckRes = await requestUrl({
                url: snapshotCheckUrl,
                method: 'GET',
                headers: this.headers,
                throw: false
            });

            const snapshotExists = snapshotCheckRes.status >= 200 && snapshotCheckRes.status < 300 && Array.isArray(snapshotCheckRes.json) && snapshotCheckRes.json.length > 0;
            if (!snapshotExists) {
                const initialSnapshotBytes = CryptoUtils.stringToHex(JSON.stringify({ ciphertext: '', iv: '' }));
                await requestUrl({
                    url: `${this.serverUrl}/vault_snapshots`,
                    method: 'POST',
                    headers: {
                        ...this.headers,
                        'Prefer': 'resolution=ignore-duplicates'
                    },
                    body: JSON.stringify({
                        document_id: documentId,
                        encrypted_state: initialSnapshotBytes,
                        updated_at: new Date().toISOString()
                    }),
                    throw: false
                });
            }

            const updateBytes = CryptoUtils.stringToHex(JSON.stringify(update));
            const res = await requestUrl({
                url: `${this.serverUrl}/vault_updates`,
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify({
                    document_id: documentId,
                    encrypted_update: updateBytes,
                    created_at: new Date().toISOString()
                }),
                throw: false
            });

            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Failed to push update: ${res.status}. Details: ${res.text}`);
            }
        } catch (err) {
            console.error(`pushUpdate failed for ${documentId}:`, err);
            throw err;
        }
    }

    public async compactSnapshot(documentId: string, newState: EncryptedBlob, maxId: number, isDeleted: boolean = false): Promise<void> {
        try {
            const stateBytes = CryptoUtils.stringToHex(JSON.stringify(newState));
            const url = `${this.serverUrl}/rpc/compact_document`;
            const res = await requestUrl({
                url: url,
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify({
                    p_document_id: documentId,
                    p_state: stateBytes,
                    p_max_id: maxId,
                    p_is_deleted: isDeleted
                }),
                throw: false
            });

            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Failed to compact snapshot: ${res.status}. Details: ${res.text}`);
            }
        } catch (err) {
            console.error(`compactSnapshot failed for ${documentId}:`, err);
            throw err;
        }
    }
}
