// src/systems/HuntScaling.js
//
// The one place a region's danger level becomes an item level. Every piece of
// hunt scaling reads it — hunt fight gear today; dropped plans and beast parts
// when those chunks land — so the mapping can never drift between them.
//
// Exploration System v2, SCALING (owner, 2026-09-17): danger runs 1-10, and
// danger level = item level, 1 -> 1 ... 10 -> 10. That puts top-tier affixes
// and Ancestral bases (both item level 8, ItemFactory.js) in danger 8-10
// regions, as decided.

export const DANGER_MIN = 1;
export const DANGER_MAX = 10;

/**
 * Item level for loot rolled in a region of the given danger level.
 * Anything missing or out of range is pulled into 1-10 rather than passed
 * through, so a bad zone entry can never roll ungated (null) or past-cap gear.
 */
export function huntItemLevel(danger) {
  const d = Number.isFinite(danger) ? Math.round(danger) : DANGER_MIN;
  return Math.min(DANGER_MAX, Math.max(DANGER_MIN, d));
}
