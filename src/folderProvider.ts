import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

type TreeNode = FolderNode | FileNode;

export class FolderProvider implements vscode.TreeDataProvider<TreeNode> {
    public static readonly FOLDERS_KEY = 'corvusTxtReader.folders';

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            const folders = this.context.globalState.get<string[]>(FolderProvider.FOLDERS_KEY, []);
            return Promise.all(
                folders.filter(f => fs.existsSync(f)).map(f => FolderNode.create(f))
            );
        }
        if (element instanceof FolderNode) {
            try {
                const files = fs.readdirSync(element.folderPath)
                    .filter((f: string) => f.toLowerCase().endsWith('.txt'))
                    .sort((a: string, b: string) => a.localeCompare(b, 'zh-TW'));
                return Promise.all(files.map((f: string) => FileNode.create(path.join(element.folderPath, f))));
            } catch {
                return [];
            }
        }
        return [];
    }

    async addFolder(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            title: '選擇包含 TXT 檔案的資料夾',
        });
        if (!uris?.length) { return; }
        const folderPath = uris[0].fsPath;
        const folders = this.context.globalState.get<string[]>(FolderProvider.FOLDERS_KEY, []);
        if (!folders.includes(folderPath)) {
            folders.push(folderPath);
            await this.context.globalState.update(FolderProvider.FOLDERS_KEY, folders);
            this.refresh();
        }
    }

    async removeFolder(node: FolderNode): Promise<void> {
        const folders = this.context.globalState.get<string[]>(FolderProvider.FOLDERS_KEY, []);
        await this.context.globalState.update(
            FolderProvider.FOLDERS_KEY,
            folders.filter(f => f !== node.folderPath)
        );
        this.refresh();
    }
}

function readLocalPercent(filePath: string): number | null {
    const progressPath = path.join(path.dirname(filePath), `.corvus.${path.basename(filePath)}.json`);
    try {
        const data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
        if (typeof data.percent === 'number') { return data.percent; }
        if (typeof data.scrollTop === 'number' && data.scrollTop > 0) { return -1; } // old format
        return null;
    } catch {
        return null;
    }
}

class FolderNode extends vscode.TreeItem {
    constructor(public readonly folderPath: string) {
        super(path.basename(folderPath), vscode.TreeItemCollapsibleState.Expanded);
        this.tooltip      = folderPath;
        this.iconPath     = new vscode.ThemeIcon('folder-library');
        this.contextValue = 'txtFolder';
    }

    static create(folderPath: string): FolderNode {
        const node = new FolderNode(folderPath);
        try {
            const files = fs.readdirSync(folderPath).filter((f: string) => f.toLowerCase().endsWith('.txt'));
            if (files.length > 0) {
                const started = files.filter((f: string) => readLocalPercent(path.join(folderPath, f)) !== null).length;
                node.description = `${started} / ${files.length}`;
            }
        } catch { /* ignore */ }
        return node;
    }
}

class FileNode extends vscode.TreeItem {
    constructor(public readonly filePath: string) {
        super(path.basename(filePath, '.txt'), vscode.TreeItemCollapsibleState.None);
        this.tooltip      = filePath;
        this.iconPath     = new vscode.ThemeIcon('book');
        this.contextValue = 'txtFile';
        this.command = {
            command: 'corvusTxtReader.openFile',
            title: '開啟',
            arguments: [vscode.Uri.file(filePath)],
        };
    }

    static create(filePath: string): FileNode {
        const node    = new FileNode(filePath);
        const percent = readLocalPercent(filePath);
        if (percent !== null) {
            node.description = percent < 0 ? '閱讀中' : (percent >= 100 ? '✓ 完結' : `${percent}%`);
        }
        return node;
    }
}
