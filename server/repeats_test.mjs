// server/repeats_test.mjs
//
// Repeats in co-op (owner's question, 2026-09-30): a skill's own repeat
// (repeatChance, e.g. Galvanic Touch against a Zapped target) and Rune
// Channel's recast are both scheduled on the scene's clock a beat after the
// hit. In co-op the SERVER's board runs them, and a session action drains
// that clock before it answers, so both must land in the same answer the
// players get: in its log, its events and its state.
//
// Run: node server/repeats_test.mjs

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(4242);

const { createSession, toWireCharacter } = await import('./session.js');
const { makeParty } = await import('../tools/headless/fixtures.js');
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
globalThis.localStorage?.setItem('dev_breakthrough', 'true');
const text = (e) => (e?.segments || []).map(g => g.text).join('') || String(e?.text || e || '');

/** A two-player session, run until Wren (Alice's staff user) is up. */
function atWren() {
  const wire = makeParty().map(toWireCharacter);
  const alice = { id: 'alice', name: 'Alice', hunters: wire.slice(0, 3).map(w => JSON.parse(JSON.stringify(w))) };
  const bob = { id: 'bob', name: 'Bob', hunters: wire.slice(3, 6).map(w => JSON.parse(JSON.stringify(w))) };
  const session = createSession({ CombatScene, players: [alice, bob], scenarioId: 'training_encounter_4', seed: 4242 });
  const host = session.host;
  for (let i = 0; i < 40 && !host.combatEnded; i++) {
    const a = host._currentChar();
    if (a?.name === 'Wren') break;
    if (!a || a.ownerId == null) break;
    session.endTurn(a.ownerId);
  }
  const wren = host._currentChar();
  const enemy = host.enemies.find(e => e.currentHP > 0);
  // Zapped, meter full: Galvanic Touch's repeat chance is its 40% cap.
  enemy.weakness = enemy.weakness || { meters: {}, tiers: {} };
  enemy.weakness.tiers.lightning = 1;
  enemy.weakness.meters.lightning = 400;
  enemy.maxHP = enemy.currentHP = 5000;
  wren.currentMP = wren.maxMP = 99;
  return { session, host, wren, enemy };
}

/** Act with every die forced low (the hit lands, the repeat or recast fires). */
function cast(S) {
  const real = Math.random;
  Math.random = () => 0.001;
  try {
    const hp0 = S.enemy.currentHP;
    const r = S.session.act('alice', { actor: S.host._unitRef(S.wren), skill: 'galvanic_touch', target: S.host._unitRef(S.enemy) });
    return { r, lost: hp0 - S.enemy.currentHP, lines: (r.log || []).map(text) };
  } finally { Math.random = real; }
}

console.log('=== a skill\'s own repeat (Galvanic Touch on a Zapped target) ===');
{
  const S = atWren();
  check('Wren (Alice\'s) is up, with a Zapped enemy to touch', S.wren?.name === 'Wren' && S.wren.ownerId === 'alice');
  const { r, lost, lines } = cast(S);
  const hits = lines.filter(l => /Galvanic Touch/.test(l) && /damage|hits/.test(l)).length;
  check('the cast is accepted', r.ok, r.reason || '');
  check('the repeat fires on the server, in the same answer', lines.some(l => /repeats!/.test(l)), lines.slice(0, 6).join(' | '));
  check('...and its damage is on the board the players are sent', lost > 0 && r.state?.units?.some(u => u.hp === S.enemy.currentHP), `${lost} damage`);
  check('...recorded as events for the clients to replay', (r.events || []).length > 0, `${(r.events || []).length} events, ${hits} hit lines`);
}

console.log('=== Rune Channel\'s recast ===');
{
  const S = atWren();
  S.wren.statusEffects = [...(S.wren.statusEffects || []), { id: 'runic_zone', name: 'Runic Zone', turns: 3, mods: { runeChannel: true } }];
  const { r, lines } = cast(S);
  check('the recast fires on the server, in the same answer', r.ok && lines.some(l => /rune channel recasts/i.test(l)), lines.slice(0, 8).join(' | '));
}

console.log('');
if (failures) { console.log(`repeats: ${failures} FAILED`); process.exit(1); }
console.log('repeats: all passed');
