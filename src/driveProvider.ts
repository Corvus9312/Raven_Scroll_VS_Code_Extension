import * as vscode from 'vscode';
import { GoogleDriveClient, DriveFile } from './googleDrive';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

type DriveNode = DriveSignInNode | DriveFolderNode | DriveFileNode;

const NAV_STACK_KEY = 'corvusTxtReader.driveNavStack';

export class DriveProvider implements vscode.TreeDataProvider<DriveNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<DriveNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private navStack: string[];

    constructor(
        private readonly client: GoogleDriveClient,
        private readonly context: vscode.ExtensionContext,
    ) {
        this.navStack = context.globalState.get<string[]>(NAV_STACK_KEY, []);
        this.updateCanGoUp();
    }

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(el: DriveNode): vscode.TreeItem { return el; }

    async getChildren(element?: DriveNode): Promise<DriveNode[]> {
        if (!(await this.client.isSignedIn())) {
            return [new DriveSignInNode()];
        }

        const folderId = element instanceof DriveFolderNode
            ? element.file.id
            : this.getCurrentRoot();

        try {
            const files = await this.client.listFiles(folderId);
            const filtered = files.filter(f => f.mimeType === FOLDER_MIME || f.name.toLowerCase().endsWith('.txt'));
            return Promise.all(filtered.map(async f => {
                if (f.mimeType === FOLDER_MIME) { return new DriveFolderNode(f); }
                const { percent } = await this.client.getProgress(f.id);
                return new DriveFileNode(f, percent);
            }));
        } catch (err: any) {
            vscode.window.showErrorMessage(`Google Drive 錯誤：${err.message}`);
            return [];
        }
    }

    navigateInto(folderId: string): void {
        this.navStack.push(folderId);
        this.saveNavStack();
        this.updateCanGoUp();
        this.refresh();
    }

    navigateUp(): void {
        if (this.navStack.length > 0) {
            this.navStack.pop();
            this.saveNavStack();
            this.updateCanGoUp();
            this.refresh();
        }
    }

    resetNav(): void {
        this.navStack = [];
        this.saveNavStack();
        this.updateCanGoUp();
        this.refresh();
    }

    private saveNavStack(): void {
        this.context.globalState.update(NAV_STACK_KEY, this.navStack);
    }

    canGoUp(): boolean {
        return this.navStack.length > 0;
    }

    private getCurrentRoot(): string {
        if (this.navStack.length > 0) {
            return this.navStack[this.navStack.length - 1];
        }
        return getSettingsRoot();
    }

    private updateCanGoUp(): void {
        vscode.commands.executeCommand(
            'setContext', 'corvusTxtReader.driveCanGoUp', this.navStack.length > 0
        );
    }
}

function getSettingsRoot(): string {
    const url = vscode.workspace
        .getConfiguration('corvusTxtReader')
        .get<string>('driveFolderUrl', '');
    if (!url) { return 'root'; }
    const m = url.match(/folders\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : 'root';
}

class DriveSignInNode extends vscode.TreeItem {
    constructor() {
        super('點此登入 Google Drive', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('account');
        this.command  = { command: 'corvusTxtReader.driveSignIn', title: '登入' };
    }
}

export class DriveFolderNode extends vscode.TreeItem {
    constructor(public readonly file: DriveFile) {
        super(file.name, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath     = new vscode.ThemeIcon('folder');
        this.contextValue = 'driveFolder';
    }
}

export class DriveFileNode extends vscode.TreeItem {
    constructor(public readonly file: DriveFile, percent?: number) {
        super(file.name.replace(/\.txt$/i, ''), vscode.TreeItemCollapsibleState.None);
        this.iconPath     = new vscode.ThemeIcon('book');
        this.contextValue = 'driveFile';
        if (percent && percent > 0) {
            this.description = percent >= 100 ? '✓ 完結' : `${percent}%`;
        }
        this.command = {
            command:   'corvusTxtReader.openDriveFile',
            title:     '開啟',
            arguments: [file.id, file.name],
        };
    }
}
