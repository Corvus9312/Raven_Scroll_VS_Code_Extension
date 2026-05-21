import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { AddressInfo } from 'net';

export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
}

interface TokenData {
    access_token: string;
    refresh_token: string;
    expires_at: number;
}

interface Credentials {
    client_id: string;
    client_secret: string;
}

type ProgressMap = Record<string, { scrollTop: number; percent: number }>;

const SCOPES    = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata';
const CREDS_KEY = 'corvusTxtReader.driveCredentials';
const TOKEN_KEY = 'corvusTxtReader.driveTokens';
const PROGRESS_FILENAME = 'corvus-progress.json';

export class GoogleDriveClient {
    private progressFileId: string | null | undefined = undefined; // undefined = not fetched yet
    private progressCache: ProgressMap | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async signIn(): Promise<void> {
        const bundledUri = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'credentials.json');
        let creds: { installed: { client_id: string; client_secret: string } };
        try {
            const bytes = await vscode.workspace.fs.readFile(bundledUri);
            creds = JSON.parse(Buffer.from(bytes).toString('utf8'));
        } catch {
            throw new Error('找不到 media/credentials.json，請將 Google OAuth2 憑證檔案放入擴充套件的 media 資料夾');
        }

        const { client_id, client_secret } = creds.installed;
        await this.context.secrets.store(CREDS_KEY, JSON.stringify({ client_id, client_secret }));
        await this.doOAuthFlow(client_id, client_secret);
        vscode.window.showInformationMessage('✅ Google Drive 登入成功');
    }

    async signOut(): Promise<void> {
        await this.context.secrets.delete(TOKEN_KEY);
        this.progressFileId = undefined;
        this.progressCache  = null;
        vscode.window.showInformationMessage('已登出 Google Drive');
    }

    async isSignedIn(): Promise<boolean> {
        return !!(await this.context.secrets.get(TOKEN_KEY));
    }

    // ── Progress (appDataFolder) ──────────────────────────────────────────────

    async getProgress(fileId: string): Promise<{ scrollTop: number; percent: number }> {
        try {
            const cache = await this.loadProgressCache();
            return cache[fileId] ?? { scrollTop: 0, percent: 0 };
        } catch {
            return { scrollTop: 0, percent: 0 };
        }
    }

    async deleteProgress(fileId: string): Promise<void> {
        try {
            const cache = await this.loadProgressCache();
            delete cache[fileId];
            const token = await this.getAccessToken();
            const body  = JSON.stringify(cache);
            if (this.progressFileId) {
                await patchAppFile(this.progressFileId, body, token);
            }
        } catch { /* silent */ }
    }

    async saveProgress(fileId: string, scrollTop: number, percent: number): Promise<void> {
        try {
            const cache = await this.loadProgressCache();
            cache[fileId] = { scrollTop, percent };
            const token = await this.getAccessToken();
            const body  = JSON.stringify(cache);
            if (this.progressFileId) {
                await patchAppFile(this.progressFileId, body, token);
            } else {
                this.progressFileId = await createAppFile(PROGRESS_FILENAME, body, token);
            }
        } catch { /* silent — don't disrupt reading */ }
    }

    private async loadProgressCache(): Promise<ProgressMap> {
        if (this.progressCache !== null) { return this.progressCache; }
        try {
            const token  = await this.getAccessToken();
            const q      = encodeURIComponent(`name='${PROGRESS_FILENAME}' and trashed=false`);
            const url    = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`;
            const data   = await apiGet(url, token);
            const files: { id: string }[] = data.files ?? [];
            if (files.length === 0) {
                this.progressFileId = null;
                this.progressCache  = {};
            } else {
                this.progressFileId = files[0].id;
                const bytes = await download(files[0].id, token);
                this.progressCache = JSON.parse(bytes.toString('utf8'));
            }
        } catch {
            this.progressCache = {};
        }
        return this.progressCache!;
    }

    // ── OAuth2 PKCE flow ──────────────────────────────────────────────────────

    private async doOAuthFlow(clientId: string, clientSecret: string): Promise<void> {
        const verifier  = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

        const { server, port, codePromise } = await startLocalServer();

        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authUrl.searchParams.set('client_id',             clientId);
        authUrl.searchParams.set('redirect_uri',          `http://localhost:${port}`);
        authUrl.searchParams.set('response_type',         'code');
        authUrl.searchParams.set('scope',                 SCOPES);
        authUrl.searchParams.set('code_challenge',        challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('access_type',           'offline');
        authUrl.searchParams.set('prompt',                'consent');

        await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
        vscode.window.showInformationMessage('請在瀏覽器中完成 Google 授權…');

        let code: string;
        try {
            code = await Promise.race([
                codePromise,
                new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error('授權逾時（5 分鐘）')), 300_000)
                ),
            ]);
        } finally {
            server.close();
        }

        const tokens = await exchangeCode(clientId, clientSecret, code, verifier, port);
        await this.context.secrets.store(TOKEN_KEY, JSON.stringify({
            access_token:  tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at:    Date.now() + tokens.expires_in * 1000,
        } satisfies TokenData));
    }

    // ── Token management ──────────────────────────────────────────────────────

    private async getAccessToken(): Promise<string> {
        const tokStr = await this.context.secrets.get(TOKEN_KEY);
        if (!tokStr) { throw new Error('尚未登入 Google Drive'); }

        const tok: TokenData = JSON.parse(tokStr);
        if (Date.now() + 300_000 >= tok.expires_at) {
            const credStr = await this.context.secrets.get(CREDS_KEY);
            if (!credStr) { throw new Error('找不到憑證，請重新登入'); }
            const { client_id, client_secret }: Credentials = JSON.parse(credStr);
            const refreshed = await refreshToken(client_id, client_secret, tok.refresh_token);
            const updated: TokenData = {
                ...tok,
                access_token: refreshed.access_token,
                expires_at:   Date.now() + refreshed.expires_in * 1000,
            };
            await this.context.secrets.store(TOKEN_KEY, JSON.stringify(updated));
            return updated.access_token;
        }

        return tok.access_token;
    }

    // ── Drive API ─────────────────────────────────────────────────────────────

    async listFiles(folderId: string = 'root'): Promise<DriveFile[]> {
        const token  = await this.getAccessToken();
        const q      = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        const fields = encodeURIComponent('files(id,name,mimeType)');
        const url    = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=folder%2Cname&pageSize=1000`;
        const data   = await apiGet(url, token);
        return (data.files as DriveFile[]) ?? [];
    }

    async downloadFile(fileId: string): Promise<Buffer> {
        const token = await this.getAccessToken();
        return download(fileId, token);
    }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function startLocalServer(): Promise<{ server: http.Server; port: number; codePromise: Promise<string> }> {
    return new Promise((resolve, reject) => {
        let resolveCode!: (code: string) => void;
        const codePromise = new Promise<string>(res => { resolveCode = res; });

        const server = http.createServer((req, res) => {
            const url  = new URL(req.url ?? '/', 'http://localhost');
            const code = url.searchParams.get('code');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            if (code) {
                res.end('<h2 style="font-family:sans-serif;padding:40px">✅ 授權成功，可關閉此頁面</h2>');
                resolveCode(code);
            } else {
                res.end('<h2 style="font-family:sans-serif;padding:40px">❌ 授權失敗</h2>');
            }
        });

        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as AddressInfo).port, codePromise });
        });
        server.on('error', reject);
    });
}

function exchangeCode(
    clientId: string, clientSecret: string,
    code: string, verifier: string, port: number
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    return postForm('https://oauth2.googleapis.com/token', {
        client_id: clientId, client_secret: clientSecret,
        code, code_verifier: verifier,
        redirect_uri: `http://localhost:${port}`,
        grant_type: 'authorization_code',
    });
}

function refreshToken(
    clientId: string, clientSecret: string, refresh_token: string
): Promise<{ access_token: string; expires_in: number }> {
    return postForm('https://oauth2.googleapis.com/token', {
        client_id: clientId, client_secret: clientSecret,
        refresh_token, grant_type: 'refresh_token',
    });
}

function postForm(url: string, params: Record<string, string>): Promise<any> {
    const body = new URLSearchParams(params).toString();
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        }, res => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString());
                    if (data.error) { reject(new Error(data.error_description ?? data.error)); }
                    else { resolve(data); }
                } catch { reject(new Error('回應格式錯誤')); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function apiGet(url: string, token: string): Promise<any> {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { Authorization: `Bearer ${token}` } }, res => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString());
                    if (data.error) { reject(new Error(data.error.message ?? JSON.stringify(data.error))); }
                    else { resolve(data); }
                } catch { reject(new Error('回應格式錯誤')); }
            });
        }).on('error', reject);
    });
}

function download(fileId: string, token: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        https.get(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            { headers: { Authorization: `Bearer ${token}` } },
            res => {
                if (res.statusCode && res.statusCode >= 400) {
                    res.resume();
                    res.on('end', () => reject(new Error(`HTTP ${res.statusCode}`)));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }
        ).on('error', reject);
    });
}

function patchAppFile(fileId: string, body: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
            {
                method: 'PATCH',
                headers: {
                    'Authorization':  `Bearer ${token}`,
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            res => {
                res.resume();
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    } else {
                        resolve();
                    }
                });
            }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function createAppFile(name: string, body: string, token: string): Promise<string> {
    const boundary = 'corvus-mp-boundary';
    const meta     = JSON.stringify({ name, parents: ['appDataFolder'] });
    const payload  = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        meta,
        `--${boundary}`,
        'Content-Type: application/json',
        '',
        body,
        `--${boundary}--`,
    ].join('\r\n');

    return new Promise((resolve, reject) => {
        const req = https.request(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
            {
                method: 'POST',
                headers: {
                    'Authorization':  `Bearer ${token}`,
                    'Content-Type':   `multipart/related; boundary=${boundary}`,
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            res => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    try {
                        const data = JSON.parse(Buffer.concat(chunks).toString());
                        if (data.error) { reject(new Error(data.error.message)); }
                        else { resolve(data.id); }
                    } catch { reject(new Error('回應格式錯誤')); }
                });
            }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}
