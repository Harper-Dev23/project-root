// src/systems/EncounterRoller.js
// Resolves a single encounter roll for HuntManager's tick loop.
//
// Stub resolution only — no combat hookup yet (per ENCOUNTER_SYSTEM.md,
// "basic enemy roster" is a separate design pass). Each category just
// returns flavor text and a small Hunt Points award so the loop is provable.

import { getZone } from '../../data/zones.js';

// Stub Hunt Points awarded per encounter category.
const HUNT_POINTS_BY_CATEGORY = {
  beasts: 3,
  environmental: 1,
  microZone: 2,
  flexible: 1,
};

const CATEGORIES = Object.keys(HUNT_POINTS_BY_CATEGORY);

export const EncounterRoller = {
  /**
   * Rolls one encounter for the given zone. Depth is accepted for future
   * weighting (deeper = rarer categories more likely) but isn't used yet.
   *
   * Returns null if the zone has no entries to roll (shouldn't happen with
   * the current stub tables, but keeps this safe against empty categories).
   */
  roll(zoneId, _depth = 0) {
    const zone = getZone(zoneId);
    if (!zone) return null;

    const table = zone.encounterTable || {};
    const nonEmptyCategories = CATEGORIES.filter(cat => (table[cat] || []).length > 0);
    if (nonEmptyCategories.length === 0) return null;

    const category = nonEmptyCategories[Math.floor(Math.random() * nonEmptyCategories.length)];
    const entries = table[category];
    const entry = entries[Math.floor(Math.random() * entries.length)];

    return {
      type: category,
      source: zoneId,
      label: entry.label,
      huntPoints: HUNT_POINTS_BY_CATEGORY[category],
    };
  },
};
