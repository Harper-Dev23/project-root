// tools/headless/battlereport.mjs
//
// The battle report (owner 2026-09-29, playtest batch 4b chunk 8;
// src/systems/CombatStats.js): its rules on hand-made turns, then real fights
// on the real CombatScene, and the Historic / renown item record it feeds.
//
// Run: node tools/headless/battlereport.mjs

import { installPhaserStub, seed } from './phaserStub.js';
installPhaserStub(1);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const { createCombatStats } = await import('../../src/systems/CombatStats.js');
const { createCombatHost } = await import('./combatHost.js');
const { makeParty, slotMapFor } = await import('./fixtures.js');
const { runFight } = await import('./fight.js');
const { createItemInstance } = await import('../../src/systems/ItemFactory.js');
const M = await import('../../src/scenes/CombatScene.js');
const CombatScene = M.default || Object.values(M).find(v => typeof v === 'function');

console.log('=== the rules, turn by turn ===');
{
  const a = { id: 'a', name: 'Wren', currentHP: 50 };
  const b = { id: 'b', name: 'Torg', currentHP: 40 };
  const e1 = { id: 'e1', name: 'Croc', currentHP: 100, isEnemy: true };
  const e2 = { id: 'e2', name: 'Viper', currentHP: 30, isEnemy: true };
  const all = [a, b, e1, e2];
  const st = createCombatStats([a, b]);
  st.begin(a, all);
  st.noteSkill(a, 'Sorrowfall');
  e1.currentHP = 60; e2.currentHP = 0; e2.status = 'incapacitated'; b.currentHP = 48 > 40 ? 40 : 40; a.currentHP = 50;
  st.end();
  st.begin(e1, all);
  a.currentHP = 35; e1.currentHP = 55;           // the croc hits Wren; a bleed ticks on the croc
  st.end();
  st.begin(b, all);
  st.noteSkill(b, 'Mending Barb');
  a.currentHP = 45; e1.currentHP = 50;
  st.end();
  const rep = st.report();
  const w = rep.rows.find(r => r.name === 'Wren'), t = rep.rows.find(r => r.name === 'Torg');
  check("a hunter's turn: the enemy side's HP lost is their damage, the biggest loss their biggest hit", w.damage === 70 && w.biggest === 40 && w.biggestSkill === 'Sorrowfall', JSON.stringify(w));
  check('...an enemy going down on it is their kill', w.kills === 1);
  check("HP a hunter loses on any turn is damage taken", w.taken === 15);
  check("the party's HP gained on a hunter's turn is that hunter's healing", t.healing === 10 && t.damage === 5, JSON.stringify(t));
  check("enemy HP lost on the enemy's own turn is the party's effects", rep.effects === 5 && rep.total.damage === 80, JSON.stringify(rep.total));
  check('the highlight is the biggest hit of the fight', rep.highlight?.name === 'Wren' && rep.highlight.amount === 40 && rep.highlight.skill === 'Sorrowfall');
}

console.log('');
console.log('=== real fights on the real CombatScene ===');
for (const sc of ['training_encounter_3', 'training_encounter_5']) {
  seed(20260929);
  const host = createCombatHost(CombatScene);
  const party = makeParty();
  // A renown item on the first hunter, to see its record filled.
  const blade = createItemInstance(party[0].equipment?.weaponMain?.id || 'crude_sword_1h', { rollAffixes: false });
  blade.history = { droppedFrom: null, droppedScenario: null, kills: 0, damageDealt: 0, battlesCarried: 0 };
  party[0].equipment.weaponMain = blade;
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId: sc });
  const run = runFight(host, (h, actor) => {
    const atk = (actor.skills || []).find(s => s.id === 'basic_attack');
    const foe = h.enemies.find(e => e.status !== 'incapacitated' && e.currentHP > 0);
    return (atk && foe) ? [{ ability: atk, target: foe }] : [];
  }, { maxTurns: 600 });
  const rep = host._finishBattleReport();
  const enemyHP = host.enemies.reduce((n, e) => n + (e.maxHP || 0), 0);
  check(`${sc}: a report with a row per hunter`, !!rep && rep.rows.length === party.length, JSON.stringify(rep?.rows?.map(r => r.name)));
  check(`${sc}: damage was dealt and taken, and a biggest hit named`, rep.total.damage > 0 && rep.total.taken > 0 && !!rep.highlight,
    JSON.stringify({ total: rep.total, highlight: rep.highlight, ended: run.ended }));
  const won = host.enemies.every(e => e.status === 'incapacitated' || e.status === 'dead' || (e.currentHP ?? 0) <= 0);
  if (won) check(`${sc}: a won fight credits every enemy as a kill`, rep.total.kills === host.enemies.length, `${rep.total.kills} of ${host.enemies.length}`);
  check(`${sc}: the damage never exceeds what the enemy side had`, rep.total.damage <= enemyHP + 1, `${rep.total.damage} of ${enemyHP}`);
  const hist = party[0].equipment.weaponMain.history;
  const r0 = rep.rows.find(r => r.name === party[0].name);
  check(`${sc}: the renown weapon's record takes its wielder's kills and damage, and one battle`,
    hist.battlesCarried === 1 && hist.damageDealt === r0.damage && hist.kills === r0.kills, JSON.stringify(hist));
  host._finishBattleReport();
  check(`${sc}: ...credited once`, hist.battlesCarried === 1);
}

console.log('');
console.log('=== a won fight: kills ===');
{
  // The basic-attack plan above loses these trials; ten-times damage wins one.
  globalThis.localStorage?.setItem('dev_super_saiyan', 'true');
  seed(20260929);
  const host = createCombatHost(CombatScene);
  const party = makeParty();
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId: 'training_encounter_1' });
  runFight(host, (h, actor) => {
    const atk = (actor.skills || []).find(s => s.id === 'basic_attack');
    const foe = h.enemies.find(e => e.status !== 'incapacitated' && e.currentHP > 0);
    return (atk && foe) ? [{ ability: atk, target: foe }] : [];
  }, { maxTurns: 600 });
  globalThis.localStorage?.removeItem('dev_super_saiyan');
  const rep = host._finishBattleReport();
  const won = host.enemies.length > 0 && host.enemies.every(e => e.status === 'incapacitated' || e.status === 'dead' || (e.currentHP ?? 0) <= 0);
  check('the fight was won', won, host.enemies.map(e => `${e.name} ${e.currentHP}`).join(', '));
  check('every enemy is somebody\'s kill', rep.total.kills === host.enemies.length, `${rep.total.kills} of ${host.enemies.length}`);
}

console.log('');
if (failures) { console.log(`battlereport: ${failures} FAILED`); process.exit(1); }
console.log('battlereport: all passed');
