import { Note } from '../Entities/Models';

export interface INoteRepository {
    readNote(path: string): Promise<string | null>;
    writeNote(path: string, content: string): Promise<void>;
    listAllNotes(): Promise<string[]>;
    onNoteChange(callback: (path: string, content: string) => void): void;
}
