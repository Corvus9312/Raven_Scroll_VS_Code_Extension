/**
 * Where a book's bytes and reading progress come from.
 *
 * A source is the *only* thing that differs between a local file and a Google
 * Drive file. Everything above this layer — the reader UI, the message loop, the
 * choice of where the webview is displayed — is shared.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { GoogleDriveClient } from './googleDrive';
import { LIBRARY_KEY } from './keys';
import * as book from './core/book';

/** Identifies one book, whatever it is stored in. */
export interface BookRef {
    /** Canonical identity: a `file:` URI string, or `drive://[folderId/]fileId`. */
    uriKey: string;
    /** File name including extension, used for titles and format detection. */
    fileName: string;
}

export interface BookSource {
    readBytes(ref: BookRef): Promise<Uint8Array>;
    readProgress(ref: BookRef): Promise<book.Progress | null>;
    writeProgress(ref: BookRef, progress: book.Progress): Promise<void>;
    /** The next book in the same folder, or undefined at the end. */
    nextBook(ref: BookRef): Promise<BookRef | undefined>;
    /** Hook for sources that maintain a recent-reads list. */
    noteOpened(ref: BookRef): void;
}

// ── Local files ─────────────────────────────────────────────────────────────

export class LocalBookSource implements BookSource {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly onLibraryChanged: () => void
    ) {}

    static refFor(uri: vscode.Uri): BookRef {
        return { uriKey: uri.toString(), fileName: path.basename(uri.fsPath) };
    }

    async readBytes(ref: BookRef): Promise<Uint8Array> {
        return vscode.workspace.fs.readFile(vscode.Uri.parse(ref.uriKey));
    }

    async readProgress(ref: BookRef): Promise<book.Progress | null> {
        try {
            const bytes = await vscode.workspace.fs.readFile(sidecarUri(vscode.Uri.parse(ref.uriKey)));
            return book.parseProgress(JSON.parse(Buffer.from(bytes).toString('utf8')));
        } catch {
            return null; // never opened, or the sidecar is unreadable
        }
    }

    async writeProgress(ref: BookRef, progress: book.Progress): Promise<void> {
        try {
            await vscode.workspace.fs.writeFile(
                sidecarUri(vscode.Uri.parse(ref.uriKey)),
                Buffer.from(JSON.stringify(progress), 'utf8')
            );
        } catch { /* read-only media — don't disrupt reading */ }
    }

    async nextBook(ref: BookRef): Promise<BookRef | undefined> {
        try {
            const uri     = vscode.Uri.parse(ref.uriKey);
            const dir     = vscode.Uri.joinPath(uri, '..');
            const entries = await vscode.workspace.fs.readDirectory(dir);
            const files   = entries
                .filter(([, type]) => type === vscode.FileType.File)
                .map(([name]) => ({ id: name, name }));

            const next = book.nextBook(files, path.basename(uri.fsPath));
            if (!next) { return undefined; }
            return LocalBookSource.refFor(vscode.Uri.joinPath(dir, next.name));
        } catch {
            return undefined;
        }
    }

    noteOpened(ref: BookRef): void {
        const fsPath  = vscode.Uri.parse(ref.uriKey).fsPath;
        const library = this.context.globalState.get<string[]>(LIBRARY_KEY, []);
        const updated = [fsPath, ...library.filter(p => p !== fsPath)];
        if (updated.length > 50) { updated.length = 50; }
        this.context.globalState.update(LIBRARY_KEY, updated);
        this.onLibraryChanged();
    }
}

/** `.corvus.<name>.json` beside the book. */
function sidecarUri(fileUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(fileUri, '..', book.sidecarName(path.basename(fileUri.fsPath)));
}

// ── Google Drive ────────────────────────────────────────────────────────────

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

export class DriveBookSource implements BookSource {
    constructor(private readonly drive: GoogleDriveClient) {}

    static refFor(fileId: string, fileName: string, folderId?: string): BookRef {
        return { uriKey: book.makeDriveKey(fileId, folderId), fileName };
    }

    async readBytes(ref: BookRef): Promise<Uint8Array> {
        const { fileId } = book.parseDriveKey(ref.uriKey);
        return new Uint8Array(await this.drive.downloadFile(fileId));
    }

    async readProgress(ref: BookRef): Promise<book.Progress | null> {
        const { fileId }  = book.parseDriveKey(ref.uriKey);
        const stored      = await this.drive.getProgress(fileId);
        return stored.scrollTop > 0 || stored.percent > 0 ? stored : null;
    }

    async writeProgress(ref: BookRef, progress: book.Progress): Promise<void> {
        const { fileId } = book.parseDriveKey(ref.uriKey);
        await this.drive.saveProgress(fileId, progress.scrollTop, progress.percent);
    }

    async nextBook(ref: BookRef): Promise<BookRef | undefined> {
        const { fileId, folderId } = book.parseDriveKey(ref.uriKey);
        if (!folderId) { return undefined; } // opened without a known parent
        try {
            const files = (await this.drive.listFiles(folderId))
                .filter(f => f.mimeType !== DRIVE_FOLDER_MIME);
            const next  = book.nextBook(files, fileId);
            if (!next) { return undefined; }
            return DriveBookSource.refFor(next.id, next.name, folderId);
        } catch {
            return undefined;
        }
    }

    noteOpened(): void {
        // The recent-reads tree is backed by local file paths; Drive books have none.
    }
}

// ── Resolution ──────────────────────────────────────────────────────────────

export class BookSources {
    constructor(
        readonly local: LocalBookSource,
        readonly drive: DriveBookSource
    ) {}

    /** Pick the source that owns this book, by key scheme. */
    for(ref: BookRef | string): BookSource {
        const uriKey = typeof ref === 'string' ? ref : ref.uriKey;
        return book.isDriveKey(uriKey) ? this.drive : this.local;
    }
}
