// tools/headless/rewards.mjs
//
// Every tier-cross debuff on a current weapon must actually DO something.
//
// _applyRewardDebuff builds its effect from a fixed set of named fields
// (damageDealtDownPct, speedDownPct, physicalVulnPct, addBuildup, ...). A debuff
// written in any other shape -- Whistling Shot's raw `mods: { AttackPower }` --
// is handed over, finds nothing it recognises, and returns without a word: the
// skill looks finished, the tooltip prints a duration, and nothing ever lands.
//
// Checked by BEHAVIOUR rather than against a list of allowed field names, since
// a hand-kept list is one more copy of a fact that can drift from the engine.
// Each debuff goes through the real _applyRewardDebuff on a fresh target, and
// must leave SOME trace: a status, a moved weakness meter, or a moved gauge.
//
// Run: node tools/headless/rewards.mjs

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(13, { deterministic: false });

const { createCombatHost } = await import('./combatHost.js');
const { makeParty, slotMapFor, skillFor } = await import('./fixtures.js');
const { startCombat, cast } = await import('./fight.js');
const { SKILLS } = await import('../../data/skills.js');
const { weaknessTierFromMeter } = await import('../../src/systems/StatusEffects.js');
const { buildSkillTooltipLines } = await import('../../src/ui/skillTooltip.js');
const CS = await import('../../src/scenes/CombatScene.js');
const CombatScene = CS.default || Object.values(CS).find(v => typeof v === 'function');

const CURRENT = ['sword_1h', 'dagger', 'staff', 'mace_2h', 'bow', 'axe_2h'];
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const board = () => {
  const host = createCombatHost(CombatScene);
  const party = makeParty();
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId: 'training_encounter_1' });
  startCombat(host);
  return { host, party };
};
const weaponsOf = (s) => Array.isArray(s.requiredWeapon) ? s.requiredWeapon : s.requiredWeapon ? [s.requiredWeapon] : [];

console.log('=== every tier-cross debuff leaves a trace ===');
const outdated = [];
for (const [id, sk] of Object.entries(SKILLS)) {
  const rules = [].concat(sk.rewardIfTierCross || []).filter(r => r?.debuff);
  if (!rules.length) continue;
  const current = weaponsOf(sk).some(w => CURRENT.includes(w));
  for (const rule of rules) {
    const { host, party } = board();
    const t = host.enemies.find(e => e.status !== 'incapacitated');
    t.initiativeGauge = 50;                          // so a drain/steal has something to take
    const before = {
      ids: new Set((t.statusEffects || []).map(e => e.id)),
      meters: JSON.stringify(t.weakness?.meters || {}),
      gauge: t.initiativeGauge,
    };
    host._applyRewardDebuff(t, rule.debuff, sk, { family: rule.family, tier: rule.tier, attacker: party[0] });
    const landed = (t.statusEffects || []).some(e => !before.ids.has(e.id))
      || JSON.stringify(t.weakness?.meters || {}) !== before.meters
      || t.initiativeGauge !== before.gauge;
    const label = `${id} (T${rule.tier} ${rule.family}): ${Object.keys(rule.debuff).join('+')}`;
    if (current) check(label, landed, landed ? '' : 'the engine applied NOTHING');
    else if (!landed) outdated.push(`${label}  [${weaponsOf(sk).join(',')}]`);
  }
}
if (outdated.length) {
  console.log('\n  Known dead on OUTDATED weapons (reported, not failed -- off-limits by policy):');
  outdated.forEach(l => console.log('    ' + l));
}

console.log('');
console.log('=== Whistling Shot, cast for real ===');
for (const [label, start, wantPct, wantTurns] of [['Dazed (T1)', 50, -10, 2], ['Concussed (T2)', 150, -18, 3]]) {
  let st = null, hit = false;
  for (let attempt = 1; attempt <= 15 && !hit; attempt++) {
    const { host, party } = board();
    const ilse = party.find(c => c.name === 'Ilse');
    ilse.maxMP = ilse.currentMP = 99;
    ilse.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
    const foe = host.enemies.find(e => e.status !== 'incapacitated');
    foe.weakness.meters.disorient = start;
    foe.weakness.tiers.disorient = weaknessTierFromMeter(start);
    cast(host, ilse, skillFor(ilse, 'whistling_shot'), foe);
    if ((foe.weakness.meters.disorient | 0) <= start) continue;   // missed; try again
    hit = true;
    st = (foe.statusEffects || []).find(e => e?.id === 'rattled_aim');
  }
  check(`crossing into ${label} rattles them`, !!st && st.mods?.AttackPower === wantPct && st.turns === wantTurns,
    st ? `AttackPower ${st.mods?.AttackPower}, ${st.turns} turns` : (hit ? 'NO STATUS' : 'never hit'));
}

const tt = (buildSkillTooltipLines(SKILLS.whistling_shot, null, {})?.lines || []).map(x => typeof x === 'string' ? x : x?.text || '');
check('its tooltip names the actual effect, not just a duration',
  tt.some(l => /Dazed.*-10% damage dealt/.test(l)) && tt.some(l => /Concussed.*-18% damage dealt/.test(l)),
  tt.filter(l => /On reaching/.test(l)).join(' | '));

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
