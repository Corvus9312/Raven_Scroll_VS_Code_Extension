/** globalState keys, in one place so every module agrees on them. */
export const PREFS_KEY   = 'corvusTxtReader.prefs';
export const LIBRARY_KEY = 'corvusTxtReader.library';
export const FOLDERS_KEY = 'corvusTxtReader.folders';

/**
 * Legacy per-URI progress map written only by the old custom-editor path.
 * Retained so `migrateLegacyProgress` can drain it into sidecar files; nothing
 * reads it for display any more.
 */
export const LEGACY_PROGRESS_KEY = 'corvusTxtReader.progress';

/** Set once the legacy progress map has been drained. */
export const MIGRATED_KEY = 'corvusTxtReader.progressMigrated';
