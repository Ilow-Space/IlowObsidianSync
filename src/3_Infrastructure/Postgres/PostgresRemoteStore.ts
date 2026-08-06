import { IRemoteStore } from '@domain/Interfaces/IRemoteStore';
import { EncryptedBlob } from '@domain/ValueObjects/CryptoTypes';
import { CRDTUpdate } from '@domain/Entities/Models';
import { CryptoUtils } from '../Crypto/CryptoUtils';

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
            const res = await fetch(`${this.serverUrl}/vault_snapshots?limit=1`, {
                method: 'GET',
                headers: this.headers
            });
            return res.ok;
        } catch (err) {
            console.error('PostgresRemoteStore connection test failed:', err);
            return false;
        }
    }

    public async fetchSnapshot(path: string): Promise<EncryptedBlob | null> {
        try {
            const url = `${this.serverUrl}/vault_snapshots?path=eq.${encodeURIComponent(path)}`;
            const res = await fetch(url, {
                method: 'GET',
                headers: this.headers
            });

            if (!res.ok) {
                if (res.status === 404) return null;
                throw new Error(`Failed to fetch snapshot: ${res.statusText}`);
            }

            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                const row = data[0];
                if (!row.encrypted_state) return null;

                const rawJson = CryptoUtils.hexToString(row.encrypted_state);
                const blob = JSON.parse(rawJson) as EncryptedBlob;
                return blob;
            }
            return null;
        } catch (err) {
            console.error(`fetchSnapshot failed for ${path}:`, err);
            return null;
        }
    }

    public async fetchUpdatesSince(path: string, lastId: number): Promise<CRDTUpdate[]> {
        try {
            const url = `${this.serverUrl}/vault_updates?path=eq.${encodeURIComponent(path)}&id=gt.${lastId}&order=id.asc`;
            const res = await fetch(url, {
                method: 'GET',
                headers: this.headers
            });

            if (!res.ok) {
                throw new Error(`Failed to fetch updates: ${res.statusText}`);
            }

            const data = await res.json();
            if (Array.isArray(data)) {
                return data.map((row: any) => {
                    const rawJson = CryptoUtils.hexToString(row.encrypted_update);
                    const blob = JSON.parse(rawJson) as EncryptedBlob;
                    return {
                        id: row.id,
                        path: row.path,
                        encryptedUpdate: blob,
                        createdAt: row.created_at
                    };
                });
            }
            return [];
        } catch (err) {
            console.error(`fetchUpdatesSince failed for ${path}:`, err);
            return [];
        }
    }

    public async pushUpdate(path: string, update: EncryptedBlob): Promise<void> {
        try {
            const snapshotCheckUrl = `${this.serverUrl}/vault_snapshots?path=eq.${encodeURIComponent(path)}`;
            const snapshotCheckRes = await fetch(snapshotCheckUrl, {
                method: 'GET',
                headers: this.headers
            });

            const snapshotExists = snapshotCheckRes.ok && (await snapshotCheckRes.json()).length > 0;
            if (!snapshotExists) {
                const initialSnapshotBytes = CryptoUtils.stringToHex(JSON.stringify({ ciphertext: '', iv: '' }));
                await fetch(`${this.serverUrl}/vault_snapshots`, {
                    method: 'POST',
                    headers: {
                        ...this.headers,
                        'Prefer': 'resolution=ignore-duplicates'
                    },
                    body: JSON.stringify({
                        path: path,
                        encrypted_state: initialSnapshotBytes,
                        updated_at: new Date().toISOString()
                    })
                });
            }

            const updateBytes = CryptoUtils.stringToHex(JSON.stringify(update));
            const res = await fetch(`${this.serverUrl}/vault_updates`, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify({
                    path: path,
                    encrypted_update: updateBytes,
                    created_at: new Date().toISOString()
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Failed to push update: ${res.statusText}. Details: ${errText}`);
            }
        } catch (err) {
            console.error(`pushUpdate failed for ${path}:`, err);
            throw err;
        }
    }

    public async compactSnapshot(path: string, newState: EncryptedBlob, maxId: number): Promise<void> {
        try {
            const stateBytes = CryptoUtils.stringToHex(JSON.stringify(newState));
            const url = `${this.serverUrl}/rpc/compact_document`;
            const res = await fetch(url, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify({
                    p_path: path,
                    p_state: stateBytes,
                    p_max_id: maxId
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Failed to compact snapshot: ${res.statusText}. Details: ${errText}`);
            }
        } catch (err) {
            console.error(`compactSnapshot failed for ${path}:`, err);
            throw err;
        }
    }
}
