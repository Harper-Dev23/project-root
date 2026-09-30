// tools/headless/enemyhits.mjs
//
// What each enemy side actually hits for (owner's question, 2026-09-30): every
// training fight and a sample of hunt fights, spawned the real way, with each
// enemy's main-hand weapon and its Basic Attack's average damage against an
// unarmoured target. A diagnostic, not part of verify.
//
//   node tools/headless/enemyhits.mjs
import { installPhaserStub } from './phaserStub.js';
installPhaserStub(7);
const quiet = console.log; console.warn = () => {}; console.info = () => {};
const { calculateDamage } = await import('../../src/systems/CombatLogic.js');
const { makeParty, slotMapFor } = await import('./fixtures.js');
const { createCombatHost } = await import('./combatHost.js');
const CombatSceneMod = await import('../../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');
const { rollLoadout, fightScenario } = await import('../../src/systems/HuntBeasts.js');
const { Items } = await import('../../data/items.js');

const target = { name: 'Target', derived: { Evasion: 0, PhysicalResist: 0, ElementalResist: 0, NecroticResist: 0 }, totalStats: {}, statusEffects: [] };
const attack = { id: 'basic_attack', name: 'Basic Attack', type: 'weapon' };
const avg = (e) => { let t = 0; for (let i = 0; i < 300; i++) t += calculateDamage(e, target, attack).amount || 0; return Math.round(t / 30) / 10; };
const weaponOf = (e) => { const w = e.equipment?.weaponMain; const id = typeof w === 'string' ? w : w?.id; return id ? `${Items[id]?.name || id}` : 'NONE (unarmed 1-2)'; };
const report = (label, begin) => {
  console.log = () => {};
  const host = createCombatHost(CombatScene);
  const party = makeParty();
  begin(host, party);
  console.log = quiet;
  console.log(`\n${label}`);
  for (const e of host.enemies.filter(x => !x.isAdd)) console.log(`  ${String(e.name).padEnd(26)} ${weaponOf(e).padEnd(28)} basic attack ~${avg(e)}`);
};
for (const id of ['training_encounter_1', 'training_encounter_2', 'training_encounter_3', 'training_encounter_4', 'training_encounter_5', 'training_encounter_6']) {
  report(id, (h, party) => h.__begin({ party, partySlots: slotMapFor(party), scenarioId: id }));
}
const hunt = (label, occ) => report(label, (h, party) => {
  occ.loadout = rollLoadout(occ, { itemLevel: 2, seed: 42 });
  h.__begin({ party, partySlots: slotMapFor(party), huntFight: { scenario: fightScenario(occ, { itemLevel: 2 }), kind: occ.kind, first: 'party', xpPool: 0 } });
});
hunt('hunt: Drowned Choir band', { id: 'o1', kind: 'cultist', cult: 'yargaleth', roster: [{ type: 'cultist' }, { type: 'cultist' }, { type: 'cultist' }] });
hunt('hunt: Temple of the Gill band', { id: 'o2', kind: 'cultist', cult: 'dagon', roster: [{ type: 'cultist' }, { type: 'cultist' }, { type: 'cultist' }] });
hunt('hunt: crocodile pack (grown)', { id: 'o3', kind: 'beast', family: 'crocodile', roster: [{ type: 'crocodile', grade: 'grown' }, { type: 'crocodile', grade: 'grown' }] });
hunt('hunt: swamp crab pack (grown)', { id: 'o4', kind: 'beast', family: 'swamp_crab', roster: [{ type: 'swamp_crab', grade: 'grown' }, { type: 'swamp_crab', grade: 'grown' }] });
process.exit(0);
