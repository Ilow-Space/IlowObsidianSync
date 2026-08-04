import { describe, it, expect, vi } from 'vitest';
import { ObsidianNoteRepository } from '../src/3_Infrastructure/Obsidian/ObsidianNoteRepository';

describe('ObsidianNoteRepository', () => {
    it('BUG REGRESSION: writeNote must recursively create missing parent directories', async () => {
        const appMock = {
            vault: {
                on: vi.fn(),
                getAbstractFileByPath: vi.fn().mockReturnValue(null),
                createFolder: vi.fn().mockResolvedValue(undefined),
                create: vi.fn().mockResolvedValue(undefined)
            }
        };
        const repo = new ObsidianNoteRepository(appMock as any);

        await repo.writeNote('Deep/Nested/Path/Doc.md', 'Data');

        expect(appMock.vault.createFolder).toHaveBeenCalledWith('Deep');
        expect(appMock.vault.createFolder).toHaveBeenCalledWith('Deep/Nested');
        expect(appMock.vault.createFolder).toHaveBeenCalledWith('Deep/Nested/Path');
        expect(appMock.vault.create).toHaveBeenCalledWith('Deep/Nested/Path/Doc.md', 'Data');
    });
});