/**
 * Tests for the webview side (`media/reader.js`), run in jsdom.
 *
 * The behaviour under test is the font gate: the bundled 文楷 is split into ~100
 * `font-display: swap` subsets, so text painted before they arrive shows a
 * fallback font and then reflows. The reader must lay the text out invisibly,
 * wait, and only then reveal and restore the scroll position.
 *
 * The page markup comes from the real `buildReaderHtml`, so a renamed or removed
 * element id fails here rather than silently at runtime.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const stub = require('./vscodeStub.js');

const READER_JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'reader.js'), 'utf8');

/** The reader page exactly as the extension serves it. */
function readerHtml() {
    const { restore } = stub.install();
    try {
        for (const id of Object.keys(require.cache)) {
            if (id.includes('out') && id.includes('.js')) { delete require.cache[id]; }
        }
        const { buildReaderHtml } = require('../out/utils.js');
        return buildReaderHtml(new stub.FakeWebview(), stub.Uri.file('/ext'));
    } finally {
        restore();
    }
}

/**
 * Boot the reader in jsdom with a controllable font loader.
 * `document.fonts` is not implemented by jsdom, so it is supplied here.
 */
function bootReader() {
    const dom = new JSDOM(readerHtml(), { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;

    const posted = [];
    let state = null;
    window.acquireVsCodeApi = () => ({
        postMessage: (msg) => posted.push(msg),
        setState: (s) => { state = s; },
        getState: () => state,
    });

    // jsdom implements neither of these; the reader only uses ResizeObserver to
    // re-anchor the scroll position on resize, which never happens here.
    const observed = [];
    window.ResizeObserver = class { observe(el) { observed.push(el); } disconnect() {} };

    let resolveFonts;
    const fontsReady = new Promise(resolve => { resolveFonts = resolve; });
    window.document.fonts = { ready: fontsReady };

    // Fire the font-wait timeout on demand rather than after a real 3 seconds.
    const realSetTimeout = window.setTimeout;
    let fireFontTimeout = null;
    window.setTimeout = (fn, delay, ...rest) => {
        if (delay === 3000) { fireFontTimeout = fn; return 0; }
        return realSetTimeout(fn, delay, ...rest);
    };

    window.eval(READER_JS);

    const $ = (id) => window.document.getElementById(id);
    return {
        window,
        posted,
        getState: () => state,
        el: { content: $('content'), epub: $('epub-content'), loading: $('loading'), title: $('book-title') },
        load: (data) => window.dispatchEvent(new window.MessageEvent('message', {
            data: { type: 'loadContent', mode: 'txt', text: '第一章\n內容內容', title: '測試',
                    savedProgress: 0, prefs: { fontFamily: 'lxgw' }, uriKey: 'file:///a.txt', ...data },
        })),
        resolveFonts: () => resolveFonts(),
        fireFontTimeout: () => fireFontTimeout && fireFontTimeout(),
        // Let queued microtasks (the async init) and any rAF callbacks run.
        tick: async () => { for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); } },
    };
}

describe('reader font gate', () => {
    test('keeps text laid out but invisible until the webfont is ready', async () => {
        const r = bootReader();

        r.load();
        await r.tick();

        assert.equal(r.el.content.style.display, 'block', 'laid out, so the subsets are actually requested');
        assert.equal(r.el.content.style.visibility, 'hidden', 'but not painted yet');
        assert.notEqual(r.el.loading.style.display, 'none', '載入中 still showing');
    });

    test('reveals the text once the webfont resolves', async () => {
        const r = bootReader();

        r.load();
        await r.tick();
        r.resolveFonts();
        await r.tick();

        assert.equal(r.el.content.style.visibility, '', 'text revealed');
        assert.equal(r.el.loading.style.display, 'none', '載入中 hidden');
    });

    test('does not wait at all for a system font', async () => {
        const r = bootReader();

        r.load({ prefs: { fontFamily: 'serif' } });
        await r.tick();

        // Fonts were never resolved, yet the text is already up.
        assert.equal(r.el.content.style.visibility, '');
        assert.equal(r.el.loading.style.display, 'none');
    });

    test('reveals anyway if the webfont never loads', async () => {
        const r = bootReader();

        r.load();
        await r.tick();
        assert.equal(r.el.content.style.visibility, 'hidden', 'still waiting');

        r.fireFontTimeout();
        await r.tick();

        assert.equal(r.el.content.style.visibility, '', 'timeout must not strand the reader on a blank page');
        assert.equal(r.el.loading.style.display, 'none');
    });

    test('a book opened while another is still waiting wins', async () => {
        const r = bootReader();

        r.load({ text: '第一本', title: '第一本', uriKey: 'file:///first.txt' });
        await r.tick();
        r.load({ text: '第二本', title: '第二本', uriKey: 'file:///second.txt' });
        await r.tick();

        r.resolveFonts();
        await r.tick();

        assert.equal(r.el.title.textContent, '第二本', 'the newer book is the one displayed');
        assert.match(r.el.content.textContent, /第二本/);
        assert.equal(r.el.content.style.visibility, '', 'and it is visible');
    });

    test('records the book in webview state so the tab can be restored', async () => {
        const r = bootReader();

        r.load({ uriKey: 'drive://F1/A1', fileName: '第一卷.txt' });
        await r.tick();

        // Compared field-wise: the object is created inside the jsdom realm, so
        // deepStrictEqual would fail on its prototype rather than its contents.
        assert.equal(r.getState().uriKey, 'drive://F1/A1');
        assert.equal(r.getState().fileName, '第一卷.txt');
    });
});
