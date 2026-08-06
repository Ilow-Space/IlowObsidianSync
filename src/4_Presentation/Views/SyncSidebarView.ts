import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import MyPlugin from '../Plugin';

export const SYNC_SIDEBAR_VIEW_TYPE = 'crdt-sync-sidebar-view';

export class SyncSidebarView extends ItemView {
    constructor(leaf: WorkspaceLeaf, private plugin: MyPlugin) {
        super(leaf);
    }

    getViewType(): string { return SYNC_SIDEBAR_VIEW_TYPE; }
    getDisplayText(): string { return 'CRDT Sync Status'; }
    getIcon(): string { return 'folder-sync'; }

    async onOpen() {
        this.render();
        this.registerInterval(window.setInterval(() => this.render(), 1000));
    }

    render() {
        const container = this.containerEl.children[1];
        container.empty();
        
        const syncOrchestrator = this.plugin.getSyncOrchestrator();
        const isConnected = this.plugin.isKeyDerived;

        // Header + Latency Badge
        const headerEl = container.createDiv({ cls: 'nav-folder-title' });
        headerEl.style.display = 'flex';
        headerEl.style.justifyContent = 'space-between';
        headerEl.style.alignItems = 'center';

        headerEl.createSpan({ text: 'Network Status' });

        if (isConnected && syncOrchestrator) {
            const ping = syncOrchestrator.getLastPing();
            if (ping !== null) {
                const tagEl = headerEl.createEl('span', { cls: 'tag', text: `${ping} ms` });
                tagEl.style.margin = '0';
                tagEl.style.fontWeight = 'var(--font-semibold)';

                if (ping < 120) {
                    tagEl.style.color = 'var(--text-success)';
                    tagEl.style.backgroundColor = 'rgba(46, 160, 67, 0.15)';
                } else if (ping < 350) {
                    tagEl.style.color = 'var(--text-warning)';
                    tagEl.style.backgroundColor = 'rgba(210, 153, 34, 0.15)';
                } else {
                    tagEl.style.color = 'var(--text-error)';
                    tagEl.style.backgroundColor = 'rgba(248, 81, 73, 0.15)';
                }
            } else {
                const tagEl = headerEl.createEl('span', { cls: 'tag', text: 'Connecting...' });
                tagEl.style.margin = '0';
                tagEl.style.color = 'var(--text-muted)';
            }
        } else {
            const tagEl = headerEl.createEl('span', { cls: 'tag', text: 'Offline' });
            tagEl.style.margin = '0';
            tagEl.style.color = 'var(--text-error)';
        }

        // Active Sync Queue List
        container.createEl('h4', { text: 'Active Sync Queue', cls: 'nav-folder-title' });
        const queueContainer = container.createDiv({ cls: 'nav-folder-children' });

        if (isConnected && syncOrchestrator) {
            const activePaths = syncOrchestrator.getActiveSyncPaths();
            
            if (activePaths.length === 0) {
                const emptyEl = queueContainer.createDiv({ cls: 'nav-file' });
                emptyEl.createDiv({ cls: 'nav-file-title', text: 'All files are up to date.' }).style.color = 'var(--text-muted)';
            } else {
                for (const path of activePaths) {
                    const itemEl = queueContainer.createDiv({ cls: 'nav-file mod-clickable' });
                    const titleEl = itemEl.createDiv({ cls: 'nav-file-title' });
                    
                    const iconEl = titleEl.createDiv({ cls: 'nav-file-icon' });
                    setIcon(iconEl, 'document');
                    
                    titleEl.createDiv({ cls: 'nav-file-title-content', text: path });
                    
                    itemEl.onClickEvent(() => {
                        if (path !== 'System Index') {
                            this.app.workspace.openLinkText(path, '', false);
                        }
                    });
                }
            }
        }
    }
}