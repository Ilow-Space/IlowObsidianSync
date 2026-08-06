
import * as Y from 'yjs';
import { LocalHistoryStore } from './LocalHistoryStore';

export class YjsEngine {
    public localStore = new LocalHistoryStore();
    private activeDocs = new Map<string, Y.Doc>();

    public async getOrCreateDoc(documentId: string, initialContent?: string): Promise<Y.Doc> {
        if (this.activeDocs.has(documentId)) {
            return this.activeDocs.get(documentId)!;
        }

        const doc = new Y.Doc();
        const yText = doc.getText('markdown');

        // Load persisted state from local history store (IndexedDB)
        const savedState = await this.localStore.loadDocumentState(documentId);
        if (savedState) {
            Y.applyUpdate(doc, savedState);
        } else if (initialContent !== undefined) {
            // Reconstruct if fresh document is opened
            yText.insert(0, initialContent);
            const state = Y.encodeStateAsUpdate(doc);
            await this.localStore.saveDocumentState(documentId, state);
        }

        this.activeDocs.set(documentId, doc);
        return doc;
    }

    public async applyUpdates(documentId: string, updates: Uint8Array[]): Promise<Y.Doc> {
        const doc = await this.getOrCreateDoc(documentId);

        doc.transact(() => {
            for (const update of updates) {
                try {
                    Y.applyUpdate(doc, update);
                } catch (err) {
                    console.error(`YjsEngine error applying update for ${documentId}:`, err);
                }
            }
        });

        // Persist new doc state to LocalHistoryStore
        const state = Y.encodeStateAsUpdate(doc);
        await this.localStore.saveDocumentState(documentId, state);

        return doc;
    }

    /**
     * Resolves local changes via standard line-by-line / text-level delta mapping
     * instead of deleting everything and re-inserting, preserving character-level tombstones and tracking.
     */
    public async handleLocalChange(documentId: string, newContent: string): Promise<Uint8Array | null> {
        const doc = await this.getOrCreateDoc(documentId);
        const yText = doc.getText('markdown');
        const currentText = yText.toString();

        if (currentText === newContent) {
            return null;
        }

        let update: Uint8Array | null = null;
        const updateHandler = (u: Uint8Array) => {
            update = u;
        };
        doc.once('update', updateHandler);

        doc.transact(() => {
            // Perform a robust, clean line-based/character diff application to keep tombstones alive
            const oldStr = currentText;
            const newStr = newContent;

            let commonPrefixLen = 0;
            while (commonPrefixLen < oldStr.length && commonPrefixLen < newStr.length && oldStr[commonPrefixLen] === newStr[commonPrefixLen]) {
                commonPrefixLen++;
            }

            let commonSuffixLen = 0;
            while (
                commonSuffixLen < oldStr.length - commonPrefixLen &&
                commonSuffixLen < newStr.length - commonPrefixLen &&
                oldStr[oldStr.length - 1 - commonSuffixLen] === newStr[newStr.length - 1 - commonSuffixLen]
            ) {
                commonSuffixLen++;
            }

            const deleteLen = oldStr.length - commonPrefixLen - commonSuffixLen;
            const insertStr = newStr.slice(commonPrefixLen, newStr.length - commonSuffixLen);

            if (deleteLen > 0) {
                yText.delete(commonPrefixLen, deleteLen);
            }
            if (insertStr.length > 0) {
                yText.insert(commonPrefixLen, insertStr);
            }
        });

        if (update) {
            const state = Y.encodeStateAsUpdate(doc);
            await this.localStore.saveDocumentState(documentId, state);
        }

        return update;
    }

    public removeDoc(documentId: string) {
        this.activeDocs.delete(documentId);
    }
}
