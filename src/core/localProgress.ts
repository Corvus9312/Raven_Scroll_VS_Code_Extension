/**
 * Synchronous sidecar reads for the library trees.
 *
 * `BookSource` is the async path used while reading; the trees build many items
 * at once and need a cheap synchronous lookup, so they share this instead of
 * each re-deriving the sidecar format. Pure Node — no `vscode` import.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isBookFile, parseProgress, sidecarName, Progress } from './book';

export function readLocalProgress(filePath: string): Progress | null {
    const sidecar = path.join(path.dirname(filePath), sidecarName(path.basename(filePath)));
    try {
        return parseProgress(JSON.parse(fs.readFileSync(sidecar, 'utf8')));
    } catch {
        return null;
    }
}

/** Progress of every book directly inside `folderPath`. */
export function readFolderProgress(folderPath: string): (Progress | null)[] {
    try {
        return fs.readdirSync(folderPath)
            .filter(isBookFile)
            .map(name => readLocalProgress(path.join(folderPath, name)));
    } catch {
        return [];
    }
}
