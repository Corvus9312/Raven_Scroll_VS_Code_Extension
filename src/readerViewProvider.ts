import * as vscode from 'vscode';
import * as path from 'path';
import { buildReaderHtml, decodeBytes } from './utils';
import { GoogleDriveClient } from './googleDrive';

export interface ReaderPrefs {
    fontSize: number;
    lineHeight: number;
    fontFamily: string;
    theme: 'dark' | 'light';
}

export const DEFAULT_PREFS: ReaderPrefs = { fontSize: 14, lineHeight: 1.2, fontFamily: 'lxgw', theme: 'dark' };

export class ReaderViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'corvusTxtReader.readerView';

    private view?: vscode.WebviewView;
    private pendingMsg?: object;
    private onProgressSaved?: () => void;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly driveClient: GoogleDriveClient,
    ) {}

    setOnProgressSaved(cb: () => void): void {
        this.onProgressSaved = cb;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _ctx: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        webviewView.webview.html = buildReaderHtml(webviewView.webview, this.context.extensionUri);

        webviewView.onDidDispose(() => { this.view = undefined; });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    if (this.pendingMsg) {
                        await webviewView.webview.postMessage(this.pendingMsg);
                        this.pendingMsg = undefined;
                    }
                    break;
                case 'saveProgress':
                    await this.writeProgress(msg.uriKey, msg.scrollTop, msg.percent ?? 0);
                    break;
                case 'requestNextFile': {
                    const next = await this.findNextFile(msg.uriKey);
                    await webviewView.webview.postMessage({ type: 'nextFile', ...next });
                    break;
                }
                case 'openNextFile':
                    await this.loadFile(vscode.Uri.parse(msg.uriKey));
                    break;
                case 'savePrefs':
                    await this.context.globalState.update('corvusTxtReader.prefs', msg.prefs as ReaderPrefs);
                    break;
            }
        });
    }

    async loadFile(uri: vscode.Uri): Promise<void> {
        const bytes  = await vscode.workspace.fs.readFile(uri);
        const text   = decodeBytes(bytes);
        const uriKey = uri.toString();
        const prefs  = this.context.globalState.get<ReaderPrefs>('corvusTxtReader.prefs', DEFAULT_PREFS);

        const msg = {
            type: 'loadContent',
            text,
            title: path.basename(uri.fsPath),
            savedProgress: await this.readProgress(uriKey, uri),
            prefs,
            uriKey,
        };

        if (this.view?.webview) {
            await this.view.webview.postMessage(msg);
            this.view.show(true);
        } else {
            this.pendingMsg = msg;
            await vscode.commands.executeCommand(`${ReaderViewProvider.viewType}.focus`);
        }
    }

    async loadBuffer(buffer: Buffer, fileName: string, uriKey: string): Promise<void> {
        const text  = decodeBytes(new Uint8Array(buffer));
        const prefs = this.context.globalState.get<ReaderPrefs>('corvusTxtReader.prefs', DEFAULT_PREFS);

        const msg = {
            type: 'loadContent',
            text,
            title: fileName.replace(/\.txt$/i, ''),
            savedProgress: await this.readProgress(uriKey),
            prefs,
            uriKey,
        };

        if (this.view?.webview) {
            await this.view.webview.postMessage(msg);
            this.view.show(true);
        } else {
            this.pendingMsg = msg;
            await vscode.commands.executeCommand(`${ReaderViewProvider.viewType}.focus`);
        }
    }

    // ── Progress helpers ──────────────────────────────────────────────────────

    private async readProgress(uriKey: string, fileUri?: vscode.Uri): Promise<number> {
        if (uriKey.startsWith('drive://')) {
            const fileId = uriKey.replace('drive://', '');
            return (await this.driveClient.getProgress(fileId)).scrollTop;
        }
        if (fileUri) {
            try {
                const bytes = await vscode.workspace.fs.readFile(this.localProgressUri(fileUri));
                const data  = JSON.parse(Buffer.from(bytes).toString('utf8'));
                return data.scrollTop ?? 0;
            } catch { /* first open */ }
        }
        return 0;
    }

    private async writeProgress(uriKey: string, scrollTop: number, percent: number): Promise<void> {
        if (uriKey.startsWith('drive://')) {
            await this.driveClient.saveProgress(uriKey.replace('drive://', ''), scrollTop, percent);
        } else {
            try {
                const fileUri = vscode.Uri.parse(uriKey);
                await vscode.workspace.fs.writeFile(
                    this.localProgressUri(fileUri),
                    Buffer.from(JSON.stringify({ scrollTop, percent }), 'utf8')
                );
            } catch { /* ignore */ }
        }
        vscode.window.setStatusBarMessage(`💾 ${percent}%`, 2000);
        this.onProgressSaved?.();
    }

    private async findNextFile(uriKey: string): Promise<{ exists: boolean; name?: string; uriKey?: string }> {
        if (uriKey.startsWith('drive://')) { return { exists: false }; }
        try {
            const fileUri = vscode.Uri.parse(uriKey);
            const dir     = vscode.Uri.joinPath(fileUri, '..');
            const base    = path.basename(fileUri.fsPath);
            const entries = await vscode.workspace.fs.readDirectory(dir);
            const txts    = entries
                .filter(([n, t]) => t === vscode.FileType.File && n.toLowerCase().endsWith('.txt'))
                .map(([n]) => n)
                .sort((a, b) => a.localeCompare(b, 'zh-TW'));
            const idx = txts.indexOf(base);
            if (idx >= 0 && idx < txts.length - 1) {
                const nextName = txts[idx + 1];
                return {
                    exists: true,
                    name:   nextName.replace(/\.txt$/i, ''),
                    uriKey: vscode.Uri.joinPath(dir, nextName).toString(),
                };
            }
        } catch { /* ignore */ }
        return { exists: false };
    }

    private localProgressUri(fileUri: vscode.Uri): vscode.Uri {
        const dir  = vscode.Uri.joinPath(fileUri, '..');
        const base = path.basename(fileUri.fsPath);
        return vscode.Uri.joinPath(dir, `.corvus.${base}.json`);
    }
}
