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
 *
 * Adding a new shape: add a case to the switch. No other files need to change.
 */

/** The four "diamond" slot IDs — centre-mass of the brick-offset formation. */
const DIAMOND_SLOTS = new Set([2, 4, 5, 7]);

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

    default:
      return [];
  }
}
