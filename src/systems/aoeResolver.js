// @ts-nocheck
/**
 * aoeResolver.js
 * Resolves AOE splash targets from a primary target and an aoe config object.
 *
 * resolveAOESplash(scene, primaryTarget, aoe) → char[]
 *
 * Returns the list of SECONDARY (splash) targets. The primary target itself
 * is never included — it is always handled as the main hit by the calling skill.
 *
 * Supported aoe.shape values:
 *   "column"   – all living units in the same column as primaryTarget
 *   "diamond"  – fixed slots {2,4,5,7} on target's side (position is absolute, cannot be moved)
 *   "all"      – every living unit on target's side
 *   "adjacent" – all living units in slots directly adjacent to primaryTarget (uses scene._getAdjacentSlots)
 *   "arc"      – the other two slots in primaryTarget's flank arc: top {8,4,3} or bottom {6,5,1}.
 *                Center-row slots {7,2} belong to neither arc (see TOP_ARC/BOT_ARC below).
 *   "smallCone" – targeting a front-rank (1,2,3) or mid-rank (4,5) slot fans out into the
 *                 1-2 slots directly behind it in the next column back. Not valid from the
 *                 back rank (6,7,8) — nothing lies further back. See SMALL_CONE_MAP below.
 *   "backCrescent" – fixed slots {8,4,5,6} on target's side (position is absolute, cannot
 *                    be moved) — same mechanic as "diamond", just a different fixed group.
 *
 * Adding a new shape: add a case to the switch. No other files need to change.
 */

/** The four "diamond" slot IDs — centre-mass of the brick-offset formation. */
const DIAMOND_SLOTS = new Set([2, 4, 5, 7]);

/** The four "backCrescent" slot IDs — back rank + mid rank. */
const BACK_CRESCENT_SLOTS = new Set([8, 4, 5, 6]);

/** The two flank "arc" groups — one slot per column (back/mid/front), top and bottom. */
const TOP_ARC = new Set([8, 4, 3]);
const BOT_ARC = new Set([6, 5, 1]);

/**
 * "smallCone" per-slot splash map. Front rank (3 slots: 3/2/1, top-to-bottom)
 * fans into mid rank (2 slots: 4/5) — front-top(3) and front-bottom(1) each
 * align with only ONE mid slot (4 and 5 respectively), since the mid column
 * only has 2 rows to their 3; front-middle(2) straddles both. Mid rank then
 * fans the same way into back rank (3 slots: 8/7/6) — mid-top(4) covers
 * back-top(8)+back-mid(7), mid-bottom(5) covers back-mid(7)+back-bottom(6).
 * Not defined for the back rank itself (6/7/8) — there's nothing behind it.
 */
const SMALL_CONE_MAP = {
  3: [4],
  2: [4, 5],
  1: [5],
  4: [8, 7],
  5: [7, 6],
};

/**
 * @param {Phaser.Scene} scene          The active CombatScene (must have enemySlots / allySlots).
 * @param {object}       primaryTarget  The character the skill was aimed at.
 * @param {{ shape: string }} aoe       The aoe config from the skill definition.
 * @returns {object[]}                  Array of character objects to receive splash damage.
 */
export function resolveAOESplash(scene, primaryTarget, aoe) {
  if (!aoe || !scene || !primaryTarget) return [];

  const sideSlots = primaryTarget.isEnemy ? scene.enemySlots : scene.allySlots;
  if (!Array.isArray(sideSlots)) return [];

  // All living units on the same side, excluding the primary target
  const candidates = sideSlots.filter(
    s => s?.char && s.char !== primaryTarget && s.char.status !== 'incapacitated'
  );

  switch (aoe.shape) {
    case 'column': {
      const col = scene._getUnitColumn?.(primaryTarget);
      if (!col) return [];
      return candidates
        .filter(s => scene._getColumnBySlotId?.(s.slotId) === col)
        .map(s => s.char);
    }

    case 'diamond': {
      // Fixed formation shape — always hits the four centre slots regardless of
      // which enemy was targeted. Cannot be repositioned.
      return candidates
        .filter(s => DIAMOND_SLOTS.has(s.slotId))
        .map(s => s.char);
    }

    case 'all': {
      return candidates.map(s => s.char);
    }

    case 'adjacent': {
      const primarySlotId = primaryTarget._slot?.slotId ?? primaryTarget.slotId;
      if (primarySlotId == null) return [];
      // scene._getAdjacentSlots is a thin wrapper around the ADJACENCY_MAP in CombatScene
      const adjList = scene._getAdjacentSlots?.(primarySlotId) ?? [];
      return candidates
        .filter(s => adjList.includes(s.slotId))
        .map(s => s.char);
    }

    case 'arc': {
      const primarySlotId = primaryTarget._slot?.slotId ?? primaryTarget.slotId;
      const arcSlots = TOP_ARC.has(primarySlotId) ? TOP_ARC : BOT_ARC.has(primarySlotId) ? BOT_ARC : null;
      if (!arcSlots) return []; // primary target is in the center row (7/2) — not a valid arc member
      return candidates
        .filter(s => arcSlots.has(s.slotId))
        .map(s => s.char);
    }

    case 'smallCone': {
      const primarySlotId = primaryTarget._slot?.slotId ?? primaryTarget.slotId;
      const hitSlots = SMALL_CONE_MAP[primarySlotId];
      if (!hitSlots) return []; // primary target is in the back rank — nothing further behind it
      return candidates
        .filter(s => hitSlots.includes(s.slotId))
        .map(s => s.char);
    }

    case 'backCrescent': {
      // Fixed formation shape — always hits the back rank + mid rank
      // regardless of which of those four was targeted. Cannot be
      // repositioned.
      return candidates
        .filter(s => BACK_CRESCENT_SLOTS.has(s.slotId))
        .map(s => s.char);
    }

    default:
      return [];
  }
}
