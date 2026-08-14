import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoroSyncEngine } from '../src/3_Infrastructure/Crdt/LoroSyncEngine';
import { LoroDoc } from 'loro-crdt';

describe('LoroSyncEngine & Conflict Resolution', () => {
    let engine: LoroSyncEngine;

    beforeEach(async () => {
        engine = new LoroSyncEngine();
        await engine.localStore.clearAll();
    });

    it('Concurrent Merges', async () => {
        const docId = 'merge-doc-id';
        const doc1 = await engine.getOrCreateDoc(docId, 'Initial shared baseline.');
        
        const doc2 = new LoroDoc();
        doc2.import(doc1.export({ mode: 'snapshot' }));

        doc1.getText('markdown').insert(24, ' Edited by Device 1.');
        doc1.commit();
        
        doc2.getText('markdown').insert(0, '[Alert] ');
        doc2.commit();

        const updateFrom1 = doc1.export({ mode: 'update' });
        const updateFrom2 = doc2.export({ mode: 'update' });

        doc1.import(updateFrom2);
        doc2.import(updateFrom1);

        const expectedMergedText = '[Alert] Initial shared baseline. Edited by Device 1.';
        expect(doc1.getText('markdown').toString()).toEqual(expectedMergedText);
        expect(doc2.getText('markdown').toString()).toEqual(expectedMergedText);
    });

    it('Tombstone Preservation (fast-diff)', async () => {
        const docId = 'tombstone-doc';
        const doc = await engine.getOrCreateDoc(docId, 'Line 1\nLine 2\nLine 3');
        
        const updateBinary = await engine.handleLocalChange(docId, 'Line 1\nLine 2 Modified\nLine 3');
        
        expect(updateBinary).not.toBeNull();
        expect(updateBinary!.length).toBeGreaterThan(0);
        expect(updateBinary!.length).toBeLessThan(150);
        
        expect(doc.getText('markdown').toString()).toBe('Line 1\nLine 2 Modified\nLine 3');
    });

    it('IndexedDB Hydration', async () => {
        const docId = 'hydrated-doc';
        
        const tempDoc = new LoroDoc();
        tempDoc.getText('markdown').insert(0, 'Restored from history');
        tempDoc.commit();
        const stateVector = tempDoc.export({ mode: 'snapshot' });

        vi.spyOn(engine.localStore, 'loadDocumentState').mockResolvedValue(stateVector);
        
        const hydratedDoc = await engine.getOrCreateDoc(docId);

        expect(engine.localStore.loadDocumentState).toHaveBeenCalledWith(docId);
        expect(hydratedDoc.getText('markdown').toString()).toBe('Restored from history');
    });

    it('BUG REGRESSION: Engine must not eject active documents during async operations', async () => {
        const docId = 'split-brain-doc';
        const doc1 = await engine.getOrCreateDoc(docId, 'Initial Content');
        
        engine.removeDoc(docId);
        
        const doc2 = await engine.getOrCreateDoc(docId);
        
        doc2.getText('markdown').insert(0, 'Prefix ');
        doc2.commit();
        
        expect(doc1).toBe(doc2);
    });

    it('BUG REGRESSION: handleLocalChange must be idempotent when text is identical', async () => {
        const docId = 'idempotent-doc';
        await engine.getOrCreateDoc(docId, 'Static Content');

        const updateBinary = await engine.handleLocalChange(docId, 'Static Content');

        expect(updateBinary).toBeNull();
    });

    it('BUG REGRESSION: applyUpdates must gracefully handle corrupted binary updates without crashing', async () => {
        const docId = 'corrupt-update-doc';
        const doc = await engine.getOrCreateDoc(docId, 'Valid Baseline');
        
        const invalidUpdate = new Uint8Array([255, 255, 255, 255, 0, 0]);

        await expect(engine.applyUpdates(docId, [invalidUpdate])).resolves.toBeDefined();
        expect(doc.getText('markdown').toString()).toBe('Valid Baseline');
    });
});
