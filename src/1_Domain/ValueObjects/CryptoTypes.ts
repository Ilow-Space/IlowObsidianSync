export interface EncryptedBlob {
    ciphertext: string; // Hex encoded AES-GCM ciphertext
    iv: string;         // Hex encoded 12-byte IV
}

export interface DbCredentials {
    serverUrl: string;
    headers: Record<string, string>;
    salt: string;
}

export interface MasterKey {
    rawKey: CryptoKey;
    hexKey: string;
}
