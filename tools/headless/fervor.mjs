// tools/headless/fervor.mjs
//
// Withering Fervor must add its necrotic damage the way Blazing Fervor adds fire.
//
// Both skills grant an attacker-side onHit rider: Blazing `{ fireDamage }`,
// Withering `{ necroticDamage }`. The typed damage pipeline — which nearly every
// current skill uses — only ever read `fireDamage`. The necrotic counterpart
// existed solely in CombatScene's legacy fallback, which skips typed skills, so on
// any modern attack Withering Fervor added no damage and no breakdown line. The
// owner noticed it missing from the damage tooltip.
//
// The buffs come from each skill's REAL apply(), and the hit goes through the
// REAL applyTypedDamageModifiers — nothing here restates either formula.
//
// Run: node tools/headless/fervor.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(5);

const { SKILLS } = await import('../../data/skills.js');
const { applyTypedDamageModifiers, getLastDamageBreakdown, _resetDamageBreakdown } = await import('../../src/systems/CombatLogic.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

/** An attacker who has cast `skillId` on itself with a full initiative gauge. */
function buffedBy(skillId) {
  const attacker = { name: 'Caster', statusEffects: [], initiativeGauge: 30, derived: {}, gearEffects: {} };
  const scene = {
    allySlots: [{ char: attacker }],
    enemySlots: [],
    _addStatusEffects: (unit, effects) => { unit.statusEffects.push(...effects.map(e => ({ ...e }))); },
    _log: () => {},
  };
  SKILLS[skillId].apply(attacker, null, scene);
  return attacker;
}

const target = () => ({ name: 'Target', statusEffects: [], derived: {}, gearEffects: {}, weakness: null });
const hit = (attacker) => applyTypedDamageModifiers(
  { physical: 100, elemental: 0, necrotic: 0 }, attacker, target(),
  { skipGearMultiplier: true, skillPct: 100, isCrit: false, critMult: 1, silent: true }
);
const plain = { name: 'Plain', statusEffects: [], derived: {}, gearEffects: {} };

console.log('=== the riders each skill grants (from its own apply) ===');
const blazing = buffedBy('blazing_fervor');
const withering = buffedBy('withering_fervor');
const bRider = blazing.statusEffects.find(s => s.id === 'blazing_fervor_buff')?.onHit;
const wRider = withering.statusEffects.find(s => s.id === 'withering_fervor_buff')?.onHit;
check('Blazing Fervor at 30 initiative grants +6 fire damage', bRider?.fireDamage === 6, JSON.stringify(bRider));
check('Withering Fervor at 30 initiative grants +6 necrotic damage', wRider?.necroticDamage === 6, JSON.stringify(wRider));

console.log('=== a typed hit with each buff ===');
const base = hit(plain);
const withB = hit(blazing);
const withW = hit(withering);
check('Blazing Fervor adds its fire damage to the hit',
  withB.elemental - base.elemental === 6, `elemental ${base.elemental} -> ${withB.elemental}`);
check('Withering Fervor adds its necrotic damage to the hit',
  withW.necrotic - base.necrotic === 6, `necrotic ${base.necrotic} -> ${withW.necrotic}`);
check('...and only necrotic — nothing leaks into the other damage types',
  withW.physical === base.physical && withW.elemental === base.elemental,
  `physical ${withW.physical}, elemental ${withW.elemental}`);

console.log('=== the damage breakdown shows both, the same way ===');
{
  _resetDamageBreakdown(); hit(blazing);
  const bLines = JSON.stringify(getLastDamageBreakdown());
  _resetDamageBreakdown(); hit(withering);
  const wLines = JSON.stringify(getLastDamageBreakdown());
  check('Blazing Fervor appears in the breakdown', /Fire rider/.test(bLines), bLines.slice(0, 120));
  check('Withering Fervor appears in the breakdown', /Necrotic rider/.test(wLines), wLines.slice(0, 120));
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
