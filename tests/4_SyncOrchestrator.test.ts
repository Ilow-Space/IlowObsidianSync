
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncOrchestrator } from '../src/2_Application/Sync/SyncOrchestrator';

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
            getOrCreateDoc: vi.fn().mockResolvedValue({
                getText: () => ({ toString: () => 'content' })
            }), 
            handleLocalChange: vi.fn().mockResolvedValue(new Uint8Array([1])) 
        };
        
        repoMock = { 
            readNote: vi.fn().mockResolvedValue(''), 
            writeNote: vi.fn().mockResolvedValue(undefined) 
        };
        
        statusCb = vi.fn();

        orchestrator = new SyncOrchestrator(remoteMock, cryptoMock, engineMock, repoMock, statusCb);
        
        // Inject dependencies to make it "Active"
        const mockKey = { type: 'secret' } as unknown as CryptoKey;
        orchestrator.setCryptoKey(mockKey);
        orchestrator.setTreeIndexManager({ 
            getUuidForPath: vi.fn().mockReturnValue('mock-uuid-1'), 
            INDEX_DOC_ID: 'system-vault-index', 
            getActiveFiles: vi.fn().mockReturnValue([{ uuid: 'mock-uuid-1', path: 'test.md' }]),
            reconcileFilesystem: vi.fn().mockResolvedValue(undefined) // Add this line
        } as any);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('Debounce Verification', async () => {
        const pushSpy = vi.spyOn(orchestrator['pushUseCase'], 'execute').mockResolvedValue(undefined);

        // Simulate 10 rapid keystrokes with 100ms pauses
        for(let i = 0; i < 10; i++) {
            orchestrator.handleLocalChange('test.md', `content typing ${i}`);
            vi.advanceTimersByTime(100);
        }

        // Before 1000ms clears, nothing should be pushed
        expect(pushSpy).not.toHaveBeenCalled();

        // Advance past the 1000ms debounce timer of the final keystroke
        await vi.advanceTimersByTimeAsync(1500);
        // Verify it was pushed EXACTLY once
        expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it('Request Storm Prevention (Mutex)', async () => {
        // Artificially slow down the pull process to test mutex locking
        vi.spyOn(orchestrator, 'pullDocument').mockImplementation(async () => {
            return new Promise(resolve => setTimeout(resolve, 500));
        });

        // Trigger runFullSync 5 times concurrently
        const promises = [];
        for(let i = 0; i < 5; i++) {
            promises.push(orchestrator.runFullSync());
        }

        // Fast forward through delays
        await vi.runAllTimersAsync();
        await Promise.all(promises);

        // It should have only executed once per document due to this.isSyncingFull flag
        expect(orchestrator.pullDocument).toHaveBeenCalledTimes(2); // 1 for index + 1 for active files
    });

    it('Auto-Compaction Trigger', async () => {
        const compactSpy = vi.spyOn(orchestrator['pushUseCase'], 'forceCompact').mockResolvedValue(undefined);
        vi.spyOn(orchestrator['pushUseCase'], 'execute').mockResolvedValue(undefined);

        // Artificially set update counter to threshold edge
        orchestrator['fileUpdateCounters'].set('mock-uuid-1', 49);

        // 50th change
        orchestrator.handleLocalChange('test.md', 'Threshold trigger content');
        await vi.advanceTimersByTimeAsync(1500);

        expect(compactSpy).toHaveBeenCalledWith('mock-uuid-1', expect.anything(), 'test.md');
        expect(orchestrator['fileUpdateCounters'].get('mock-uuid-1')).toBe(0); // Counter resets
    });

    it('Network Failure Graceful Exit', async () => {
        // Simulate a network crash during a sync
        remoteMock.getLatestUpdateId.mockRejectedValue(new Error('net::ERR_FAILED'));
        
        // Provide a baseline lastSyncId so it attempts the update check
        orchestrator['fileLastSyncIds'].set('mock-uuid-1', 5);

        // Orchestrator should catch this and NOT throw, but instead flag connection error
        await expect(orchestrator.pullDocument('mock-uuid-1', 'test.md')).resolves.not.toThrow();

        expect(orchestrator['hasConnectionError']).toBe(true);
        expect(orchestrator['lastErrorMessage']).toBe('Connection failed');
    });
});
