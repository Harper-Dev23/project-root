// tools/headless/damagecheck.mjs
//
// Dual wield and flat added damage (owner's notes, 2026-09-29: "verify dual
// wield and added flat elemental or necrotic damage are applied properly").
// Drives the real calculateDamage over many rolls:
//   - one weapon: the base is its die plus Strength/5;
//   - two one-handers: each blade's die at 75%, Strength added once;
//   - a two-hander never pairs with an off hand;
//   - a weapon's flat fire lands as ELEMENTAL, a flat necrotic as NECROTIC
//     (it used to land as elemental), each hand's flats at 75% when dual
//     wielding.
//
// Run: node tools/headless/damagecheck.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(99);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const { calculateDamage, getMasteryMultiplier } = await import('../../src/systems/CombatLogic.js');
const { createItemInstance, getItemComputedData } = await import('../../src/systems/ItemFactory.js');
const { rebuildCharacterStats } = await import('../../src/systems/CharacterBuilder.js');
const { makeParty } = await import('./fixtures.js');
const { Items } = await import('../../data/items.js');

const target = { name: 'Dummy', derived: { Evasion: 0, PhysicalResist: 0, ElementalResist: 0, NecroticResist: 0 }, totalStats: {}, statusEffects: [] };
const attack = { id: 'basic_attack', name: 'Basic Attack', type: 'weapon' };
const weapon = (id, flats = null) => {
  const w = createItemInstance(id, { rarity: 'common', rollAffixes: false });
  if (flats) { w.instanceMods = w.instanceMods || {}; w.instanceMods.elementalFlat = flats; }
  return w;
};
const armed = (main, off = null) => {
  const c = makeParty()[0];
  // Weapons only: no armour, so no gear damage% between the die and the hit.
  c.equipment = { weaponMain: main, weaponOff: off, head: null, chest: null, legs: null, gloves: null, boots: null, ring: null, amulet: null };
  return rebuildCharacterStats(c) || c;
};
const rolls = (c, n = 400) => Array.from({ length: n }, () => calculateDamage(c, target, attack));
const range = (xs) => [Math.min(...xs), Math.max(...xs)];
const baseOf = (r) => r.physical;   // crit is folded in last; keep crits out below
// The hunter's mastery (Proficiency) multiplier scales the physical base.
const scaled = (c, n) => Math.floor(n * getMasteryMultiplier(c));
const nonCrit = (rs) => rs.filter(r => !r.isCrit);

console.log('=== one weapon ===');
{
  const sw = weapon('crude_sword_1h');
  const c = armed(sw);
  const str = Math.floor((c.totalStats?.STR || 0) / 5);
  const d = getItemComputedData(sw).damage;
  const [lo, hi] = range(nonCrit(rolls(c)).map(baseOf));
  check('a single 1h sword: its die plus Strength/5 (then its mastery)', lo === scaled(c, d.min + str) && hi === scaled(c, d.max + str), `${lo}-${hi} vs die ${d.min}-${d.max} + STR ${str}`);
}

console.log('=== two one-handers ===');
{
  const main = weapon('crude_sword_1h'), off = weapon('crude_dagger');
  const c = armed(main, off);
  const str = Math.floor((c.totalStats?.STR || 0) / 5);
  const dm = getItemComputedData(main).damage, doff = getItemComputedData(off).damage;
  const want = [scaled(c, Math.floor(dm.min * 0.75) + Math.floor(doff.min * 0.75) + str), scaled(c, Math.floor(dm.max * 0.75) + Math.floor(doff.max * 0.75) + str)];
  const [lo, hi] = range(nonCrit(rolls(c)).map(baseOf));
  check('each blade at 75%, Strength once', lo === want[0] && hi === want[1], `${lo}-${hi} vs ${want[0]}-${want[1]}`);
  const single = range(nonCrit(rolls(armed(weapon('crude_sword_1h')))).map(baseOf));
  check('...which hits harder on average than the sword alone', hi > single[1] || lo > single[0], `dual ${lo}-${hi}, single ${single[0]}-${single[1]}`);
}

console.log('=== a two-hander ignores the off hand ===');
{
  const mace = weapon('crude_mace_2h');
  const c = armed(mace, weapon('crude_dagger'));
  const str = Math.floor((c.totalStats?.STR || 0) / 5);
  const d = getItemComputedData(mace).damage;
  const [lo, hi] = range(nonCrit(rolls(c)).map(baseOf));
  check('a 2h mace with a dagger in the off hand rolls the mace alone', lo === scaled(c, d.min + str) && hi === scaled(c, d.max + str), `${lo}-${hi}`);
}

console.log('=== flat added damage ===');
{
  const c = armed(weapon('crude_sword_1h', { necrotic: { min: 6, max: 6 } }));
  const rs = nonCrit(rolls(c, 200));
  check('a flat necrotic lands as necrotic, not elemental', rs.every(r => r.necrotic === 6 && r.elemental === 0), JSON.stringify(rs.slice(0, 2).map(r => [r.physical, r.elemental, r.necrotic])));
  const f = armed(weapon('crude_sword_1h', { fire: { min: 6, max: 6 } }));
  const fr = nonCrit(rolls(f, 200));
  check('a flat fire lands as elemental', fr.every(r => r.elemental >= 6 && r.necrotic === 0));
  const dual = armed(weapon('crude_sword_1h', { necrotic: { min: 8, max: 8 } }), weapon('crude_dagger', { fire: { min: 8, max: 8 } }));
  const dr = nonCrit(rolls(dual, 200));
  check('dual wielding: each hand\'s flats at 75% (8 -> 6), in their own buckets', dr.every(r => r.necrotic === 6 && r.elemental === 6),
    JSON.stringify(dr.slice(0, 2).map(r => [r.physical, r.elemental, r.necrotic])));
}

console.log('');
if (failures) { console.log(`damagecheck: ${failures} FAILED`); process.exit(1); }
console.log('damagecheck: all passed');
