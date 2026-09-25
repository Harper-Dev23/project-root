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

// ---- claiming a slot -------------------------------------------------------
//
// Each player places their OWN hunters and nobody else's. There is no host
// override on purpose: it is what makes the formation ungriefable, and it is
// the only rule here worth getting wrong.
console.log('');
console.log('=== slot claims ===');
{
  const aliceHunters = alice.last('lobby').players.find(p => p.id === 'p1').hunters;
  const bobHunters = alice.last('lobby').players.find(p => p.id === 'p2').hunters;

  check('hunters start unplaced',
    aliceHunters.every(h => h.slotId === null),
    aliceHunters.map(h => h.name + ':' + h.slotId).join(' '));

  alice.clear();
  hub.handle(alice, { t: 'claimSlot', ref: aliceHunters[0].ref, slotId: 3 });
  const placed = alice.last('lobby').players.find(p => p.id === 'p1').hunters;
  check('a player can place their own hunter',
    placed.find(h => h.ref === aliceHunters[0].ref)?.slotId === 3,
    'slot ' + placed.find(h => h.ref === aliceHunters[0].ref)?.slotId);

  bob.clear();
  hub.handle(bob, { t: 'claimSlot', ref: bobHunters[0].ref, slotId: 3 });
  check('a slot someone already holds is refused',
    bob.errors().some(e => /already standing/.test(e)), bob.errors().join(' | '));

  // The one that matters. Fail-closed: asking to move a hunter that is not
  // yours must be REFUSED, not quietly ignored -- silence would read to the
  // caller as success.
  bob.clear();
  hub.handle(bob, { t: 'claimSlot', ref: aliceHunters[1].ref, slotId: 5 });
  check('you cannot place a hunter that is not yours',
    bob.errors().some(e => /not yours/.test(e)), bob.errors().join(' | '));
  check('and it did not move anyway',
    alice.last('lobby').players.find(p => p.id === 'p1')
      .hunters.find(h => h.ref === aliceHunters[1].ref)?.slotId === null);

  alice.clear();
  hub.handle(alice, { t: 'claimSlot', ref: aliceHunters[0].ref, slotId: 99 });
  check('a slot the board does not have is refused',
    alice.errors().some(e => /no such slot/.test(e)), alice.errors().join(' | '));

  alice.clear();
  hub.handle(alice, { t: 'claimSlot', ref: aliceHunters[0].ref, slotId: null });
  check('a hunter can be picked back up',
    alice.last('lobby').players.find(p => p.id === 'p1')
      .hunters.find(h => h.ref === aliceHunters[0].ref)?.slotId === null);

  // Claim it again so the start-of-hunt assertion below has something to prove.
  hub.handle(alice, { t: 'claimSlot', ref: aliceHunters[0].ref, slotId: 6 });
  check('changing the formation un-readies you',
    alice.last('lobby').players.find(p => p.id === 'p1').ready === false);

  // The one that was actually reported as "the slots are sticking". Ticking a
  // hunter in the roster resends the WHOLE list, and rebuilding it from that
  // payload used to wipe every placement anyone had made.
  hub.handle(alice, { t: 'setHunters', hunters: clone(3, 0) });
  check('a roster change does NOT wipe placements already made',
    alice.last('lobby').players.find(p => p.id === 'p1')
      .hunters.find(h => h.ref === aliceHunters[0].ref)?.slotId === 6,
    'slot ' + alice.last('lobby').players.find(p => p.id === 'p1')
      .hunters.find(h => h.ref === aliceHunters[0].ref)?.slotId);

  // ...but a hunter who leaves takes their placement with them, rather than
  // leaving a slot held by somebody who is not coming.
  hub.handle(alice, { t: 'setHunters', hunters: clone(2, 1) });
  const stillHeld = alice.last('lobby').players.find(p => p.id === 'p1')
    .hunters.some(h => h.slotId === 6);
  check('a dropped hunter releases the slot they held', !stillHeld);
  hub.handle(alice, { t: 'setHunters', hunters: clone(3, 0) });
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

// ---- reconnecting to a fight in progress ----------------------------------
//
// All hunt state is in memory, so a dropped socket used to be the end of the
// fight: the seat was held but nothing could reattach to it, and the lobby was
// deleted outright the moment the last connection went away.
console.log('');
console.log('=== reconnecting ===');
{
  const hub2 = createHub({ CombatScene, codeFactory: () => 'RECON', resumeGraceMs: 60 });
  const ann = conn('ann'), bo = conn('bo');
  hub2.handle(ann, { t: 'create', name: 'Ann', scenarioId: 'training_encounter_1',
    hunters: clone(2, 0), clientId: 'ann-browser' });
  hub2.handle(bo, { t: 'join', code: 'RECON', name: 'Bo', hunters: clone(2, 2),
    clientId: 'bo-browser' });
  hub2.handle(ann, { t: 'ready', ready: true });
  hub2.handle(bo, { t: 'ready', ready: true });
  hub2.handle(ann, { t: 'start' });
  check('a hunt is under way', !!ann.last('started'));

  // Bo's laptop lid closes.
  hub2.disconnect(bo);
  check('the seat is held, not freed',
    ann.last('lobby').players.length === 2, ann.last('lobby').players.length + ' players');

  // A STRANGER cannot walk into a started hunt.
  const nosy = conn('nosy');
  hub2.handle(nosy, { t: 'join', code: 'RECON', name: 'Nosy', hunters: clone(1, 4),
    clientId: 'someone-else' });
  check('a stranger still cannot join a started hunt',
    nosy.errors().some(e => /already started/.test(e)), nosy.errors().join(' | '));

  // Bo comes back, same browser, same code. No special "rejoin" flow.
  const bo2 = conn('bo2');
  hub2.handle(bo2, { t: 'join', code: 'RECON', name: 'Bo', hunters: [],
    clientId: 'bo-browser' });
  check('Bo gets his OWN seat back, not a new one',
    bo2.last('joined')?.playerId === 'p2' && bo2.last('joined')?.resumed === true,
    bo2.last('joined')?.playerId + ' resumed=' + bo2.last('joined')?.resumed);
  check('and is handed the fight in progress, board and all',
    !!bo2.last('started')?.state?.units?.length,
    (bo2.last('started')?.state?.units?.length ?? 0) + ' units');
  check('his hunters are still his own on that board',
    bo2.last('started').roster.filter(h => h.ownerId === 'p2').length === 2);
  // Rejoining with empty hunters must not have wiped the party he is fighting with.
  check('reconnecting did NOT replace his party with the empty list he sent',
    ann.last('lobby').players.find(p => p.id === 'p2').hunters.length === 2);

  // A second tab must not steal a live seat.
  const bo3 = conn('bo3');
  hub2.handle(bo3, { t: 'join', code: 'RECON', name: 'Bo', hunters: [],
    clientId: 'bo-browser' });
  check('a second tab cannot steal a seat that is already connected',
    bo3.errors().some(e => /already connected/.test(e)), bo3.errors().join(' | '));

  // Everyone drops. The fight must survive the grace period.
  hub2.disconnect(ann); hub2.disconnect(bo2);
  const backIn = conn('backIn');
  hub2.handle(backIn, { t: 'join', code: 'RECON', name: 'Ann', hunters: [],
    clientId: 'ann-browser' });
  check('a hunt with NOBODY connected is still there to come back to',
    backIn.last('joined')?.resumed === true, backIn.errors().join(' | ') || 'resumed');
  hub2.disconnect(backIn);
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

  // An UNSTARTED lobby with nobody in it is worth nothing and goes at once.
  h2.disconnect(a);
  check('an unstarted lobby is dropped once nobody is connected', !h2.lobbies.has('DROP'));
}

// A STARTED hunt is held instead, so a dropped connection is survivable -- but
// only for a while, or an abandoned fight would hold the one hunt this process
// allows forever.
{
  const h3 = createHub({ CombatScene, codeFactory: () => 'GRACE', resumeGraceMs: 120 });
  const a = conn('a');
  h3.handle(a, { t: 'create', name: 'A', hunters: clone(1, 0), clientId: 'a-browser' });
  h3.handle(a, { t: 'ready', ready: true });
  h3.handle(a, { t: 'start' });
  h3.disconnect(a);
  check('a started hunt is NOT dropped when the last player goes', h3.lobbies.has('GRACE'));

  await new Promise(r => setTimeout(r, 200));
  check('but it is reaped once the grace period passes', !h3.lobbies.has('GRACE'));
}

// Coming back inside the grace period must CANCEL the reap, not merely beat it.
{
  const h4 = createHub({ CombatScene, codeFactory: () => 'BACK', resumeGraceMs: 150 });
  const a = conn('a');
  h4.handle(a, { t: 'create', name: 'A', hunters: clone(1, 0), clientId: 'a-browser' });
  h4.handle(a, { t: 'ready', ready: true });
  h4.handle(a, { t: 'start' });
  h4.disconnect(a);

  const a2 = conn('a2');
  h4.handle(a2, { t: 'join', code: 'BACK', name: 'A', hunters: [], clientId: 'a-browser' });
  check('rejoining inside the grace period works', a2.last('joined')?.resumed === true);

  await new Promise(r => setTimeout(r, 250));
  check('and the pending reap was cancelled, not just outrun', h4.lobbies.has('BACK'),
    h4.lobbies.has('BACK') ? 'still there' : 'DELETED OUT FROM UNDER A LIVE PLAYER');
  h4.disconnect(a2);
}

// A FINISHED hunt is not held at all -- there is nothing to come back to, and
// on a one-hunt-per-process server holding it would block the next fight for
// the whole grace period.
{
  const h5 = createHub({ CombatScene, codeFactory: () => 'DONE', resumeGraceMs: 60000 });
  const a = conn('a');
  h5.handle(a, { t: 'create', name: 'A', hunters: clone(1, 0), clientId: 'a-browser' });
  h5.handle(a, { t: 'ready', ready: true });
  h5.handle(a, { t: 'start' });
  const lobby = h5.lobbies.get('DONE');
  // Drive it to a conclusion the blunt way: the party is wiped.
  lobby.finished = true;
  h5.disconnect(a);
  check('a finished hunt is dropped at once, not held for the grace period',
    !h5.lobbies.has('DONE'));
}

// ---- many live hunts per process -------------------------------------------
// Until chunk 12a the hub refused a second live fight: GameState was a module
// singleton, and a second board made the FIRST one check the wrong party for
// deaths. Each host now owns its party, so a second lobby starts.
// server/concurrent_test.mjs plays two such fights interleaved to the end.
console.log('=== many live hunts per process ===');
{
  const h3 = createHub({ CombatScene, codeFactory: () => 'ONE1' });
  const a = conn('a');
  h3.handle(a, { t: 'create', name: 'A', hunters: clone(1, 0) });
  h3.handle(a, { t: 'ready', ready: true });
  h3.handle(a, { t: 'start' });
  check('the first hunt starts', !!a.last('started'));

  // A second lobby, in the same hub, starts while the first is live.
  const b = conn('b');
  h3.lobbies.set('TWO2', { code: 'TWO2', scenarioId: 'training_encounter_1', hostId: 'p1', players: [], session: null });
  h3.handle(b, { t: 'join', code: 'TWO2', name: 'B', hunters: clone(1, 1) });
  h3.handle(b, { t: 'ready', ready: true });
  b.clear();
  h3.handle(b, { t: 'start' });
  check('a second concurrent hunt starts', !!b.last('started') && !b.errors().length, b.errors()[0] || '');
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

// ---- public lobbies and browsing -------------------------------------------
console.log('=== public lobbies ===');
{
  const h5 = createHub({ CombatScene, codeFactory: () => 'PUB1' });
  const host1 = conn('host1');
  h5.handle(host1, { t: 'create', name: 'Pat', hunters: clone(2, 0), isPublic: true });

  const browser = conn('browser');
  h5.handle(browser, { t: 'browse' });
  const list = browser.last('lobbies')?.lobbies || [];
  check('a public lobby is listed', list.length === 1 && list[0].code === 'PUB1',
    JSON.stringify(list));
  check('the listing says who is hosting and how full it is',
    list[0]?.host === 'Pat' && list[0]?.used === 2 && list[0]?.limit === 6,
    list[0]?.host + ' ' + list[0]?.used + '/' + list[0]?.limit);
  check('browsing works WITHOUT being seated first',
    browser.errors().length === 0, browser.errors()[0] || '');

  // Private is the default, and the host can change their mind.
  const h6 = createHub({ CombatScene, codeFactory: () => 'PRIV' });
  const host2 = conn('host2');
  h6.handle(host2, { t: 'create', name: 'Quinn', hunters: clone(1, 0) });
  const b2 = conn('b2');
  h6.handle(b2, { t: 'browse' });
  check('a lobby is PRIVATE unless the host says otherwise',
    (b2.last('lobbies')?.lobbies || []).length === 0);

  h6.handle(host2, { t: 'setPublic', isPublic: true });
  b2.clear(); h6.handle(b2, { t: 'browse' });
  check('the host can open it up later',
    (b2.last('lobbies')?.lobbies || []).length === 1);

  // A guest must not be able to expose someone else's lobby.
  const guest = conn('guest');
  h6.handle(guest, { t: 'join', code: 'PRIV', name: 'G', hunters: clone(1, 1) });
  guest.clear();
  h6.handle(guest, { t: 'setPublic', isPublic: false });
  check('a guest cannot change who can see the lobby',
    /only the host/.test(guest.errors()[0] || ''), guest.errors()[0]);

  // Started hunts drop off the list: they cannot be joined.
  h6.handle(host2, { t: 'ready', ready: true });
  h6.handle(guest, { t: 'ready', ready: true });
  h6.handle(host2, { t: 'start' });
  b2.clear(); h6.handle(b2, { t: 'browse' });
  check('a hunt already under way is not listed',
    (b2.last('lobbies')?.lobbies || []).length === 0);
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
