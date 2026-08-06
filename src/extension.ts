import * as vscode from 'vscode';
import * as path from 'path';
import { LibraryProvider } from './libraryProvider';
import { FolderProvider } from './folderProvider';
import { GoogleDriveClient } from './googleDrive';
import { DriveProvider } from './driveProvider';
import { BookRef, BookSources, DriveBookSource, LocalBookSource } from './bookSource';
import {
    EditorPanelHost, EditorTabs, OpenIn, PanelViewHost, ReaderEditorProvider, ReaderRouter, setOpenIn,
} from './readerHosts';
import { migrateLegacyProgress } from './migrateProgress';
import { FOLDERS_KEY, LIBRARY_KEY, PREFS_KEY } from './keys';
import { isSidecarName, sidecarName, stripBookExt } from './core/book';

export function activate(context: vscode.ExtensionContext): void {
    context.globalState.setKeysForSync([PREFS_KEY, LIBRARY_KEY, FOLDERS_KEY]);
    void migrateLegacyProgress(context);

    // ── Trees ──────────────────────────────────────────────────────────────────
    const driveClient     = new GoogleDriveClient(context);
    const libraryProvider = new LibraryProvider(context);
    const folderProvider  = new FolderProvider(context);
    const driveProvider   = new DriveProvider(driveClient, context);

    const refreshTrees = () => {
        folderProvider.refresh();
        libraryProvider.refresh();
        driveProvider.refresh();
    };

    // ── Sources, session hosts, routing ────────────────────────────────────────
    const sources = new BookSources(
        new LocalBookSource(context, () => libraryProvider.refresh()),
        new DriveBookSource(driveClient)
    );
    // `openBook` is resolved lazily: the router needs the hosts, and the hosts
    // need to be able to call back into the router when a reader moves on to the
    // next book.
    const deps = {
        context,
        sources,
        onProgressSaved: refreshTrees,
        openBook: (ref: BookRef) => openBook(ref),
    };

    const editorTabs  = new EditorTabs();
    const panelView   = new PanelViewHost(deps);
    const editorPanel = new EditorPanelHost(deps, editorTabs);
    const router      = new ReaderRouter(panelView, editorPanel, sources);

    context.subscriptions.push(
        ReaderEditorProvider.register(deps, editorTabs),
        editorPanel.register(),
        vscode.window.registerWebviewViewProvider(
            PanelViewHost.viewType,
            panelView,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    const openBook = async (ref: BookRef) => {
        try {
            await router.open(ref);
        } catch (err: any) {
            vscode.window.showErrorMessage(`無法開啟《${stripBookExt(ref.fileName)}》：${err?.message ?? err}`);
        }
    };

    // ── Open commands ──────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.openFile', async (uri: vscode.Uri) => {
            await openBook(LocalBookSource.refFor(uri));
        }),
        vscode.commands.registerCommand(
            'corvusTxtReader.openDriveFile',
            async (fileId: string, fileName: string, folderId?: string) => {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `載入 ${stripBookExt(fileName)}…` },
                    () => openBook(DriveBookSource.refFor(fileId, fileName, folderId))
                );
            }
        )
    );

    // ── 開啟位置快速切換 ────────────────────────────────────────────────────────
    // Menus show only the location the reader is *not* currently using, so the
    // label always states what the click will do. The book being read moves with
    // the setting; otherwise switching would silently close it.
    const chooseOpenIn = async (value: OpenIn) => {
        const moving = value === 'editor' ? panelView.current() : editorTabs.active();

        await setOpenIn(value);

        if (moving) {
            moving.close();
            await openBook(moving.ref);
        }
        vscode.window.setStatusBarMessage(
            value === 'editor' ? '📖 之後在主編輯區開啟' : '📖 之後在下方面板開啟',
            3000
        );
    };
    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.openInEditor', () => chooseOpenIn('editor')),
        vscode.commands.registerCommand('corvusTxtReader.openInPanel',  () => chooseOpenIn('panel'))
    );

    // ── 本機書庫 ───────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.createTreeView('corvusTxtReader.folders', { treeDataProvider: folderProvider }),
        vscode.commands.registerCommand('corvusTxtReader.addFolder', () => folderProvider.addFolder()),
        vscode.commands.registerCommand('corvusTxtReader.removeFolder', (node) => folderProvider.removeFolder(node)),
        vscode.commands.registerCommand('corvusTxtReader.refreshFolders', () => folderProvider.refresh()),
        vscode.commands.registerCommand('corvusTxtReader.resetFileProgress', async (node: any) => {
            const filePath: string | undefined = node?.filePath;
            if (!filePath) { return; }
            const progressUri = vscode.Uri.file(
                path.join(path.dirname(filePath), sidecarName(path.basename(filePath)))
            );
            try { await vscode.workspace.fs.delete(progressUri); } catch { /* not found */ }
            folderProvider.refresh();
            libraryProvider.refresh();
        }),
        vscode.commands.registerCommand('corvusTxtReader.resetFolderProgress', async (node: any) => {
            const folderPath: string | undefined = node?.folderPath;
            if (!folderPath) { return; }
            const answer = await vscode.window.showWarningMessage(
                `確定要清空「${path.basename(folderPath)}」的所有閱讀進度？`, { modal: true }, '清空'
            );
            if (answer !== '清空') { return; }
            const folderUri = vscode.Uri.file(folderPath);
            const entries   = await vscode.workspace.fs.readDirectory(folderUri);
            for (const [name] of entries) {
                if (isSidecarName(name)) {
                    try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(folderUri, name)); } catch { /* ignore */ }
                }
            }
            folderProvider.refresh();
            libraryProvider.refresh();
        })
    );

    // ── 最近閱讀 ───────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.createTreeView('corvusTxtReader.library', { treeDataProvider: libraryProvider }),
        vscode.commands.registerCommand('corvusTxtReader.clearLibrary', async () => {
            const answer = await vscode.window.showWarningMessage(
                '確定要清空最近閱讀紀錄嗎？', { modal: true }, '清空'
            );
            if (answer === '清空') {
                await context.globalState.update(LIBRARY_KEY, []);
                libraryProvider.refresh();
            }
        })
    );

    // ── Google Drive ───────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.createTreeView('corvusTxtReader.drive', { treeDataProvider: driveProvider }),
        vscode.commands.registerCommand('corvusTxtReader.driveSignIn', async () => {
            try {
                await driveClient.signIn();
                driveProvider.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`登入失敗：${err.message}`);
            }
        }),
        vscode.commands.registerCommand('corvusTxtReader.driveSignOut', async () => {
            await driveClient.signOut();
            driveProvider.refresh();
        }),
        vscode.commands.registerCommand('corvusTxtReader.refreshDrive', () => {
            driveClient.invalidateProgressCache();
            driveProvider.refresh();
        }),
        vscode.commands.registerCommand('corvusTxtReader.resetDriveFileProgress', async (node: any) => {
            const fileId: string | undefined = node?.file?.id;
            if (!fileId) { return; }
            await driveClient.deleteProgress(fileId);
            driveProvider.refresh();
        }),
        vscode.commands.registerCommand('corvusTxtReader.setDriveRoot', (node) => {
            const folderId: string = node?.file?.id;
            if (!folderId) { return; }
            driveProvider.navigateInto(folderId);
        }),
        vscode.commands.registerCommand('corvusTxtReader.driveGoUp', () => driveProvider.navigateUp()),
        vscode.commands.registerCommand('corvusTxtReader.resetDriveRoot', () => driveProvider.resetNav())
    );
}

export function deactivate(): void {}
