/**
 * The reader's behaviour, in one place.
 *
 * One session drives one webview. It owns the whole message contract with
 * `media/reader.js` — loading content, restoring and saving progress, reader
 * preferences, and moving on to the next book. It knows nothing about where the
 * book came from (that is a `BookSource`) or where the webview is displayed
 * (that is a host in `readerHosts.ts`).
 */

import * as vscode from 'vscode';
import { BookRef, BookSources } from './bookSource';
import { PREFS_KEY } from './keys';
import { buildContentMsg, DEFAULT_PREFS, ReaderPrefs } from './core/content';
import { stripBookExt } from './core/book';

export interface SessionDeps {
    context: vscode.ExtensionContext;
    sources: BookSources;
    /** Refresh the library trees after progress is written. */
    onProgressSaved: () => void;
    /** Bring this session's webview to the front. */
    reveal?: () => void | Promise<void>;
    /**
     * How to open a *different* book — normally the router, so "next book"
     * honours the `openIn` setting.
     *
     * Without this a session would swap content in place, which is right for the
     * reusable panel view but wrong for an editor tab: the tab is bound to one
     * book for its title and for restoring after a reload, so a swapped-in book
     * would leave the tab describing the wrong thing.
     */
    openBook?: (ref: BookRef) => Promise<void>;
}

export class ReaderSession {
    private webview?: vscode.Webview;
    private ready = false;
    private pending?: object;
    private current?: BookRef;

    constructor(private readonly deps: SessionDeps) {}

    /** Wire up a webview. Returns a disposable that unhooks it. */
    attach(webview: vscode.Webview): vscode.Disposable {
        this.webview = webview;
        this.ready   = false;

        const sub = webview.onDidReceiveMessage(msg => this.handle(msg));
        return new vscode.Disposable(() => {
            sub.dispose();
            if (this.webview === webview) {
                this.webview = undefined;
                this.ready   = false;
            }
        });
    }

    /** Load a book into this session's webview. */
    async open(ref: BookRef): Promise<void> {
        const source = this.deps.sources.for(ref);
        const bytes  = await source.readBytes(ref);

        this.current = ref;
        source.noteOpened(ref);

        const progress = await source.readProgress(ref);
        await this.post({
            type: 'loadContent',
            ...buildContentMsg(bytes, ref.fileName),
            savedProgress: progress?.scrollTop ?? 0,
            prefs: this.prefs(),
            uriKey: ref.uriKey,
            // Echoed back by the webview via setState, so a reloaded window can
            // restore the tab without the extension tracking it separately.
            fileName: ref.fileName,
        });
    }

    // ── Message loop ────────────────────────────────────────────────────────

    private async handle(msg: any): Promise<void> {
        switch (msg?.type) {
            case 'ready':
                this.ready = true;
                if (this.pending) {
                    const queued = this.pending;
                    this.pending = undefined;
                    await this.webview?.postMessage(queued);
                }
                break;

            case 'saveProgress':
                await this.saveProgress(msg.uriKey, msg.scrollTop, msg.percent ?? 0);
                break;

            case 'savePrefs':
                await this.deps.context.globalState.update(PREFS_KEY, msg.prefs as ReaderPrefs);
                break;

            case 'requestNextFile': {
                const next = await this.deps.sources.for(msg.uriKey).nextBook(this.refFor(msg.uriKey));
                await this.webview?.postMessage(
                    next
                        ? { type: 'nextFile', exists: true, name: stripBookExt(next.fileName), fileName: next.fileName, uriKey: next.uriKey }
                        : { type: 'nextFile', exists: false }
                );
                break;
            }

            case 'openNextFile': {
                const next = { uriKey: msg.uriKey, fileName: msg.fileName ?? '' };
                await (this.deps.openBook ? this.deps.openBook(next) : this.open(next));
                break;
            }
        }
    }

    private async saveProgress(uriKey: string, scrollTop: number, percent: number): Promise<void> {
        if (!uriKey) { return; }
        await this.deps.sources.for(uriKey).writeProgress(this.refFor(uriKey), { scrollTop, percent });
        vscode.window.setStatusBarMessage(`💾 ${percent}%`, 2000);
        this.deps.onProgressSaved();
    }

    // ── Plumbing ────────────────────────────────────────────────────────────

    /**
     * Rebuild a ref from a key the webview sent.
     *
     * The name is only filled in when the key still matches the loaded book: on
     * a switch, reader.js flushes the *previous* book's progress after this
     * session has already moved on, so `current.fileName` would be the wrong name
     * for that key.
     */
    private refFor(uriKey: string): BookRef {
        return {
            uriKey,
            fileName: this.current?.uriKey === uriKey ? this.current.fileName : '',
        };
    }

    private prefs(): ReaderPrefs {
        return this.deps.context.globalState.get<ReaderPrefs>(PREFS_KEY, DEFAULT_PREFS);
    }

    /**
     * Send to the webview, or queue until it signals `ready`. A webview that has
     * only just been created has no listener yet, so posting immediately would
     * drop the message.
     */
    private async post(msg: object): Promise<void> {
        if (this.webview && this.ready) {
            await this.webview.postMessage(msg);
        } else {
            this.pending = msg;
        }
        await this.deps.reveal?.();
    }
}
