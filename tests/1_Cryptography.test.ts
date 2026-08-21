
import { describe, it, expect } from 'vitest';
import { WebCryptoService } from '../src/3_Infrastructure/Crypto/WebCryptoService';
import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';

describe('Cryptography & Data Pipeline', () => {
    const service = new WebCryptoService();

    it('Deterministic Key Derivation', async () => {
        const salt = service.generateSalt();
        const password = 'super-secure-password-123';
        
        // Derive key twice with same inputs
        const key1 = await service.deriveKey(password, salt);
        const key2 = await service.deriveKey(password, salt);
        
        const exported1 = await service.exportKey(key1);
        const exported2 = await service.exportKey(key2);
        
        expect(exported1).toEqual(exported2);
    });

    it('Deterministic Vault Alias ID Derivation and Isolation', async () => {
        const salt = service.generateSalt();
        const password1 = 'user-a-password';
        const password2 = 'user-b-password';

        const keyA1 = await service.deriveKey(password1, salt);
        const keyA2 = await service.deriveKey(password1, salt);
        const keyB = await service.deriveKey(password2, salt);

        const aliasA1 = await service.getVaultAliasId(keyA1);
        const aliasA2 = await service.getVaultAliasId(keyA2);
        const aliasB = await service.getVaultAliasId(keyB);

        expect(aliasA1).toEqual(aliasA2);
        expect(aliasA1).not.toEqual(aliasB);
        expect(aliasA1.length).toBe(64); // SHA-256 hex string length
    });

    it('Encryption/Decryption Symmetry', async () => {
        const salt = service.generateSalt();
        const key = await service.deriveKey('symmetry-test', salt);
        const originalData = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
        
        const encrypted = await service.encrypt(originalData, key);
        expect(encrypted.ciphertext).toBeDefined();
        expect(encrypted.iv).toBeDefined();

        const decrypted = await service.decrypt(encrypted, key);
        expect(decrypted).toEqual(originalData);
    });

    it('Tamper Resistance', async () => {
        const salt = service.generateSalt();
        const key = await service.deriveKey('tamper-test', salt);
        const data = strToU8('Sensitive Vault Content');
        
        const encrypted = await service.encrypt(data, key);
        
        // Mutate the ciphertext (change the last byte)
        const mutatedCiphertext = encrypted.ciphertext.substring(0, encrypted.ciphertext.length - 2) + '00';
        const tamperedBlob = { ...encrypted, ciphertext: mutatedCiphertext };
        
        // AES-GCM must throw an auth tag mismatch error, not silently return garbage
        await expect(service.decrypt(tamperedBlob, key)).rejects.toThrow();
    });

    it('Compression Integrity', () => {
        const testPayloads = [
            '', // Empty string
            'A'.repeat(5 * 1024 * 1024), // 5MB massive string
            'Hello 🌍, these are some complex unicode & emoji characters: 漢字 🚀'
        ];

        for (const payload of testPayloads) {
            const encoded = strToU8(payload);
            const compressed = gzipSync(encoded);
            
            // Validate size reduction for large payloads
            if (payload.length > 1000) {
                expect(compressed.length).toBeLessThan(encoded.length);
            }
            
            const decompressed = gunzipSync(compressed);
            const decoded = strFromU8(decompressed);
            
            expect(decoded).toEqual(payload);
        }
    });
});

