// tools/headless/dials.mjs
//
// Every enemy spawns with the damage dial its fight intends.
//
// `damageMultiplierPct` can be set on an enemy TYPE or overridden on a
// SCENARIO's entry for that enemy. The override exists because encounters 4 and
// 5 reuse one enemy type across the base fight and every Reckoning tier: a dial
// on the type trims them all together, and the owner wanted the base fights
// softened while the higher tiers kept their damage.
//
// Checked at the SPAWNED enemy's gearEffects, after drops are equipped -- not at
// the data -- so a later step that rebuilt gearEffects and dropped the dial
// would fail here instead of silently undoing the trim.
//
// Run: node tools/headless/dials.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(7);

const { createCombatHost } = await import('./combatHost.js');
const CS = await import('../../src/scenes/CombatScene.js');
const CombatScene = CS.default || Object.values(CS).find(v => typeof v === 'function');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

// scenario -> the dial every enemy on its OPENING board should carry
// (undefined = no dial at all, i.e. full damage)
const EXPECT = {
  training_encounter_4:             -15,
  training_encounter_4_reckoning_1: -7.5,
  training_encounter_4_reckoning_2: undefined,
  training_encounter_4_reckoning_3: undefined,
  training_encounter_5:             -10,
  training_encounter_5_reckoning_1: -5,
  training_encounter_5_reckoning_2: undefined,
  training_encounter_5_reckoning_3: undefined,
  training_encounter_6:             -46,
  training_encounter_6_reckoning_1: -40.5,
  training_encounter_6_reckoning_2: -35,
  training_encounter_6_reckoning_3: -32.5,
  training_encounter_6_reckoning_4: -30,
  training_encounter_6_reckoning_5: -27.5,
};

console.log('=== the dial each spawned enemy actually carries ===');
for (const [sid, want] of Object.entries(EXPECT)) {
  const host = createCombatHost(CombatScene);
  host._placeEnemies(sid);
  const got = (host.enemies || []).map(e => ({ name: e.name, pct: e.gearEffects?.hiddenDamagePercent }));
  const ok = got.length > 0 && got.every(g => g.pct === want);
  check(`${sid.padEnd(34)} ${String(want ?? 'none').padStart(5)}`, ok,
    got.map(g => `${g.name}=${g.pct ?? 'none'}`).join(' '));
}

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
