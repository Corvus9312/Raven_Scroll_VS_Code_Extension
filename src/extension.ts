import * as vscode from 'vscode';
import * as path from 'path';
import { TxtEditorProvider } from './txtEditorProvider';
import { LibraryProvider } from './libraryProvider';
import { FolderProvider } from './folderProvider';
import { ReaderViewProvider } from './readerViewProvider';
import { GoogleDriveClient } from './googleDrive';
import { DriveProvider } from './driveProvider';
import { stripBookExt } from './utils';

export function activate(context: vscode.ExtensionContext): void {
    context.globalState.setKeysForSync([
        TxtEditorProvider.PREFS_KEY,
        TxtEditorProvider.PROGRESS_KEY,
        TxtEditorProvider.LIBRARY_KEY,
        FolderProvider.FOLDERS_KEY,
    ]);

    // ── Google Drive client (建立在前，供 readerViewProvider 使用) ───────────────
    const driveClient = new GoogleDriveClient(context);

    // ── Custom editor ──────────────────────────────────────────────────────────
    const libraryProvider = new LibraryProvider(context);
    context.subscriptions.push(
        TxtEditorProvider.register(context, () => libraryProvider.refresh())
    );

    // ── Reader panel view ──────────────────────────────────────────────────────
    const readerViewProvider = new ReaderViewProvider(context, driveClient);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ReaderViewProvider.viewType,
            readerViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // ── 統一開啟指令 ───────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.openFile', async (uri: vscode.Uri) => {
            const openIn = vscode.workspace
                .getConfiguration('corvusTxtReader')
                .get<string>('openIn', 'panel');
            if (openIn === 'panel') {
                await readerViewProvider.loadFile(uri);
            } else {
                await vscode.commands.executeCommand('vscode.openWith', uri, TxtEditorProvider.viewType);
            }
        })
    );

    // ── 本機書庫 ───────────────────────────────────────────────────────────────
    const folderProvider = new FolderProvider(context);
    context.subscriptions.push(
        vscode.window.createTreeView('corvusTxtReader.folders', { treeDataProvider: folderProvider })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.addFolder', () => folderProvider.addFolder())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.removeFolder', (node) => folderProvider.removeFolder(node))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.refreshFolders', () => folderProvider.refresh())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.resetFileProgress', async (node: any) => {
            const filePath: string | undefined = node?.filePath;
            if (!filePath) { return; }
            const progressUri = vscode.Uri.file(
                path.join(path.dirname(filePath), `.corvus.${path.basename(filePath)}.json`)
            );
            try { await vscode.workspace.fs.delete(progressUri); } catch { /* not found */ }
            folderProvider.refresh();
            libraryProvider.refresh();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.resetFolderProgress', async (node: any) => {
            const folderPath: string | undefined = node?.folderPath;
            if (!folderPath) { return; }
            const answer = await vscode.window.showWarningMessage(
                `確定要清空「${path.basename(folderPath)}」的所有閱讀進度？`, { modal: true }, '清空'
            );
            if (answer !== '清空') { return; }
            const folderUri = vscode.Uri.file(folderPath);
            const entries = await vscode.workspace.fs.readDirectory(folderUri);
            for (const [name] of entries) {
                if (name.startsWith('.corvus.') && name.endsWith('.json')) {
                    try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(folderUri, name)); } catch { /* ignore */ }
                }
            }
            folderProvider.refresh();
            libraryProvider.refresh();
        })
    );

    // ── 最近閱讀 ───────────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.window.createTreeView('corvusTxtReader.library', { treeDataProvider: libraryProvider })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.clearLibrary', async () => {
            const answer = await vscode.window.showWarningMessage(
                '確定要清空最近閱讀紀錄嗎？', { modal: true }, '清空'
            );
            if (answer === '清空') {
                await context.globalState.update(TxtEditorProvider.LIBRARY_KEY, []);
                libraryProvider.refresh();
            }
        })
    );

    // ── Google Drive ───────────────────────────────────────────────────────────
    const driveProvider = new DriveProvider(driveClient, context);
    readerViewProvider.setOnProgressSaved(() => {
        folderProvider.refresh();
        libraryProvider.refresh();
        driveProvider.refresh();
    });

    context.subscriptions.push(
        vscode.window.createTreeView('corvusTxtReader.drive', { treeDataProvider: driveProvider })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.driveSignIn', async () => {
            try {
                await driveClient.signIn();
                driveProvider.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`登入失敗：${err.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.driveSignOut', async () => {
            await driveClient.signOut();
            driveProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.refreshDrive', () => {
            driveClient.invalidateProgressCache();
            driveProvider.refresh();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.resetDriveFileProgress', async (node: any) => {
            const fileId: string | undefined = node?.file?.id;
            if (!fileId) { return; }
            await driveClient.deleteProgress(fileId);
            driveProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.setDriveRoot', (node) => {
            const folderId: string = node?.file?.id;
            if (!folderId) { return; }
            driveProvider.navigateInto(folderId);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.driveGoUp', () => {
            driveProvider.navigateUp();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('corvusTxtReader.resetDriveRoot', () => {
            driveProvider.resetNav();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'corvusTxtReader.openDriveFile',
            async (fileId: string, fileName: string, folderId?: string) => {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `載入 ${stripBookExt(fileName)}…` },
                    async () => {
                        const buffer = await driveClient.downloadFile(fileId);
                        const uriKey = folderId ? `drive://${folderId}/${fileId}` : `drive://${fileId}`;
                        await readerViewProvider.loadBuffer(buffer, fileName, uriKey);
                    }
                );
            }
        )
    );
}

export function deactivate(): void {}
