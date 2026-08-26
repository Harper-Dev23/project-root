export const JOURNAL_CATEGORIES = [
  { id: 'lore',       label: 'Lore',       order: 1 },
  { id: 'systems',    label: 'Systems',    order: 2 },
  { id: 'hunt',       label: 'Hunt',       order: 3 },
  { id: 'encounters', label: 'Encounters', order: 4 },
  { id: 'items',      label: 'Items',      order: 5 },
  { id: 'people',     label: 'People',     order: 6 },
  { id: 'places',     label: 'Places',     order: 7 },
  { id: 'factions',   label: 'Factions',   order: 8 },
  { id: 'divinity',   label: 'Divinity',   order: 9 },
  { id: 'buildings',  label: 'Buildings',  order: 10 },
  { id: 'personal',   label: 'Personal',   order: 11 },
  { id: 'index',      label: 'Index',      order: 12 }
];

/** @typedef {Object} JournalEntry
 * @property {string} id            // 'systems/weakness_overview'
 * @property {string} category      // 'lore'|'systems'|'hunt'
 * @property {string[]} tags
 * @property {string} title
 * @property {string} excerpt       // short list blurb
 * @property {string} content       // markdown string (rendered)
 * @property {{related?: string[]}} links
 * @property {string[]} requires    // unlock flags, e.g. ['seenWeakness:cold']
 * @property {number}  sort
 * @property {string}  icon         // optional glyph key
 * @property {string}  updatedAt    // ISO
 * @property {number}  version
 */
