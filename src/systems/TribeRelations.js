/**
 * TribeRelations.js — Centralized tribe reputation system.
 *
 * All four tribes (elseth, styx, lesse, zafaar) have a numeric reputation
 * score tracked per save slot. The player's own tribe uses a different set
 * of level names and has a higher max level than the other three.
 *
 * Rep levels (index 0–6):
 *   0  Hostile    / Exiled       — the worst standing
 *   1  Threatening/ Disgraced
 *   2  Unfriendly / Unwelcome
 *   3  Neutral    / Initiate     — default starting level for all tribes
 *   4  Cordial    / Member
 *   5  Friendly   / Trusted
 *   6  Allied     / Champion     — locked for non-own tribes
 *
 * Score thresholds (same numeric scale for both own and other tribes):
 *   < −50     → index 0
 *   −50…−21   → index 1
 *   −20…−6    → index 2
 *   −5…+25    → index 3  (starting band — wide so Styx/Zafaar modifiers don't shift level)
 *   +26…+65   → index 4
 *   +66…+105  → index 5
 *   +106+     → index 6  (own tribe only; non-own tribe capped at +105)
 */

export const TRIBE_IDS = ['elseth', 'styx', 'lesse', 'zafaar'];

export const TRIBE_DISPLAY = {
  elseth: 'Elseth',
  styx:   'Styx',
  lesse:  "Le'sse",
  zafaar: 'Zafaar',
};

/**
 * Default rep scores baked into a new save.
 * Styx is slightly positive, Zafaar slightly negative — neither shifts the
 * starting level, but they do put those tribes at different positions within
 * the Neutral/Initiate band before any leader quests.
 */
export const DEFAULT_TRIBE_REP = {
  elseth:  0,
  styx:    5,
  lesse:   0,
  zafaar: -5,
};

/** Rep awarded when a tribe leader's challenge is acknowledged (flag cleared). */
export const LEADER_QUEST_REP_GAIN = 40;

/** Max score allowed for tribes that are NOT the player's own tribe. */
const OTHER_TRIBE_SCORE_CAP = 105; // keeps them at Friendly max (index 5)

// ── Threshold table ───────────────────────────────────────────────────────────

const THRESHOLDS = [-50, -20, -5, 26, 66, 106];
//                  ^1   ^2   ^3  ^4  ^5  ^6   (lower bound of each level above 0)

/**
 * Returns the rep level index (0–6) for a given numeric score.
 */
export function getRepIndex(score) {
  if (score < THRESHOLDS[0]) return 0;
  if (score < THRESHOLDS[1]) return 1;
  if (score < THRESHOLDS[2]) return 2;
  if (score < THRESHOLDS[3]) return 3;
  if (score < THRESHOLDS[4]) return 4;
  if (score < THRESHOLDS[5]) return 5;
  return 6;
}

/**
 * Returns the numeric score at the bottom of a given rep level index.
 * Useful for showing "X more rep to next level".
 */
export function getThresholdForIndex(index) {
  return THRESHOLDS[index - 1] ?? -Infinity;
}

/**
 * Returns the score needed to reach the NEXT level (undefined if already max).
 */
export function getNextThreshold(currentIndex, isOwnTribe) {
  const maxIndex = isOwnTribe ? 6 : 5;
  if (currentIndex >= maxIndex) return null;
  return THRESHOLDS[currentIndex]; // bottom bound of the next level
}

// ── Level definitions ─────────────────────────────────────────────────────────

export const OWN_TRIBE_LEVELS = [
  {
    index: 0, name: 'Exiled',
    color: '#cc3333',
    effect: 'Tribe vendor inaccessible. Stash locked. You are no longer welcome.',
  },
  {
    index: 1, name: 'Disgraced',
    color: '#cc6633',
    effect: 'Tribe vendor inaccessible. Limited lodge access.',
  },
  {
    index: 2, name: 'Unwelcome',
    color: '#cc9933',
    effect: 'Basic lodge access only. Tribe vendor restricted.',
  },
  {
    index: 3, name: 'Initiate',
    color: '#aaaaaa',
    effect: 'Full tribe vendor access. Stash access. Standard treatment.',
  },
  {
    index: 4, name: 'Member',
    color: '#88aaff',
    effect: '10% tribe vendor discount. +5% healing received from tribe allies.',
  },
  {
    index: 5, name: 'Trusted',
    color: '#88ffaa',
    effect: '20% tribe vendor discount. +10% healing. Exclusive Trusted items.',
  },
  {
    index: 6, name: 'Champion',
    color: '#ffdd44',
    effect: '30% discount. +15% healing. Unique Champion perks. (Coming soon)',
  },
];

export const OTHER_TRIBE_LEVELS = [
  {
    index: 0, name: 'Hostile',
    color: '#cc3333',
    effect: 'Lodge entry refused. No trade.',
  },
  {
    index: 1, name: 'Threatening',
    color: '#cc6633',
    effect: 'No trade. Hostile dialogue.',
  },
  {
    index: 2, name: 'Unfriendly',
    color: '#cc9933',
    effect: 'Lodge entry allowed. Brief dialogue only. No trade.',
  },
  {
    index: 3, name: 'Neutral',
    color: '#aaaaaa',
    effect: 'Standard lodge access. No discounts.',
  },
  {
    index: 4, name: 'Cordial',
    color: '#88aaff',
    effect: '5% vendor discount when trading at this lodge. (Coming soon)',
  },
  {
    index: 5, name: 'Friendly',
    color: '#88ffaa',
    effect: '10% discount. Extended dialogue options. (Coming soon)',
  },
  {
    index: 6, name: 'Allied',
    color: '#ffdd44',
    effect: 'Max cross-tribe access. (Locked for non-own tribes)',
  },
];

// ── Main query functions ──────────────────────────────────────────────────────

/**
 * Returns the full rep level definition for a tribe, including the current score.
 * Uses ProgressionManager's tribeRep data.
 *
 * @param {string} tribeId - 'elseth' | 'styx' | 'lesse' | 'zafaar'
 * @param {object} pm      - ProgressionManager
 * @returns {{ name, color, effect, score, index, isMax, isOwnTribe }}
 */
export function getTribeRepLevel(tribeId, pm) {
  const score     = pm.tribeRep?.[tribeId] ?? DEFAULT_TRIBE_REP[tribeId] ?? 0;
  const isOwnTribe = pm.tribe === tribeId;
  const index     = getRepIndex(score);
  const maxIndex  = isOwnTribe ? 6 : 5;
  const cappedIdx = Math.min(index, maxIndex);
  const levels    = isOwnTribe ? OWN_TRIBE_LEVELS : OTHER_TRIBE_LEVELS;

  return {
    ...levels[cappedIdx],
    score,
    index:     cappedIdx,
    isMax:     cappedIdx >= maxIndex,
    isOwnTribe,
    nextThreshold: getNextThreshold(cappedIdx, isOwnTribe),
  };
}

/**
 * Clamps a rep score for a non-own tribe.
 * Own tribe has no cap.
 */
export function clampRepScore(score, isOwnTribe) {
  if (isOwnTribe) return score;
  return Math.min(score, OTHER_TRIBE_SCORE_CAP);
}
