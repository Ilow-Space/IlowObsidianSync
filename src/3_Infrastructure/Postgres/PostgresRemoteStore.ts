
import { IRemoteStore, RemoteManifestItem } from '@domain/Interfaces/IRemoteStore';
import { EncryptedBlob } from '@domain/ValueObjects/CryptoTypes';
import { CRDTUpdate } from '@domain/Entities/Models';
import { CryptoUtils } from '../Crypto/CryptoUtils';
import { requestUrl } from 'obsidian';

export class PostgresRemoteStore implements IRemoteStore {
    private serverUrl: string;
    private headers: Record<string, string>;
    private socket: WebSocket | null = null;
    private subscriptions = new Map<string, Array<() => void>>();

    constructor(serverUrl: string, headers: Record<string, string>) {
        this.serverUrl = serverUrl.replace(/\/$/, ''); // strip trailing slash
        this.headers = {
            'Content-Type': 'application/json',
            ...headers
        };
    }

    public connectWebSocket(wssUrl: string) {
        try {
            this.socket = new WebSocket(wssUrl);

            // Flush all pending subscriptions to Go as soon as the connection opens
            this.socket.onopen = () => {
                for (const documentId of this.subscriptions.keys()) {
                    this.socket?.send(JSON.stringify({
                        action: 'subscribe',
                        filter: `document_id=eq.${documentId}`
                    }));
                }
            };

            this.socket.onmessage = (event) => {
                try {
                    const payload = JSON.parse(event.data);

                    // Listen for INSERT/DELETE events
                    if (payload.type === 'INSERT' && payload.table === 'vault_updates') {
                        const docId = payload.record.document_id;
                        const callbacks = this.subscriptions.get(docId);
                        if (callbacks) {
                            callbacks.forEach(cb => cb());
                        }
                    } else if (payload.type === 'DELETE' && payload.table === 'vault_snapshots') {
                        const docId = payload.record.document_id;
                        const callbacks = this.subscriptions.get(docId);
                        if (callbacks) {
                            callbacks.forEach(cb => cb());
                        }
                    }
                } catch (err) {
                    // Ignore parsing errors for non-JSON messages
                }
            };

            this.socket.onerror = (err) => {
                console.error('Postgres realtime WebSocket error:', err);
            };
        } catch (err) {
            console.error('Failed to establish realtime WebSocket connection:', err);
        }
    }

    public subscribeToUpdates(documentId: string, onUpdateDetected: () => void): () => void {
        if (!this.subscriptions.has(documentId)) {
            this.subscriptions.set(documentId, []);
        }

        this.subscriptions.get(documentId)!.push(onUpdateDetected);

        // Send subscription payload immediately if socket is already open
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ action: 'subscribe', filter: `document_id=eq.${documentId}` }));
        }

        // Return unsubscribe function
        return () => {
            const callbacks = this.subscriptions.get(documentId);
            if (callbacks) {
                const remaining = callbacks.filter(cb => cb !== onUpdateDetected);
                if (remaining.length === 0) {
                    this.subscriptions.delete(documentId);
                } else {
                    this.subscriptions.set(documentId, remaining);
                }
            }
        };
    }

    public disconnect() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.subscriptions.clear();
    }

    public async testConnection(): Promise<boolean> {
        try {
            const res = await requestUrl({
                url: `${this.serverUrl}/api/vault/manifest`,
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
            const url = `${this.serverUrl}/api/snapshots/${encodeURIComponent(documentId)}/latest_id`;
            const res = await requestUrl({
                url: url,
                method: 'GET',
                headers: this.headers,
                throw: false
            });

            if (res.status >= 200 && res.status < 300) {
                return res.json.id || 0;
            }
            return 0; // No updates exist
        } catch (err) {
            console.error(`getLatestUpdateId failed for ${documentId}:`, err);
            return 0;
        }
    }

    public async fetchSnapshot(documentId: string): Promise<EncryptedBlob | null> {
        try {
            const url = `${this.serverUrl}/api/snapshots/${encodeURIComponent(documentId)}`;
            const res = await requestUrl({
                url: url,
                method: 'GET',
                headers: this.headers,
                throw: false
            });

            if (res.status === 404) return null;
            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Failed to fetch snapshot: ${res.status}`);
            }

            const data = res.json;
            if (Array.isArray(data) && data.length > 0) {
                const row = data[0];
                if (row.is_deleted) return null;
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
        try {
            const url = `${this.serverUrl}/api/snapshots/${encodeURIComponent(documentId)}/updates?since=${lastId}`;
            const res = await requestUrl({
                url: url,
                method: 'GET',
                headers: this.headers,
                throw: false
            });

            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Failed to fetch updates: ${res.status}`);
            }

            const data = res.json;
            if (Array.isArray(data)) {
                return data.map((row: any) => {
                    const rawJson = CryptoUtils.hexToString(row.encrypted_update);
                    const blob = JSON.parse(rawJson) as EncryptedBlob;
                    return {
                        id: row.id,
                        documentId: row.document_id,
                        encryptedUpdate: blob,
                        createdAt: row.created_at
                    };
                });
            }
            return [];
        } catch (err) {
            console.error(`fetchUpdatesSince failed for ${documentId}:`, err);
            return [];
        }
    }

    public async pushUpdate(documentId: string, update: EncryptedBlob, encryptedPath?: EncryptedBlob | null): Promise<void> {
        try {
            const updateBytes = CryptoUtils.stringToHex(JSON.stringify(update));
            const pathBytes = encryptedPath ? CryptoUtils.stringToHex(JSON.stringify(encryptedPath)) : undefined;

            const res = await requestUrl({
                url: `${this.serverUrl}/api/updates`,
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify({
                    document_id: documentId,
                    encrypted_update: updateBytes,
                    encrypted_path: pathBytes
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

    public async compactSnapshot(
        documentId: string,
        newState: EncryptedBlob,
        maxId: number,
        isDeleted: boolean = false,
        encryptedPath?: EncryptedBlob | null
    ): Promise<void> {
        try {
            const stateBytes = CryptoUtils.stringToHex(JSON.stringify(newState));
            const pathBytes = encryptedPath ? CryptoUtils.stringToHex(JSON.stringify(encryptedPath)) : undefined;

            const url = `${this.serverUrl}/api/snapshots/${encodeURIComponent(documentId)}/compact`;
            const res = await requestUrl({
                url: url,
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify({
                    p_state: stateBytes,
                    p_max_id: maxId,
                    p_is_deleted: isDeleted,
                    p_encrypted_path: pathBytes
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

    public async fetchManifest(): Promise<RemoteManifestItem[]> {
        try {
            const url = `${this.serverUrl}/api/vault/manifest`;
            const res = await requestUrl({
                url: url,
                method: 'GET',
                headers: this.headers,
                throw: false
            });

            if (res.status >= 200 && res.status < 300) {
                return res.json as RemoteManifestItem[];
            }
            throw new Error(`Manifest fetch failed with status: ${res.status}`);
        } catch (err) {
            console.error('fetchManifest failed:', err);
            return [];
        }
    }

    public async deleteSnapshot(documentId: string): Promise<void> {
        try {
            const url = `${this.serverUrl}/api/snapshots/${encodeURIComponent(documentId)}`;
            const res = await requestUrl({
                url: url,
                method: 'DELETE',
                headers: this.headers,
                throw: false
            });

            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Failed to delete snapshot remote: ${res.status}`);
            }
        } catch (err) {
            console.error(`deleteSnapshot failed for ${documentId}:`, err);
            throw err;
        }
    }

    public async truncateServer(adminToken: string): Promise<void> {
        try {
            const url = `${this.serverUrl}/api/admin/truncate`;
            const res = await requestUrl({
                url: url,
                method: 'POST',
                headers: {
                    ...this.headers,
                    'Authorization': `Bearer ${adminToken}`
                },
                throw: false
            });

            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Truncate server failed: ${res.status}. Details: ${res.text}`);
            }
        } catch (err) {
            console.error('truncateServer failed:', err);
            throw err;
        }
    }
}
