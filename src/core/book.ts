/**
 * Pure helpers shared by every reader path — book identity, progress parsing,
 * and sibling ordering.
 *
 * This module must never import `vscode`: it is unit-tested in plain Node
 * against the compiled output in `out/core/book.js`.
 */

const DRIVE_SCHEME   = 'drive://';
const SIDECAR_PREFIX = '.corvus.';
const SIDECAR_SUFFIX = '.json';

// ── Book formats ────────────────────────────────────────────────────────────

export function isEpub(name: string): boolean {
    return name.toLowerCase().endsWith('.epub');
}

export function isBookFile(name: string): boolean {
    const n = name.toLowerCase();
    return n.endsWith('.txt') || n.endsWith('.epub');
}

export function stripBookExt(name: string): string {
    return name.replace(/\.(txt|epub)$/i, '');
}

// ── Drive keys ──────────────────────────────────────────────────────────────
// A Drive book is identified by `drive://<folderId>/<fileId>`, or by
// `drive://<fileId>` when it was opened without a known parent folder.

export function isDriveKey(uriKey: string): boolean {
    return uriKey.startsWith(DRIVE_SCHEME);
}

export function makeDriveKey(fileId: string, folderId?: string): string {
    return folderId
        ? `${DRIVE_SCHEME}${folderId}/${fileId}`
        : `${DRIVE_SCHEME}${fileId}`;
}

export function parseDriveKey(uriKey: string): { fileId: string; folderId?: string } {
    const raw   = uriKey.slice(DRIVE_SCHEME.length);
    const slash = raw.indexOf('/');
    if (slash === -1) { return { fileId: raw }; }
    return { folderId: raw.slice(0, slash), fileId: raw.slice(slash + 1) };
}

// ── Local sidecar progress files ────────────────────────────────────────────
// Progress for a local book lives in `.corvus.<filename>.json` beside it, so it
// travels with the folder and the library trees can read it without opening the book.

export function sidecarName(fileName: string): string {
    return `${SIDECAR_PREFIX}${fileName}${SIDECAR_SUFFIX}`;
}

export function isSidecarName(name: string): boolean {
    return name.startsWith(SIDECAR_PREFIX) && name.endsWith(SIDECAR_SUFFIX);
}

// ── Progress ────────────────────────────────────────────────────────────────

export interface Progress {
    scrollTop: number;
    /** 0–100, or -1 when the position is known but the percent predates the format. */
    percent: number;
}

/**
 * Parse a stored progress payload. Returns null when nothing was ever recorded.
 * Tolerates the pre-1.0 format that stored only `scrollTop`.
 */
export function parseProgress(raw: unknown): Progress | null {
    if (!raw || typeof raw !== 'object') { return null; }
    const data      = raw as Record<string, unknown>;
    const scrollTop = typeof data.scrollTop === 'number' ? data.scrollTop : 0;
    if (typeof data.percent === 'number') { return { scrollTop, percent: data.percent }; }
    if (scrollTop > 0) { return { scrollTop, percent: -1 }; }
    return null;
}

/** Label shown next to a book in the library trees. `undefined` = show nothing. */
export function describePercent(percent: number | null | undefined): string | undefined {
    if (percent === null || percent === undefined) { return undefined; }
    if (percent < 0)   { return '閱讀中'; }
    if (percent >= 95) { return '✓ 完結'; }
    if (percent > 0)   { return `${percent}%`; }
    return undefined;
}

export function describeProgress(progress: Progress | null): string | undefined {
    return describePercent(progress?.percent ?? null);
}

function isCompleted(progress: Progress | null): boolean {
    return !!progress && progress.percent >= 95;
}

/** Folder-level summary, e.g. "3 / 10" — or undefined for an empty folder. */
export function describeFolderProgress(progresses: (Progress | null)[]): string | undefined {
    if (progresses.length === 0) { return undefined; }
    return `${progresses.filter(isCompleted).length} / ${progresses.length}`;
}

// ── Sibling ordering ────────────────────────────────────────────────────────

interface BookEntry {
    id: string;
    name: string;
}

/** Books in a folder, in the display order both library trees use. */
function sortBooks<T extends BookEntry>(entries: T[]): T[] {
    return entries
        .filter(e => isBookFile(e.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));
}

/** The book after `currentId` in the same folder, or undefined at the end. */
export function nextBook<T extends BookEntry>(entries: T[], currentId: string): T | undefined {
    const books = sortBooks(entries);
    const idx   = books.findIndex(e => e.id === currentId);
    return idx >= 0 && idx < books.length - 1 ? books[idx + 1] : undefined;
}
