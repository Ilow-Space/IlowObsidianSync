import { LoroDoc } from 'loro-crdt';
import diff from 'fast-diff';
import { LoroSnapshotStore } from './LoroSnapshotStore';

export class LoroSyncEngine {
	public localStore = new LoroSnapshotStore();
	private activeDocs = new Map<string, LoroDoc>();
	private refCounts = new Map<string, number>();
	private fallbackCache = new Map<string, WeakRef<LoroDoc>>();
	private loadingDocs = new Map<string, Promise<LoroDoc>>();

	public async getOrCreateDoc(documentId: string, initialContent?: string): Promise<LoroDoc> {
		if (this.activeDocs.has(documentId)) {
			const currentCount = this.refCounts.get(documentId) || 0;
			this.refCounts.set(documentId, currentCount + 1);
			return this.activeDocs.get(documentId)!;
		}

		if (this.loadingDocs.has(documentId)) {
			const doc = await this.loadingDocs.get(documentId)!;
			const currentCount = this.refCounts.get(documentId) || 0;
			this.refCounts.set(documentId, currentCount + 1);
			return doc;
		}

		const loadPromise = (async () => {
			try {
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

				const doc = new LoroDoc();

				if (documentId !== 'shard-index') {
					doc.getText('markdown');
				} else {
					doc.getTree('vault-tree');
				}

				const savedState = await this.localStore.loadDocumentState(documentId);
				if (savedState) {
					doc.import(savedState);
				} else if (initialContent !== undefined) {
					if (documentId !== 'shard-index') {
						const text = doc.getText('markdown');
						text.insert(0, initialContent);
						const snapshot = doc.export({ mode: 'snapshot' });
						await this.localStore.saveDocumentState(documentId, snapshot);
					}
				}

				this.activeDocs.set(documentId, doc);
				this.refCounts.set(documentId, 1);
				return doc;
			} finally {
				this.loadingDocs.delete(documentId);
			}
		})();

		this.loadingDocs.set(documentId, loadPromise);
		return await loadPromise;
	}

	public async applyUpdates(documentId: string, updates: Uint8Array[]): Promise<LoroDoc> {
		const doc = await this.getOrCreateDoc(documentId);

		try {
			for (const update of updates) {
				try {
					doc.import(update);
				} catch (err) {
					console.error(`LoroSyncEngine error applying update for ${documentId}:`, err);
				}
			}

			// CRITICAL FIX: Commit imported ops so container nodes (LoroTree/LoroText) update
			doc.commit();

			const snapshot = doc.export({ mode: 'snapshot' });
			await this.localStore.saveDocumentState(documentId, snapshot);

			return doc;
		} finally {
			this.removeDoc(documentId);
		}
	}

	public async handleLocalChange(documentId: string, newContent: string): Promise<Uint8Array | null> {
		const doc = await this.getOrCreateDoc(documentId);

		try {
			const text = doc.getText('markdown');
			const currentText = text.toString();

			if (currentText === newContent) {
				return null;
			}

			// FIX: Capture the state vector BEFORE applying diffs using doc.version()
			const oldVersion = doc.version();

			let update: Uint8Array | null = null;
			const diffs = diff(currentText, newContent);
			let index = 0;

			doc.setPeerId(doc.peerId);

			for (const [op, value] of diffs) {
				if (op === 0) {
					index += value.length;
				} else if (op === 1) {
					text.insert(index, value);
					index += value.length;
				} else if (op === -1) {
					text.delete(index, value.length);
				}
			}

			doc.commit();
			
			// FIX: Export ONLY the tiny incremental delta generated since the oldVersion
			update = new Uint8Array(doc.export({ mode: 'update', from: oldVersion }));

			const snapshot = doc.export({ mode: 'snapshot' });
			await this.localStore.saveDocumentState(documentId, snapshot);

			return update;
		} finally {
			this.removeDoc(documentId);
		}
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
		this.loadingDocs.delete(documentId);
	}

	public destroy(): void {
		this.activeDocs.clear();
		this.refCounts.clear();
		this.fallbackCache.clear();
		this.loadingDocs.clear();
		this.localStore.close();
	}
}