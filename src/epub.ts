import * as zlib from 'zlib';

// ── Public types ──────────────────────────────────────────────────────────────

interface EpubChapter {
    title: string;
    anchor: string; // element id in the rendered HTML to scroll to
}

interface EpubBook {
    title: string;
    html: string;            // combined body HTML for all spine docs (images inlined)
    chapters: EpubChapter[]; // table of contents
}

// ── Security limits ─────────────────────────────────────────────────────────────
// EPUB is an untrusted ZIP. Guard against decompression bombs: cap the inflated
// size of any single entry and the total across the whole archive. We never write
// entries to disk and never execute them, so zip-slip / embedded executables are
// not a concern here — the only real risk from the container itself is resource
// exhaustion, which these limits bound.

const MAX_ENTRY_BYTES  = 50 * 1024 * 1024;   // 50 MB per inflated entry
const MAX_TOTAL_BYTES  = 200 * 1024 * 1024;  // 200 MB inflated total

// ── ZIP reader (dependency-free, uses Node zlib) ────────────────────────────────
// The VSIX is packed with --no-dependencies, so a third-party zip library would
// not be bundled. We parse the central directory and inflate each entry ourselves.

function unzip(buf: Buffer): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    const EOCD_SIG = 0x06054b50;
    const CDH_SIG  = 0x02014b50;

    // Locate the End Of Central Directory record (scan backwards; comment ≤ 64 KB).
    let eocd = -1;
    const minPos = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= minPos; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) { throw new Error('不是有效的 ZIP/EPUB 檔案'); }

    const cdCount  = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);

    let total = 0;
    let p = cdOffset;
    for (let n = 0; n < cdCount; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) { break; }
        const method     = buf.readUInt16LE(p + 10);
        const compSize   = buf.readUInt32LE(p + 20);
        const nameLen    = buf.readUInt16LE(p + 28);
        const extraLen   = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOff   = buf.readUInt32LE(p + 42);
        // ZIP mandates '/' separators; normalise stray '\' from non-conformant producers.
        const name       = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');

        // Locate the data start via the local file header (its name/extra lengths
        // may differ from the central directory record). Bounds-check everything:
        // a malformed offset must throw cleanly, never read out of range.
        if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
            const lhNameLen  = buf.readUInt16LE(localOff + 26);
            const lhExtraLen = buf.readUInt16LE(localOff + 28);
            const dataStart  = localOff + 30 + lhNameLen + lhExtraLen;
            const dataEnd    = dataStart + compSize;
            if (dataEnd <= buf.length) {
                const raw = buf.subarray(dataStart, dataEnd);
                try {
                    let content: Buffer | undefined;
                    if (method === 0) {
                        content = Buffer.from(raw);
                    } else if (method === 8) {
                        content = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
                    }
                    // other methods (encrypted / zip64) are skipped
                    if (content) {
                        total += content.length;
                        if (total > MAX_TOTAL_BYTES) { throw new Error('EPUB 解壓後過大，已中止（疑似解壓炸彈）'); }
                        files.set(name, content);
                    }
                } catch (e) {
                    if (e instanceof Error && e.message.includes('解壓炸彈')) { throw e; }
                    /* skip unreadable / oversized single entry */
                }
            }
        }

        p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
}

// ── Path helpers ────────────────────────────────────────────────────────────────

function dirOf(p: string): string {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
}

function decode(seg: string): string {
    try { return decodeURIComponent(seg); } catch { return seg; }
}

/** Resolve an href (relative to `base` dir) into a normalised zip path, no fragment/query. */
function resolvePath(base: string, rel: string): string {
    let r = rel.split('#')[0].split('?')[0];
    r = decode(r);
    const parts = (base ? base + '/' + r : r).split('/');
    const out: string[] = [];
    for (const part of parts) {
        if (part === '' || part === '.') { continue; }
        if (part === '..') { out.pop(); } else { out.push(part); }
    }
    return out.join('/');
}

function fragOf(href: string): string {
    const i = href.indexOf('#');
    return i < 0 ? '' : href.slice(i + 1);
}

// ── XML / HTML helpers (regex-based; OPF/NCX are simple, well-formed XML) ────────
// Regex parsing also sidesteps XXE: there is no XML entity expansion or external
// entity resolution, so a crafted DOCTYPE cannot trigger file/network access.

function attr(tag: string, name: string): string | undefined {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
    return m ? (m[2] ?? m[3]) : undefined;
}

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
    return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

const MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
};

function imageDataUri(src: string, xhtmlDir: string, files: Map<string, Buffer>): string | null {
    const full = resolvePath(xhtmlDir, src);
    const bytes = files.get(full);
    if (!bytes) { return null; }
    const ext  = (full.split('.').pop() || '').toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    return `data:${mime};base64,${bytes.toString('base64')}`;
}

// ── Spine document processing ────────────────────────────────────────────────────

function extractBody(xhtml: string): string {
    const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml);
    let body = m ? m[1] : xhtml;
    // Drop active/styling content — presentation is controlled by the webview and
    // any injected script is dead under the webview CSP anyway.
    body = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<link\b[^>]*>/gi, '')
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')   // strip inline event handlers
        .replace(/(href\s*=\s*)("|')\s*javascript:[^"']*\2/gi, '$1$2#$2'); // neutralise javascript: links
    return body;
}

/** Namespace every id="x" to id="<prefix>x" so ids stay unique across spine docs. */
function namespaceIds(html: string, prefix: string): string {
    return html.replace(/\bid\s*=\s*("([^"]*)"|'([^']*)')/gi, (_full, _q, dq, sq) => {
        const v = dq ?? sq ?? '';
        return `id="${prefix}${v}"`;
    });
}

function inlineImages(html: string, xhtmlDir: string, files: Map<string, Buffer>): string {
    // Only inline as data: URIs. Remote image URLs are deliberately NOT followed,
    // so a book cannot phone home / embed tracking pixels through the reader.
    const replaceSrc = (full: string, pre: string, q: string, src: string): string => {
        if (/^data:/i.test(src)) { return full; }
        const uri = imageDataUri(src, xhtmlDir, files);
        return uri ? `${pre}${q}${uri}${q}` : full;
    };
    return html
        .replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi, replaceSrc)
        .replace(/(<image\b[^>]*?\b(?:xlink:href|href)\s*=\s*)(["'])([^"']*)\2/gi, replaceSrc);
}

// ── TOC parsing ──────────────────────────────────────────────────────────────────

interface RawTocEntry { title: string; href: string; }

function parseNcx(ncx: string): RawTocEntry[] {
    const out: RawTocEntry[] = [];
    // Each navPoint carries its label before its <content src>. Lazy match pairs them.
    const re = /<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ncx)) !== null) {
        const title = stripTags(m[1]);
        const href  = m[3] ?? m[4] ?? '';
        if (title && href) { out.push({ title, href }); }
    }
    return out;
}

function parseNavDoc(nav: string): RawTocEntry[] {
    // Prefer the <nav epub:type="toc"> region; fall back to the whole document.
    const region = /<nav\b[^>]*epub:type\s*=\s*("[^"]*\btoc\b[^"]*"|'[^']*\btoc\b[^']*')[^>]*>([\s\S]*?)<\/nav>/i.exec(nav);
    const scope  = region ? region[2] : nav;
    const out: RawTocEntry[] = [];
    const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scope)) !== null) {
        const href  = m[2] ?? m[3] ?? '';
        const title = stripTags(m[4]);
        if (title && href) { out.push({ title, href }); }
    }
    return out;
}

// ── Main entry point ─────────────────────────────────────────────────────────────

export function parseEpub(bytes: Uint8Array): EpubBook {
    const buf   = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const files = unzip(buf);

    // 1. container.xml → OPF path
    const container = files.get('META-INF/container.xml');
    if (!container) { throw new Error('EPUB 缺少 META-INF/container.xml'); }
    const opfMatch = /<rootfile\b[^>]*\bfull-path\s*=\s*("([^"]*)"|'([^']*)')/i.exec(container.toString('utf8'));
    const opfPath  = opfMatch ? (opfMatch[2] ?? opfMatch[3] ?? '') : '';
    const opfBytes = opfPath ? files.get(opfPath) : undefined;
    if (!opfBytes) { throw new Error('EPUB 缺少 OPF 檔案'); }

    const opf    = opfBytes.toString('utf8');
    const opfDir = dirOf(opfPath);

    // 2. Title
    const titleMatch = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf);
    const title = titleMatch ? stripTags(titleMatch[1]) : '';

    // 3. Manifest: id → { href, properties }
    const manifest = new Map<string, { href: string; props: string }>();
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
        const tag  = m[0];
        const id   = attr(tag, 'id');
        const href = attr(tag, 'href');
        if (id && href) { manifest.set(id, { href, props: attr(tag, 'properties') || '' }); }
    }

    // 4. Spine: ordered list of manifest idrefs, plus optional ncx toc id
    const spineTag = /<spine\b[^>]*>/i.exec(opf);
    const ncxId    = spineTag ? attr(spineTag[0], 'toc') : undefined;
    const spineRefs: string[] = [];
    for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
        const idref = attr(m[0], 'idref');
        if (idref) { spineRefs.push(idref); }
    }

    // 5. Build combined HTML; remember which spine section each file path maps to
    const sectionOfPath = new Map<string, number>(); // full zip path → spine index
    const sectionHtml: string[] = [];
    spineRefs.forEach((idref, i) => {
        const item = manifest.get(idref);
        if (!item) { return; }
        const fullPath = resolvePath(opfDir, item.href);
        const raw = files.get(fullPath);
        if (!raw) { return; }

        const prefix   = `epub-sec-${i}-`;
        const xhtmlDir = dirOf(fullPath);
        let body = extractBody(raw.toString('utf8'));
        body = inlineImages(body, xhtmlDir, files);
        body = namespaceIds(body, prefix);

        sectionOfPath.set(fullPath, i);
        sectionHtml[i] = `<section id="epub-sec-${i}" data-href="${fullPath}">${body}</section>`;
    });

    // 6. Table of contents
    let rawToc: RawTocEntry[] = [];
    let tocPath = '';
    if (ncxId && manifest.has(ncxId)) {
        tocPath = resolvePath(opfDir, manifest.get(ncxId)!.href);
        const ncx = files.get(tocPath);
        if (ncx) { rawToc = parseNcx(ncx.toString('utf8')); }
    }
    if (rawToc.length === 0) {
        // EPUB3 nav document (manifest item with properties="nav")
        for (const [, item] of manifest) {
            if (/\bnav\b/.test(item.props)) {
                tocPath = resolvePath(opfDir, item.href);
                const nav = files.get(tocPath);
                if (nav) { rawToc = parseNavDoc(nav.toString('utf8')); }
                break;
            }
        }
    }

    const tocDir = dirOf(tocPath);
    const chapters: EpubChapter[] = [];
    for (const entry of rawToc) {
        const targetPath = resolvePath(tocDir, entry.href);
        const secIdx = sectionOfPath.get(targetPath);
        if (secIdx === undefined) { continue; }
        const frag = fragOf(entry.href);
        let anchor = `epub-sec-${secIdx}`;
        if (frag) {
            const nsId = `epub-sec-${secIdx}-${frag}`;
            if (sectionHtml[secIdx]?.includes(`id="${nsId}"`)) { anchor = nsId; }
        }
        chapters.push({ title: entry.title, anchor });
    }

    // Fallback: no usable TOC → one entry per spine section
    if (chapters.length === 0) {
        spineRefs.forEach((_idref, i) => {
            if (sectionHtml[i] === undefined) { return; }
            chapters.push({ title: `第 ${i + 1} 節`, anchor: `epub-sec-${i}` });
        });
    }

    return { title, html: sectionHtml.filter(Boolean).join('\n'), chapters };
}
