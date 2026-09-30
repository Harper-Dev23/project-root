// server/reactions_test.mjs
//
// Reactions in co-op (owner's notes, 2026-09-29: "reactions are not triggering
// in co-op"). A player's "Prepare Selected" only armed the reactions on their
// own screen, and the server's fight, the one reactions fire in, never heard
// of them. The 'prepareReactions' message carries them there
// (session.prepareReactions). This proves: only the owner may prepare, only
// reactions that hunter can use; and a prepared reaction fires in a real
// server-run fight when the enemy attacks.
//
// Run: node server/reactions_test.mjs

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(4242);

const { createSession, toWireCharacter } = await import('./session.js');
const { makeParty } = await import('../tools/headless/fixtures.js');
const { SKILLS, getReactionSkillsFor } = await import('../data/skills.js');
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

// Stat gates are not what this is about: every reaction is on offer.
globalThis.localStorage?.setItem('dev_breakthrough', 'true');

const wire = makeParty().map(toWireCharacter);
const alice = { id: 'alice', name: 'Alice', hunters: wire.slice(0, 3).map(w => JSON.parse(JSON.stringify(w))) };
const bob = { id: 'bob', name: 'Bob', hunters: wire.slice(3, 6).map(w => JSON.parse(JSON.stringify(w))) };
const session = createSession({ CombatScene, players: [alice, bob], scenarioId: 'training_encounter_4', seed: 4242 });
const host = session.host;
const ref = (u) => host._unitRef(u);

console.log('=== preparing reactions on the server ===');
const aliceUnits = host._party().filter(u => u.ownerId === 'alice');
const bobUnits = host._party().filter(u => u.ownerId === 'bob');
const reactor = [...aliceUnits, ...bobUnits].find(u => getReactionSkillsFor(u).some(s => ['read_and_react', 'cover_strike', 'riposte', 'bedrock_guard', 'aftershock', 'covering_arc'].includes(s.id)));
check('a hunter with a hit reaction to prepare', !!reactor, host._party().map(u => `${u.name}:${getReactionSkillsFor(u).map(s => s.id).join('/')}`).join(' '));
const owner = reactor.ownerId, other = owner === 'alice' ? 'bob' : 'alice';
const picks = getReactionSkillsFor(reactor).map(s => s.id).filter(id => ['read_and_react', 'cover_strike', 'riposte', 'bedrock_guard', 'aftershock', 'covering_arc'].includes(id)).slice(0, 2);

const notYours = session.prepareReactions(other, { actor: ref(reactor), skills: picks });
check("another player cannot prepare someone else's hunter", !notYours.ok && /not yours/.test(notYours.reason), notYours.reason);
const wrong = session.prepareReactions(owner, { actor: ref(reactor), skills: ['not_a_reaction'] });
check('a reaction the hunter cannot use is refused', !wrong.ok, wrong.reason);
const ok = session.prepareReactions(owner, { actor: ref(reactor), skills: picks });
const prepared = host.reactions.listPrepared(reactor).map(s => s.id);
check("the owner's prepared set lands on the server's fight", ok.ok && picks.every(id => prepared.includes(id)), `${picks.join(',')} -> ${prepared.join(',')}`);
check('...and the room is told', (ok.log || []).length > 0);

console.log('');
console.log('=== a prepared reaction fires when the enemy attacks ===');
{
  const fired = () => (host.combatEntries || []).some(e => {
    const t = (e?.segments || []).map(g => g.text).join('') || String(e?.text || e || '');
    return picks.some(id => t.includes(SKILLS[id].name) && !/readies|prepares/.test(t));
  });
  const stateBefore = JSON.stringify(host.reactions.listPrepared(reactor).map(s => s.id));
  let guard = 0;
  while (!host.combatEnded && !fired() && guard++ < 60) {
    const actor = host._currentChar();
    if (!actor || actor.ownerId == null) break;
    // Re-arm after a firing disarms the set, as a player would.
    if (!host.reactions.listPrepared(reactor).length) session.prepareReactions(owner, { actor: ref(reactor), skills: picks });
    const r = session.endTurn(actor.ownerId);
    if (!r.ok) break;
  }
  check('within a few rounds, the reaction fired on the server', fired(), `rounds ${guard}; prepared was ${stateBefore}`);
}

console.log('');
if (failures) { console.log(`reactions: ${failures} FAILED`); process.exit(1); }
console.log('reactions: all passed');
