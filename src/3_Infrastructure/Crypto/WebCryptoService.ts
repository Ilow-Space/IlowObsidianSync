import { ICryptography } from '../../1_Domain/Interfaces/ICryptography';
import { EncryptedBlob } from '../../1_Domain/ValueObjects/CryptoTypes';
import { CryptoUtils } from './CryptoUtils';

export class WebCryptoService implements ICryptography {
	private static derivedKeyCache = new Map<string, CryptoKey>();
	private static aliasIdCache = new WeakMap<CryptoKey, string>();

	public generateSalt(): string {
		const array = new Uint8Array(16);
		window.crypto.getRandomValues(array);
		return CryptoUtils.bufToHex(array);
	}

	public async getVaultAliasId(key: CryptoKey): Promise<string> {
		if (WebCryptoService.aliasIdCache.has(key)) {
			return WebCryptoService.aliasIdCache.get(key)!;
		}
		const rawKeyBuffer = await window.crypto.subtle.exportKey('raw', key);
		const hashBuffer = await window.crypto.subtle.digest('SHA-256', rawKeyBuffer);
		const aliasId = CryptoUtils.bufToHex(new Uint8Array(hashBuffer));
		WebCryptoService.aliasIdCache.set(key, aliasId);
		return aliasId;
	}

	public async deriveKey(password: string, salt: string): Promise<CryptoKey> {
		const cacheKey = `${password}:${salt}`;
		if (WebCryptoService.derivedKeyCache.has(cacheKey)) {
			return WebCryptoService.derivedKeyCache.get(cacheKey)!;
		}

		try {
			const cachedJwk = window.sessionStorage?.getItem(`ilow-key-${cacheKey}`);
			if (cachedJwk) {
				const key = await this.importKey(cachedJwk);
				WebCryptoService.derivedKeyCache.set(cacheKey, key);
				return key;
			}
		} catch (e) {}

		const enc = new TextEncoder();
		const keyMaterial = await window.crypto.subtle.importKey(
			'raw',
			enc.encode(password),
			{ name: 'PBKDF2' },
			false,
			['deriveBits', 'deriveKey']
		);

		const saltBuffer = CryptoUtils.hexToBuf(salt);

		const derivedKey = await window.crypto.subtle.deriveKey(
			{
				name: 'PBKDF2',
				salt: saltBuffer as any,
				iterations: 100000,
				hash: 'SHA-256'
			},
			keyMaterial,
			{ name: 'AES-GCM', length: 256 },
			true, // ⚡ CHANGED TO TRUE: Allows the key to be exported to disk
			['encrypt', 'decrypt']
		);

		try {
			const jwkString = await this.exportKey(derivedKey);
			window.sessionStorage?.setItem(`ilow-key-${cacheKey}`, jwkString);
		} catch (e) {}

		WebCryptoService.derivedKeyCache.set(cacheKey, derivedKey);
		return derivedKey;
	}

	public async exportKey(key: CryptoKey): Promise<string> {
		// Export the raw CryptoKey to a JSON Web Key (JWK)
		const exported = await window.crypto.subtle.exportKey('jwk', key);
		return JSON.stringify(exported);
	}

	public async importKey(keyData: string): Promise<CryptoKey> {
		// Re-import the JWK string back into a functional CryptoKey
		const jwk = JSON.parse(keyData);
		return await window.crypto.subtle.importKey(
			'jwk',
			jwk,
			{ name: 'AES-GCM', length: 256 },
			true,
			['encrypt', 'decrypt']
		);
	}

	public async encrypt(data: Uint8Array, key: CryptoKey): Promise<EncryptedBlob> {
		const iv = window.crypto.getRandomValues(new Uint8Array(12));
		const ciphertextBuffer = await window.crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: iv as any },
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
			{ name: 'AES-GCM', iv: iv as any },
			key,
            ciphertext as any
		);

		return new Uint8Array(decryptedBuffer);
	}
}