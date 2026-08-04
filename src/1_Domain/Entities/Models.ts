import { EncryptedBlob } from '../ValueObjects/CryptoTypes';

export interface Note {
    path: string;
    content: string;
    mtime: number;
}

export interface CRDTSnapshot {
    path: string;
    encryptedState: EncryptedBlob;
    updatedAt: string;
}

export interface CRDTUpdate {
    id: number;
    path: string;
    encryptedUpdate: EncryptedBlob;
    createdAt: string;
}
