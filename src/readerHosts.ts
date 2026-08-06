/**
 * Where the reader webview is displayed.
 *
 * Each host is a thin shell: create a webview, hand it to a `ReaderSession`, and
 * get out of the way. All reading behaviour lives in the session, so the three
 * hosts differ only in placement and lifecycle.
 */

import * as vscode from 'vscode';
import { BookRef, BookSources, LocalBookSource } from './bookSource';
import { ReaderSession, SessionDeps } from './readerSession';
import { buildReaderHtml } from './utils';
import { stripBookExt } from './core/book';

/**
 * Everything a host needs to build a session. `openBook` is the router, so that
 * opening a *different* book always re-enters routing and lands wherever the
 * `openIn` setting says — rather than each host deciding for itself.
 */
type Deps = Omit<SessionDeps, 'reveal'>;

function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    };
}

/** A book currently on screen somewhere, and how to take it off screen. */
interface OpenReader {
    ref: BookRef;
    close(): void;
}

/**
 * The reader tabs in the editor area — both custom editors (local books) and
 * standalone panels (Drive books). Tracked so that switching `openIn` can carry
 * the book you are reading over to the panel instead of stranding it.
 */
export class EditorTabs {
    private readonly tabs = new Map<vscode.WebviewPanel, BookRef>();

    track(panel: vscode.WebviewPanel, ref: BookRef): void {
        this.tabs.set(panel, ref);
        panel.onDidDispose(() => this.tabs.delete(panel));
    }

    /** The focused reader tab, or the only one if none has focus. */
    active(): OpenReader | undefined {
        const entries = [...this.tabs.entries()];
        const found = entries.find(([panel]) => panel.active) ?? (entries.length === 1 ? entries[0] : undefined);
        if (!found) { return undefined; }
        const [panel, ref] = found;
        return { ref, close: () => panel.dispose() };
    }
}

// ── Bottom panel (a single, reused view) ────────────────────────────────────

export class PanelViewHost implements vscode.WebviewViewProvider {
    public static readonly viewType = 'corvusTxtReader.readerView';

    private readonly session: ReaderSession;
    private view?: vscode.WebviewView;
    private book?: BookRef;

    constructor(private readonly deps: Deps) {
        this.session = new ReaderSession({
            ...deps,
            reveal: () => this.reveal(),
        });
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = webviewOptions(this.deps.context.extensionUri);
        view.webview.html    = buildReaderHtml(view.webview, this.deps.context.extensionUri);

        const attached = this.session.attach(view.webview);
        view.onDidDispose(() => {
            attached.dispose();
            this.view = undefined;
        });
    }

    async open(ref: BookRef): Promise<void> {
        this.book = ref;
        await this.session.open(ref);
    }

    /** The book showing in the panel, so a switch to the editor can take it along. */
    current(): OpenReader | undefined {
        if (!this.book) { return undefined; }
        const ref = this.book;
        // Nothing to close: the panel view hides itself once `openIn` is `editor`.
        return { ref, close: () => { this.book = undefined; } };
    }

    private async reveal(): Promise<void> {
        if (this.view) {
            this.view.show(true);
        } else {
            // Not resolved yet — focusing the view creates it, which replays the
            // queued content once the webview reports ready.
            await vscode.commands.executeCommand(`${PanelViewHost.viewType}.focus`);
        }
    }
}

// ── Main editor area, as a standalone webview panel ─────────────────────────
// Used for books that have no file URI (Google Drive), which the custom editor
// below cannot open.

export class EditorPanelHost {
    public static readonly viewType = 'corvusTxtReader.readerPanel';

    /** One panel per book, so re-opening focuses instead of duplicating. */
    private readonly open = new Map<string, vscode.WebviewPanel>();

    constructor(private readonly deps: Deps, private readonly tabs: EditorTabs) {}

    async show(ref: BookRef): Promise<void> {
        const existing = this.open.get(ref.uriKey);
        if (existing) {
            existing.reveal(existing.viewColumn);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            EditorPanelHost.viewType,
            stripBookExt(ref.fileName),
            vscode.ViewColumn.Active,
            { ...webviewOptions(this.deps.context.extensionUri), retainContextWhenHidden: true }
        );
        await this.adopt(panel, ref);
    }

    /**
     * Restore panels after a window reload. The book to reload comes from the
     * state the webview saved, so these tabs come back like custom-editor tabs do.
     */
    register(): vscode.Disposable {
        return vscode.window.registerWebviewPanelSerializer(EditorPanelHost.viewType, {
            deserializeWebviewPanel: async (panel, state: any) => {
                const ref = toRef(state);
                if (!ref) {
                    panel.dispose(); // nothing recorded — don't leave a blank tab
                    return;
                }
                panel.webview.options = webviewOptions(this.deps.context.extensionUri);
                await this.adopt(panel, ref);
            },
        });
    }

    private async adopt(panel: vscode.WebviewPanel, ref: BookRef): Promise<void> {
        panel.webview.html = buildReaderHtml(panel.webview, this.deps.context.extensionUri);

        const session  = new ReaderSession({ ...this.deps, reveal: () => panel.reveal(panel.viewColumn) });
        const attached = session.attach(panel.webview);

        this.open.set(ref.uriKey, panel);
        this.tabs.track(panel, ref);
        panel.onDidDispose(() => {
            attached.dispose();
            this.open.delete(ref.uriKey);
        });

        try {
            await session.open(ref);
        } catch (err) {
            panel.dispose(); // don't leave an empty tab behind a failed download
            throw err;
        }
    }
}

function toRef(state: unknown): BookRef | undefined {
    if (!state || typeof state !== 'object') { return undefined; }
    const { uriKey, fileName } = state as Record<string, unknown>;
    if (typeof uriKey !== 'string' || !uriKey) { return undefined; }
    return { uriKey, fileName: typeof fileName === 'string' ? fileName : '' };
}

// ── Main editor area, as a custom editor ────────────────────────────────────
// Registered for *.txt / *.epub so opening a book from the Explorer (or restoring
// a tab after a window reload) renders the reader instead of raw text.

export class ReaderEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'corvusTxtReader.reader';

    constructor(private readonly deps: Deps, private readonly tabs: EditorTabs) {}

    static register(deps: Deps, tabs: EditorTabs): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            ReaderEditorProvider.viewType,
            new ReaderEditorProvider(deps, tabs),
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        panel: vscode.WebviewPanel
    ): Promise<void> {
        panel.webview.options = webviewOptions(this.deps.context.extensionUri);
        panel.webview.html    = buildReaderHtml(panel.webview, this.deps.context.extensionUri);

        const session  = new ReaderSession({ ...this.deps, reveal: () => panel.reveal(panel.viewColumn) });
        const attached = session.attach(panel.webview);
        panel.onDidDispose(() => attached.dispose());

        const ref = LocalBookSource.refFor(document.uri);
        this.tabs.track(panel, ref);
        await session.open(ref);
    }
}

// ── Routing ─────────────────────────────────────────────────────────────────

export type OpenIn = 'editor' | 'panel';

const CONFIG_SECTION = 'corvusTxtReader';
const OPEN_IN_KEY    = 'openIn';

/** The configured location, normalised — anything unrecognised means the panel. */
export function readOpenIn(): OpenIn {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(OPEN_IN_KEY, 'panel');
    return value === 'editor' ? 'editor' : 'panel';
}

/**
 * Menus and the panel view's visibility key off `config.corvusTxtReader.openIn`
 * directly, so writing the setting is all that is needed — there is no mirrored
 * context key to keep in step, and the manifest is correct before the extension
 * has even activated.
 */
export async function setOpenIn(value: OpenIn): Promise<void> {
    await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(OPEN_IN_KEY, value, vscode.ConfigurationTarget.Global);
}

/**
 * Send a book to the configured location. The setting selects the host only —
 * it is deliberately independent of where the book's bytes come from, so it
 * behaves identically for local and Drive books.
 */
export class ReaderRouter {
    constructor(
        private readonly panelView: PanelViewHost,
        private readonly editorPanel: EditorPanelHost,
        private readonly sources: BookSources
    ) {}

    async open(ref: BookRef): Promise<void> {
        if (readOpenIn() === 'panel') {
            await this.panelView.open(ref);
            return;
        }
        // Local books go through the custom editor so their tab survives a reload;
        // Drive books have no file URI, so they get a standalone webview panel.
        if (this.sources.for(ref) === this.sources.local) {
            await vscode.commands.executeCommand(
                'vscode.openWith',
                vscode.Uri.parse(ref.uriKey),
                ReaderEditorProvider.viewType
            );
        } else {
            await this.editorPanel.show(ref);
        }
    }
}
