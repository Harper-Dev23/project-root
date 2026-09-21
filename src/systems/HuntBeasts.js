// src/systems/HuntBeasts.js
//
// What a map-hunt occupant carries into a fight (Exploration System v2, chunk
// 9a). Design: the vault's BEAST_PARTS and ENCOUNTERS; the owner's chunk 9
// decisions 1-7 (2026-09-21). Pure: no Phaser, no GameState, no Math.random
// for anything that matters.
//
// ── The loadout ─────────────────────────────────────────────────────────────
// A beast wears its PARTS (data/beastParts.js): one item per slot its family's
// anatomy has, each rolled from the member's grade and the party's Item Rarity
// (PartyStats.rollPartRarity) at the region's item level. A cultist wears one
// piece of armour (CULTIST_GEAR_SLOT), rolled like the Advance loop's cultist
// drop (rollHuntDropRarity). Either way it is rolled ONCE per occupant, the
// first time it is needed (decision 4): when the party scouts it, or when the
// fight starts. HuntEngine keeps it on the occupant, so what was scouted is what
// is fought, and a reload does not re-roll it.
//
// It draws from the occupant's OWN stream (loadoutSeed: the hunt seed mixed
// with the occupant's number), never the hunt's or the world's, so rolling a
// loadout never shifts what a forage finds or where a pack walks. Item Rarity is
// read at that moment, so a party that stacks it meets rarer parts.
//
// ── Initiative ──────────────────────────────────────────────────────────────
// Enemy initiative replaces chunk 7's placeholder table (decision 7): each
// member's Initiative is worked out from its REAL enemy type the way
// CombatScene._spawnEnemy builds one: base stats plus every stat bonus its
// loadout adds, through the same calculateDerivedStats, plus the type's
// derivedBonus and the loadout's direct Initiative mods. The occupant's
// initiative is the members' average, compared against the party's average
// (ENCOUNTERS: both sides normalised the same way). Chunk 9b's harness checks
// this number against the real spawned enemies' computeEffectiveInitiative.

import { ENEMY_TYPES } from '../../data/enemyTypes.js';
import { Items } from '../../data/items.js';
import {
  HUNT_BEASTS, HUNT_CULTIST_TYPES, CULTIST_GEAR_SLOT, GRADE_HP_SCALE, partBaseId,
} from '../../data/beastParts.js';
import { calculateDerivedStats } from './CharacterBuilder.js';
import { createItemInstance, getItemComputedData, pickBaseId } from './ItemFactory.js';
import { rollPartRarity, rollHuntDropRarity } from './PartyStats.js';
import { makeRng } from './seededRng.js';

const occNum = (o) => Number(String(o.id).replace(/\D/g, '')) || 0;

/** The occupant's own stream: the hunt seed mixed with its number. */
export function loadoutSeed(huntSeed, occ) {
  return ((huntSeed >>> 0) ^ Math.imul(occNum(occ) + 1, 0x85EBCA6B)) >>> 0;
}

/** The combat enemy type a roster member fights as. */
export function memberType(occ, index) {
  if (occ.kind === 'cultist') return HUNT_CULTIST_TYPES[index % HUNT_CULTIST_TYPES.length];
  const fam = HUNT_BEASTS[occ.roster[index]?.type] || HUNT_BEASTS[occ.family];
  if (!fam) throw new Error(`no hunt beast for family '${occ.roster[index]?.type || occ.family}'`);
  return fam.type;
}

/** Armour bases a cultist can wear in a slot (as CombatScene's random drop). */
function armorBases(slot) {
  return Object.entries(Items).filter(([, it]) => it?.type === 'armor' && it?.slot === slot).map(([id]) => id);
}

/**
 * Roll an occupant's loadout: one { slot: item instance } per roster member.
 * `itemLevel` is the region's (huntItemLevel), `itemRarity` the party's now.
 */
export function rollLoadout(occ, { itemLevel, itemRarity = 0, seed }) {
  const rng = makeRng(seed);
  return occ.roster.map((m) => {
    const out = {};
    if (occ.kind === 'cultist') {
      const id = pickBaseId(armorBases(CULTIST_GEAR_SLOT), itemLevel, { maxBaseTier: 1, rng });
      const rarity = rollHuntDropRarity(itemRarity, rng);
      const inst = id ? createItemInstance(id, { rarity, itemLevel, rng }) : null;
      if (inst) out[CULTIST_GEAR_SLOT] = inst;
      return out;
    }
    const fam = HUNT_BEASTS[m.type] || HUNT_BEASTS[occ.family];
    for (const slot of Object.keys(fam.parts)) {
      const rarity = rollPartRarity(m.grade, itemRarity, rng);
      const inst = createItemInstance(partBaseId(m.type, slot), {
        rarity, itemLevel, rng, rollAffixes: rarity !== 'common',
      });
      if (inst) {
        inst.grade = m.grade;   // Trophy (9d) reads a part's grade
        out[slot] = inst;
      }
    }
    return out;
  });
}

/** One member's Initiative from its type and what it wears (see the header). */
export function memberInitiative(type, gear = {}) {
  const t = ENEMY_TYPES[type];
  if (!t) throw new Error(`unknown enemy type '${type}'`);
  const stats = { ...(t.baseStats || {}) };
  let direct = t.derivedBonus?.Initiative || 0;
  for (const inst of Object.values(gear)) {
    const view = getItemComputedData(inst);
    for (const [k, v] of Object.entries(view?.bonuses || {})) stats[k] = (stats[k] || 0) + v;
    direct += view?._derivedMods?.Initiative || 0;
  }
  return calculateDerivedStats(stats).Initiative + direct;
}

/** The occupant's initiative: its members' average. Without a loadout (never
 *  rolled yet), their bare types'. */
export function occupantInitiative(occ) {
  const roster = occ?.roster || [];
  if (!roster.length) return 0;
  const each = roster.map((m, i) => memberInitiative(memberType(occ, i), occ.loadout?.[i] || {}));
  return each.reduce((a, b) => a + b, 0) / each.length;
}

/** What a scout reveals of a loadout (ENCOUNTERS: "actual gear or part
 *  rarity"): each member's slots and rarities, never the affixes. */
export function loadoutView(occ) {
  if (!occ?.loadout) return null;
  return occ.loadout.map(gear => Object.fromEntries(Object.entries(gear).map(([slot, inst]) => [slot, inst.rarity])));
}


// ── The fight (chunk 9b) ────────────────────────────────────────────────────
// A tile's occupant IS the enemy side of the board (ENCOUNTERS: "that roster is
// the enemy side of the board"), so an encounter turns into a combat scenario
// with nothing translated: one enemy per member, in its real type, scaled by
// its grade, wearing its kept loadout. CombatScene reads this through
// data.huntFight (its _placeEnemies / _spawnEnemy take the scenario as given).

/** Board slots filled in order: the front rank's centre first (slot 2), then
 *  the rest of the front, the middle, the back (boardGeometry: column 2 is
 *  the front, the middle row is the centre). */
export const FIGHT_SLOT_ORDER = [2, 1, 3, 5, 4, 7, 6, 8];

const GRADE_RANK = { great: 3, prime: 2, grown: 1, yearling: 0 };

/** A member's base-HP scale (decision 2); cultists have no grade. */
export function gradeHpScale(grade) {
  return grade ? (GRADE_HP_SCALE[grade] ?? 1) : 1;
}

/**
 * The combat scenario for an occupant whose loadout has been rolled.
 * Members stand by grade, the strongest at the front centre (the leader of an
 * Alpha and pack, the mother of a Matriarch and young); ties keep roster order.
 * Each gets a COPY of its loadout, so what combat does to an item never
 * reaches the hunt's saved occupant. A cultist's armour drops if it falls (the
 * Advance loop's cultist drop); a beast's parts never drop, they are
 * harvested (9d).
 */
export function fightScenario(occ, { itemLevel = 1, zoneName = null } = {}) {
  if (!occ?.loadout) throw new Error(`occupant ${occ?.id} has no loadout yet`);
  const order = occ.roster.map((m, i) => i)
    .sort((a, b) => (GRADE_RANK[occ.roster[b].grade] ?? -1) - (GRADE_RANK[occ.roster[a].grade] ?? -1) || a - b);
  const enemies = order.map((i, k) => {
    const m = occ.roster[i];
    const type = memberType(occ, i);
    const gear = JSON.parse(JSON.stringify(occ.loadout[i] || {}));
    const base = ENEMY_TYPES[type]?.name || type;
    return {
      type,
      slotId: FIGHT_SLOT_ORDER[k],
      name: m.grade ? `${m.grade[0].toUpperCase()}${m.grade.slice(1)} ${base}` : base,
      grade: m.grade || null,
      hpMult: gradeHpScale(m.grade),
      gear,
      gearDroppable: occ.kind === 'cultist' ? Object.fromEntries(Object.keys(gear).map(sl => [sl, true])) : {},
    };
  });
  const lead = occ.kind === 'cultist' ? 'Cultists' : (HUNT_BEASTS[occ.family]?.name || 'Beasts');
  return {
    id: `hunt_map_${occ.id}`,
    name: occ.kind === 'cultist' ? 'Cultist band' : `${lead}${occ.roster.length > 1 ? ' pack' : ''}`,
    description: zoneName ? `A fight in the ${zoneName}.` : 'A fight on the hunt.',
    portraitKey: occ.kind === 'cultist' ? 'soldier_portrait' : 'beast_portrait',
    loot: { itemLevel, maxBaseTier: 1 },
    enemies,
  };
}
