// tools/headless/gates.mjs
//
// Every weapon skill unlocks exactly at the Proficiency gate it declares, and
// the unlock orders the owner set are respected.
//
// The golden master cannot see any of this: it casts skills directly, never
// through getWeaponSkillsFor, the function that builds the combat menu and is
// the only thing that actually enforces a gate. So a gate change always reads
// IDENTICAL there, whatever it did.
//
// Checked through the real menu: each skill must be PRESENT with its stat's
// Proficiency exactly at the gate, and ABSENT one point below.
//
// Deliberately does NOT pin the distribution (how many skills per step): the
// owner is hand-tuning that, and a test that fought every move would be noise.
//
// Run: node tools/headless/gates.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(1);

const { SKILLS, getWeaponSkillsFor } = await import('../../data/skills.js');
const { getProficiency } = await import('../../src/systems/CombatLogic.js');
const { makeParty } = await import('./fixtures.js');

const WIELDER = { sword_1h: 'Bran', dagger: 'Sable', staff: 'Wren', mace_2h: 'Halvard', bow: 'Ilse', axe_2h: 'Torg' };
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok || process.env.VERBOSE) console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const party = makeParty();
const who = Object.fromEntries(Object.entries(WIELDER).map(([w, n]) => [w, party.find(c => c.name === n)]));

// Put `char` at exactly `value` Proficiency in `stat`, via the token bonus the
// engine already adds on top of permanent stats (negative is allowed).
function setProf(char, stat, value) {
  char.proficiencyBonus = { ...(char.proficiencyBonus || {}), [stat]: 0 };
  char.proficiencyBonus[stat] = value - getProficiency(char, stat);
}
const inMenu = (char, id) => getWeaponSkillsFor(char).some(s => s?.id === id);

console.log('=== each skill unlocks exactly at its gate, through the real menu ===');
let n = 0;
for (const [id, s] of Object.entries(SKILLS)) {
  if (s.hidden || s.type !== 'weapon' || !s.requiredStat) continue;
  const w = [].concat(s.requiredWeapon || []).find(x => WIELDER[x]);
  if (!w) continue;
  const char = who[w];
  const saved = { ...(char.proficiencyBonus || {}) };
  setProf(char, s.requiredStat, s.requiredValue);
  const at = inMenu(char, id);
  setProf(char, s.requiredStat, s.requiredValue - 1);
  const below = inMenu(char, id);
  char.proficiencyBonus = saved;
  n++;
  check(`${s.name} (${w}, ${s.requiredStat} ${s.requiredValue})`, at && !below,
    `at gate: ${at ? 'in menu' : 'MISSING'}, one below: ${below ? 'STILL IN MENU' : 'locked'}`);
}
console.log(`  ${n} skills checked` + (failures ? '' : ' -- all unlock exactly at their gate'));

console.log('');
console.log('=== owner-set unlock orders ===');
const gate = (id) => SKILLS[id]?.requiredValue;
for (const [a, b, why] of [
  ['staggering_point', 'whistling_shot', 'bow Disorient: builder before the stronger debuff'],
  ['storm_splitter', 'thunderhead', 'axe Lightning: builder before the payoff that needs it'],
]) {
  const ok = SKILLS[a]?.requiredStat === SKILLS[b]?.requiredStat ? gate(a) < gate(b) : true;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + `  ${SKILLS[a].name} ${gate(a)} before ${SKILLS[b].name} ${gate(b)}   (${why})`);
  if (!ok) failures++;
}
for (const [id, s] of Object.entries(SKILLS)) {
  if (!s.supersededBy || !SKILLS[s.supersededBy]) continue;
  const u = SKILLS[s.supersededBy];
  const ok = s.requiredStat !== u.requiredStat || s.requiredValue < u.requiredValue;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + `  ladder: ${s.name} ${s.requiredValue} unlocks before its upgrade ${u.name} ${u.requiredValue}`
    + (ok ? '' : '   -- the entry skill would vanish the moment it unlocks'));
  if (!ok) failures++;
}

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
