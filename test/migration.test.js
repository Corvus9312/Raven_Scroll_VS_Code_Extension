/**
 * Tests for the one-time legacy progress migration.
 *
 * This is the only code in the refactor that touches a reader's existing data,
 * so it is tested against an in-memory filesystem: it must never overwrite a
 * sidecar, and must run exactly once.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const stub = require('./vscodeStub.js');

let vscode, restore, migrateLegacyProgress, keys;

beforeEach(() => {
    ({ vscode, restore } = stub.install());
    for (const id of Object.keys(require.cache)) {
        if (id.includes('out') && id.includes('.js')) { delete require.cache[id]; }
    }
    migrateLegacyProgress = require('../out/migrateProgress.js').migrateLegacyProgress;
    keys = require('../out/keys.js');
});

afterEach(() => restore());

function fakeContext(initial = {}) {
    const state = new Map(Object.entries(initial));
    return {
        globalState: {
            get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
            update: async (key, value) => { state.set(key, value); },
        },
        __state: state,
    };
}

/** Absolute paths that survive stub Uri round-tripping on this platform. */
const BOOK_A = path.resolve('/books/a.txt');
const BOOK_B = path.resolve('/books/b.txt');
const SIDECAR_A = path.resolve('/books/.corvus.a.txt.json');
const SIDECAR_B = path.resolve('/books/.corvus.b.txt.json');

const uriFor = (p) => stub.Uri.file(p).toString();

describe('migrateLegacyProgress', () => {
    test('writes a sidecar for a book that has none', async () => {
        const context = fakeContext({ [keys.LEGACY_PROGRESS_KEY]: { [uriFor(BOOK_A)]: 480 } });

        const count = await migrateLegacyProgress(context);

        assert.equal(count, 1);
        assert.deepEqual(JSON.parse(vscode.__files.get(SIDECAR_A)), { scrollTop: 480 });
    });

    test('never overwrites an existing sidecar', async () => {
        const existing = JSON.stringify({ scrollTop: 999, percent: 80 });
        vscode.__files.set(SIDECAR_A, existing);
        const context = fakeContext({ [keys.LEGACY_PROGRESS_KEY]: { [uriFor(BOOK_A)]: 480 } });

        const count = await migrateLegacyProgress(context);

        assert.equal(count, 0);
        assert.equal(vscode.__files.get(SIDECAR_A), existing, 'newer sidecar progress must win');
    });

    test('migrates only the books that need it', async () => {
        vscode.__files.set(SIDECAR_A, JSON.stringify({ scrollTop: 1, percent: 5 }));
        const context = fakeContext({
            [keys.LEGACY_PROGRESS_KEY]: { [uriFor(BOOK_A)]: 480, [uriFor(BOOK_B)]: 120 },
        });

        const count = await migrateLegacyProgress(context);

        assert.equal(count, 1);
        assert.deepEqual(JSON.parse(vscode.__files.get(SIDECAR_B)), { scrollTop: 120 });
    });

    test('clears the legacy store and marks itself done', async () => {
        const context = fakeContext({ [keys.LEGACY_PROGRESS_KEY]: { [uriFor(BOOK_A)]: 480 } });

        await migrateLegacyProgress(context);

        assert.equal(context.globalState.get(keys.LEGACY_PROGRESS_KEY, 'gone'), undefined);
        assert.equal(context.globalState.get(keys.MIGRATED_KEY, false), true);
    });

    test('is a no-op on every later run', async () => {
        const context = fakeContext({ [keys.LEGACY_PROGRESS_KEY]: { [uriFor(BOOK_A)]: 480 } });
        await migrateLegacyProgress(context);
        vscode.__files.delete(SIDECAR_A);

        const second = await migrateLegacyProgress(context);

        assert.equal(second, 0);
        assert.equal(vscode.__files.has(SIDECAR_A), false, 'must not re-migrate drained data');
    });

    test('skips books it cannot write and still completes', async () => {
        vscode.__readOnly.add(SIDECAR_A);
        const context = fakeContext({
            [keys.LEGACY_PROGRESS_KEY]: { [uriFor(BOOK_A)]: 480, [uriFor(BOOK_B)]: 120 },
        });

        const count = await migrateLegacyProgress(context);

        assert.equal(count, 1, 'the writable book still migrates');
        assert.equal(vscode.__files.has(SIDECAR_A), false);
        assert.equal(context.globalState.get(keys.MIGRATED_KEY, false), true);
    });

    test('does nothing when there is no legacy data', async () => {
        const context = fakeContext();

        assert.equal(await migrateLegacyProgress(context), 0);
        assert.equal(vscode.__files.size, 0);
    });

    test('ignores entries that hold no real position', async () => {
        const context = fakeContext({
            [keys.LEGACY_PROGRESS_KEY]: { [uriFor(BOOK_A)]: 0, [uriFor(BOOK_B)]: -5 },
        });

        assert.equal(await migrateLegacyProgress(context), 0);
        assert.equal(vscode.__files.size, 0, 'an unread book needs no sidecar');
    });

    test('ignores Drive keys and malformed values', async () => {
        const context = fakeContext({
            [keys.LEGACY_PROGRESS_KEY]: {
                'drive://FOLDER1/FILE1': 400,   // Drive progress lives in appdata, not a sidecar
                [uriFor(BOOK_A)]: 'not a number',
                'nonsense': 300,
            },
        });

        assert.equal(await migrateLegacyProgress(context), 0);
        assert.equal(vscode.__files.size, 0);
    });
});
