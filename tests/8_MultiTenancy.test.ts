import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebCryptoService } from '../src/3_Infrastructure/Crypto/WebCryptoService';
import { PostgresRemoteStore } from '../src/3_Infrastructure/Postgres/PostgresRemoteStore';
import { requestUrl } from 'obsidian';

// Mock Obsidian's global request URL to safely trap and inspect REST API headers
vi.mock('obsidian', () => ({
	requestUrl: vi.fn().mockResolvedValue({ status: 200, json: [] })
}));

class MockWebSocket {
	url: string;
	readyState: number = 1; // OPEN
	send = vi.fn();
	close = vi.fn();
	onopen: (() => void) | null = null;
	onmessage: ((event: any) => void) | null = null;
	onerror: ((err: any) => void) | null = null;
	onclose: (() => void) | null = null;

	constructor(url: string) {
		this.url = url;
		(globalThis as any).createdWs = this;
	}
}

describe('Multi-Tenancy & Data Isolation Checks', () => {
	let cryptoService: WebCryptoService;
	let remoteStore: PostgresRemoteStore;

	beforeEach(() => {
		vi.stubGlobal('WebSocket', MockWebSocket);
		(globalThis as any).createdWs = null;
		
		cryptoService = new WebCryptoService();
		remoteStore = new PostgresRemoteStore('http://localhost', {});
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('1. WebCryptoService deterministically generates the same VaultAliasID for identical keys', async () => {
		const salt = cryptoService.generateSalt();
		const keyA = await cryptoService.deriveKey('tenant-password', salt);
		const keyB = await cryptoService.deriveKey('tenant-password', salt);

		const aliasA = await cryptoService.getVaultAliasId(keyA);
		const aliasB = await cryptoService.getVaultAliasId(keyB);

		expect(aliasA).toEqual(aliasB);
	});

	it('2. WebCryptoService generates globally isolated VaultAliasIDs for different passwords', async () => {
		const salt = cryptoService.generateSalt();
		const keyA = await cryptoService.deriveKey('tenant-1-password', salt);
		const keyB = await cryptoService.deriveKey('tenant-2-password', salt);

		const aliasA = await cryptoService.getVaultAliasId(keyA);
		const aliasB = await cryptoService.getVaultAliasId(keyB);

		expect(aliasA).not.toEqual(aliasB);
		expect(aliasA.length).toBe(64); // SHA-256 hex length
	});

	it('3. PostgresRemoteStore applies X-Vault-Alias-ID to all HTTP headers', () => {
		remoteStore.setVaultAliasId('isolated-tenant-hash');
		const headers = (remoteStore as any).headers;
		
		expect(headers['X-Vault-Alias-ID']).toBe('isolated-tenant-hash');
	});

	it('4. PostgresRemoteStore cleanly removes X-Vault-Alias-ID when alias is cleared', () => {
		remoteStore.setVaultAliasId('temporary-tenant-hash');
		remoteStore.setVaultAliasId('');
		
		const headers = (remoteStore as any).headers;
		expect(headers['X-Vault-Alias-ID']).toBeUndefined();
	});

	it('5. PostgresRemoteStore restricts WebSocket connection URLs to the designated vault_alias_id', () => {
		remoteStore.setVaultAliasId('tenant-url-param');
		remoteStore.connectWebSocket('ws://localhost:3001');
		
		const ws = (globalThis as any).createdWs as MockWebSocket;
		expect(ws.url).toContain('vault_alias_id=tenant-url-param');
	});

	it('6. PostgresRemoteStore enforces tenant boundaries in WebSocket subscription payloads', () => {
		remoteStore.setVaultAliasId('tenant-isolated');
		remoteStore.connectWebSocket('ws://localhost:3001');
		const ws = (globalThis as any).createdWs as MockWebSocket;
		
		remoteStore.subscribeToUpdates('target-doc', vi.fn());
		
		expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"vault_alias_id":"tenant-isolated"'));
	});

	it('7. PostgresRemoteStore safely unbinds tenant state during disconnect()', () => {
		remoteStore.connectWebSocket('ws://localhost:3001');
		const ws = (globalThis as any).createdWs as MockWebSocket;
		
		remoteStore.subscribeToUpdates('test-doc', vi.fn());
		remoteStore.disconnect();
		
		expect(ws.close).toHaveBeenCalled();
		expect((remoteStore as any).subscriptions.size).toBe(0);
	});

	it('8. REST API calls strictly transport the tenant alias to prevent backend cross-contamination', async () => {
		remoteStore.setVaultAliasId('tenant-rest');
		await remoteStore.fetchManifest();
		
		expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
			headers: expect.objectContaining({
				'X-Vault-Alias-ID': 'tenant-rest'
			})
		}));
	});

	it('BUG 1: setVaultAliasId fails to reconnect an active WebSocket, causing cross-tenant data leaks on mid-session key changes', () => {
		remoteStore.setVaultAliasId('tenant-A');
		remoteStore.connectWebSocket('ws://localhost:3001');
		const wsA = (globalThis as any).createdWs as MockWebSocket;
		
		// Mid-session tenant change (e.g., user unloads key and loads a new one)
		remoteStore.setVaultAliasId('tenant-B');
		
		// The store MUST sever the old socket connected to tenant-A to prevent data bleeding
		// Current Codebase: Fails because it updates `this.vaultAliasId` but leaves the socket active.
		expect(wsA.close).toHaveBeenCalled(); 
	});

	it('BUG 2: PostgresRemoteStore lacks client-side vault_alias_id validation on incoming WS messages, trusting server blindly', () => {
		remoteStore.setVaultAliasId('tenant-A');
		remoteStore.connectWebSocket('ws://localhost:3001');
		const ws = (globalThis as any).createdWs as MockWebSocket;
		
		const callbackSpy = vi.fn();
		remoteStore.subscribeToUpdates('shared-doc', callbackSpy);
		
		// Simulate a leaky backend sending Tenant B's data down the pipe
		ws.onmessage!({
			data: JSON.stringify({
				type: 'INSERT',
				table: 'vault_updates',
				record: {
					document_id: 'shared-doc',
					vault_alias_id: 'tenant-B-Secret' // NOT tenant-A!
				}
			})
		});
		
		// Client MUST discard payloads where payload.record.vault_alias_id !== this.vaultAliasId
		// Current Codebase: Fails because it processes the payload without validating the alias.
		expect(callbackSpy).not.toHaveBeenCalled();
	});
});