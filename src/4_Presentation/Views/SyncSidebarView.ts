import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import MyPlugin from '../Plugin';
import { ServerTelemetry } from '@domain/Interfaces/IRemoteStore';

export const SYNC_SIDEBAR_VIEW_TYPE = 'crdt-sync-sidebar-view';

export class SyncSidebarView extends ItemView {
    private telemetry: ServerTelemetry | null = null;

    constructor(leaf: WorkspaceLeaf, private plugin: MyPlugin) {
        super(leaf);
    }

    getViewType(): string { return SYNC_SIDEBAR_VIEW_TYPE; }
    getDisplayText(): string { return 'CRDT Sync Status'; }
    getIcon(): string { return 'folder-sync'; }

    async onOpen() {
        this.render();
        this.registerInterval(window.setInterval(() => this.render(), 1000));
        this.registerInterval(window.setInterval(() => this.fetchTelemetry(), 5000));
        this.fetchTelemetry();
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

        // // --- Network Status Header ---
        // const headerEl = container.createDiv({ cls: 'nav-folder-title' });
        // headerEl.style.display = 'flex';
        // headerEl.style.justifyContent = 'space-between';
        // headerEl.style.alignItems = 'center';

        // headerEl.createSpan({ text: 'Network Status' });

        // if (isConnected && syncOrchestrator) {
        //     const ping = syncOrchestrator.getLastPing();
        //     if (ping !== null) {
        //         const tagEl = headerEl.createEl('span', { cls: 'tag', text: `${ping} ms` });
        //         tagEl.style.margin = '0';
        //         tagEl.style.fontWeight = 'var(--font-semibold)';

        //         if (ping < 120) {
        //             tagEl.style.color = 'var(--text-success)';
        //             tagEl.style.backgroundColor = 'rgba(46, 160, 67, 0.15)';
        //         } else if (ping < 350) {
        //             tagEl.style.color = 'var(--text-warning)';
        //             tagEl.style.backgroundColor = 'rgba(210, 153, 34, 0.15)';
        //         } else {
        //             tagEl.style.color = 'var(--text-error)';
        //             tagEl.style.backgroundColor = 'rgba(248, 81, 73, 0.15)';
        //         }
        //     } else {
        //         const tagEl = headerEl.createEl('span', { cls: 'tag', text: 'Connecting...' });
        //         tagEl.style.margin = '0';
        //         tagEl.style.color = 'var(--text-muted)';
        //     }
        // } else {
        //     const tagEl = headerEl.createEl('span', { cls: 'tag', text: 'Offline' });
        //     tagEl.style.margin = '0';
        //     tagEl.style.color = 'var(--text-error)';
        // }

        // --- System Telemetry Metrics Dashboard ---
        if (isConnected && this.telemetry) {
            container.createEl('h4', { text: 'Server Telemetry', cls: 'nav-folder-title' });
            
            const statsGrid = container.createDiv();
            statsGrid.style.display = 'grid';
            statsGrid.style.gridTemplateColumns = '1fr 1fr';
            statsGrid.style.gap = '8px';
            statsGrid.style.padding = '8px';
            statsGrid.style.marginBottom = '12px';
            statsGrid.style.border = '1px solid var(--background-modifier-border)';
            statsGrid.style.borderRadius = 'var(--radius-s)';
            statsGrid.style.backgroundColor = 'var(--background-secondary)';

            const createStat = (label: string, value: string, color?: string) => {
                const statBox = statsGrid.createDiv();
                statBox.style.display = 'flex';
                statBox.style.flexDirection = 'column';
                
                const labelEl = statBox.createSpan({ text: label });
                labelEl.style.fontSize = 'var(--font-ui-smaller)';
                labelEl.style.color = 'var(--text-muted)';
                labelEl.style.textTransform = 'uppercase';
                labelEl.style.letterSpacing = '0.05em';
                
                const valEl = statBox.createSpan({ text: value });
                valEl.style.fontWeight = 'var(--font-bold)';
                valEl.style.fontSize = 'var(--font-ui-medium)';
                if (color) valEl.style.color = color;
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
            // Filter out 'System Index' so it never clutters the UI list
            const activePaths = syncOrchestrator.getActiveSyncPaths().filter(p => p !== 'System Index');
            
            if (activePaths.length === 0) {
                const emptyEl = queueContainer.createDiv({ cls: 'nav-file' });
                emptyEl.createDiv({ cls: 'nav-file-title', text: 'All files are up to date.' }).style.color = 'var(--text-muted)';
            } else {
                for (const path of activePaths) {
                    const itemEl = queueContainer.createDiv({ cls: 'nav-file mod-clickable' });
                    
                    // Native UI styling with borders
                    itemEl.style.border = '1px solid var(--background-modifier-border)';
                    itemEl.style.borderRadius = 'var(--radius-s)';
                    itemEl.style.padding = '6px 8px';
                    itemEl.style.marginBottom = '6px';
                    itemEl.style.display = 'flex';
                    itemEl.style.alignItems = 'center';
                    itemEl.style.gap = '8px';

                    const iconEl = itemEl.createDiv({ cls: 'nav-file-icon' });
                    setIcon(iconEl, 'document');

                    // Split path into name and directory
                    const pathParts = path.split('/');
                    const fileName = pathParts.pop() || path;
                    const dirName = pathParts.join('/');

                    const textContainer = itemEl.createDiv();
                    textContainer.style.display = 'flex';
                    textContainer.style.flexDirection = 'column';
                    textContainer.style.overflow = 'hidden'; 

                    // File name 
                    const nameEl = textContainer.createDiv({ text: fileName });
                    nameEl.style.color = 'var(--text-normal)';
                    nameEl.style.fontWeight = 'var(--font-medium)';
                    nameEl.style.whiteSpace = 'nowrap';
                    nameEl.style.textOverflow = 'ellipsis';
                    nameEl.style.overflow = 'hidden';

                    // File path 
                    if (dirName) {
                        const pathEl = textContainer.createDiv({ text: dirName });
                        pathEl.style.color = 'var(--text-muted)';
                        pathEl.style.fontSize = 'var(--font-ui-smaller)';
                        pathEl.style.fontFamily = 'var(--font-monospace)';
                        pathEl.style.whiteSpace = 'nowrap';
                        pathEl.style.textOverflow = 'ellipsis';
                        pathEl.style.overflow = 'hidden';
                    }
                    
                    itemEl.onClickEvent(() => {
                        this.app.workspace.openLinkText(path, '', false);
                    });
                }
            }
        }
    }
}