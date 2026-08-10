import { EncryptedBlob } from '../ValueObjects/CryptoTypes';
import { CRDTUpdate } from '../Entities/Models';

export interface RemoteManifestItem {
    document_id: string;
    encrypted_path?: string; // hex string prefixed with \x
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
}

export interface IRemoteStore {
    getLatestUpdateId(documentId: string): Promise<number>;
    fetchSnapshot(documentId: string): Promise<EncryptedBlob | null>;
    fetchUpdatesSince(documentId: string, lastId: number): Promise<CRDTUpdate[]>;
    pushUpdate(documentId: string, update: EncryptedBlob, encryptedPath?: EncryptedBlob | null): Promise<void>;
    compactSnapshot(documentId: string, newState: EncryptedBlob, maxId: number, isDeleted: boolean, encryptedPath?: EncryptedBlob | null): Promise<void>;
    fetchManifest(): Promise<RemoteManifestItem[]>;
    deleteSnapshot(documentId: string): Promise<void>;
    truncateServer(adminToken: string): Promise<void>;
    testConnection(): Promise<boolean>;
    fetchTelemetry(): Promise<ServerTelemetry | null>;
    
    // Realtime WebSocket support
    connectWebSocket(wssUrl: string): void;
    subscribeToUpdates(documentId: string, onUpdateDetected: () => void): () => void;
    disconnect(): void;
}