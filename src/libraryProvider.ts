import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { describeProgress, stripBookExt } from './core/book';
import { readLocalProgress } from './core/localProgress';
import { LIBRARY_KEY } from './keys';

export class LibraryProvider implements vscode.TreeDataProvider<LibraryItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<LibraryItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: LibraryItem): vscode.TreeItem { return element; }

    getChildren(): LibraryItem[] {
        const library = this.context.globalState.get<string[]>(LIBRARY_KEY, []);
        return library
            .filter(p => fs.existsSync(p))
            .map(p => new LibraryItem(p));
    }
}

class LibraryItem extends vscode.TreeItem {
    constructor(public readonly filePath: string) {
        super(stripBookExt(path.basename(filePath)), vscode.TreeItemCollapsibleState.None);
        this.tooltip      = filePath;
        this.iconPath     = new vscode.ThemeIcon('book');
        this.contextValue = 'libraryItem';
        this.command = {
            command: 'corvusTxtReader.openFile',
            title: '開啟',
            arguments: [vscode.Uri.file(filePath)],
        };
        this.description = describeProgress(readLocalProgress(filePath));
    }
}
