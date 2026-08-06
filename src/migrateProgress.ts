/**
 * One-time migration of reading progress out of the old `globalState` store.
 *
 * Before the reader paths were unified, the custom-editor path recorded progress
 * in `globalState['corvusTxtReader.progress']` keyed by `uri.toString()`, while
 * every other part of the extension (both library trees, the reset commands, the
 * panel reader) used `.corvus.<name>.json` sidecar files. The sidecar is the
 * format that survives; this turns any leftover globalState entries into sidecars.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { LEGACY_PROGRESS_KEY, MIGRATED_KEY } from './keys';
import { sidecarName } from './core/book';

export async function migrateLegacyProgress(context: vscode.ExtensionContext): Promise<number> {
    if (context.globalState.get<boolean>(MIGRATED_KEY, false)) { return 0; }

    const legacy = context.globalState.get<Record<string, unknown>>(LEGACY_PROGRESS_KEY, {});
    let migrated = 0;

    for (const { filePath, scrollTop } of planMigration(legacy)) {
        const target = vscode.Uri.file(
            path.join(path.dirname(filePath), sidecarName(path.basename(filePath)))
        );
        try {
            // Never clobber a sidecar — it is either newer, or already this value.
            await vscode.workspace.fs.stat(target);
            continue;
        } catch { /* no sidecar yet */ }

        try {
            // Only scrollTop was ever recorded; percent stays unknown and reads
            // back as "閱讀中" until the book is next scrolled.
            await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify({ scrollTop }), 'utf8'));
            migrated++;
        } catch { /* folder gone or read-only — skip */ }
    }

    await context.globalState.update(LEGACY_PROGRESS_KEY, undefined);
    await context.globalState.update(MIGRATED_KEY, true);
    return migrated;
}

/**
 * Which legacy entries are worth writing out. Entries that are not local `file:`
 * URIs, or that record no real position, are dropped.
 */
function planMigration(legacy: Record<string, unknown>): { filePath: string; scrollTop: number }[] {
    const plan: { filePath: string; scrollTop: number }[] = [];
    for (const [uriString, value] of Object.entries(legacy ?? {})) {
        if (typeof value !== 'number' || value <= 0) { continue; }
        if (!uriString.startsWith('file://')) { continue; }
        try {
            plan.push({ filePath: fileURLToPath(uriString), scrollTop: value });
        } catch { /* unparseable URI */ }
    }
    return plan;
}
