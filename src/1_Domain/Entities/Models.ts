import { EncryptedBlob } from '../ValueObjects/CryptoTypes';

export interface Note {
    path: string;
    content: string;
    mtime: number;
}

export interface CRDTSnapshot {
    documentId: string;
    encryptedState: EncryptedBlob;
    updatedAt: string;
    isDeleted: boolean;
}

export interface CRDTUpdate {
    id: number;
    documentId: string;
    encryptedUpdate: EncryptedBlob;
    createdAt: string;
}

export interface DocumentMetadata {
    path: string;
    isDeleted: boolean;
    mtime: number;
}

