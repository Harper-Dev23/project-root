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
import { BOSSES } from '../../data/bosses.js';
import { Items } from '../../data/items.js';
import {
  HUNT_BEASTS, HUNT_CULTIST_TYPES, CULT_BANDS, CULTIST_GEAR_SLOT, GRADE_HP_SCALE, partBaseId,
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
  // A boss's members name their enemy types outright (data/bosses.js, 14b-4).
  if (occ.kind === 'boss') return occ.roster[index].type;
  if (occ.kind === 'cultist') {
    // A band serving a false god fights as its cult (CULT_BANDS, chunk 14a).
    const types = CULT_BANDS[occ.cult]?.types || HUNT_CULTIST_TYPES;
    return types[index % types.length];
  }
  const fam = HUNT_BEASTS[occ.roster[index]?.type] || HUNT_BEASTS[occ.family];
  if (!fam) throw new Error(`no hunt beast for family '${occ.roster[index]?.type || occ.family}'`);
  return fam.type;
}

/** Armour bases a cultist can wear in a slot (as CombatScene's random drop). */
function armorBases(slot) {
  return Object.entries(Items).filter(([, it]) => it?.type === 'armor' && it?.slot === slot && !it?.historic).map(([id]) => id);
}

/**
 * Roll an occupant's loadout: one { slot: item instance } per roster member.
 * `itemLevel` is the region's (huntItemLevel), `itemRarity` the party's now.
 */
export function rollLoadout(occ, { itemLevel, itemRarity = 0, seed, historicInWild = () => true }) {
  const rng = makeRng(seed);
  return occ.roster.map((m, i) => {
    const out = {};
    // A boss (14b): only members that fight in real gear roll it (the Ghost
    // Party); the rest keep their natural weapons (fightScenario).
    if (occ.kind === 'boss') return rollBossKit(occ, i, { itemLevel, itemRarity, rng, historicInWild });
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

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic'];
const atLeast = (rarity, floor) => (RARITY_ORDER.indexOf(rarity) < RARITY_ORDER.indexOf(floor) ? floor : rarity);
/** Weapon bases of one type a boss member can carry (never natural, Historic or unique). */
function weaponBases(weaponType) {
  return Object.entries(Items).filter(([, it]) => it?.type === 'weapon' && it.weaponType === weaponType && !it.natural && !it.historic && !it.unique).map(([id]) => id);
}

/**
 * A boss member's kit (data/bosses.js: weaponType, armor, dropSlot,
 * historicSlot, substituteSlot, and the boss's `kit` rarities). Soulbound
 * pieces roll kit.soulboundRarity; the drop slot rolls the party's drop odds,
 * never below kit.dropFloor. The Historic item goes on its wearer while it is
 * in the wild; while it is held, the substitute slot rolls kit.substitute.
 * Which pieces drop is decided the same way in bossScenario (bossDrops).
 */
function rollBossKit(occ, i, { itemLevel, itemRarity, rng, historicInWild }) {
  const boss = BOSSES[occ.boss];
  const mem = boss?.fight?.members?.[i];
  const out = {};
  if (!mem?.weaponType) return out;
  const kit = boss.kit || {};
  const worn = !!(mem.historicSlot && boss.historic && historicInWild(boss.historic) !== false);
  const slots = ['weaponMain', ...(mem.armor || [])];
  if (mem.substituteSlot && !worn && !slots.includes(mem.substituteSlot)) slots.push(mem.substituteSlot);
  for (const slot of slots) {
    const ids = slot === 'weaponMain' ? weaponBases(mem.weaponType) : armorBases(slot);
    const id = pickBaseId(ids, itemLevel, { maxBaseTier: 1, rng });
    if (!id) continue;
    const rarity = (mem.substituteSlot === slot && !worn) ? (kit.substitute || 'epic')
      : slot === mem.dropSlot ? atLeast(rollHuntDropRarity(itemRarity, rng), kit.dropFloor || 'common')
      : (kit.soulboundRarity || 'common');
    const inst = createItemInstance(id, { rarity, itemLevel, rng });
    if (inst) out[slot] = inst;
  }
  if (worn) {
    const inst = createItemInstance(boss.historic, { itemLevel, rng });
    if (inst) out[mem.historicSlot] = inst;
  }
  return out;
}

/** Which of a boss member's pieces drop (not soulbound): its drop slot, and the
 *  Historic item it wears, or while that is held, its substitute. */
function bossDrops(boss, mem, gear) {
  const out = {};
  if (mem.dropSlot && gear[mem.dropSlot]) out[mem.dropSlot] = true;
  if (mem.historicSlot && gear[mem.historicSlot]?.id === boss.historic) out[mem.historicSlot] = true;
  else if (mem.substituteSlot && gear[mem.substituteSlot]) out[mem.substituteSlot] = true;
  return out;
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

/**
 * A boss's fight (chunk 14b-4): its members exactly as data/bosses.js lays them
 * out, in their own slots and names, at full size (no grade).
 */
function bossScenario(occ, { itemLevel }) {
  const def = BOSSES[occ.boss]?.fight;
  if (!def) throw new Error(`no fight for boss '${occ.boss}'`);
  const enemies = def.members.map((m, i) => {
    // A member in real gear wears its rolled kit (rollBossKit); one with a
    // natural weapon fights with that (a beast of a boss wears no loot).
    const kitGear = m.weaponType ? JSON.parse(JSON.stringify(occ.loadout?.[i] || {})) : null;
    const gear = kitGear || (m.weapon ? { weaponMain: createItemInstance(m.weapon, { itemLevel, rollAffixes: false }) } : {});
    return {
    type: m.type, slotId: m.slotId, name: m.name || ENEMY_TYPES[m.type]?.name || m.type,
    grade: null, hpMult: 1,
    gear,
    gearDroppable: kitGear ? bossDrops(BOSSES[occ.boss], m, kitGear) : {},
    bossPart: occ.boss,                    // CombatScene: the whole boss collapses together
    ...(m.pool ? { pool: m.pool } : {}),   // CombatScene._linkSharedPools
    // The fight's damage dial (CombatScene: damageMultiplierPct, as encounter 4 tunes by).
    ...(Number.isFinite(def.damagePct) ? { damageMultiplierPct: def.damagePct } : {}),
    };
  });
  return {
    id: `hunt_boss_${occ.boss}`,
    name: def.name,
    description: BOSSES[occ.boss].lair?.name || def.name,
    portraitKey: ENEMY_TYPES[enemies[0]?.type]?.skin || null,
    loot: { itemLevel, maxBaseTier: 1 },
    boss: occ.boss,
    enemies,
  };
}

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
/** A beast's name label colour in a fight, by its mark: the map's ring
 *  colours (HuntFieldOverlay MARK_RING). */
export const MARK_COLOR = { marked: '#f2d27a', unmarked: '#c3ccd6', corrupted: '#c48ae8' };

export function fightScenario(occ, { itemLevel = 1, zoneName = null } = {}) {
  if (!occ?.loadout) throw new Error(`occupant ${occ?.id} has no loadout yet`);
  if (occ.kind === 'boss') return bossScenario(occ, { itemLevel });
  const order = occ.roster.map((m, i) => i)
    .sort((a, b) => (GRADE_RANK[occ.roster[b].grade] ?? -1) - (GRADE_RANK[occ.roster[a].grade] ?? -1) || a - b);
  const enemies = order.map((i, k) => {
    const m = occ.roster[i];
    const type = memberType(occ, i);
    const gear = JSON.parse(JSON.stringify(occ.loadout[i] || {}));
    const base = ENEMY_TYPES[type]?.name || type;
    // The lead of a boosted beast (an apex, zones `boost`) is stronger.
    const boost = k === 0 && occ.boost ? occ.boost : null;
    return {
      type,
      slotId: FIGHT_SLOT_ORDER[k],
      name: occ.name && k === 0 ? `${occ.name[0].toUpperCase()}${occ.name.slice(1)}` : m.grade ? `${m.grade[0].toUpperCase()}${m.grade.slice(1)} ${base}` : base,
      // A beast's prophet mark shows in the fight too (owner's playtest,
      // 2026-09-27): its name label in the mark's colour, as its map ring.
      ...(occ.kind === 'beast' && MARK_COLOR[occ.mark] ? { nameColor: MARK_COLOR[occ.mark] } : {}),
      grade: m.grade || null,
      hpMult: gradeHpScale(m.grade) * (boost?.hpMult || 1),
      ...(Number.isFinite(boost?.damagePct) ? { damageMultiplierPct: boost.damagePct } : {}),
      gear,
      gearDroppable: occ.kind === 'cultist' ? Object.fromEntries(Object.keys(gear).map(sl => [sl, true])) : {},
    };
  });
  const lead = occ.kind === 'cultist' ? 'Cultists' : (HUNT_BEASTS[occ.family]?.name || 'Beasts');
  const cult = occ.kind === 'cultist' ? CULT_BANDS[occ.cult]?.name : null;
  return {
    id: `hunt_map_${occ.id}`,
    name: occ.kind === 'cultist' ? (cult || 'Cultist band') : `${lead}${occ.roster.length > 1 ? ' pack' : ''}`,
    description: zoneName ? `A fight in the ${zoneName}.` : 'A fight on the hunt.',
    // The lead member's own portrait (14a): the old keys were never loaded.
    portraitKey: ENEMY_TYPES[enemies[0]?.type]?.skin || null,
    loot: { itemLevel, maxBaseTier: 1 },
    enemies,
  };
}
