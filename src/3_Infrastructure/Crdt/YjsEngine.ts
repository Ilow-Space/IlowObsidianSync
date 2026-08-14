import * as Y from 'yjs';
import { LocalHistoryStore } from './LocalHistoryStore';

export class YjsEngine {
	public localStore = new LocalHistoryStore();
	private activeDocs = new Map<string, Y.Doc>();
	private refCounts = new Map<string, number>();
	private fallbackCache = new Map<string, WeakRef<Y.Doc>>();

	public async getOrCreateDoc(documentId: string, initialContent?: string): Promise<Y.Doc> {
		// Increment reference count if already active
		if (this.activeDocs.has(documentId)) {
			const currentCount = this.refCounts.get(documentId) || 0;
			this.refCounts.set(documentId, currentCount + 1);
			return this.activeDocs.get(documentId)!;
		}

		// Check fallback cache first (soft cache)
		const fallbackRef = this.fallbackCache.get(documentId);
		if (fallbackRef) {
			const doc = fallbackRef.deref();
			if (doc) {
				this.activeDocs.set(documentId, doc);
				this.refCounts.set(documentId, 1);
				this.fallbackCache.delete(documentId);
				return doc;
			}
			this.fallbackCache.delete(documentId);
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
		this.refCounts.set(documentId, 1);
		return doc;
	}

	public async applyUpdates(documentId: string, updates: Uint8Array[]): Promise<Y.Doc> {
		const doc = await this.getOrCreateDoc(documentId);

		if (documentId === 'shard-index') {
			console.log('[applyUpdates] BEFORE:', Array.from(doc.getMap('vault-tree').entries()).map(e => [e[0], (e[1] as any)?.isDeleted]));
		}

		for (const update of updates) {
			try {
				if (documentId === 'shard-index') {
					const tempDoc = new Y.Doc();
					Y.applyUpdate(tempDoc, update);
					console.log(`[applyUpdates] update tempDoc entries:`, Array.from(tempDoc.getMap('vault-tree').entries()).map(e => [e[0], (e[1] as any)?.isDeleted]));
				}
				Y.applyUpdate(doc, update);
			} catch (err) {
				console.error(`YjsEngine error applying update for ${documentId}:`, err);
			}
		}

		if (documentId === 'shard-index') {
			console.log('[applyUpdates] AFTER:', Array.from(doc.getMap('vault-tree').entries()).map(e => [e[0], (e[1] as any)?.isDeleted]));
		}

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
		if (!this.activeDocs.has(documentId)) return;

		const currentCount = this.refCounts.get(documentId) || 1;
		if (currentCount > 1) {
			this.refCounts.set(documentId, currentCount - 1);
		} else {
			const doc = this.activeDocs.get(documentId)!;
			this.fallbackCache.set(documentId, new WeakRef(doc));
			this.activeDocs.delete(documentId);
			this.refCounts.delete(documentId);
		}
	}

	public forceEjectDoc(documentId: string): void {
		this.activeDocs.delete(documentId);
		this.refCounts.delete(documentId);
		this.fallbackCache.delete(documentId);
	}

	public destroy(): void {
		this.activeDocs.clear();
		this.refCounts.clear();
		this.fallbackCache.clear();
		this.localStore.close();
	}
}
