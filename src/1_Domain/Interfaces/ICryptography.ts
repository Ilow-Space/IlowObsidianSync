import { EncryptedBlob } from '../ValueObjects/CryptoTypes';

export interface ICryptography {
    deriveKey(password: string, salt: string): Promise<CryptoKey>;
    getVaultAliasId(key: CryptoKey): Promise<string>;
    generateSalt(): string;
    encrypt(data: Uint8Array, key: CryptoKey): Promise<EncryptedBlob>;
    decrypt(blob: EncryptedBlob, key: CryptoKey): Promise<Uint8Array>;
    exportKey(key: CryptoKey): Promise<string>;
    importKey(keyData: string): Promise<CryptoKey>;
    hashData(data: Uint8Array): Promise<string>;
}