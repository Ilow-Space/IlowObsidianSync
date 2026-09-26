import { EncryptedBlob } from '../ValueObjects/CryptoTypes';
import { CRDTUpdate } from '../Entities/Models';

export interface RemoteManifestItem {
    document_id: string;
    encrypted_path?: string;
    is_deleted: boolean;
    updated_at: string;
}

export interface ServerTelemetry {
    rps: number;
    rpmAvgHour: number;
    dataTransferredBytes: number;
    activeWebSockets: number;
    uptimeSeconds: number;
    memoryAllocMb: number;
    dbConnections: number;
    systemHealth: 'healthy' | 'degraded' | 'critical';
    gcReclaimedBytes?: number;
}

export interface SnapshotDetails {
    encryptedState: EncryptedBlob | null;
    maxCompactedId: number;
    isDeleted: boolean;
}

export interface IRemoteStore {
    getLatestUpdateId(documentId: string): Promise<number>;
    /**
     * Highest update id per document, or null when the request did not succeed.
     * Null means "unknown" and must not be read as "no document has updates".
     */
    getBulkLatestUpdateIds(): Promise<Record<string, number> | null>;
    fetchSnapshot(documentId: string): Promise<EncryptedBlob | null>;
    fetchSnapshotDetails(documentId: string): Promise<SnapshotDetails | null>;
    fetchUpdatesSince(documentId: string, lastId: number): Promise<CRDTUpdate[]>;
    pushUpdate(documentId: string, update: EncryptedBlob, encryptedPath?: EncryptedBlob | null): Promise<void>;
    compactSnapshot(documentId: string, newState: EncryptedBlob, maxId: number, isDeleted: boolean, encryptedPath?: EncryptedBlob | null): Promise<void>;
    fetchManifest(): Promise<RemoteManifestItem[]>;
    uploadBlobManifest(hashes: string[]): Promise<void>;
    deleteSnapshot(documentId: string): Promise<void>;
    truncateServer(adminToken: string): Promise<void>;
    testConnection(): Promise<boolean>;
    /** Opens a real socket to prove the WebSocket upgrade itself succeeds -- testConnection's REST check does not exercise the server's Origin gate on that handshake. */
    testWebSocketConnection(): Promise<boolean>;
    fetchTelemetry(): Promise<ServerTelemetry | null>;
    uploadBlob(hash: string, encryptedData: Uint8Array): Promise<void>;
    downloadBlob(hash: string): Promise<Uint8Array | null>;
    
    connectWebSocket(wssUrl: string): void;
    subscribeToUpdates(documentId: string, onUpdateDetected: (docId?: string, action?: string) => void): () => void;
    disconnect(): void;

    /**
     * Fired every time the socket (re)connects, with the server's current global
     * update watermark. There is no periodic re-sync elsewhere, so this is the
     * only signal a client gets that it may have missed updates while offline --
     * the handler should trigger a reconciliation sweep rather than compare the
     * number itself, since a global watermark can't be mapped to any one document.
     */
    onServerVersion?: (latestId: number) => void;
    /** The most recent value delivered via onServerVersion, or null before the first connect. */
    getLastKnownVersion(): number | null;
}