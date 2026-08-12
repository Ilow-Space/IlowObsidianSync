import { describe, it, expect, vi, beforeEach } from 'vitest';
import { YjsEngine } from '../src/3_Infrastructure/Crdt/YjsEngine';
import * as Y from 'yjs';

describe('CRDT Engine & Conflict Resolution', () => {
    let engine: YjsEngine;

    beforeEach(() => {
        engine = new YjsEngine();
    });

    it('Concurrent Merges', async () => {
        const docId = 'merge-doc-id';
        const doc1 = await engine.getOrCreateDoc(docId, 'Initial shared baseline.');
        
        // Simulate a second isolated device pulling the same baseline
        const doc2 = new Y.Doc();
        Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

        // Device 1 appends text
        doc1.getText('markdown').insert(24, ' Edited by Device 1.');
        
        // Device 2 modifies the beginning simultaneously
        doc2.getText('markdown').insert(0, '[Alert] ');

        const updateFrom1 = Y.encodeStateAsUpdate(doc1);
        const updateFrom2 = Y.encodeStateAsUpdate(doc2);

        // Sync devices with each other
        Y.applyUpdate(doc1, updateFrom2);
        Y.applyUpdate(doc2, updateFrom1);

        // Assert convergence
        const expectedMergedText = '[Alert] Initial shared baseline. Edited by Device 1.';
        expect(doc1.getText('markdown').toString()).toEqual(expectedMergedText);
        expect(doc2.getText('markdown').toString()).toEqual(expectedMergedText);
    });

    it('Tombstone Preservation (Line-based Diff Generator)', async () => {
        const docId = 'tombstone-doc';
        const doc = await engine.getOrCreateDoc(docId, 'Line 1\nLine 2\nLine 3');
        
        // Using the handleLocalChange text reconciler instead of Y.Text insertions directly
        const updateBinary = await engine.handleLocalChange(docId, 'Line 1\nLine 2 Modified\nLine 3');
        
        expect(updateBinary).not.toBeNull();
        expect(updateBinary!.length).toBeGreaterThan(0);
        
        // The update payload should be small (delta), not the size of the entire replaced document
        expect(updateBinary!.length).toBeLessThan(100); 
        
        // Verify state is successfully applied to the local Yjs instance
        expect(doc.getText('markdown').toString()).toBe('Line 1\nLine 2 Modified\nLine 3');
    });

    it('IndexedDB Hydration', async () => {
        const docId = 'hydrated-doc';
        
        // Pre-create a state vector as if it were loaded from IndexedDB
        const tempDoc = new Y.Doc();
        tempDoc.getText('markdown').insert(0, 'Restored from history');
        const stateVector = Y.encodeStateAsUpdate(tempDoc);

        // Mock IndexedDB read
        vi.spyOn(engine.localStore, 'loadDocumentState').mockResolvedValue(stateVector);
        
        // Get doc (should trigger hydration)
        const hydratedDoc = await engine.getOrCreateDoc(docId);

        expect(engine.localStore.loadDocumentState).toHaveBeenCalledWith(docId);
        expect(hydratedDoc.getText('markdown').toString()).toBe('Restored from history');
    });

    it('BUG REGRESSION: Engine must not eject active documents during async operations (Split-Brain Prevention)', async () => {
        const docId = 'split-brain-doc';
        const doc1 = await engine.getOrCreateDoc(docId, 'Initial Content');
        
        // Simulate file close while asynchronous network/sync task holds a reference
        engine.removeDoc(docId);
        
        // File re-opened immediately
        const doc2 = await engine.getOrCreateDoc(docId);
        
        // Modifying the doc should reflect across active references rather than diverging
        doc2.getText('markdown').insert(0, 'Prefix ');
        
        expect(doc1).toBe(doc2);
    });

    it('BUG REGRESSION: handleLocalChange must be idempotent when text is identical', async () => {
        const docId = 'idempotent-doc';
        await engine.getOrCreateDoc(docId, 'Static Content');

        // Apply identical content
        const updateBinary = await engine.handleLocalChange(docId, 'Static Content');

        expect(updateBinary).toBeNull();
    });

    it('BUG REGRESSION: applyUpdates must gracefully handle corrupted binary updates without crashing', async () => {
        const docId = 'corrupt-update-doc';
        const doc = await engine.getOrCreateDoc(docId, 'Valid Baseline');
        
        const invalidUpdate = new Uint8Array([255, 255, 255, 255, 0, 0]);

        // Should catch errors gracefully and preserve baseline doc
        await expect(engine.applyUpdates(docId, [invalidUpdate])).resolves.toBeDefined();
        expect(doc.getText('markdown').toString()).toBe('Valid Baseline');
    });
});