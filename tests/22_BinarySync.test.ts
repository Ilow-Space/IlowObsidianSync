import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isBinaryPath, uint8ArrayToBase64, base64ToUint8Array, getArrayBufferFromBytes } from '../src/3_Infrastructure/Utils/BinaryUtils';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { NetworkOrchestrator } from '../src/2_Application/Sync/NetworkOrchestrator';
import { SyncEventBus } from '../src/2_Application/Sync/SyncEventBus';
import { LoroVfsController } from '../src/2_Application/Sync/LoroVfsController';

describe('Binary Synchronization & Utility Suite', () => {
    describe('BinaryUtils', () => {
        it('correctly identifies binary extensions', () => {
            expect(isBinaryPath('image.png')).toBe(true);
            expect(isBinaryPath('photo.JPEG')).toBe(true);
            expect(isBinaryPath('document.pdf')).toBe(true);
            expect(isBinaryPath('archive.zip')).toBe(true);
            expect(isBinaryPath('audio.mp3')).toBe(true);

            expect(isBinaryPath('note.md')).toBe(false);
            expect(isBinaryPath('script.ts')).toBe(false);
            expect(isBinaryPath('README')).toBe(false);
        });

        it('converts Uint8Array to base64 and back losslessly', () => {
            const originalBytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64, 32]);
            const base64 = uint8ArrayToBase64(originalBytes);
            const recoveredBytes = base64ToUint8Array(base64);

            expect(recoveredBytes).toEqual(originalBytes);
        });

        it('extracts ArrayBuffer safely using getArrayBufferFromBytes', () => {
            const buffer = new ArrayBuffer(16);
            const bytes = new Uint8Array(buffer, 4, 8);
            bytes[0] = 42;
            bytes[7] = 99;

            const slicedBuf = getArrayBufferFromBytes(bytes);
            expect(slicedBuf.byteLength).toBe(8);
            const view = new Uint8Array(slicedBuf);
            expect(view[0]).toBe(42);
            expect(view[7]).toBe(99);
        });
    });

    describe('LoroSyncEngine Binary Support', () => {
        let engine: LoroSyncEngine;

        beforeEach(async () => {
            engine = new LoroSyncEngine();
            await engine.localStore.clearAll();
        });

        it('bypasses fast-diff for binary payloads and updates LoroText atomically', async () => {
            const docId = 'binary-doc-uuid';
            const initialBytes = new Uint8Array([1, 2, 3, 4]);
            const initialBase64 = uint8ArrayToBase64(initialBytes);

            await engine.getOrCreateDoc(docId, initialBase64);

            const updatedBytes = new Uint8Array([5, 6, 7, 8, 9]);
            const updatedBase64 = uint8ArrayToBase64(updatedBytes);

            const updateBinary = await engine.handleLocalChange(docId, updatedBase64, true);

            expect(updateBinary).not.toBeNull();
            expect(updateBinary!.length).toBeGreaterThan(0);

            const doc = await engine.getOrCreateDoc(docId);
            expect(doc.getText('markdown').toString()).toBe(updatedBase64);
        });
    });

    describe('NetworkOrchestrator Offline Binary Reconciliation', () => {
        let orchestrator: NetworkOrchestrator;
        let remoteStoreMock: any;
        let cryptoMock: any;
        let engine: LoroSyncEngine;
        let noteRepoMock: any;
        let vfsController: LoroVfsController;
        let eventBus: SyncEventBus;

        beforeEach(async () => {
            eventBus = new SyncEventBus();
            engine = new LoroSyncEngine();
            await engine.localStore.clearAll();

            vfsController = new LoroVfsController(engine, eventBus);
            await vfsController.initialize();

            remoteStoreMock = {
                pushUpdate: vi.fn().mockResolvedValue(undefined),
                getBulkLatestUpdateIds: vi.fn().mockResolvedValue({}),
                fetchSnapshotDetails: vi.fn().mockResolvedValue(null),
                fetchUpdatesSince: vi.fn().mockResolvedValue([])
            };

            cryptoMock = {
                encrypt: vi.fn().mockImplementation(async (bytes) => bytes),
                decrypt: vi.fn().mockImplementation(async (bytes) => bytes)
            };

            noteRepoMock = {
                readNote: vi.fn(),
                writeNote: vi.fn().mockResolvedValue(undefined),
                listAllNotes: vi.fn().mockResolvedValue([]),
                onNoteChange: vi.fn()
            };

            orchestrator = new NetworkOrchestrator(
                remoteStoreMock,
                cryptoMock,
                engine,
                noteRepoMock,
                vfsController,
                eventBus,
                vi.fn()
            );

            orchestrator.initialize();
            orchestrator.setCryptoKey({} as any);
        });

        it('reconciles offline added binary files and uploads them on full sync', async () => {
            const binaryData = new Uint8Array([10, 20, 30, 40, 50]);
            const base64Data = uint8ArrayToBase64(binaryData);

            noteRepoMock.listAllNotes.mockResolvedValue(['attachment.png']);
            noteRepoMock.readNote.mockResolvedValue(base64Data);

            await orchestrator.runFullSync();

            expect(remoteStoreMock.pushUpdate).toHaveBeenCalled();
            const docId = vfsController.getUuidForPath('attachment.png');
            expect(docId).not.toBeNull();

            const doc = await engine.getOrCreateDoc(docId!);
            expect(doc.getText('markdown').toString()).toBe(base64Data);
        });
    });
});
