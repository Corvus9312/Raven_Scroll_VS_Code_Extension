import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { IncomingMessage } from 'http';

export interface FetchResult {
    content: string;
    title: string;
}

export function fetchUrl(urlStr: string, redirectCount = 0): Promise<FetchResult> {
    if (redirectCount > 5) {
        return Promise.reject(new Error('Too many redirects'));
    }

    return new Promise((resolve, reject) => {
        let url: URL;
        try { url = new URL(urlStr); }
        catch { return reject(new Error('無效的網址')); }

        const client = url.protocol === 'https:' ? https : http;
        const req = client.get(
            {
                hostname: url.hostname,
                port: url.port || undefined,
                path: url.pathname + url.search,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
                },
                timeout: 15000,
            },
            (res: IncomingMessage) => {
                // Follow redirects
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const next = res.headers.location.startsWith('http')
                        ? res.headers.location
                        : new URL(res.headers.location, urlStr).toString();
                    res.resume();
                    fetchUrl(next, redirectCount + 1).then(resolve).catch(reject);
                    return;
                }
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 400)) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    let html = decodeBuffer(buf, res.headers['content-type'] ?? '');

                    // Re-decode if meta charset says GBK
                    const metaCs = html.match(/<meta[^>]+charset=["']?\s*([^"'\s;>/]+)/i);
                    if (metaCs) {
                        const cs = metaCs[1].toLowerCase().replace(/[-_]/g, '');
                        if (cs === 'gbk' || cs === 'gb2312' || cs === 'gb18030') {
                            html = decodeGbk(buf);
                        }
                    }

                    const title   = extractTitle(html) || url.hostname;
                    const content = extractText(html);

                    if (content.length < 80) {
                        return reject(new Error('無法擷取頁面內容（頁面可能需要登入或由 JavaScript 動態渲染）'));
                    }
                    resolve({ content, title });
                });
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('連線逾時')); });
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function decodeBuffer(buf: Buffer, contentType: string): string {
    const m = contentType.match(/charset=([^\s;]+)/i);
    if (m) {
        const cs = m[1].toLowerCase().replace(/[-_]/g, '');
        if (cs === 'gbk' || cs === 'gb2312' || cs === 'gb18030') {
            return decodeGbk(buf);
        }
    }
    return buf.toString('utf8');
}

function decodeGbk(buf: Buffer): string {
    try { return new TextDecoder('gb18030').decode(buf); }
    catch { return buf.toString('utf8'); }
}

function extractTitle(html: string): string {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? decodeEntities(m[1]).trim().replace(/\s+/g, ' ') : '';
}

function extractText(html: string): string {
    // Strip boilerplate sections
    let text = html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<head[\s\S]*?<\/head>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<aside[\s\S]*?<\/aside>/gi, '');

    // Convert structural tags to newlines before stripping
    text = text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<hr[^>]*>/gi, '\n───────────────────\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&emsp;/gi, '　')
        .replace(/&ensp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return text;
}

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
