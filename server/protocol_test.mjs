// @ts-nocheck
// server/protocol_test.mjs
//
// Drives a whole co-op hunt through PROTOCOL MESSAGES only - create, join,
// setHunters, ready, start, act, endTurn - with fake connections instead of
// sockets. If this passes, the WebSocket server has no decisions left to make.
//
// Run: node server/protocol_test.mjs

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(31337);

const { createHub } = await import('./protocol.js');
const { toWireCharacter } = await import('./session.js');
const { makeParty } = await import('../tools/headless/fixtures.js');
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

/** A fake connection: records everything the server sends it. */
function conn(label) {
  return {
    label,
    inbox: [],
    send(msg) { this.inbox.push(msg); },
    last(type) { return [...this.inbox].reverse().find(m => m.t === type) || null; },
    errors() { return this.inbox.filter(m => m.t === 'error').map(m => m.reason); },
    clear() { this.inbox.length = 0; },
  };
}

const roster = makeParty().map(toWireCharacter);
const clone = (n, from = 0) => JSON.parse(JSON.stringify(roster.slice(from, from + n)));

// A fixed code so the test reads deterministically.
const hub = createHub({ CombatScene, codeFactory: () => 'TEST' });
const alice = conn('alice');
const bob = conn('bob');

// ---- lobby -----------------------------------------------------------------
console.log('=== lobby ===');
{
  hub.handle(alice, { t: 'create', name: 'Alice', scenarioId: 'training_encounter_1', hunters: clone(3, 0), seed: 31337 });
  const joined = alice.last('joined');
  check('host created a lobby and got a code', joined?.code === 'TEST', JSON.stringify(joined));

  hub.handle(bob, { t: 'join', code: 'test', name: 'Bob', hunters: clone(3, 3) });
  check('join is case-insensitive on the code', bob.last('joined')?.playerId === 'p2');

  const view = bob.last('lobby');
  check('both players are listed with their hunters',
    view?.players?.length === 2 && view.used === 6, 'used ' + view?.used + '/' + view?.limit);
}

// ---- the shared party budget ----------------------------------------------
console.log('=== the shared six ===');
{
  const carol = conn('carol');
  hub.handle(carol, { t: 'join', code: 'TEST', name: 'Carol', hunters: clone(1, 0) });
  check('a seventh hunter is refused at the door',
    carol.errors().length === 1, carol.errors()[0]);

  // Slice from 0, not 3: the roster is only six long, so clone(4, 3) would
  // silently yield three hunters and test nothing.
  bob.clear();
  hub.handle(bob, { t: 'setHunters', hunters: clone(4, 0) });
  check('and refused when resizing your own party',
    bob.errors().length === 1, bob.errors()[0]);

  bob.clear();
  hub.handle(bob, { t: 'setHunters', hunters: clone(2, 3) });
  check('shrinking your party is allowed', bob.errors().length === 0,
    'used ' + bob.last('lobby')?.used + '/6');

  // Carol can now take the freed slot.
  hub.handle(carol, { t: 'join', code: 'TEST', name: 'Carol', hunters: clone(1, 5) });
  check('a third player takes the freed slot',
    carol.last('joined')?.playerId === 'p3', 'used ' + carol.last('lobby')?.used + '/6');
  hub.disconnect(carol);
}

// ---- starting --------------------------------------------------------------
console.log('=== starting ===');
{
  bob.clear();
  hub.handle(bob, { t: 'start' });
  check('only the host may start', bob.errors()[0] === 'only the host can start', bob.errors()[0]);

  alice.clear();
  hub.handle(alice, { t: 'start' });
  check('cannot start until everyone is ready',
    alice.errors()[0] === 'not everyone is ready', alice.errors()[0]);

  hub.handle(alice, { t: 'ready', ready: true });
  hub.handle(bob, { t: 'ready', ready: true });
  alice.clear(); bob.clear();
  hub.handle(alice, { t: 'start' });

  check('the hunt starts and both players get the board',
    !!alice.last('started') && !!bob.last('started'));
  const s = alice.last('started').state;
  const allies = s.units.filter(u => u.side === 'ally');
  check('the party is Alice 3 + Bob 2 after the resize', allies.length === 5,
    allies.length + ' allies');
  check('every hunter is owned, by one of the two players',
    allies.every(u => u.owner) && new Set(allies.map(u => u.owner)).size === 2,
    [...new Set(allies.map(u => u.owner))].join(' + '));
  check('a human is due to act', s.current?.ownerId != null, s.current?.name);
}

// ---- playing it out --------------------------------------------------------
console.log('=== a hunt, played entirely through messages ===');
{
  const connOf = { p1: alice, p2: bob };
  let turns = 0;
  let over = null;

  while (!over && turns < 300) {
    const state = alice.last('state')?.state || alice.last('started')?.state;
    const cur = state?.current;
    if (!cur || cur.ownerId == null) break;

    const me = connOf[cur.ownerId];
    const foe = state.units.find(u => u.side === 'enemy' && u.hp > 0);

    // The other player trying to act on this turn must be refused.
    if (turns === 0) {
      const other = cur.ownerId === 'p1' ? bob : alice;
      other.clear();
      hub.handle(other, { t: 'act', actor: cur.ref, skill: 'basic_attack', target: foe?.ref });
      check('a player cannot act for someone else\'s hunter',
        other.errors().length === 1, other.errors()[0]);
    }

    if (foe) hub.handle(me, { t: 'act', actor: cur.ref, skill: 'basic_attack', target: foe.ref });
    hub.handle(me, { t: 'endTurn' });
    over = alice.last('over');
    turns++;
  }

  check('the hunt reached a conclusion', !!over, over?.outcome + ' in ' + turns + ' player turns');
  check('both players were told how it ended', !!bob.last('over'));
  check('the outcome names the survivors and the players',
    (over?.survivors?.length ?? 0) > 0 && over?.players?.length === 2,
    (over?.survivors?.length ?? 0) + ' survivors, ' + over?.players?.join(' + '));
}

// ---- disconnects -----------------------------------------------------------
console.log('=== disconnects ===');
{
  const h2 = createHub({ CombatScene, codeFactory: () => 'DROP' });
  const a = conn('a'); const b = conn('b');
  h2.handle(a, { t: 'create', name: 'A', hunters: clone(1, 0) });
  h2.handle(b, { t: 'join', code: 'DROP', name: 'B', hunters: clone(1, 1) });
  h2.disconnect(b);
  check('leaving BEFORE the start frees the seat',
    h2.lobbies.get('DROP').players.length === 1);

  h2.handle(a, { t: 'ready', ready: true });
  h2.handle(a, { t: 'start' });
  h2.disconnect(a);
  check('the lobby is dropped once nobody is connected', !h2.lobbies.has('DROP'));
}

// ---- one live hunt per process ---------------------------------------------
// Not a policy choice: GameState is a module singleton, and a second board in
// the same process makes the FIRST one check the wrong party for deaths. That
// was observed directly — a wiped party kept "fighting" because defeat was
// never detected — so the hub refuses rather than corrupting both fights.
console.log('=== one live hunt per process ===');
{
  const h3 = createHub({ CombatScene, codeFactory: () => 'ONE1' });
  const a = conn('a');
  h3.handle(a, { t: 'create', name: 'A', hunters: clone(1, 0) });
  h3.handle(a, { t: 'ready', ready: true });
  h3.handle(a, { t: 'start' });
  check('the first hunt starts', !!a.last('started'));

  // A second lobby, in the same hub, tries to start while the first is live.
  const h3b = h3;
  const b = conn('b');
  h3b.lobbies.set('TWO2', { code: 'TWO2', scenarioId: 'training_encounter_1', hostId: 'p1', players: [], session: null });
  h3b.handle(b, { t: 'join', code: 'TWO2', name: 'B', hunters: clone(1, 1) });
  h3b.handle(b, { t: 'ready', ready: true });
  b.clear();
  h3b.handle(b, { t: 'start' });
  check('a second concurrent hunt is refused',
    /already running a hunt/.test(b.errors()[0] || ''), b.errors()[0]);
}

// ---- chat and private feedback ---------------------------------------------
console.log('=== chat and private feedback ===');
{
  const h4 = createHub({ CombatScene, codeFactory: () => 'CHAT' });
  const a = conn('a'); const b = conn('b');
  h4.handle(a, { t: 'create', name: 'Ann', hunters: clone(1, 0) });
  h4.handle(b, { t: 'join', code: 'CHAT', name: 'Ben', hunters: clone(1, 1) });

  a.clear(); b.clear();
  h4.handle(a, { t: 'say', text: 'on my way' });
  check('chat reaches the other player', b.last('said')?.text === 'on my way', b.last('said')?.text);
  check('the sender is attributed by the SERVER, not the message',
    b.last('said')?.from === 'Ann', b.last('said')?.from);

  b.clear();
  h4.handle(a, { t: 'say', text: '   ' });
  check('an empty message is not relayed', !b.last('said'));

  // A client must not be able to speak as someone else.
  b.clear();
  h4.handle(a, { t: 'say', text: 'hi', from: 'Ben', name: 'Ben' });
  check('a client cannot forge who it is', b.last('said')?.from === 'Ann',
    b.last('said')?.from);
}

// ---- malformed input -------------------------------------------------------
console.log('=== malformed input ===');
{
  const junk = conn('junk');
  hub.handle(junk, 'not json at all');
  check('malformed JSON is refused, not thrown', junk.errors()[0] === 'malformed message');
  hub.handle(junk, { nope: true });
  check('a message with no type is refused', junk.errors()[1] === 'missing message type');
  hub.handle(junk, { t: 'act' });
  check('acting without a lobby is refused', junk.errors()[2] === 'you are not in a lobby');
  hub.handle(alice, { t: '_seat', hunters: [] });
  check('internal handlers are not reachable from the wire',
    /unknown message/.test(alice.errors().slice(-1)[0] || ''), alice.errors().slice(-1)[0]);
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
