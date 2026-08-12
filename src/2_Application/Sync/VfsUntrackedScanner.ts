import { App, TFolder, TAbstractFile } from 'obsidian';

export class VfsUntrackedScanner {
    constructor(private app: App) {}

    public scan(
        pathToUuid: Map<string, string>,
        justDeletedPaths: Set<string>
    ): TAbstractFile[] {
        const allFiles = this.app.vault.getAllLoadedFiles();
        const newFilesToTrack: TAbstractFile[] = [];

        for (const file of allFiles) {
            if (file.path === '/' || file.path.startsWith('.')) continue;

            if (!pathToUuid.has(file.path) && !justDeletedPaths.has(file.path)) {
                newFilesToTrack.push(file);
            }
        }
        return newFilesToTrack;
    }
}
