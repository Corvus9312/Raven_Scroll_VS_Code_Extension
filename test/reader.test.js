/**
 * Behavioural tests for the shared reader layer.
 *
 * These are the ones that matter for the bug this refactor fixed: a local book
 * and a Drive book must take the *same* code path, and the `openIn` setting must
 * select the display location for both. Anything that re-forks the two paths
 * should break a test here.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const stub = require('./vscodeStub.js');

let vscode, restore, ReaderSession, ReaderRouter, EditorPanelHost, EditorTabs, bookCore;

beforeEach(() => {
    ({ vscode, restore } = stub.install());
    // Require after the stub is installed, and fresh each time so module state
    // never leaks between tests.
    for (const id of Object.keys(require.cache)) {
        if (id.includes('out') && id.includes('.js')) { delete require.cache[id]; }
    }
    ReaderSession   = require('../out/readerSession.js').ReaderSession;
    ReaderRouter    = require('../out/readerHosts.js').ReaderRouter;
    EditorPanelHost = require('../out/readerHosts.js').EditorPanelHost;
    EditorTabs      = require('../out/readerHosts.js').EditorTabs;
    bookCore        = require('../out/core/book.js');
});

afterEach(() => restore());

// ── Test doubles ────────────────────────────────────────────────────────────

/** A BookSource backed by an in-memory map, standing in for local or Drive. */
function fakeSource(label, books) {
    return {
        label,
        progress: new Map(),
        opened: [],
        readBytes: async (ref) => new Uint8Array(Buffer.from(books[ref.uriKey]?.text ?? '', 'utf8')),
        readProgress: async function (ref) { return this.progress.get(ref.uriKey) ?? null; },
        writeProgress: async function (ref, p) { this.progress.set(ref.uriKey, p); },
        nextBook: async (ref) => books[ref.uriKey]?.next,
        noteOpened: function (ref) { this.opened.push(ref.uriKey); },
    };
}

function fakeSources(local, drive) {
    return {
        local,
        drive,
        for: (ref) => {
            const key = typeof ref === 'string' ? ref : ref.uriKey;
            return bookCore.isDriveKey(key) ? drive : local;
        },
    };
}

function fakeContext() {
    const state = new Map();
    return {
        extensionUri: stub.Uri.file('/ext'),
        globalState: {
            get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
            update: async (key, value) => { state.set(key, value); },
        },
    };
}

const LOCAL_KEY = 'file:///books/a.txt';
const DRIVE_KEY = 'drive://FOLDER1/FILE1';

function makeSession(overrides = {}) {
    const local = fakeSource('local', {
        [LOCAL_KEY]: { text: '本機內容', next: { uriKey: 'file:///books/b.txt', fileName: 'b.txt' } },
    });
    const drive = fakeSource('drive', {
        [DRIVE_KEY]: { text: '雲端內容', next: { uriKey: 'drive://FOLDER1/FILE2', fileName: '第二卷.txt' } },
    });
    const sources = fakeSources(local, drive);
    const saved = [];
    const session = new ReaderSession({
        context: fakeContext(),
        sources,
        onProgressSaved: () => saved.push(true),
        ...overrides,
    });
    return { session, local, drive, sources, saved };
}

/** Attach a webview and complete the handshake reader.js performs on load. */
async function attachReady(session) {
    const webview = new stub.FakeWebview();
    session.attach(webview);
    await webview.send({ type: 'ready' });
    return webview;
}

// ── Loading ─────────────────────────────────────────────────────────────────

describe('ReaderSession.open', () => {
    test('loads a local book', async () => {
        const { session } = makeSession();
        const webview = await attachReady(session);

        await session.open({ uriKey: LOCAL_KEY, fileName: 'a.txt' });

        const msg = webview.posted.at(-1);
        assert.equal(msg.type, 'loadContent');
        assert.equal(msg.text, '本機內容');
        assert.equal(msg.uriKey, LOCAL_KEY);
    });

    test('loads a Drive book through the identical path', async () => {
        const { session } = makeSession();
        const webview = await attachReady(session);

        await session.open({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });

        const msg = webview.posted.at(-1);
        assert.equal(msg.type, 'loadContent');
        assert.equal(msg.text, '雲端內容');
        assert.equal(msg.uriKey, DRIVE_KEY);
        assert.equal(msg.title, '第一卷', 'title comes from the same helper for both sources');
    });

    test('restores saved position from the owning source', async () => {
        const { session, drive } = makeSession();
        drive.progress.set(DRIVE_KEY, { scrollTop: 512, percent: 30 });
        const webview = await attachReady(session);

        await session.open({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });

        assert.equal(webview.posted.at(-1).savedProgress, 512);
    });

    test('queues content until the webview reports ready, then flushes', async () => {
        const { session } = makeSession();
        const webview = new stub.FakeWebview();
        session.attach(webview);

        await session.open({ uriKey: LOCAL_KEY, fileName: 'a.txt' });
        assert.equal(webview.posted.length, 0, 'nothing posted before ready');

        await webview.send({ type: 'ready' });
        assert.equal(webview.posted.length, 1, 'queued content replayed on ready');
        assert.equal(webview.posted[0].text, '本機內容');
    });

    test('records the book in the source recent-reads hook', async () => {
        const { session, local, drive } = makeSession();
        await attachReady(session);

        await session.open({ uriKey: LOCAL_KEY, fileName: 'a.txt' });
        await session.open({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });

        assert.deepEqual(local.opened, [LOCAL_KEY]);
        assert.deepEqual(drive.opened, [DRIVE_KEY]);
    });
});

// ── Progress ────────────────────────────────────────────────────────────────

describe('ReaderSession progress', () => {
    test('writes local progress to the local source', async () => {
        const { session, local, saved } = makeSession();
        const webview = await attachReady(session);
        await session.open({ uriKey: LOCAL_KEY, fileName: 'a.txt' });

        await webview.send({ type: 'saveProgress', uriKey: LOCAL_KEY, scrollTop: 300, percent: 45 });

        assert.deepEqual(local.progress.get(LOCAL_KEY), { scrollTop: 300, percent: 45 });
        assert.equal(saved.length, 1, 'library trees refreshed');
    });

    test('writes Drive progress to the Drive source', async () => {
        const { session, drive, local } = makeSession();
        const webview = await attachReady(session);
        await session.open({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });

        await webview.send({ type: 'saveProgress', uriKey: DRIVE_KEY, scrollTop: 700, percent: 88 });

        assert.deepEqual(drive.progress.get(DRIVE_KEY), { scrollTop: 700, percent: 88 });
        assert.equal(local.progress.size, 0, 'must not leak into the local store');
    });

    test('ignores a save with no book loaded', async () => {
        const { session, local } = makeSession();
        const webview = await attachReady(session);

        await webview.send({ type: 'saveProgress', uriKey: '', scrollTop: 10, percent: 1 });

        assert.equal(local.progress.size, 0);
    });

    test('persists reader preferences', async () => {
        const { session } = makeSession();
        const webview = await attachReady(session);

        const prefs = { fontSize: 20, lineHeight: 1.8, fontFamily: 'kaiti', theme: 'light' };
        await webview.send({ type: 'savePrefs', prefs });
        await session.open({ uriKey: LOCAL_KEY, fileName: 'a.txt' });

        assert.deepEqual(webview.posted.at(-1).prefs, prefs);
    });
});

// ── Next book ───────────────────────────────────────────────────────────────

describe('ReaderSession next book', () => {
    test('answers requestNextFile for a local book', async () => {
        const { session } = makeSession();
        const webview = await attachReady(session);
        await session.open({ uriKey: LOCAL_KEY, fileName: 'a.txt' });

        await webview.send({ type: 'requestNextFile', uriKey: LOCAL_KEY });

        assert.deepEqual(webview.posted.at(-1), {
            type: 'nextFile', exists: true, name: 'b', fileName: 'b.txt', uriKey: 'file:///books/b.txt',
        });
    });

    test('answers requestNextFile for a Drive book — the case the editor path used to drop', async () => {
        const { session } = makeSession();
        const webview = await attachReady(session);
        await session.open({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });

        await webview.send({ type: 'requestNextFile', uriKey: DRIVE_KEY });

        assert.deepEqual(webview.posted.at(-1), {
            type: 'nextFile', exists: true, name: '第二卷', fileName: '第二卷.txt', uriKey: 'drive://FOLDER1/FILE2',
        });
    });

    test('reports the end of a folder', async () => {
        const { session } = makeSession();
        const webview = await attachReady(session);
        await session.open({ uriKey: 'file:///books/last.txt', fileName: 'last.txt' });

        await webview.send({ type: 'requestNextFile', uriKey: 'file:///books/last.txt' });

        assert.deepEqual(webview.posted.at(-1), { type: 'nextFile', exists: false });
    });

    test('openNextFile routes through openBook so the openIn setting is honoured', async () => {
        const routed = [];
        const { session } = makeSession({ openBook: async (ref) => { routed.push(ref); } });
        const webview = await attachReady(session);
        await session.open({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });
        const before = webview.posted.length;

        await webview.send({ type: 'openNextFile', uriKey: 'drive://FOLDER1/FILE2', fileName: '第二卷.txt' });

        assert.deepEqual(routed, [{ uriKey: 'drive://FOLDER1/FILE2', fileName: '第二卷.txt' }]);
        assert.equal(webview.posted.length, before, 'must not also swap content into this webview');
    });

    test('openNextFile swaps in place when no router is wired', async () => {
        const { session, drive } = makeSession();
        const webview = await attachReady(session);
        await session.open({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });

        await webview.send({ type: 'openNextFile', uriKey: 'drive://FOLDER1/FILE2', fileName: '第二卷.txt' });

        const msg = webview.posted.at(-1);
        assert.equal(msg.type, 'loadContent');
        assert.equal(msg.uriKey, 'drive://FOLDER1/FILE2');
        assert.deepEqual(drive.opened, [DRIVE_KEY, 'drive://FOLDER1/FILE2']);
    });
});

// ── Routing: the openIn setting ─────────────────────────────────────────────

describe('ReaderRouter', () => {
    function makeRouter() {
        const local = fakeSource('local', {});
        const drive = fakeSource('drive', {});
        const sources = fakeSources(local, drive);
        const panelView   = { opened: [], open: async function (ref) { this.opened.push(ref.uriKey); } };
        const editorPanel = { shown: [],  show: async function (ref) { this.shown.push(ref.uriKey); } };
        return { router: new ReaderRouter(panelView, editorPanel, sources), panelView, editorPanel };
    }

    test('openIn=panel sends a local book to the panel view', async () => {
        vscode.__setConfig({ openIn: 'panel' });
        const { router, panelView, editorPanel } = makeRouter();

        await router.open({ uriKey: LOCAL_KEY, fileName: 'a.txt' });

        assert.deepEqual(panelView.opened, [LOCAL_KEY]);
        assert.deepEqual(editorPanel.shown, []);
    });

    test('openIn=panel sends a Drive book to the panel view', async () => {
        vscode.__setConfig({ openIn: 'panel' });
        const { router, panelView } = makeRouter();

        await router.open({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });

        assert.deepEqual(panelView.opened, [DRIVE_KEY]);
    });

    test('openIn=editor opens a local book with the custom editor', async () => {
        vscode.__setConfig({ openIn: 'editor' });
        const { router, panelView, editorPanel } = makeRouter();

        await router.open({ uriKey: LOCAL_KEY, fileName: 'a.txt' });

        assert.deepEqual(panelView.opened, []);
        assert.deepEqual(editorPanel.shown, []);
        const [command, , viewType] = vscode.__calls.executeCommand.at(-1);
        assert.equal(command, 'vscode.openWith');
        assert.equal(viewType, 'corvusTxtReader.reader');
    });

    test('openIn=editor opens a Drive book in the main editor area — the reported bug', async () => {
        vscode.__setConfig({ openIn: 'editor' });
        const { router, panelView, editorPanel } = makeRouter();

        await router.open({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });

        assert.deepEqual(editorPanel.shown, [DRIVE_KEY], 'Drive book must reach the editor area');
        assert.deepEqual(panelView.opened, [], 'and must not fall back to the bottom panel');
    });

    test('defaults to the panel when the setting is missing or unrecognised', async () => {
        for (const value of [undefined, 'nonsense']) {
            vscode.__setConfig(value === undefined ? {} : { openIn: value });
            const { router, panelView } = makeRouter();
            await router.open({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });
            assert.deepEqual(panelView.opened, [DRIVE_KEY], `openIn=${value}`);
        }
    });
});

// ── Editor-area panels (the host Drive books use) ───────────────────────────

describe('EditorPanelHost', () => {
    function makeHost() {
        const drive = fakeSource('drive', {
            [DRIVE_KEY]: { text: '雲端內容' },
            'drive://FOLDER1/FILE2': { text: '第二本' },
        });
        const sources = fakeSources(fakeSource('local', {}), drive);
        const tabs = new EditorTabs();
        return {
            host: new EditorPanelHost({ context: fakeContext(), sources, onProgressSaved: () => {} }, tabs),
            drive,
            tabs,
        };
    }

    /** Complete the ready handshake for the most recently created panel. */
    async function readyLast() {
        const panel = vscode.__panels.at(-1);
        await panel.webview.send({ type: 'ready' });
        return panel;
    }

    test('opens a Drive book in a titled editor tab', async () => {
        const { host } = makeHost();

        await host.show({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });
        const panel = await readyLast();

        assert.equal(vscode.__panels.length, 1);
        assert.equal(panel.title, '第一卷', 'tab shows the book name without the extension');
        assert.equal(panel.webview.posted.at(-1).text, '雲端內容');
    });

    test('re-opening the same book focuses the existing tab instead of duplicating', async () => {
        const { host } = makeHost();

        await host.show({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });
        await readyLast();
        await host.show({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });

        assert.equal(vscode.__panels.length, 1, 'no second tab');
        assert.equal(vscode.__panels[0].revealed > 0, true, 'existing tab focused');
    });

    test('a different book gets its own tab', async () => {
        const { host } = makeHost();

        await host.show({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });
        await readyLast();
        await host.show({ uriKey: 'drive://FOLDER1/FILE2', fileName: '第二卷.txt' });
        await readyLast();

        assert.equal(vscode.__panels.length, 2);
    });

    test('closing a tab lets the same book open a fresh one', async () => {
        const { host } = makeHost();

        await host.show({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });
        await readyLast();
        vscode.__panels[0].dispose();
        await host.show({ uriKey: DRIVE_KEY, fileName: '第一卷.txt' });

        assert.equal(vscode.__panels.length, 2, 'a disposed tab is no longer reused');
    });

    test('restores a Drive tab after a window reload', async () => {
        const { host } = makeHost();
        host.register();
        const serializer = vscode.__serializers.get('corvusTxtReader.readerPanel');
        assert.ok(serializer, 'serializer registered');

        // VS Code hands back a fresh panel plus the state the webview saved.
        const restored = new stub.FakeWebviewPanel('corvusTxtReader.readerPanel', '第一卷', 1);
        vscode.__panels.push(restored);
        await serializer.deserializeWebviewPanel(restored, { uriKey: DRIVE_KEY, fileName: '第一卷.txt' });
        await restored.webview.send({ type: 'ready' });

        assert.equal(restored.disposed, false);
        assert.equal(restored.webview.posted.at(-1).uriKey, DRIVE_KEY, 'the same book came back');
    });

    test('discards a restored tab with no recorded book instead of showing a blank one', async () => {
        const { host } = makeHost();
        host.register();
        const serializer = vscode.__serializers.get('corvusTxtReader.readerPanel');

        for (const state of [undefined, null, {}, { uriKey: '' }]) {
            const restored = new stub.FakeWebviewPanel('corvusTxtReader.readerPanel', '?', 1);
            await serializer.deserializeWebviewPanel(restored, state);
            assert.equal(restored.disposed, true, `state=${JSON.stringify(state)}`);
        }
    });
});
