// src/systems/BossLoot.js
//
// What a boss leaves (chunk 14b; data/bosses.js `loot` and `historic`). Every
// kill, the first included, is worth it beyond the Historic item (owner,
// 2026-09-26):
//   spoils  the boss's own parts, harvested like a beast's (HuntEngine.harvest):
//           each slot in loot.parts, rolled at Great-grade odds with the
//           party's Item Rarity, never below loot.rarityFloor; and its bodies
//   chest   straight into the pack: the Historic item while it is in the wild,
//           otherwise loot.substitute (that part again, at that rarity)
// Rolled from `rng`, which the engine seeds from the hunt, so a reload rolls
// the same loot.

import { BOSSES } from '../../data/bosses.js';
import { partBaseId } from '../../data/beastParts.js';
import { rollPartRarity } from './PartyStats.js';
import { createItemInstance } from './ItemFactory.js';

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic'];
const atLeast = (rarity, floor) => (RARITY_ORDER.indexOf(rarity) < RARITY_ORDER.indexOf(floor) ? floor : rarity);

function part(family, slot, rarity, { itemLevel, rng }) {
  const inst = createItemInstance(partBaseId(family, slot), { rarity, itemLevel, rng, rollAffixes: rarity !== 'common' });
  if (inst) inst.grade = 'great';   // Trophy (9d) reads a part's grade
  return inst;
}

/**
 * @returns {{ spoils: { family, parts, bodies } | null, chest: object[], historic: string | null }}
 *   `historic` is the Historic item's id when it is in the chest.
 */
export function rollBossLoot(bossId, { itemLevel = 1, itemRarity = 0, rng, historicInWild = () => true }) {
  const boss = BOSSES[bossId];
  const loot = boss?.loot;
  const out = { spoils: null, chest: [], historic: null };
  if (loot) {
    const parts = loot.parts.map(slot => part(loot.family, slot, atLeast(rollPartRarity('great', itemRarity, rng), loot.rarityFloor || 'common'), { itemLevel, rng }))
      .filter(Boolean);
    out.spoils = { family: loot.family, parts, bodies: Array.from({ length: loot.bodies || 0 }, () => 'great') };
  }
  // A boss that WEARS its Historic item (the Ghost Party's Captain, 14b-5)
  // drops it, or its substitute, off its body in the fight, never from a chest.
  if (boss?.historicWorn) return out;
  if (boss?.historic && historicInWild(boss.historic) !== false) {
    const inst = createItemInstance(boss.historic, { itemLevel, rng });
    if (inst) { out.chest.push(inst); out.historic = boss.historic; }
  } else if (loot?.substitute) {
    const inst = part(loot.family, loot.substitute.slot, loot.substitute.rarity, { itemLevel, rng });
    if (inst) out.chest.push(inst);
  }
  return out;
}
