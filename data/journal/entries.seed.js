/** @type {import('./manifest').JournalEntry[]} */
export const JOURNAL_ENTRIES = [
    {
        id: 'systems/_welcome',
        category: 'systems',
        tags: ['journal'],
        title: 'Journal System',
        excerpt: 'How this journal is structured.',
        content: 'This is a placeholder entry used to test UI rendering.',
        links: { related: [] },
        requires: [],
        sort: 1, icon: 'icon-journal', version: 1, updatedAt: new Date().toISOString()
    },
    {
        id: 'lore/_welcome',
        category: 'lore',
        tags: ['journal'],
        title: 'Lore Section',
        excerpt: 'Placeholder for lore pages.',
        content: 'Content to be provided later.',
        links: { related: [] },
        requires: [],
        sort: 1, icon: 'icon-scroll', version: 1, updatedAt: new Date().toISOString()
    }
];