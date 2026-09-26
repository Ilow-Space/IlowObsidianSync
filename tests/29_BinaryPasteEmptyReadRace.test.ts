import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { VaultEventWatcher } from '../src/2_Application/Sync/VaultEventWatcher';
import { TFile } from 'obsidian';

/**
 * Reproduces a live incident: a pasted image ends up synced under the right
 * filename and the right (self-consistent) blob hash, but with zero bytes of
 * actual content -- confirmed live via the server's blob store, where the
 * hash on record was e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855,
 * the well-known SHA-256 of an empty input. The upload path only ever uploads
 * whatever base64 content it was handed; the loss traces back to the file
 * read that produced that content in the first place.
 *
 * VaultEventWatcher.readTFileContent has a retry loop that looks like it
 * tries the read up to 3 times, but for a read that SUCCEEDS with 0 bytes
 * (no exception -- just a file whose write has not flushed to disk yet,
 * which a large pasted image is exactly likely to be on a slow disk), it
 * does exactly one extra inline read after a single 100ms wait and then
 * returns unconditionally, regardless of whether that second read is also
 * empty. The outer `for` loop's remaining iterations are only ever reached
 * from the `catch` block, i.e. only when the read throws -- never when it
 * simply returns nothing.
 */
describe('Binary Paste Empty-Read Race: readTFileContent must not give up after one retry', () => {
	let eventBus: SyncEventBus;
	let vaultWatcher: VaultEventWatcher;
	let appMock: any;
	let readBinaryCallCount: number;
	let createCallback: ((file: TFile) => void) | null;

	beforeEach(() => {
		eventBus = new SyncEventBus();
		readBinaryCallCount = 0;
		createCallback = null;

		appMock = {
			vault: {
				on: vi.fn((event: string, callback: any) => {
					if (event === 'create') createCallback = callback;
				}),
				off: vi.fn(),
				getAbstractFileByPath: vi.fn(() => null),
				read: vi.fn(),
				adapter: {
					exists: vi.fn(async () => true),
					// The write has not flushed yet: the first TWO reads (the initial
					// attempt and the loop's one inline retry) come back empty, exactly
					// like a large pasted image whose bytes are still being written.
					// A third read -- reachable only if the outer loop actually retries
					// -- returns the real content.
					readBinary: vi.fn(async () => {
						readBinaryCallCount++;
						if (readBinaryCallCount <= 2) return new ArrayBuffer(0);
						return new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer; // PNG magic bytes
					})
				}
			},
			fileManager: {}
		};

		vaultWatcher = new VaultEventWatcher(appMock, eventBus);
		vaultWatcher.initialize();
	});

	afterEach(() => {
		vaultWatcher.destroy();
		eventBus.destroy();
		vi.restoreAllMocks();
	});

	it('retries past a second empty read instead of accepting empty content', async () => {
		const file = new TFile();
		(file as any).path = 'Assets/pasted-image.png';

		const received: Array<{ path: string; content?: string }> = [];
		eventBus.on('LocalFileCreated', (payload) => received.push(payload));

		expect(createCallback).not.toBeNull();
		createCallback!(file);

		// Give every retry/backoff window room to run: 3 outer iterations at up
		// to 150ms backoff each, plus the loop's own inline 100ms wait.
		await new Promise(resolve => setTimeout(resolve, 700));

		expect(readBinaryCallCount, 'the fix must actually reach a third read attempt').toBeGreaterThanOrEqual(3);

		const event = received.find(r => r.path === 'Assets/pasted-image.png');
		expect(event?.content, 'must not accept empty content when a later retry would have found real bytes').not.toBe('');
		expect(event?.content).toBeTruthy();
	});
});
