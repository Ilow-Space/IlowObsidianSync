import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PostgresRemoteStore } from '../src/3_Infrastructure/Postgres/PostgresRemoteStore';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';
import * as obsidian from 'obsidian';

describe('Multi-Tenancy & Isolation Suite (10 Audits)', () => {
	let createdWs: any = null;

	class MockWebSocket {
		send = vi.fn();
		close = vi.fn();
		onopen: (() => void) | null = null;
		onmessage: ((event: any) => void) | null = null;
		onerror: ((err: any) => void) | null = null;
		onclose: (() => void) | null = null;
		readyState = 1;

		constructor(public url: string) {
			createdWs = this;
		}
	}

	beforeEach(() => {
		createdWs = null;
		vi.stubGlobal('WebSocket', MockWebSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	// Audit 1
	it('1. Header Management: setVaultAliasId sets X-Vault-Alias-ID header', () => {
		const store = new PostgresRemoteStore('http://localhost:3000', {});
		store.setVaultAliasId('tenant-alias-123');

		expect((store as any).headers['X-Vault-Alias-ID']).toBe('tenant-alias-123');
	});

	// Audit 2
	it('2. Header Cleanup: setVaultAliasId("") removes X-Vault-Alias-ID header', () => {
		const store = new PostgresRemoteStore('http://localhost:3000', {});
		store.setVaultAliasId('tenant-alias-123');
		store.setVaultAliasId('');

		expect((store as any).headers['X-Vault-Alias-ID']).toBeUndefined();
	});

	// Audit 3
	it('3. Socket Reconnection on Alias Change: Disconnects and reconnects on vault switch', () => {
		const store = new PostgresRemoteStore('http://localhost:3000', {});
		store.setVaultAliasId('alias-a');
		store.connectWebSocket('ws://localhost:3000');

		const firstWs = createdWs;
		expect(firstWs).not.toBeNull();

		store.setVaultAliasId('alias-b');

		expect(firstWs.close).toHaveBeenCalled();
		expect(createdWs).not.toBe(firstWs);
		expect(createdWs.url).toContain('vault_alias_id=alias-b');
	});

	// Audit 4
	it('4. Incoming WS Tenant Validation: Discards updates from foreign vault alias', () => {
		const store = new PostgresRemoteStore('http://localhost:3000', {});
		store.setVaultAliasId('tenant-a');
		store.connectWebSocket('ws://localhost:3000');

		const callback = vi.fn();
		store.subscribeToUpdates('doc-1', callback);

		createdWs.onmessage({
			data: JSON.stringify({
				type: 'INSERT',
				table: 'vault_updates',
				record: {
					document_id: 'doc-1',
					vault_alias_id: 'tenant-b-FOREIGN'
				}
			})
		});

		expect(callback).not.toHaveBeenCalled();
	});

	// Audit 5
	it('5. Incoming WS Tenant Validation: Accepts updates matching vault alias', () => {
		const store = new PostgresRemoteStore('http://localhost:3000', {});
		store.setVaultAliasId('tenant-a');
		store.connectWebSocket('ws://localhost:3000');

		const callback = vi.fn();
		store.subscribeToUpdates('doc-1', callback);

		createdWs.onmessage({
			data: JSON.stringify({
				type: 'INSERT',
				table: 'vault_updates',
				record: {
					document_id: 'doc-1',
					vault_alias_id: 'tenant-a'
				}
			})
		});

		expect(callback).toHaveBeenCalledWith('doc-1', 'insert');
	});

	// Audit 6
	it('6. Socket URL Encoding: Passes vault_alias_id as query parameter on connectWebSocket', () => {
		const store = new PostgresRemoteStore('http://localhost:3000', {});
		store.setVaultAliasId('my-secret-vault-alias');
		store.connectWebSocket('ws://localhost:3000');

		expect(createdWs.url).toContain('vault_alias_id=my-secret-vault-alias');
	});

	// Audit 7
	it('7. Subscription Persistence: Preserves registered subscription keys on alias reconnect', () => {
		const store = new PostgresRemoteStore('http://localhost:3000', {});
		store.setVaultAliasId('tenant-1');
		store.subscribeToUpdates('doc-persist', vi.fn());
		store.connectWebSocket('ws://localhost:3000');

		store.setVaultAliasId('tenant-2');
		createdWs.onopen();

		expect(createdWs.send).toHaveBeenCalledWith(
			expect.stringContaining('doc-persist')
		);
		expect(createdWs.send).toHaveBeenCalledWith(
			expect.stringContaining('"vault_alias_id":"tenant-2"')
		);
	});

	// Audit 8
	it('8. Session State Isolation: NetworkOrchestrator.stopAll prevents session bleed across vault switches', async () => {
		const bus = new SyncEventBus();
		const engine = new LoroSyncEngine();
		await engine.localStore.clearAll();
		const vfs = new LoroVfsController(engine, bus);
		await vfs.initialize();

		const orchestrator = new NetworkOrchestrator(
			{} as any,
			{} as any,
			engine,
			{} as any,
			vfs,
			bus,
			vi.fn(),
			1000
		);

		orchestrator.setCryptoKey({} as any);
		(orchestrator as any).fileLastSyncIds.set('vaultA-doc1', 42);

		orchestrator.stopAll();

		expect((orchestrator as any).fileLastSyncIds.has('vaultA-doc1')).toBe(false);

		vfs.destroy();
		engine.destroy();
	});

	// Audit 9
	it('9. Admin Truncation Isolation: Sends Admin API Token in Authorization header', async () => {
		const store = new PostgresRemoteStore('http://localhost:3000', {});
		const requestUrlSpy = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({ status: 200 } as any);

		await store.truncateServer('secret-admin-token-xyz');

		expect(requestUrlSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'http://localhost:3000/api/admin/truncate',
				method: 'POST',
				headers: expect.objectContaining({
					'Authorization': 'Bearer secret-admin-token-xyz'
				})
			})
		);
	});

	// Audit 10
	it('10. Bulk Subscription Payload: Bulk payload contains current vault_alias_id', () => {
		const store = new PostgresRemoteStore('http://localhost:3000', {});
		store.setVaultAliasId('alias-bulk-test');
		store.subscribeToUpdates('doc-a', vi.fn());
		store.subscribeToUpdates('doc-b', vi.fn());

		store.connectWebSocket('ws://localhost:3000');
		createdWs.onopen();

		expect(createdWs.send).toHaveBeenCalledWith(
			JSON.stringify({
				action: 'subscribe_bulk',
				filters: ['document_id=eq.doc-a', 'document_id=eq.doc-b'],
				vault_alias_id: 'alias-bulk-test'
			})
		);
	});
});