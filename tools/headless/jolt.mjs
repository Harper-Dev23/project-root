// tools/headless/jolt.mjs
//
// A Lightning jolt does what lightningJoltOdds says it does.
//
// lightningJoltOdds(meter) is the one definition of how many extra jolt rolls a
// Shocked target gets and the chance each lands. applyLightningJolt, the
// in-combat tooltip and the journal all describe or use it. This guards the
// property that went silently wrong once already: the jolt function computing
// its count inline and ignoring the dials, while the golden masters -- which
// only ever saw default values -- reported IDENTICAL.
//
// Counts jolts through the REAL function by making each jolt deal exactly 1 for
// the test only, so a hit's jolt total equals its jolt count.
//
// Run: node tools/headless/jolt.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(31, { deterministic: false });
const { applyLightningJolt } = await import('../../src/systems/CombatLogic.js');
const { WeaknessV3, weaknessTierFromMeter, lightningJoltOdds } = await import('../../src/systems/StatusEffects.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const L = WeaknessV3.families.lightning;
const saved = { die: L.t1.joltDieMax, flat: L.t1.joltFlat,
  er: L.t2.extraJoltsExp, ek: L.t2.multiJoltChanceExp, cap: L.t2.extraJoltsCap };
L.t1.joltDieMax = 0; L.t1.joltFlat = 1;

const hit = (m) => applyLightningJolt({ name: 'T', statusEffects: [],
  weakness: { meters: { lightning: m }, tiers: { lightning: weaknessTierFromMeter(m) } } }).joltTotal;
const avgAt = (m, n = 8000) => { let s = 0; for (let i = 0; i < n; i++) s += hit(m); return s / n; };

console.log('=== Zapped (T1): exactly one jolt ===');
{
  let ok = true;
  for (let i = 0; i < 2000; i++) if (hit(150) !== 1) { ok = false; break; }
  check('a Zapped target always takes exactly 1 jolt', ok);
}

console.log('');
console.log('=== Shocked (T2): the jolt follows lightningJoltOdds ===');
for (const m of [200, 400, 800, 1600]) {
  const o = lightningJoltOdds(m);
  const want = 1 + o.rolls * o.chance;
  const got = avgAt(m);
  check(`meter ${String(m).padStart(4)}: average jolts match 1 + rolls x chance`,
    Math.abs(got - want) < 0.2, `measured ${got.toFixed(2)}, expected ${want.toFixed(2)} (${o.rolls} rolls @ ${Math.round(o.chance * 100)}%)`);
}

console.log('');
console.log('=== the dials actually move the jolt ===');
{
  const before = avgAt(1600);
  L.t2.extraJoltsExp = 0.5; L.t2.multiJoltChanceExp = 0.5;
  const after = avgAt(1600);
  check('lowering both exponents lowers the jolts a hit deals',
    after < before - 1, `meter 1600: ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  L.t2.extraJoltsCap = 3;
  const capped = avgAt(1600);
  check('a count cap bounds the jolts', capped <= 1 + 3 + 0.05, `with cap 3: ${capped.toFixed(2)} (max possible 4)`);
}

L.t1.joltDieMax = saved.die; L.t1.joltFlat = saved.flat;
if (saved.er === undefined) delete L.t2.extraJoltsExp; else L.t2.extraJoltsExp = saved.er;
if (saved.ek === undefined) delete L.t2.multiJoltChanceExp; else L.t2.multiJoltChanceExp = saved.ek;
if (saved.cap === undefined) delete L.t2.extraJoltsCap; else L.t2.extraJoltsCap = saved.cap;

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
