import { PostgresRemoteStore } from '../src/3_Infrastructure/Postgres/PostgresRemoteStore';
import { vi, describe, it, expect } from 'vitest';

describe('PostgresRemoteStore Performance', () => {
	it('PERF REGRESSION: Must bulk-subscribe on reconnect to prevent WS flooding', () => {
		let createdWs: any = null;

		class MockWebSocket {
			send = vi.fn();
			onopen: (() => void) | null = null;
			onmessage: ((event: any) => void) | null = null;
			onerror: ((err: any) => void) | null = null;
			onclose: (() => void) | null = null;

			constructor(public url: string) {
				createdWs = this;
			}
		}

		vi.stubGlobal('WebSocket', MockWebSocket);

		const store = new PostgresRemoteStore('http://localhost', {});

		// Add 1000 subscriptions
		for (let i = 0; i < 1000; i++) {
			store.subscribeToUpdates(`doc-${i}`, vi.fn());
		}

		// Connect WebSocket which instantiates MockWebSocket and sets onopen
		store.connectWebSocket('ws://localhost:3001');

		expect(createdWs).not.toBeNull();
		expect(typeof createdWs.onopen).toBe('function');

		// Trigger actual onopen set by PostgresRemoteStore
		createdWs.onopen();

		// Must send exactly 1 optimized payload, not 1000.
		expect(createdWs.send).toHaveBeenCalledTimes(1);
		expect(createdWs.send).toHaveBeenCalledWith(
			expect.stringContaining('"action":"subscribe_bulk"')
		);

		vi.unstubAllGlobals();
	});
});
