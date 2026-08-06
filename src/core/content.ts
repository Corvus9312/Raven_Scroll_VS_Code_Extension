/**
 * Turning raw book bytes into the payload the webview renders.
 * Pure — no `vscode` import, so it is unit-testable in plain Node.
 */

import { parseEpub } from '../epub';
import { isEpub, stripBookExt } from './book';

export interface ReaderPrefs {
    fontSize: number;
    lineHeight: number;
    fontFamily: string;
    theme: 'dark' | 'light';
}

export const DEFAULT_PREFS: ReaderPrefs = {
    fontSize: 14,
    lineHeight: 1.2,
    fontFamily: 'lxgw',
    theme: 'dark',
};

type BookContent =
    | { mode: 'txt';  text: string; title: string }
    | { mode: 'epub'; html: string; chapters: { title: string; anchor: string }[]; title: string };

/** Decode bytes into webview content — plain text, or a parsed EPUB. */
export function buildContentMsg(bytes: Uint8Array, fileName: string): BookContent {
    if (isEpub(fileName)) {
        try {
            const parsed = parseEpub(bytes);
            return {
                mode: 'epub',
                html: parsed.html,
                chapters: parsed.chapters,
                title: parsed.title || stripBookExt(fileName),
            };
        } catch (err: any) {
            return {
                mode: 'txt',
                text: `無法開啟此 EPUB：${err?.message ?? err}`,
                title: stripBookExt(fileName),
            };
        }
    }
    return { mode: 'txt', text: decodeBytes(bytes), title: stripBookExt(fileName) };
}

/**
 * Decode book text. TXT files in the wild are a mix of UTF-8 and GB18030, so an
 * explicit BOM wins outright and otherwise UTF-8 is tried strictly before
 * falling back to CJK.
 */
export function decodeBytes(bytes: Uint8Array): string {
    let data = bytes;
    const hasBom = data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF;
    if (hasBom) {
        data = data.slice(3);
        // BOM is authoritative: decode as UTF-8 lax (replace invalid bytes), never fall back to CJK
        return new TextDecoder('utf-8').decode(data);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
        try {
            return new TextDecoder('gb18030').decode(data);
        } catch {
            return new TextDecoder('utf-8').decode(data);
        }
    }
}
