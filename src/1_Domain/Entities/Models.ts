
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
    isFolder?: boolean;
}

export interface VFSNode {
    type: 'file' | 'folder';
    parentId: string; // "root" or uuid of parent folder node
    metadata: string; // Represents filename or foldername
    isDeleted: boolean;
}

