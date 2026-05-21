import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TxtEditorProvider } from './txtEditorProvider';

export class LibraryProvider implements vscode.TreeDataProvider<LibraryItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<LibraryItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: LibraryItem): vscode.TreeItem { return element; }

    getChildren(): LibraryItem[] {
        const library = this.context.globalState.get<string[]>(TxtEditorProvider.LIBRARY_KEY, []);
        return library
            .filter(p => fs.existsSync(p))
            .map(p => new LibraryItem(p));
    }
}

class LibraryItem extends vscode.TreeItem {
    constructor(public readonly filePath: string) {
        super(path.basename(filePath, '.txt'), vscode.TreeItemCollapsibleState.None);
        this.tooltip      = filePath;
        this.iconPath     = new vscode.ThemeIcon('book');
        this.contextValue = 'libraryItem';
        this.command = {
            command: 'corvusTxtReader.openFile',
            title: '開啟',
            arguments: [vscode.Uri.file(filePath)],
        };

        const percent = readLocalPercent(filePath);
        if (percent !== null) {
            this.description = percent < 0 ? '閱讀中' : (percent >= 100 ? '✓ 完結' : `${percent}%`);
        }
    }
}

function readLocalPercent(filePath: string): number | null {
    const progressPath = path.join(path.dirname(filePath), `.corvus.${path.basename(filePath)}.json`);
    try {
        const data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
        if (typeof data.percent === 'number') { return data.percent; }
        if (typeof data.scrollTop === 'number' && data.scrollTop > 0) { return -1; }
        return null;
    } catch {
        return null;
    }
}
