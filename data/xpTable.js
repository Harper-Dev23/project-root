/**
 * Highest level a Hunter can reach. The full game is designed for 10
 * (Exploration System v2, SCALING — owner, 2026-09-17).
 *
 * The cap exists because Reckoning tiers grant XP on EVERY clear, not just the
 * first — without one the level is unbounded.
 */
export const LEVEL_CAP = 10;

/**
 * Highest level training (the pit, Reckoning tiers included) can take a
 * Hunter to. Past it, levels come from hunts (owner, 2026-09-18). This is the
 * demo's old cap, so a repeatable tier can't be ground to 10.
 * Read by GameState.awardTrainingXPTo.
 */
export const TRAINING_LEVEL_CAP = 5;

/**
 * XP needed to go from `level` to `level + 1`. PLACEHOLDER (chunk 2).
 *
 * Levels 1-5 are unchanged from the demo on purpose, so existing characters
 * and the pit's XP rewards mean what they did; 6-10 continue the same +50
 * step. Total 1 -> 10 is 2,700. The real curve is set in chunk 13, once a hex
 * hunt's XP can be measured against the target of ~40 small hunts to level 10
 * (SCALING). At the cap this is also the value the full bar pins to.
 */
const XP_TO_NEXT = [100, 150, 200, 250, 300, 350, 400, 450, 500, 550];

export function getXPNeededForLevel(level) {
  const i = Math.min(Math.max(1, level | 0), XP_TO_NEXT.length) - 1;
  return XP_TO_NEXT[i];
}

/**
 * The smallest share of a hunt XP pool any one hunter gets, as a percent of
 * the pool. PLACEHOLDER (chunk 2) — tuned in chunk 13.
 *
 * SCALING, party-size scaling (owner, 2026-09-18): a small party is riskier
 * and faster, a big one safer and slower. XP is one pool, split between the
 * hunters, so fewer hunters level faster; the floor stops a full party's
 * share from shrinking all the way to a sixth.
 */
export const XP_SHARE_FLOOR_PCT = 25;

/**
 * Each hunter's share of an XP pool split across a party of `partySize`.
 * The pool divided evenly, but never below XP_SHARE_FLOOR_PCT of the pool,
 * and never 0 while the pool is positive.
 */
export function xpShare(pool, partySize) {
  if (!(pool > 0)) return 0;
  const n = Math.max(1, partySize | 0);
  const fraction = Math.max(1 / n, XP_SHARE_FLOOR_PCT / 100);
  return Math.max(1, Math.round(pool * fraction));
}
