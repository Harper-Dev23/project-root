// tools/headless/fightcount.mjs
//
// A fight holds exactly the pack the map shows (co-op playtest item B2: "4
// enemies" after a scout, 5 in the fight). The scouted "Exactly:" line reads
// the occupant's roster; the fight is built from the same roster. Checked on
// real hunts, parties of 2, 4 and 6, on the solo board and on the co-op
// server's board (two players).
//
// Run: node tools/headless/fightcount.mjs
import { installPhaserStub } from './phaserStub.js';
installPhaserStub(7);
const { createMapHunt } = await import('../../src/systems/HuntEngine.js');
const { makeParty, slotMapFor } = await import('./fixtures.js');
const { createCombatHost } = await import('./combatHost.js');
const M = await import('../../src/scenes/CombatScene.js'); const CombatScene = M.default;
const { createSession, huntFightFrom, toWireCharacter } = await import('../../server/session.js');
const { makeRng } = await import('../../src/systems/seededRng.js');

let solo = 0, coop = 0; const bad = [];
for (let seed = 1; seed <= 40; seed++) for (const size of [2, 4, 6]) {
  const party = makeParty().slice(0, size);
  const world = { party: () => party, nightFalls() {}, dayBreaks() {}, awardHuntPoints() {}, bankItems() {} };
  const h = createMapHunt('reeds_of_gethsemane', { plan: { objective: 'cull', size: 'medium', mods: {}, bonusObjectives: [] }, supplies: 300, seed }, world);
  const pick = makeRng(seed);
  for (let i = 0; i < 80 && !h.encounter(); i++) { const v = h.view(); if (v.event) h.leaveEvent(); const mv = h.view().moves; if (!mv.length) break; h.move(mv[Math.floor(pick() * mv.length)].tile); }
  const e = h.encounter(); if (!e) continue;
  const spec = h.fightSpec();
  const want = spec.scenario.enemies.length;
  // Solo board
  const host = createCombatHost(CombatScene);
  host.__begin({ party, partySlots: slotMapFor(party), huntFight: { ...spec, hunt: h } });
  const soloN = (host.enemies || []).length; solo++;
  if (soloN !== want) bad.push(`solo seed ${seed} party ${size}: pack ${want}, board ${soloN}`);
  // Co-op server board (two players)
  const wire = party.map(toWireCharacter);
  const half = Math.ceil(size / 2);
  const players = [{ id: 'p1', hunters: wire.slice(0, half) }, { id: 'p2', hunters: wire.slice(half) }].filter(p => p.hunters.length);
  try {
    const hf = huntFightFrom(JSON.parse(JSON.stringify({ ...spec, zoneId: 'reeds_of_gethsemane' })));
    const s = createSession({ CombatScene, players, huntFight: hf.fight });
    const coopN = s.host.enemies.length; coop++;
    if (coopN !== want) bad.push(`co-op seed ${seed} party ${size}: pack ${want}, board ${coopN}`);
  } catch (err) { bad.push(`co-op seed ${seed}: ${err.message}`); }
}
const ok = solo >= 30 && coop >= 30 && bad.length === 0;
console.log(`  ${ok ? 'PASS' : 'FAIL'}  every fight holds exactly the pack the map shows: ${solo} solo, ${coop} co-op, ${bad.length} differ`
  + (bad.length ? `   ${bad.slice(0, 4).join(' | ')}` : ''));
console.log('\n' + (ok ? 'ALL CHECKS PASSED' : '1 CHECK(S) FAILED'));
process.exit(ok ? 0 : 1);
