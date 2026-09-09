// @ts-nocheck
// tools/headless/smoke.mjs
//
// Does the whole chain still stand up? Run: node tools/headless/smoke.mjs
//
// This makes no assertions about numbers - that is combat_snapshot.js's job.
// It answers one question, quickly: can a real party, real enemies and the
// real engine still be assembled and made to fight in Node?
//
// Note the load order. installPhaserStub() is a static import so it runs
// first; everything downstream is a dynamic import, because CombatScene
// reaches for Phaser at module scope and would throw if it loaded any earlier.

import { installPhaserStub } from './phaserStub.js';
installPhaserStub(12345);

const { createCombatHost } = await import('./combatHost.js');
const { makeParty, slotMapFor, skillFor, usableSkillIds } = await import('./fixtures.js');
const { runFight, snapshotBoard } = await import('./fight.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');

// ---- 1. a board -----------------------------------------------------------
const host = createCombatHost(CombatScene);
const party = makeParty();
host.__begin({ party, partySlots: slotMapFor(party), scenarioId: 'training_encounter_1' });

console.log('=== party (built through buildCharacter, armed from Items) ===');
for (const c of party) {
  const p = c.permanentStats;
  console.log(
    '  ' + c.name.padEnd(9) + String(c.weaponType || '-').padEnd(9) +
    'HP ' + String(c.maxHP).padStart(3) + '  MP ' + String(c.maxMP).padStart(3) + '  ' +
    `STR ${p.STR} DEX ${p.DEX} CON ${p.CON} INT ${p.INT} WIS ${p.WIS} CHA ${p.CHA}  ` +
    'unlocked skills ' + usableSkillIds(c).length
  );
}

console.log('=== enemies (built through CombatScene._spawnEnemy) ===');
for (const e of host.enemies) {
  console.log('  ' + String(e.name).padEnd(20) + 'slot ' + e.slotId +
    '  HP ' + e.currentHP + '/' + e.maxHP);
}

console.log('=== turn order (sorted by the real computeEffectiveInitiative) ===');
console.log('  ' + host.turnOrder.map(u => u.name).join(' -> '));

// ---- 2. one ability, through the real path --------------------------------
const bran = party.find(c => c.name === 'Bran');
const foe = host.enemies[0];
const before = foe.currentHP;
const logStart = host.combatEntries.length;

host._applyAbilityToTarget(bran, foe, skillFor(bran, 'basic_attack'));

console.log('=== one basic attack ===');
console.log(`  ${bran.name} -> ${foe.name}: HP ${before} -> ${foe.currentHP} ` +
  `(dealt ${before - foe.currentHP})`);
host.__logLines().slice(logStart).forEach(l => console.log('  | ' + String(l).slice(0, 110)));

// ---- 3. a whole fight, driven by the engine's own turn loop and AI ---------
const host2 = createCombatHost(CombatScene);
const party2 = makeParty();
host2.__begin({ party: party2, partySlots: slotMapFor(party2), scenarioId: 'training_encounter_1' });

const result = runFight(host2, (h, actor) => {
  const enemy = h.enemies.find(e => e.status !== 'incapacitated' && e.currentHP > 0);
  return enemy ? [{ ability: skillFor(actor, 'basic_attack'), target: enemy }] : [];
});
const snap = snapshotBoard(host2);

console.log('=== a whole fight ===');
console.log('  ' + JSON.stringify(result));
console.log('  allies: ' + snap.allies.map(a => `${a.name} ${a.hp}/${a.maxHP}`).join(', '));
console.log('  enemies: ' + (snap.enemies.some(e => e.hp > 0)
  ? snap.enemies.map(e => `${e.name} ${e.hp}`).join(', ') : '(all down)'));
console.log('  log lines: ' + host2.combatEntries.length);

// ---- 4. what was never executed -------------------------------------------
console.log('=== presentation calls skipped ===');
const skips = Object.entries(host.__skipped).sort((a, b) => b[1] - a[1]);
console.log('  ' + (skips.length ? skips.map(([k, v]) => k + ' x' + v).join(', ') : '(none)'));
