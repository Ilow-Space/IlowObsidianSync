import { IRemoteStore, RemoteManifestItem, ServerTelemetry } from '@domain/Interfaces/IRemoteStore';
import { EncryptedBlob } from '@domain/ValueObjects/CryptoTypes';
import { CRDTUpdate } from '@domain/Entities/Models';
import { CryptoUtils } from '../Crypto/CryptoUtils';
import { requestUrl } from 'obsidian';

export class PostgresRemoteStore implements IRemoteStore {
	private serverUrl: string;
	private apiKey: string;
	private headers: Record<string, string>;
	private vaultAliasId: string = '';
	private socket: WebSocket | null = null;
	private subscriptions = new Map<string, Array<(docId?: string, action?: string) => void>>();

	constructor(serverUrl: string, apiKey: string, customHeaders: Record<string, string> = {}) {
		this.serverUrl = serverUrl.replace(/\/$/, '');
		this.apiKey = apiKey;
		this.headers = {
			'Content-Type': 'application/json',
			'X-API-Key': apiKey, // Injected for REST HTTP requests
			...customHeaders
		};
	}

	public setApiKey(apiKey: string) {
		this.apiKey = apiKey;
		this.headers['X-API-Key'] = apiKey;
		if (this.socket) {
			this.disconnect();
			this.connectWebSocket(this.serverUrl.replace(/^http/i, 'ws'));
		}
	}

	public setVaultAliasId(vaultAliasId: string) {
		const changed = this.vaultAliasId !== vaultAliasId;
		this.vaultAliasId = vaultAliasId;
		if (vaultAliasId) {
			this.headers['X-Vault-Alias-ID'] = vaultAliasId;
		} else {
			delete this.headers['X-Vault-Alias-ID'];
		}
		if (changed && this.socket) {
			this.disconnect();
			if (vaultAliasId) this.connectWebSocket(this.serverUrl.replace(/^http/i, 'ws'));
		}
	}

	public async getBulkLatestUpdateIds(): Promise<Record<string, number>> {
		try {
			const url = `${this.serverUrl}/api/vault/latest_ids`;
			const res = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.headers,
				throw: false
			});

			if (res.status >= 200 && res.status < 300) {
				return res.json || {};
			}
			return {};
		} catch (err) {
			return {};
		}
	}

	public connectWebSocket(wssUrl: string) {
		try {
			const socketUrl = new URL(wssUrl);

			// Pass API key via query parameter to satisfy Nginx $arg_api_key validation
			if (this.apiKey) {
				socketUrl.searchParams.set('api_key', this.apiKey);
			}

			if (this.vaultAliasId) {
				socketUrl.searchParams.set('vault_alias_id', this.vaultAliasId);
			}

			this.socket = new WebSocket(socketUrl.toString());

			this.socket.onopen = () => {
				const keys = Array.from(this.subscriptions.keys());
				if (keys.length > 0) {
					const filters = keys.map(docId => `document_id=eq.${docId}`);
					this.socket?.send(JSON.stringify({
						action: 'subscribe_bulk',
						filters,
						vault_alias_id: this.vaultAliasId
					}));
				}
			};

			this.socket.onmessage = (event) => {
				try {
					const payload = JSON.parse(event.data);
					if (payload.record && payload.record.vault_alias_id && payload.record.vault_alias_id !== this.vaultAliasId) {
						return; // Discard misrouted cross-tenant updates
					}

					const action = payload.type === 'DELETE' ? 'delete' : 'insert';

					if (payload.type === 'INSERT' && payload.table === 'vault_updates') {
						const docId = payload.record.document_id;
						const callbacks = this.subscriptions.get(docId);
						if (callbacks) {
							callbacks.forEach(cb => cb(docId, action));
						}
						const manifestCallbacks = this.subscriptions.get('manifest');
						if (manifestCallbacks) {
							manifestCallbacks.forEach(cb => cb(docId, action));
						}
					} else if (payload.type === 'DELETE' && payload.table === 'vault_snapshots') {
						const docId = payload.record.document_id;
						const callbacks = this.subscriptions.get(docId);
						if (callbacks) {
							callbacks.forEach(cb => cb(docId, action));
						}
						const manifestCallbacks = this.subscriptions.get('manifest');
						if (manifestCallbacks) {
							manifestCallbacks.forEach(cb => cb(docId, action));
						}
					}
				} catch (err) {}
			};

			this.socket.onerror = (err) => {
				console.warn('Postgres realtime WebSocket error:', err);
			};

			this.socket.onclose = () => {
				if (this.socket === null) return;
				setTimeout(() => {
					this.connectWebSocket(wssUrl);
				}, 3000);
			};
		} catch (err) {
			console.warn('Failed to establish realtime WebSocket connection:', err);
		}
	}

	public subscribeToUpdates(documentId: string, onUpdateDetected: (docId?: string, action?: string) => void): () => void {
		if (!this.subscriptions.has(documentId)) {
			this.subscriptions.set(documentId, []);
		}

        this.subscriptions.get(documentId)!.push(onUpdateDetected);

        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        	this.socket.send(JSON.stringify({
        		action: 'subscribe',
        		filter: `document_id=eq.${documentId}`,
        		vault_alias_id: this.vaultAliasId
        	}));
        }

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
			const temp = this.socket;
			this.socket = null;
			temp.onclose = null;
			temp.close();
		}
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
			return false;
		}
	}

	public async fetchTelemetry(): Promise<ServerTelemetry | null> {
		try {
			const res = await requestUrl({
				url: `${this.serverUrl}/api/telemetry`,
				method: 'GET',
				headers: this.headers,
				throw: false
			});

			if (res.status >= 200 && res.status < 300) {
				return res.json as ServerTelemetry;
			}
			return null;
		} catch (err) {
			return null;
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
			return 0;
		} catch (err) {
			throw err;
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
			throw err;
		}
	}

	public async fetchSnapshotDetails(documentId: string): Promise<{ encryptedState: EncryptedBlob | null; maxCompactedId: number; isDeleted: boolean } | null> {
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
				throw new Error(`Failed to fetch snapshot details: ${res.status}`);
			}

			const data = res.json;
			if (Array.isArray(data) && data.length > 0) {
				const row = data[0];
				let encStateBlob: EncryptedBlob | null = null;
				if (row.encrypted_state) {
					const rawJson = CryptoUtils.hexToString(row.encrypted_state);
					encStateBlob = JSON.parse(rawJson) as EncryptedBlob;
				}
				return {
					encryptedState: encStateBlob,
					maxCompactedId: row.max_compacted_id || 0,
					isDeleted: !!row.is_deleted
				};
			}
			return null;
		} catch (err) {
			throw err;
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
			throw err;
		}
	}

	public async pushUpdate(documentId: string, update: EncryptedBlob, encryptedPath?: EncryptedBlob | null): Promise<void> {
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
	}

	public async compactSnapshot(
		documentId: string,
		newState: EncryptedBlob,
		maxId: number,
		isDeleted: boolean = false,
		encryptedPath?: EncryptedBlob | null
	): Promise<void> {
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
	}

	public async uploadBlobManifest(hashes: string[]): Promise<void> {
		const url = `${this.serverUrl}/api/blobs/manifest`;
		const res = await requestUrl({
			url: url,
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify({
				active_hashes: hashes
			}),
			throw: false
		});

		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Failed to upload blob manifest: ${res.status}. Details: ${res.text}`);
		}
	}
	
	public async fetchManifest(): Promise<RemoteManifestItem[]> {
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
	}

	public async deleteSnapshot(documentId: string): Promise<void> {
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
	}

	public async truncateServer(adminToken: string): Promise<void> {
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
	}
}