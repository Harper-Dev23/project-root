// Real journal content lives in data/journal/md/**/*.md, loaded at runtime
// by MarkdownLoader. This file used to ship two placeholder test entries
// ("Content to be provided later") that merged into every real entry list —
// kept empty now so JournalOverlay's `[...SEEDS, ...mdEntries]` merge has
// nothing stale to add.

/** @type {import('./manifest').JournalEntry[]} */
export const JOURNAL_ENTRIES = [];
