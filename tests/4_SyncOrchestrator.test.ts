import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncOrchestrator } from '../src/2_Application/Sync/SyncOrchestrator';
import { PostgresRemoteStore } from '../src/3_Infrastructure/Postgres/PostgresRemoteStore';
import * as Y from 'yjs';

describe('Sync Orchestrator & Network Resilience', () => {
    let orchestrator: SyncOrchestrator;
    let remoteMock: any;
    let cryptoMock: any;
    let engineMock: any;
    let repoMock: any;
    let statusCb: any;

    beforeEach(() => {
        vi.useFakeTimers();
        
        remoteMock = {
            getLatestUpdateId: vi.fn(),
            fetchSnapshot: vi.fn().mockResolvedValue(null),
            fetchUpdatesSince: vi.fn().mockResolvedValue([]),
            pushUpdate: vi.fn().mockResolvedValue(undefined),
            compactSnapshot: vi.fn().mockResolvedValue(undefined),
            subscribeToUpdates: vi.fn().mockReturnValue(() => {})
        };
        
        cryptoMock = { 
            decrypt: vi.fn(), 
            encrypt: vi.fn() 
        };
        
        engineMock = { 
            getOrCreateDoc: vi.fn().mockImplementation(async () => new Y.Doc()), 
            handleLocalChange: vi.fn().mockResolvedValue(new Uint8Array([1])) 
        };
        
        repoMock = { 
            readNote: vi.fn().mockResolvedValue(''), 
            writeNote: vi.fn().mockResolvedValue(undefined) 
        };
        
        statusCb = vi.fn();

        orchestrator = new SyncOrchestrator(remoteMock, cryptoMock, engineMock, repoMock, statusCb);
        
        const mockKey = { type: 'secret' } as unknown as CryptoKey;
        orchestrator.setCryptoKey(mockKey);
        orchestrator.setTreeIndexManager({ 
            getUuidForPath: vi.fn().mockReturnValue('mock-uuid-1'), 
            INDEX_DOC_ID: 'system-vault-index', 
            getActiveFiles: vi.fn().mockReturnValue([{ uuid: 'mock-uuid-1', path: 'test.md' }]),
            reconcileFilesystem: vi.fn().mockResolvedValue(undefined)
        } as any);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('Debounce Verification', async () => {
        const pushSpy = vi.spyOn(orchestrator['pushUseCase'], 'execute').mockResolvedValue(undefined);

        for(let i = 0; i < 10; i++) {
            orchestrator.handleLocalChange('test.md', `content typing ${i}`);
            vi.advanceTimersByTime(100);
        }

        expect(pushSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1500);
        expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it('Request Storm Prevention (Mutex)', async () => {
        vi.spyOn(orchestrator, 'pullDocument').mockImplementation(async () => {
            return new Promise(resolve => setTimeout(resolve, 500));
        });

        const promises = [];
        for(let i = 0; i < 5; i++) {
            promises.push(orchestrator.runFullSync());
        }

        await vi.runAllTimersAsync();
        await Promise.all(promises);

        expect(orchestrator.pullDocument).toHaveBeenCalledTimes(2);
    });

    it('Auto-Compaction Trigger', async () => {
        const compactSpy = vi.spyOn(orchestrator['pushUseCase'], 'forceCompact').mockResolvedValue(undefined);
        vi.spyOn(orchestrator['pushUseCase'], 'execute').mockResolvedValue(undefined);

        orchestrator['fileUpdateCounters'].set('mock-uuid-1', 49);

        orchestrator.handleLocalChange('test.md', 'Threshold trigger content');
        await vi.advanceTimersByTimeAsync(1500);

        expect(compactSpy).toHaveBeenCalledWith('mock-uuid-1', expect.anything(), 'test.md');
        expect(orchestrator['fileUpdateCounters'].get('mock-uuid-1')).toBe(0);
    });

    it('Network Failure Graceful Exit', async () => {
        remoteMock.getLatestUpdateId.mockRejectedValue(new Error('net::ERR_FAILED'));
        orchestrator['fileLastSyncIds'].set('mock-uuid-1', 5);

        await expect(orchestrator.pullDocument('mock-uuid-1', 'test.md')).resolves.not.toThrow();

        expect(orchestrator['hasConnectionError']).toBe(true);
        expect(orchestrator['lastErrorMessage']).toBe('Connection failed');
    });

    it('BUG REGRESSION: Orchestrator must garbage collect UUIDs from memory maps upon deletion', async () => {
        const documentId = 'memory-leak-uuid';
        
        orchestrator['fileLastSyncIds'].set(documentId, 10);
        orchestrator['fileUpdateCounters'].set(documentId, 5);
        
        await orchestrator.deleteRemoteSnapshot(documentId);

        expect(orchestrator['fileLastSyncIds'].has(documentId)).toBe(false);
        expect(orchestrator['fileUpdateCounters'].has(documentId)).toBe(false);
    });

    it('BUG REGRESSION: Remote store must properly clean up subscriptions to prevent leaks', () => {
        const store = new PostgresRemoteStore('http://localhost', {});
        const callback1 = vi.fn();
        const callback2 = vi.fn();
        
        const unsub1 = store.subscribeToUpdates('manifest', callback1);
        const unsub2 = store.subscribeToUpdates('manifest', callback2);
        
        expect(store['subscriptions'].get('manifest')?.length).toBe(2);
        
        unsub1();
        
        expect(store['subscriptions'].get('manifest')?.length).toBe(1);
        expect(store['subscriptions'].get('manifest')?.[0]).toBe(callback2);
    });

    it('BUG REGRESSION: Remote pull must acquire the UI lock before fetching network updates', async () => {
        let wasLockedDuringFetch = false;
        
        remoteMock.fetchUpdatesSince.mockImplementation(async () => {
            wasLockedDuringFetch = orchestrator['isApplyingRemoteChanges'];
            return [];
        });

        await orchestrator.pullDocument('lock-test-id');

        expect(wasLockedDuringFetch).toBe(true);
    });

    it('BUG REGRESSION: forceCompact must pass the file path to prevent DB manifest nullification', async () => {
        const compactSpy = vi.spyOn(remoteMock, 'compactSnapshot');
        const documentId = 'auto-compact-doc';
        const filePath = 'Project/Notes.md';
        
        orchestrator.setTreeIndexManager({
            getPathForUuid: vi.fn().mockReturnValue(filePath),
            getUuidForPath: vi.fn().mockReturnValue(documentId),
            INDEX_DOC_ID: 'index'
        } as any);

        await orchestrator['pushUseCase'].forceCompact(documentId, orchestrator.getActiveKey()!, filePath);

        expect(compactSpy).toHaveBeenCalledWith(
            documentId,
            expect.anything(),
            expect.anything(),
            false,
            expect.not.stringMatching(/undefined|null/)
        );
    });
    it('BUG REGRESSION: Silent background pull failure must notify statusCallback of error', async () => {
        statusCb.mockClear();

        // Simulate HTTP 502 / network error during snapshot fetch
        remoteMock.fetchSnapshot.mockRejectedValue(new Error('Failed to fetch snapshot: 502'));

        // Execute silent pull (isSilent = true, as done for shard-index during background sync)
        await orchestrator.pullDocument('shard-index', null, true);

        // Internal connection error state must be set
        expect(orchestrator['hasConnectionError']).toBe(true);

        // UI Status callback MUST be triggered with error status despite being a silent pull
        expect(statusCb).toHaveBeenCalledWith('error', expect.stringMatching(/Connection failed/i));
    });

    it('BUG REGRESSION: runFullSync failure must trigger UI error status and suppress completion log', async () => {
        statusCb.mockClear();

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Fail index pull during runFullSync
        remoteMock.fetchSnapshot.mockRejectedValue(new Error('Failed to fetch snapshot: 502'));

        await orchestrator.runFullSync();

        // 1. Must notify UI statusCallback of failure
        expect(statusCb).toHaveBeenCalledWith('error', expect.anything());

        // 2. Must NOT falsely log "Full Sync Complete." when errors occur
        const logMessages = logSpy.mock.calls.map(call => call.join(' '));
        expect(logMessages.some(msg => msg.includes('Full Sync Complete'))).toBe(false);

        logSpy.mockRestore();
        warnSpy.mockRestore();
    });
});