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
}

export interface IRemoteStore {
    getLatestUpdateId(documentId: string): Promise<number>;
    getBulkLatestUpdateIds(): Promise<Record<string, number>>; // NEW BULK METHOD
    fetchSnapshot(documentId: string): Promise<EncryptedBlob | null>;
    fetchUpdatesSince(documentId: string, lastId: number): Promise<CRDTUpdate[]>;
    pushUpdate(documentId: string, update: EncryptedBlob, encryptedPath?: EncryptedBlob | null): Promise<void>;
    compactSnapshot(documentId: string, newState: EncryptedBlob, maxId: number, isDeleted: boolean, encryptedPath?: EncryptedBlob | null): Promise<void>;
    fetchManifest(): Promise<RemoteManifestItem[]>;
    deleteSnapshot(documentId: string): Promise<void>;
    truncateServer(adminToken: string): Promise<void>;
    testConnection(): Promise<boolean>;
    fetchTelemetry(): Promise<ServerTelemetry | null>;
    
    connectWebSocket(wssUrl: string): void;
    subscribeToUpdates(documentId: string, onUpdateDetected: (docId?: string, action?: string) => void): () => void;
    disconnect(): void;
}