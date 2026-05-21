import * as vscode from 'vscode';
import * as path from 'path';
import { buildReaderHtml, decodeBytes } from './utils';
import { ReaderPrefs, DEFAULT_PREFS } from './readerViewProvider';

type ProgressMap = Record<string, number>;

export class TxtEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType    = 'corvusTxtReader.reader';
    public static readonly PREFS_KEY   = 'corvusTxtReader.prefs';
    public static readonly PROGRESS_KEY = 'corvusTxtReader.progress';
    public static readonly LIBRARY_KEY = 'corvusTxtReader.library';

    public static register(
        context: vscode.ExtensionContext,
        onLibraryUpdate: () => void
    ): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            TxtEditorProvider.viewType,
            new TxtEditorProvider(context, onLibraryUpdate),
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly onLibraryUpdate: () => void
    ) {}

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        webviewPanel.webview.html = buildReaderHtml(webviewPanel.webview, this.context.extensionUri);

        this.trackInLibrary(document.uri);

        const fileUri = document.uri.toString();
        const progress = this.context.globalState.get<ProgressMap>(TxtEditorProvider.PROGRESS_KEY, {});
        const prefs    = this.context.globalState.get<ReaderPrefs>(TxtEditorProvider.PREFS_KEY, DEFAULT_PREFS);
        const text     = decodeBytes(await vscode.workspace.fs.readFile(document.uri));
        const title    = path.basename(document.uri.fsPath);

        const disposable = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    webviewPanel.webview.postMessage({
                        type: 'loadContent',
                        text,
                        title,
                        savedProgress: progress[fileUri] ?? 0,
                        prefs,
                        uriKey: fileUri,
                    });
                    break;
                case 'saveProgress': {
                    const map = this.context.globalState.get<ProgressMap>(TxtEditorProvider.PROGRESS_KEY, {});
                    map[fileUri] = msg.scrollTop;
                    await this.context.globalState.update(TxtEditorProvider.PROGRESS_KEY, map);
                    break;
                }
                case 'savePrefs':
                    await this.context.globalState.update(TxtEditorProvider.PREFS_KEY, msg.prefs as ReaderPrefs);
                    break;
            }
        });

        webviewPanel.onDidDispose(() => disposable.dispose());
    }

    private trackInLibrary(uri: vscode.Uri): void {
        const library = this.context.globalState.get<string[]>(TxtEditorProvider.LIBRARY_KEY, []);
        const fsPath  = uri.fsPath;
        const filtered = library.filter(p => p !== fsPath);
        filtered.unshift(fsPath);
        if (filtered.length > 50) { filtered.length = 50; }
        this.context.globalState.update(TxtEditorProvider.LIBRARY_KEY, filtered);
        this.onLibraryUpdate();
    }
}
