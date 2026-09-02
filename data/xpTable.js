/**
 * Highest level reachable in the demo.
 *
 * Needed because Reckoning tiers grant XP on EVERY clear, not just the first —
 * without a cap the level is unbounded and a player can grind past every
 * balance assumption in the item system (affix tier 1 opens at item level 8,
 * Ancestral bases at 8). 5 is the intended ceiling: reachable by clearing the
 * base game plus either all of Gorek's Reckoning tiers or all of encounter
 * 4+5's, but not exceedable.
 */
export const LEVEL_CAP = 5;

export function getXPNeededForLevel(level) {
  // Example curve — tweak as needed
  return 100 + (level - 1) * 50;
}
