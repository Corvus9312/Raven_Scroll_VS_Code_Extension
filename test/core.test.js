/**
 * Unit tests for the vscode-free core.
 *
 * Run with `npm test` (compiles first). These exercise the logic that used to be
 * duplicated between the custom-editor and panel reader paths, so a regression
 * that makes local and Drive books behave differently shows up here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const book    = require('../out/core/book.js');
const content = require('../out/core/content.js');
const localPr = require('../out/core/localProgress.js');

// ── Layering ────────────────────────────────────────────────────────────────

describe('core layering', () => {
    test('no core module imports vscode', () => {
        const dir = path.join(__dirname, '..', 'out', 'core');
        const offenders = fs.readdirSync(dir)
            .filter(f => f.endsWith('.js'))
            .filter(f => /require\(["']vscode["']\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
        assert.deepEqual(offenders, [], 'core must stay unit-testable outside VS Code');
    });
});

// ── Book identity ───────────────────────────────────────────────────────────

describe('book formats', () => {
    test('recognises txt and epub, case-insensitively', () => {
        assert.equal(book.isBookFile('a.txt'), true);
        assert.equal(book.isBookFile('a.TXT'), true);
        assert.equal(book.isBookFile('a.EPub'), true);
        assert.equal(book.isBookFile('a.pdf'), false);
        assert.equal(book.isBookFile('.corvus.a.txt.json'), false);
    });

    test('strips only the book extension', () => {
        assert.equal(book.stripBookExt('第一卷.txt'), '第一卷');
        assert.equal(book.stripBookExt('v1.2.epub'), 'v1.2');
        assert.equal(book.stripBookExt('no-ext'), 'no-ext');
    });
});

describe('drive keys', () => {
    test('round-trip with a folder', () => {
        const key = book.makeDriveKey('FILE1', 'FOLDER1');
        assert.equal(key, 'drive://FOLDER1/FILE1');
        assert.deepEqual(book.parseDriveKey(key), { folderId: 'FOLDER1', fileId: 'FILE1' });
    });

    test('round-trip without a folder', () => {
        const key = book.makeDriveKey('FILE1');
        assert.equal(key, 'drive://FILE1');
        assert.deepEqual(book.parseDriveKey(key), { fileId: 'FILE1' });
    });

    test('distinguishes drive keys from file URIs', () => {
        assert.equal(book.isDriveKey('drive://A/B'), true);
        assert.equal(book.isDriveKey('file:///d%3A/books/a.txt'), false);
    });
});

describe('sidecar names', () => {
    test('derives and recognises the sidecar file name', () => {
        assert.equal(book.sidecarName('第一卷.txt'), '.corvus.第一卷.txt.json');
        assert.equal(book.isSidecarName('.corvus.第一卷.txt.json'), true);
        assert.equal(book.isSidecarName('第一卷.txt'), false);
        assert.equal(book.isSidecarName('.corvus.notjson'), false);
    });
});

// ── Progress ────────────────────────────────────────────────────────────────

describe('parseProgress', () => {
    test('reads the current format', () => {
        assert.deepEqual(book.parseProgress({ scrollTop: 120, percent: 42 }), { scrollTop: 120, percent: 42 });
    });

    test('reads a completed book', () => {
        assert.deepEqual(book.parseProgress({ scrollTop: 900, percent: 100 }), { scrollTop: 900, percent: 100 });
    });

    test('marks the pre-1.0 format as percent -1 so the position is kept', () => {
        assert.deepEqual(book.parseProgress({ scrollTop: 120 }), { scrollTop: 120, percent: -1 });
    });

    test('treats an unread book as no progress', () => {
        assert.equal(book.parseProgress({ scrollTop: 0 }), null);
        assert.equal(book.parseProgress({}), null);
        assert.equal(book.parseProgress(null), null);
        assert.equal(book.parseProgress('garbage'), null);
    });

    test('keeps an explicit percent of 0', () => {
        assert.deepEqual(book.parseProgress({ scrollTop: 0, percent: 0 }), { scrollTop: 0, percent: 0 });
    });
});

describe('describePercent', () => {
    test('labels each band', () => {
        assert.equal(book.describePercent(null), undefined);
        assert.equal(book.describePercent(undefined), undefined);
        assert.equal(book.describePercent(0), undefined);
        assert.equal(book.describePercent(-1), '閱讀中');
        assert.equal(book.describePercent(1), '1%');
        assert.equal(book.describePercent(94), '94%');
        assert.equal(book.describePercent(95), '✓ 完結');
        assert.equal(book.describePercent(100), '✓ 完結');
    });

    test('describeProgress agrees with describePercent', () => {
        assert.equal(book.describeProgress({ scrollTop: 1, percent: 96 }), '✓ 完結');
        assert.equal(book.describeProgress(null), undefined);
    });
});

describe('describeFolderProgress', () => {
    test('counts only completed books', () => {
        const progresses = [
            { scrollTop: 1, percent: 100 },
            { scrollTop: 1, percent: 95 },
            { scrollTop: 1, percent: 94 },
            null,
        ];
        assert.equal(book.describeFolderProgress(progresses), '2 / 4');
    });

    test('says nothing about an empty folder', () => {
        assert.equal(book.describeFolderProgress([]), undefined);
    });
});

// ── Sibling ordering ────────────────────────────────────────────────────────

describe('nextBook', () => {
    const entries = [
        { id: '3', name: '第三卷.txt' },
        { id: '1', name: '第一卷.txt' },
        { id: '2', name: '第二卷.txt' },
    ];

    test('follows zh-TW display order, not input order', () => {
        assert.equal(book.nextBook(entries, '1').id, '2');
        assert.equal(book.nextBook(entries, '2').id, '3');
    });

    test('returns undefined at the end of the folder', () => {
        assert.equal(book.nextBook(entries, '3'), undefined);
    });

    test('returns undefined for a book that is not in the folder', () => {
        assert.equal(book.nextBook(entries, 'nope'), undefined);
    });

    test('ignores non-book files, including sidecars', () => {
        const mixed = [
            { id: 'a', name: 'a.txt' },
            { id: 'side', name: '.corvus.a.txt.json' },
            { id: 'img', name: 'cover.jpg' },
            { id: 'b', name: 'b.epub' },
        ];
        assert.equal(book.nextBook(mixed, 'a').id, 'b');
        assert.equal(book.nextBook(mixed, 'b'), undefined);
    });

    test('works the same for local names and drive ids', () => {
        // Local sources use the file name as the id; Drive uses the Drive file id.
        const local = [{ id: 'a.txt', name: 'a.txt' }, { id: 'b.txt', name: 'b.txt' }];
        assert.equal(book.nextBook(local, 'a.txt').id, 'b.txt');
    });
});

// ── Decoding ────────────────────────────────────────────────────────────────

describe('decodeBytes', () => {
    test('strips a UTF-8 BOM', () => {
        const bytes = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('第一章', 'utf8')]);
        assert.equal(content.decodeBytes(new Uint8Array(bytes)), '第一章');
    });

    test('decodes plain UTF-8', () => {
        assert.equal(content.decodeBytes(new Uint8Array(Buffer.from('第一章', 'utf8'))), '第一章');
    });

    test('falls back to GB18030 for non-UTF-8 CJK bytes', () => {
        // "中文" in GB18030
        const gb = new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4]);
        assert.equal(content.decodeBytes(gb), '中文');
    });
});

describe('buildContentMsg', () => {
    test('builds a txt payload with the extension stripped from the title', () => {
        const msg = content.buildContentMsg(new Uint8Array(Buffer.from('內容', 'utf8')), '第一卷.txt');
        assert.equal(msg.mode, 'txt');
        assert.equal(msg.title, '第一卷');
        assert.equal(msg.text, '內容');
    });

    test('reports a broken EPUB as readable text instead of throwing', () => {
        const msg = content.buildContentMsg(new Uint8Array([1, 2, 3]), 'broken.epub');
        assert.equal(msg.mode, 'txt');
        assert.equal(msg.title, 'broken');
        assert.match(msg.text, /無法開啟此 EPUB/);
    });
});

// ── Sidecar reads against the real filesystem ───────────────────────────────

describe('readLocalProgress', () => {
    let dir;

    const setup = () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-test-'));
        return dir;
    };
    const write = (name, body) => fs.writeFileSync(path.join(dir, name), body, 'utf8');

    test('reads a sidecar written beside the book', () => {
        setup();
        write('a.txt', 'body');
        write('.corvus.a.txt.json', JSON.stringify({ scrollTop: 42, percent: 7 }));
        assert.deepEqual(localPr.readLocalProgress(path.join(dir, 'a.txt')), { scrollTop: 42, percent: 7 });
    });

    test('returns null when there is no sidecar', () => {
        setup();
        write('a.txt', 'body');
        assert.equal(localPr.readLocalProgress(path.join(dir, 'a.txt')), null);
    });

    test('returns null for a corrupt sidecar instead of throwing', () => {
        setup();
        write('a.txt', 'body');
        write('.corvus.a.txt.json', 'not json{');
        assert.equal(localPr.readLocalProgress(path.join(dir, 'a.txt')), null);
    });

    test('aggregates a folder, ignoring sidecars and non-books', () => {
        setup();
        write('a.txt', 'body');
        write('b.txt', 'body');
        write('cover.jpg', 'x');
        write('.corvus.a.txt.json', JSON.stringify({ scrollTop: 9, percent: 100 }));
        const progresses = localPr.readFolderProgress(dir);
        assert.equal(progresses.length, 2, 'two books, sidecar and image excluded');
        assert.equal(book.describeFolderProgress(progresses), '1 / 2');
    });

    test('returns an empty list for a missing folder', () => {
        assert.deepEqual(localPr.readFolderProgress(path.join(os.tmpdir(), 'raven-does-not-exist')), []);
    });
});
