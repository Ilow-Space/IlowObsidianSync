import mitt, { Emitter } from 'mitt';
import { z } from 'zod';

export const LocalFileCreatedSchema = z.object({
	path: z.string(),
	isFolder: z.boolean(),
	content: z.string().optional()
});

export const LocalFileRenamedSchema = z.object({
	oldPath: z.string(),
	newPath: z.string()
});

export const LocalFileModifiedSchema = z.object({
	path: z.string(),
	content: z.string()
});

export const LocalFileDeletedSchema = z.object({
	path: z.string()
});

export const CrdtNodeCreatedSchema = z.object({
	uuid: z.string(),
	path: z.string(),
	isFolder: z.boolean(),
	content: z.string().optional()
});

export const CrdtNodeMovedSchema = z.object({
	uuid: z.string(),
	oldPath: z.string(),
	newPath: z.string()
});

export const CrdtTextChangedSchema = z.object({
	uuid: z.string(),
	path: z.string(),
	content: z.string()
});

export const CrdtNodeSoftDeletedSchema = z.object({
	uuid: z.string(),
	path: z.string()
});

export const RemoteSnapshotReceivedSchema = z.object({
	documentId: z.string(),
	encryptedState: z.any()
});

export const IncrementalUpdatesReceivedSchema = z.object({
	documentId: z.string(),
	updates: z.array(z.any())
});

export const LocalDeltaReadyForPushSchema = z.object({
	documentId: z.string(),
	updateBinary: z.instanceof(Uint8Array),
	path: z.string().nullable().optional()
});

export const RebalancePathUuidSchema = z.object({
	path: z.string(),
	remoteUuid: z.string()
});

export type LocalFileCreated = z.infer<typeof LocalFileCreatedSchema>;
export type LocalFileRenamed = z.infer<typeof LocalFileRenamedSchema>;
export type LocalFileModified = z.infer<typeof LocalFileModifiedSchema>;
export type LocalFileDeleted = z.infer<typeof LocalFileDeletedSchema>;

export type CrdtNodeCreated = z.infer<typeof CrdtNodeCreatedSchema>;
export type CrdtNodeMoved = z.infer<typeof CrdtNodeMovedSchema>;
export type CrdtTextChanged = z.infer<typeof CrdtTextChangedSchema>;
export type CrdtNodeSoftDeleted = z.infer<typeof CrdtNodeSoftDeletedSchema>;

export type RemoteSnapshotReceived = z.infer<typeof RemoteSnapshotReceivedSchema>;
export type IncrementalUpdatesReceived = z.infer<typeof IncrementalUpdatesReceivedSchema>;
export type LocalDeltaReadyForPush = z.infer<typeof LocalDeltaReadyForPushSchema>;

export type RebalancePathUuid = z.infer<typeof RebalancePathUuidSchema>;

export type SyncEvents = {
	LocalFileCreated: LocalFileCreated;
	LocalFileRenamed: LocalFileRenamed;
	LocalFileModified: LocalFileModified;
	LocalFileDeleted: LocalFileDeleted;

	CrdtNodeCreated: CrdtNodeCreated;
	CrdtNodeMoved: CrdtNodeMoved;
	CrdtTextChanged: CrdtTextChanged;
	CrdtNodeSoftDeleted: CrdtNodeSoftDeleted;

	RemoteSnapshotReceived: RemoteSnapshotReceived;
	IncrementalUpdatesReceived: IncrementalUpdatesReceived;
	LocalDeltaReadyForPush: LocalDeltaReadyForPush;
	RebalancePathUuid: RebalancePathUuid;
};

export class SyncEventBus {
	private emitter: Emitter<SyncEvents>;

	constructor() {
		this.emitter = mitt<SyncEvents>();
	}

	public emit<K extends keyof SyncEvents>(event: K, payload: SyncEvents[K]): void {
		this.validate(event, payload);
		this.emitter.emit(event, payload);
	}

	public on<K extends keyof SyncEvents>(event: K, handler: (payload: SyncEvents[K]) => void): void {
		this.emitter.on(event, handler);
	}

	public off<K extends keyof SyncEvents>(event: K, handler: (payload: SyncEvents[K]) => void): void {
		this.emitter.off(event, handler);
	}

	public clear(): void {
		this.emitter.all.clear();
	}

	public destroy(): void {
		this.clear();
	}

	private validate<K extends keyof SyncEvents>(event: K, payload: any): void {
		switch (event) {
			case 'LocalFileCreated':
				LocalFileCreatedSchema.parse(payload);
				break;
			case 'LocalFileRenamed':
				LocalFileRenamedSchema.parse(payload);
				break;
			case 'LocalFileModified':
				LocalFileModifiedSchema.parse(payload);
				break;
			case 'LocalFileDeleted':
				LocalFileDeletedSchema.parse(payload);
				break;
			case 'CrdtNodeCreated':
				CrdtNodeCreatedSchema.parse(payload);
				break;
			case 'CrdtNodeMoved':
				CrdtNodeMovedSchema.parse(payload);
				break;
			case 'CrdtTextChanged':
				CrdtTextChangedSchema.parse(payload);
				break;
			case 'CrdtNodeSoftDeleted':
				CrdtNodeSoftDeletedSchema.parse(payload);
				break;
			case 'RemoteSnapshotReceived':
				RemoteSnapshotReceivedSchema.parse(payload);
				break;
			case 'IncrementalUpdatesReceived':
				IncrementalUpdatesReceivedSchema.parse(payload);
				break;
			case 'LocalDeltaReadyForPush':
				LocalDeltaReadyForPushSchema.parse(payload);
				break;
			case 'RebalancePathUuid':
				RebalancePathUuidSchema.parse(payload);
				break;
			default:
				throw new Error(`Unknown event type to validate: ${event}`);
		}
	}
}
