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
                    textContainer.style.overflow = 'hidden'; // Prevent text clipping

                    // File name (Primary color, bold)
                    const nameEl = textContainer.createDiv({ text: fileName });
                    nameEl.style.color = 'var(--text-normal)';
                    nameEl.style.fontWeight = 'var(--font-medium)';
                    nameEl.style.whiteSpace = 'nowrap';
                    nameEl.style.textOverflow = 'ellipsis';
                    nameEl.style.overflow = 'hidden';

                    // File path (Monospace, small, grey)
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