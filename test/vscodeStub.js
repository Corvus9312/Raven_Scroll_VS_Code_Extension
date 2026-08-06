/**
 * A minimal stand-in for the `vscode` module, enough to drive `ReaderSession`
 * and `ReaderRouter` outside VS Code.
 *
 * Install it with `install()` before requiring anything under `out/` that
 * imports vscode. Only the surface those two modules actually touch is
 * implemented — anything else throws loudly rather than silently returning
 * undefined, so a test can never pass by accident.
 */

const Module = require('node:module');
const path   = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

/**
 * Stands in for `vscode.Uri`. Like the real thing it stores the URI and derives
 * `fsPath` from it, so a parse/toString round-trip is lossless — including for
 * POSIX-style URIs on Windows, which `fileURLToPath` alone rejects.
 */
class Uri {
    constructor(uriString) {
        this._uri = uriString;
        const pathname = decodeURIComponent(new URL(uriString).pathname);
        try {
            this.fsPath = fileURLToPath(uriString);
        } catch {
            this.fsPath = pathname; // e.g. file:///books/a.txt under Windows
        }
    }
    static file(p) { return new Uri(pathToFileURL(path.resolve(p)).toString()); }
    static parse(s) {
        if (!s.startsWith('file:')) { throw new Error(`stub Uri.parse: not a file URI: ${s}`); }
        return new Uri(s);
    }
    static joinPath(uri, ...segments) {
        const url = new URL(uri._uri);
        url.pathname = path.posix.resolve(url.pathname, ...segments);
        return new Uri(url.toString());
    }
    toString() { return this._uri; }
}

class Disposable {
    constructor(fn) { this._fn = fn; }
    dispose() { this._fn?.(); }
}

/** Records every message posted to the webview and lets a test drive replies. */
class FakeWebview {
    constructor() {
        this.posted = [];
        this._handlers = [];
        this.options = {};
        this.html = '';
    }
    postMessage(msg) { this.posted.push(msg); return Promise.resolve(true); }
    onDidReceiveMessage(fn) {
        this._handlers.push(fn);
        return new Disposable(() => {
            this._handlers = this._handlers.filter(h => h !== fn);
        });
    }
    /** Simulate media/reader.js sending a message. */
    async send(msg) { for (const h of [...this._handlers]) { await h(msg); } }
    asWebviewUri(uri) { return uri; }
    get cspSource() { return 'vscode-webview:'; }
}

/** Stands in for a `vscode.WebviewPanel` in the main editor area. */
class FakeWebviewPanel {
    constructor(viewType, title, viewColumn) {
        this.viewType   = viewType;
        this.title      = title;
        this.viewColumn = viewColumn;
        this.webview    = new FakeWebview();
        this.revealed   = 0;
        this.disposed   = false;
        this._onDispose = [];
    }
    reveal() { this.revealed++; }
    onDidDispose(fn) { this._onDispose.push(fn); return new Disposable(() => {}); }
    dispose() {
        this.disposed = true;
        for (const fn of this._onDispose) { fn(); }
    }
}

function makeVscode() {
    const calls = { executeCommand: [], statusBar: [], errors: [], configUpdates: [] };
    let config = {};
    const panels = [];
    const serializers = new Map();
    const files = new Map();
    const readOnly = new Set();

    return {
        __panels: panels,
        __serializers: serializers,
        Uri,
        Disposable,
        FileType: { File: 1, Directory: 2 },
        ViewColumn: { Active: -1 },
        ProgressLocation: { Notification: 15 },

        commands: {
            executeCommand: (...args) => { calls.executeCommand.push(args); return Promise.resolve(); },
        },
        window: {
            setStatusBarMessage: (text) => { calls.statusBar.push(text); },
            showErrorMessage: (text) => { calls.errors.push(text); return Promise.resolve(); },
            createWebviewPanel: (viewType, title, viewColumn) => {
                const panel = new FakeWebviewPanel(viewType, title, viewColumn);
                panels.push(panel);
                return panel;
            },
            registerWebviewPanelSerializer: (viewType, serializer) => {
                serializers.set(viewType, serializer);
                return new Disposable(() => serializers.delete(viewType));
            },
        },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },

        workspace: {
            getConfiguration: () => ({
                get: (key, fallback) => config[key] ?? fallback,
                update: async (key, value, target) => {
                    config[key] = value;
                    calls.configUpdates.push({ key, value, target });
                },
            }),
            // An in-memory filesystem keyed by fsPath.
            fs: {
                stat: async (uri) => {
                    if (!files.has(uri.fsPath)) { throw new Error('ENOENT'); }
                    return { type: 1, size: files.get(uri.fsPath).length };
                },
                readFile: async (uri) => {
                    if (!files.has(uri.fsPath)) { throw new Error('ENOENT'); }
                    return Buffer.from(files.get(uri.fsPath));
                },
                writeFile: async (uri, bytes) => {
                    if (readOnly.has(uri.fsPath)) { throw new Error('EACCES'); }
                    files.set(uri.fsPath, Buffer.from(bytes).toString('utf8'));
                },
                delete: async (uri) => { files.delete(uri.fsPath); },
            },
        },
        __files: files,
        __readOnly: readOnly,

        // ── test handles ──
        __calls: calls,
        __setConfig: (next) => { config = next; },
    };
}

/** Swap `require('vscode')` for the stub. Returns { vscode, restore }. */
function install() {
    const vscode = makeVscode();
    const original = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') { return vscode; }
        return original.apply(this, arguments);
    };
    return {
        vscode,
        restore: () => { Module._load = original; },
    };
}

module.exports = { install, FakeWebview, FakeWebviewPanel, Uri, Disposable };
