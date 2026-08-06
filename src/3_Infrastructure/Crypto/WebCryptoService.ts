import { ICryptography } from '../../1_Domain/Interfaces/ICryptography';
import { EncryptedBlob } from '../../1_Domain/ValueObjects/CryptoTypes';
import { CryptoUtils } from './CryptoUtils';

export class WebCryptoService implements ICryptography {
    public generateSalt(): string {
        const array = new Uint8Array(16);
        window.crypto.getRandomValues(array);
        return CryptoUtils.bufToHex(array);
    }

    public async deriveKey(password: string, salt: string): Promise<CryptoKey> {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw',
            enc.encode(password),
            { name: 'PBKDF2' },
            false,
            ['deriveBits', 'deriveKey']
        );

        const saltBuffer = CryptoUtils.hexToBuf(salt);

        return await window.crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: saltBuffer as any,
                iterations: 100000,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    public async encrypt(data: Uint8Array, key: CryptoKey): Promise<EncryptedBlob> {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const ciphertextBuffer = await window.crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: iv as any
            },
            key,
            data as any
        );

        return {
            ciphertext: CryptoUtils.bufToHex(new Uint8Array(ciphertextBuffer)),
            iv: CryptoUtils.bufToHex(iv)
        };
    }

    public async decrypt(blob: EncryptedBlob, key: CryptoKey): Promise<Uint8Array> {
        const ciphertext = CryptoUtils.hexToBuf(blob.ciphertext);
        const iv = CryptoUtils.hexToBuf(blob.iv);

        const decryptedBuffer = await window.crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: iv as any
            },
            key,
            ciphertext as any
        );

        return new Uint8Array(decryptedBuffer);
    }
}
