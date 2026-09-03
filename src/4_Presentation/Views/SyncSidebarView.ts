import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import IlowSyncPlugin from '../Plugin';
import { ServerTelemetry } from '@domain/Interfaces/IRemoteStore';

export const SYNC_SIDEBAR_VIEW_TYPE = 'ilow-sync-sidebar-view';

export class SyncSidebarView extends ItemView {
	private telemetry: ServerTelemetry | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: IlowSyncPlugin) {
		super(leaf);
	}

	getViewType(): string { return SYNC_SIDEBAR_VIEW_TYPE; }
	getDisplayText(): string { return 'Ilow Sync Status'; }
	getIcon(): string { return 'folder-sync'; }

	async onOpen() {
		this.render();
		this.registerInterval(window.setInterval(() => this.render(), 1000));
		this.registerInterval(window.setInterval(() => { void this.fetchTelemetry(); }, 5000));
		void this.fetchTelemetry();
	}

	private async fetchTelemetry() {
		const store = this.plugin.getRemoteStore();
		if (store) {
			this.telemetry = await store.fetchTelemetry();
			this.render();
		}
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
	}

	private formatUptime(seconds: number): string {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;
		return `${h}h ${m}m ${s}s`;
	}

	render() {
		const container = this.containerEl.children[1];
		container.empty();
        
		const syncOrchestrator = this.plugin.getSyncOrchestrator();
		const isConnected = this.plugin.isKeyDerived;

		// --- System Telemetry Metrics Dashboard ---
		if (isConnected && this.telemetry) {
			container.createEl('h4', { text: 'Server Telemetry', cls: 'nav-folder-title' });
            
			const statsGrid = container.createDiv({ cls: 'ilow-sync-stats-grid' });

			const createStat = (label: string, value: string, color?: string) => {
				const statBox = statsGrid.createDiv({ cls: 'ilow-sync-stat-box' });
                
				statBox.createSpan({ cls: 'ilow-sync-stat-label', text: label });
                
				const valEl = statBox.createSpan({ cls: 'ilow-sync-stat-val', text: value });
				if (color) valEl.setCssStyles({ color });
			};

			const healthColor = this.telemetry.systemHealth === 'healthy' ? 'var(--text-success)' :
				this.telemetry.systemHealth === 'degraded' ? 'var(--text-warning)' : 'var(--text-error)';

			createStat('Health', this.telemetry.systemHealth.toUpperCase(), healthColor);
			createStat('Uptime', this.formatUptime(this.telemetry.uptimeSeconds));
			createStat('RPS (Live)', `${this.telemetry.rps}/s`);
			createStat('RPM (Avg/Hr)', `${this.telemetry.rpmAvgHour.toFixed(1)}/m`);
			createStat('Data Sent/Recv', this.formatBytes(this.telemetry.dataTransferredBytes));
			createStat('Active WS', `${this.telemetry.activeWebSockets}`);
			createStat('Mem Alloc', `${this.telemetry.memoryAllocMb.toFixed(1)} MB`);
			createStat('DB Conns', `${this.telemetry.dbConnections}`);
		}

		// --- Active Sync Queue List ---
		container.createEl('h4', { text: 'Active Sync Queue', cls: 'nav-folder-title' });
		const queueContainer = container.createDiv({ cls: 'nav-folder-children' });

		if (isConnected && syncOrchestrator) {
			const activePaths = (typeof syncOrchestrator.getActiveSyncPaths === 'function')
				? syncOrchestrator.getActiveSyncPaths().filter(p => p !== 'System Index')
				: [];
            
			if (activePaths.length === 0) {
				const emptyEl = queueContainer.createDiv({ cls: 'nav-file' });
				emptyEl.createDiv({ cls: 'nav-file-title ilow-sync-stat-label', text: 'All files are up to date.' });
			} else {
				for (const path of activePaths) {
					const itemEl = queueContainer.createDiv({ cls: 'ilow-sync-queue-item mod-clickable' });

					const iconEl = itemEl.createDiv({ cls: 'nav-file-icon' });
					setIcon(iconEl, 'document');

					const pathParts = path.split('/');
					const fileName = pathParts.pop() || path;
					const dirName = pathParts.join('/');

					const textContainer = itemEl.createDiv({ cls: 'ilow-sync-queue-text' });

					textContainer.createDiv({ cls: 'ilow-sync-queue-name', text: fileName });

					if (dirName) {
						textContainer.createDiv({ cls: 'ilow-sync-queue-path', text: dirName });
					}

					itemEl.onClickEvent(() => {
						void this.app.workspace.openLinkText(path, '', false);
					});
				}
			}
		}
	}
}