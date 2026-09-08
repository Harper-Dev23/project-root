// @ts-nocheck
// tools/headless/fixtures.js
//
// Builds the two sides of a fight from REAL game data, not hand-written stubs.
//
// This distinction is the whole value of the harness. Design measurements so
// far have used ad-hoc stub characters, and a stub drifts from the real
// construction pipeline without anyone noticing - the probe that proved this
// approach worked dealt 2 damage, because its `equipment.weapon` was not the
// `equipment.weaponMain` field the engine actually reads. A number "verified"
// against a stub can be quietly wrong. Here the party goes through
// buildCharacter + rebuildCharacterStats exactly as character creation does,
// and enemies go through CombatScene's own _spawnEnemy.
//
// LOAD ORDER: like combatHost.js, this imports production modules, so
// installPhaserStub() must run first.

if (!globalThis.Phaser) {
  throw new Error('fixtures.js imported before installPhaserStub().');
}

import { buildCharacter, rebuildCharacterStats } from '../../src/systems/CharacterBuilder.js';
import { getWeaponSkillsFor, getClassSkillsFor, getReactionSkillsFor, SKILLS } from '../../data/skills.js';
import { Items } from '../../data/items.js';

// Affix-free tier-2 bases, one per current weapon type. Chosen deliberately
// over a rolled instance: a base id carries no random affixes, so a golden
// master records the SKILL's behaviour rather than a lucky roll. Gear-affix
// runs are a separate scenario, not the baseline.
export const BASE_WEAPON = {
  sword_1h: 'hardened_sword_1h',
  dagger: 'hardened_dagger',
  staff: 'hardened_staff',
  mace_2h: 'hardened_mace_2h',
  bow: 'hardened_bow',
  axe_2h: 'hardened_axe_2h',
};

// Level-5 stat spreads. The budget is real: 30 base (5 per stat) + 10 at
// creation + 5 per level-up = 60 allocated points at level 5, before race and
// class bonuses. Each hunter leans into its weapon's primary stat but keeps a
// real secondary, because that is what the re-gate pass assumed a player would
// actually look like - a pure specialist and a pure generalist are both
// separate, deliberate test cases rather than the default.
export const HUNTERS = [
  {
    name: 'Bran', race: 'Dwarf', baseClass: 'Grunt', slotId: 2,
    weaponType: 'sword_1h',
    stats: { STR: 16, DEX: 10, CON: 14, INT: 5, WIS: 8, CHA: 7 },
  },
  {
    name: 'Sable', race: 'Skith', baseClass: 'Beggar', slotId: 1,
    weaponType: 'dagger',
    stats: { STR: 8, DEX: 17, CON: 9, INT: 12, WIS: 7, CHA: 7 },
  },
  {
    name: 'Wren', race: 'Elf', baseClass: 'Scholar', slotId: 8,
    weaponType: 'staff',
    stats: { STR: 5, DEX: 8, CON: 9, INT: 17, WIS: 14, CHA: 7 },
  },
  {
    name: 'Halvard', race: 'Dwarf', baseClass: 'Acolyte', slotId: 3,
    weaponType: 'mace_2h',
    stats: { STR: 13, DEX: 6, CON: 13, INT: 5, WIS: 16, CHA: 7 },
  },
  {
    name: 'Ilse', race: 'Ferrow', baseClass: 'Shepherd', slotId: 7,
    weaponType: 'bow',
    stats: { STR: 8, DEX: 16, CON: 9, INT: 6, WIS: 14, CHA: 7 },
  },
  {
    name: 'Torg', race: 'Wylett', baseClass: 'Grunt', slotId: 4,
    weaponType: 'axe_2h',
    stats: { STR: 17, DEX: 8, CON: 14, INT: 5, WIS: 9, CHA: 7 },
  },
];

/**
 * Builds party members through the real creation pipeline.
 *
 * `level` is set explicitly rather than by looping applyLevelUp, because
 * applyLevelUp only hands out unspent points - the allocation itself lives in
 * `stats` above, already spent.
 */
export function makeParty(specs = HUNTERS, { level = 5 } = {}) {
  return specs.map(spec => {
    const char = buildCharacter({
      name: spec.name,
      race: spec.race,
      baseClass: spec.baseClass,
      stats: spec.stats,
      skin: spec.skin || null,
    });

    char.level = level;
    char.unspentStatPoints = 0;

    const weaponId = spec.weaponMain || BASE_WEAPON[spec.weaponType];
    if (weaponId) {
      if (!Items[weaponId]) throw new Error('fixture weapon not in Items: ' + weaponId);
      char.equipment.weaponMain = weaponId;
    }
    if (spec.weaponOff) char.equipment.weaponOff = spec.weaponOff;

    // Recompute permanentStats/derived/gearEffects with the weapon on. This is
    // what makes Proficiency - and therefore every skill gate - correct.
    rebuildCharacterStats(char);

    char.currentHP = char.maxHP;
    char.currentMP = char.maxMP;
    char.status = 'active';

    // Grant the full unlocked kit the same way the action menu does, so the
    // harness exercises exactly the skills this character can really use.
    char.skills = [
      ...char.skills,
      ...getWeaponSkillsFor(char),
      ...getClassSkillsFor(char),
      ...getReactionSkillsFor(char),
    ];

    return char;
  });
}

/** Slot assignment map in the shape GameState.partySlots uses. */
export function slotMapFor(party, specs = HUNTERS) {
  const map = {};
  party.forEach((char, i) => {
    const slotId = specs[i]?.slotId;
    if (slotId != null) map[slotId] = char.instanceId || char.id;
  });
  return map;
}

/**
 * Resolves a skill for a character by id, preferring the character's own
 * granted copy (which carries the per-character fields the menu adds) and
 * falling back to the registry. Throws rather than returning undefined: a
 * silently missing skill is how a "verified" run measures nothing at all.
 */
export function skillFor(char, id) {
  const own = (char.skills || []).find(s => s?.id === id);
  if (own) return own;
  if (SKILLS[id]) return SKILLS[id];
  throw new Error('skill not found: ' + id + ' (commented out in skills.js?)');
}

/** Every current-weapon skill a character can actually use, ids only. */
export function usableSkillIds(char) {
  return getWeaponSkillsFor(char).map(s => s.id);
}
