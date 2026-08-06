/**
 * The quick toggle for where books open.
 *
 * Two halves: the setting/context-key logic, and the package.json wiring that
 * decides whether the menu items ever appear. The manifest half matters because
 * a mistyped command id or context key fails silently at runtime — the menu
 * entry simply never shows up.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stub = require('./vscodeStub.js');

const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

// ── Setting and context key ─────────────────────────────────────────────────

describe('openIn setting', () => {
    let vscode, restore, hosts;

    beforeEach(() => {
        ({ vscode, restore } = stub.install());
        for (const id of Object.keys(require.cache)) {
            if (id.includes('out') && id.includes('.js')) { delete require.cache[id]; }
        }
        hosts = require('../out/readerHosts.js');
    });

    afterEach(() => restore());

    test('reads the configured location', () => {
        vscode.__setConfig({ openIn: 'editor' });
        assert.equal(hosts.readOpenIn(), 'editor');
    });

    test('falls back to the panel for anything unrecognised', () => {
        for (const value of [undefined, '', 'Editor', 'sidebar']) {
            vscode.__setConfig(value === undefined ? {} : { openIn: value });
            assert.equal(hosts.readOpenIn(), 'panel', `openIn=${JSON.stringify(value)}`);
        }
    });

    test('writes to user settings, not the workspace', async () => {
        vscode.__setConfig({ openIn: 'panel' });

        await hosts.setOpenIn('editor');

        assert.deepEqual(vscode.__calls.configUpdates, [
            { key: 'openIn', value: 'editor', target: vscode.ConfigurationTarget.Global },
        ]);
        assert.equal(hosts.readOpenIn(), 'editor', 'and takes effect immediately');
    });

    test('sets no mirrored context key — the menus read the setting directly', async () => {
        vscode.__setConfig({ openIn: 'panel' });
        await hosts.setOpenIn('editor');

        const setContextCalls = vscode.__calls.executeCommand.filter(c => c[0] === 'setContext');
        assert.deepEqual(setContextCalls, [], 'a mirrored key would only be able to drift');
    });
});

// ── Carrying the current book across a switch ───────────────────────────────

describe('EditorTabs', () => {
    let restore, hosts;

    beforeEach(() => {
        ({ restore } = stub.install());
        for (const id of Object.keys(require.cache)) {
            if (id.includes('out') && id.includes('.js')) { delete require.cache[id]; }
        }
        hosts = require('../out/readerHosts.js');
    });

    afterEach(() => restore());

    const panel = (active) => {
        const p = new stub.FakeWebviewPanel('corvusTxtReader.readerPanel', 't', 1);
        p.active = active;
        return p;
    };
    const REF_A = { uriKey: 'file:///a.txt', fileName: 'a.txt' };
    const REF_B = { uriKey: 'drive://F/B', fileName: 'b.txt' };

    test('reports nothing when no reader tab is open', () => {
        assert.equal(new hosts.EditorTabs().active(), undefined);
    });

    test('picks the focused tab', () => {
        const tabs = new hosts.EditorTabs();
        tabs.track(panel(false), REF_A);
        tabs.track(panel(true), REF_B);

        assert.equal(tabs.active().ref.uriKey, REF_B.uriKey);
    });

    test('falls back to the only tab when none has focus', () => {
        const tabs = new hosts.EditorTabs();
        tabs.track(panel(false), REF_A);

        assert.equal(tabs.active().ref.uriKey, REF_A.uriKey);
    });

    test('stays out of the way when several tabs are open and none has focus', () => {
        const tabs = new hosts.EditorTabs();
        tabs.track(panel(false), REF_A);
        tabs.track(panel(false), REF_B);

        assert.equal(tabs.active(), undefined, 'guessing which book to move would be wrong');
    });

    test('closing the reported tab disposes it', () => {
        const tabs = new hosts.EditorTabs();
        const p = panel(true);
        tabs.track(p, REF_A);

        tabs.active().close();

        assert.equal(p.disposed, true);
    });

    test('forgets a tab once it is closed', () => {
        const tabs = new hosts.EditorTabs();
        const p = panel(true);
        tabs.track(p, REF_A);
        p.dispose();

        assert.equal(tabs.active(), undefined);
    });
});

// ── Manifest wiring ─────────────────────────────────────────────────────────

describe('openIn menu contributions', () => {
    const declared = new Set(manifest.contributes.commands.map(c => c.command));
    const allMenuItems = Object.entries(manifest.contributes.menus)
        .flatMap(([menu, items]) => items.map(item => ({ menu, ...item })));

    test('both toggle commands are declared', () => {
        assert.ok(declared.has('corvusTxtReader.openInEditor'));
        assert.ok(declared.has('corvusTxtReader.openInPanel'));
    });

    test('every menu item refers to a declared command', () => {
        const unknown = allMenuItems
            .filter(item => !declared.has(item.command))
            .map(item => `${item.menu}: ${item.command}`);
        assert.deepEqual(unknown, [], 'a menu item for an undeclared command never appears');
    });

    test('the toggle is offered from the editor tab, the trees, and the palette', () => {
        const menus = new Set(
            allMenuItems
                .filter(item => item.command.startsWith('corvusTxtReader.openIn'))
                .map(item => item.menu)
        );
        for (const expected of ['editor/title/context', 'view/title', 'view/item/context', 'commandPalette']) {
            assert.ok(menus.has(expected), `missing from ${expected}`);
        }
    });

    const toggles = allMenuItems.filter(i => i.command.startsWith('corvusTxtReader.openIn'));

    // The reader panel's own toolbar button needs no state gate: that view only
    // exists while `openIn` is not `editor`, so the button is always the right
    // one to offer. Everything else must gate itself explicitly.
    const isPanelToolbarButton = (item) => item.when === 'view == corvusTxtReader.readerView';

    test('each state-gated entry shows only when the reader is not already there', () => {
        const gated = toggles.filter(i => !isPanelToolbarButton(i));
        assert.ok(gated.length > 0);
        for (const item of gated) {
            const wants = item.command.endsWith('openInEditor') ? 'panel' : 'editor';
            assert.match(
                item.when,
                new RegExp(`config\\.corvusTxtReader\\.openIn == ${wants}\\b`),
                `${item.menu}/${item.command} could show while the reader is already there`
            );
        }
    });

    test('state-gated entries come in mutually exclusive pairs per menu', () => {
        const byMenu = new Map();
        for (const item of toggles.filter(i => !isPanelToolbarButton(i))) {
            byMenu.set(item.menu, [...(byMenu.get(item.menu) ?? []), item]);
        }
        for (const [menu, items] of byMenu) {
            assert.equal(items.length, 2, `${menu} should offer exactly one of each`);
            const states = items.map(i => (i.when.includes('openIn == panel') ? 'panel' : 'editor'));
            assert.deepEqual([...states].sort(), ['editor', 'panel'], `${menu} gates are not mutually exclusive`);
        }
    });

    test('the reader panel carries a toolbar button to move the book to the editor', () => {
        const button = toggles.find(isPanelToolbarButton);
        assert.ok(button, 'no ungated entry pinned to the reader view');
        assert.equal(button.menu, 'view/title');
        assert.equal(button.command, 'corvusTxtReader.openInEditor', 'offering "move to panel" from the panel is a no-op');
        assert.match(button.group, /^navigation/, 'must be a visible button, not buried in the ... overflow');
    });

    test('every toggle command declares an icon, since one is shown as a button', () => {
        for (const id of ['corvusTxtReader.openInEditor', 'corvusTxtReader.openInPanel']) {
            const declared = manifest.contributes.commands.find(c => c.command === id);
            assert.match(declared.icon ?? '', /^\$\([a-z-]+\)$/, `${id} needs a codicon`);
        }
    });

    test('gates read the setting directly, so they are right before activation', () => {
        for (const item of toggles.filter(i => !isPanelToolbarButton(i))) {
            assert.match(item.when, /config\.corvusTxtReader\.openIn/, `${item.menu} uses a mirrored key`);
        }
    });

    test('the panel view hides itself in editor mode', () => {
        const view = manifest.contributes.views['corvus-reader-panel']
            .find(v => v.id === 'corvusTxtReader.readerView');
        assert.ok(view, 'the reader panel view is still declared');
        assert.equal(view.when, 'config.corvusTxtReader.openIn != editor');
    });

    test('the editor tab entry also covers Drive tabs, which have no file extension', () => {
        const tabItems = allMenuItems.filter(
            i => i.menu === 'editor/title/context' && i.command.startsWith('corvusTxtReader.openIn')
        );
        for (const item of tabItems) {
            assert.match(item.when, /activeWebviewPanelId == corvusTxtReader\.readerPanel/);
        }
    });

    test('the webview panel id in the manifest matches the host', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'readerHosts.ts'), 'utf8');
        assert.match(src, /viewType = 'corvusTxtReader\.readerPanel'/);
    });
});
