
import { EncryptedBlob } from '../ValueObjects/CryptoTypes';
import { CRDTUpdate } from '../Entities/Models';

export interface IRemoteStore {
    getLatestUpdateId(documentId: string): Promise<number>;
    fetchSnapshot(documentId: string): Promise<EncryptedBlob | null>;
    fetchUpdatesSince(documentId: string, lastId: number): Promise<CRDTUpdate[]>;
    pushUpdate(documentId: string, update: EncryptedBlob): Promise<void>;
    compactSnapshot(documentId: string, newState: EncryptedBlob, maxId: number, isDeleted?: boolean): Promise<void>;
    testConnection(): Promise<boolean>;
    
    // Realtime WebSocket support
    connectWebSocket(wssUrl: string): void;
    subscribeToUpdates(documentId: string, onUpdateDetected: () => void): () => void;
    disconnect(): void;
}


