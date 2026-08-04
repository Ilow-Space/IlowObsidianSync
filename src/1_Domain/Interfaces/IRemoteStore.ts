import { EncryptedBlob } from '../ValueObjects/CryptoTypes';
import { CRDTUpdate } from '../Entities/Models';

export interface IRemoteStore {
    fetchSnapshot(path: string): Promise<EncryptedBlob | null>;
    fetchUpdatesSince(path: string, lastId: number): Promise<CRDTUpdate[]>;
    pushUpdate(path: string, update: EncryptedBlob): Promise<void>;
    compactSnapshot(path: string, newState: EncryptedBlob, maxId: number): Promise<void>;
    testConnection(): Promise<boolean>;
}
