import { App } from 'obsidian';

export class VfsReconciliationService {
    constructor(private app: App) {}

    public async executePhase2(
        toKeep: Array<[string, any]>,
        uuidToLastKnownPath: Map<string, string>,
        ensureFolderExists: (filePath: string, isFolderPath: boolean) => Promise<void>,
        safeExists: (p: string) => Promise<boolean>
    ): Promise<void> {
        for (const [uuid, node] of toKeep) {
            const localFile = this.app.vault.getAbstractFileByPath(node.path);
            if (!localFile && !(await safeExists(node.path))) {
                await this.recreateOrRename(uuid, node, uuidToLastKnownPath, ensureFolderExists);
            }
            uuidToLastKnownPath.set(uuid, node.path);
        }
    }

    private async recreateOrRename(
        uuid: string,
        node: any,
        uuidToLastKnownPath: Map<string, string>,
        ensureFolderExists: (filePath: string, isFolderPath: boolean) => Promise<void>
    ): Promise<void> {
        const lastKnownPath = uuidToLastKnownPath.get(uuid);
        const oldLocalFile = lastKnownPath ? this.app.vault.getAbstractFileByPath(lastKnownPath) : null;

        if (oldLocalFile) {
            await ensureFolderExists(node.path, false);
            try {
                await this.app.fileManager.renameFile(oldLocalFile, node.path);
            } catch (e) {}
        } else {
            const isFolder = node.type === 'folder';
            await ensureFolderExists(node.path, isFolder);
        }
    }
}
