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

	public async hashData(data: Uint8Array): Promise<string> {
		const hashBuffer = await window.crypto.subtle.digest('SHA-256', data as BufferSource);
		return CryptoUtils.bufToHex(new Uint8Array(hashBuffer));
	}

	/**
	 * Cache handle for a password/salt pair that does not contain the password.
	 * The previous key was `${password}:${salt}` and was used verbatim as a
	 * sessionStorage key name, putting the master password in cleartext where any
	 * other plugin in the renderer could read it.
	 */
	private async cacheHandle(password: string, salt: string): Promise<string> {
		const material = new TextEncoder().encode(`${salt}:${password}`);
		const digest = await window.crypto.subtle.digest('SHA-256', material as BufferSource);
		return CryptoUtils.bufToHex(new Uint8Array(digest));
	}

	/**
	 * Drops every cached key. Call this on logout: without it, clearing the
	 * plugin's own reference leaves a usable key in this process.
	 */
	public static clearCachedKeys(): void {
		WebCryptoService.derivedKeyCache.clear();
	}

	public async deriveKey(password: string, salt: string): Promise<CryptoKey> {
		const cacheKey = await this.cacheHandle(password, salt);
		if (WebCryptoService.derivedKeyCache.has(cacheKey)) {
			return WebCryptoService.derivedKeyCache.get(cacheKey)!;
		}

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
				salt: saltBuffer as BufferSource,
				iterations: 100000,
				hash: 'SHA-256'
			},
			keyMaterial,
			{ name: 'AES-GCM', length: 256 },
			// Extractable so Plugin.ts can hand it to Obsidian's secretStorage, which
			// is the one place this key is meant to be persisted. It is deliberately
			// no longer written to sessionStorage, which is readable by every other
			// plugin loaded in the same renderer.
			true,
			['encrypt', 'decrypt']
		);

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
		const jwk = JSON.parse(keyData) as JsonWebKey;
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
			{ name: 'AES-GCM', iv: iv as BufferSource },
			key,
			data as BufferSource
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
			{ name: 'AES-GCM', iv: iv as BufferSource },
			key,
			ciphertext as BufferSource
		);

		return new Uint8Array(decryptedBuffer);
	}
}