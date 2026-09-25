// @ts-nocheck
// server/hunt_test.mjs
//
// A co-op MAP HUNT through protocol messages only (Exploration System v2,
// chunk 12b). The host's side runs a real HuntEngine hunt in this process, as
// the host's browser will; the server stores and relays its snapshots, carries
// guests' moves to it, and runs each fight from the host's beginFight() spec.
//
// What it proves:
//   - a hunt lobby starts the HUNT (no fight): everyone gets the roster
//   - snapshots: host only, versions must go up, stored and relayed to the
//     guests (not echoed to the host), a too-big one refused
//   - moves: a guest's move at the current version reaches the host as an
//     intent; a stale one is refused to the guest only; the host can refuse
//     one back to the asker
//   - a fight from the host's real spec, sent as JSON: the party starts with
//     the map's HP (vitals), the board holds the hunt's own enemies, the hunt
//     is frozen while it is live (moves and snapshots refused)
//   - won: `over` carries huntOutcome 'won' + the vitals; applied to the host's
//     real hunt the kill is recorded; the lobby stays open and moves resume
//   - fled: host only, on the party's turn; outcome 'fled', applied as a flee
//   - wipe: no intercession prompt in co-op (decision 5); outcome 'wipe' with
//     the death rule, applied as the hunt's wipe
//   - two hunt lobbies with live fights at once, each ending on its own
//   - a cultist win's armour crosses the wire and lands in the host's pack
//   - vitals never hand in a hunter at 0 HP (nobody is down on the map)
//   - a guest reconnecting mid-fight gets the roster, the hunt and the fight
//   - a host that misses a fight's end gets it again on resume
//   - the host gone past the grace period ends the hunt for the guests with
//     the last snapshot; a host back in time keeps it going
//   - huntEnd: host only, relays the report, and the lobby is gone
//
// Run: node server/hunt_test.mjs

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(0, { deterministic: false });   // as server/index.js does

const { createHub } = await import('./protocol.js');
const { toWireCharacter, fromWireCharacter } = await import('./session.js');
const { makeParty } = await import('../tools/headless/fixtures.js');
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');
const HE = await import('../src/systems/HuntEngine.js');
const { walkingAway } = await import('../tools/headless/walkAway.js');
const { createMapHunt } = walkingAway({ createMapHunt: HE.createMapHunt, restoreMapHunt: HE.restoreMapHunt });
const { makeRng } = await import('../src/systems/seededRng.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function conn(label) {
  return {
    label, inbox: [],
    send(msg) { this.inbox.push(JSON.parse(JSON.stringify(msg))); },   // as a socket would
    last(type) { return [...this.inbox].reverse().find(m => m.t === type) || null; },
    all(type) { return this.inbox.filter(m => m.t === type); },
    errors() { return this.inbox.filter(m => m.t === 'error').map(m => m.reason); },
    clear() { this.inbox.length = 0; },
  };
}

const roster = makeParty().map(toWireCharacter);
const clone = (n, from = 0) => JSON.parse(JSON.stringify(roster.slice(from, from + n)));

/**
 * The host's side: a real map hunt over the MERGED party (every player's
 * hunters, rebuilt from the roster the server sent), walked until it meets
 * an encounter of `kind`. Returns the hunt and the party it plays with.
 */
function hostHunt(rosterMsg, { kind = 'beast', zoneId = 'reeds_of_gethsemane', from = 100, first = null } = {}) {
  for (let n = from; n < from + 200; n++) {
    const party = rosterMsg.map(w => { const c = fromWireCharacter(w); c.ownerId = w.ownerId; return c; });
    const world = { party: () => party, nightFalls() {}, dayBreaks() {}, awardHuntPoints() {}, bankItems() {} };
    const h = createMapHunt(zoneId, { plan: { objective: 'cull', size: 'medium', mods: {}, bonusObjectives: [] }, supplies: 300, seed: n }, world);
    const pick = makeRng(n);
    for (let i = 0; i < 120; i++) {
      const e = h.encounter();
      if (e) { if (e.kind === kind && (!first || e.first === first)) return { h, party, zoneId }; h.flee(); continue; }
      const mv = h.view().moves; if (!mv.length) break;
      h.move(mv[Math.floor(pick() * mv.length)].tile);
    }
  }
  throw new Error('no ' + kind + ' encounter found');
}
const vitalsOf = (party) => Object.fromEntries(party.map(c => [c.instanceId || c.id, { hp: c.currentHP, mp: c.currentMP, status: c.status }]));
/** The host begins the fight and sends it, as the map scene will. */
function sendFight(hub, hostConn, hh, version) {
  const spec = hh.h.beginFight();
  hub.handle(hostConn, { t: 'huntFight', version, spec: JSON.parse(JSON.stringify({ ...spec, zoneId: hh.zoneId })), vitals: vitalsOf(hh.party) });
  return spec;
}
/** Play the live fight through messages: each owner acts, then ends the turn. */
function playFight(hub, lobby, connOf, { attack = true, maxTurns = 400 } = {}) {
  for (let t = 0; t < maxTurns && lobby.session; t++) {
    const cur = lobby.session.current();
    if (!cur || cur.ownerId == null) break;
    const me = connOf[cur.ownerId];
    const foe = lobby.session.host.enemies.find(e => e.status !== 'incapacitated' && e.currentHP > 0);
    if (attack && foe) hub.handle(me, { t: 'act', actor: cur.ref, skill: 'basic_attack', target: lobby.session.host._unitRef(foe) });
    if (lobby.session) hub.handle(me, { t: 'endTurn' });
  }
}
/** A two-player hunt lobby, started. */
function huntLobby(code, { resumeGraceMs } = {}) {
  const hub = createHub({ CombatScene, codeFactory: () => code, ...(resumeGraceMs ? { resumeGraceMs } : {}) });
  const host = conn('host'), guest = conn('guest');
  hub.handle(host, { t: 'create', mode: 'hunt', name: 'Hana', hunters: clone(3, 0), clientId: 'hana' });
  hub.handle(guest, { t: 'join', code, name: 'Gus', hunters: clone(3, 3), clientId: 'gus' });
  hub.handle(host, { t: 'ready', ready: true });
  hub.handle(guest, { t: 'ready', ready: true });
  hub.handle(host, { t: 'start' });
  return { hub, host, guest, lobby: hub.lobbies.get(code), connOf: { p1: host, p2: guest } };
}

// =============================================================================
console.log('=== a hunt lobby starts the hunt, not a fight ===');
const A = huntLobby('HUNT');
{
  check('the lobby says it is a hunt', A.host.last('lobby')?.mode === 'hunt');
  const hs = A.guest.last('huntStarted');
  check('everyone gets huntStarted with all six hunters, each with its owner',
    !!A.host.last('huntStarted') && hs?.roster.length === 6 && hs.roster.every(h => h.ownerId === 'p1' || h.ownerId === 'p2'));
  check('no fight was started', !A.lobby.session && !A.host.last('started'));
  const late = conn('late');
  A.hub.handle(late, { t: 'join', code: 'HUNT', name: 'Late', hunters: [] });
  check('nobody new can join a hunt under way', /already started/.test(late.errors()[0] || ''));
}

console.log('=== snapshots ===');
// The party opens this one, so the vitals check reads HP before anyone is hit.
const hh = hostHunt(A.host.last('huntStarted').roster, { first: 'party' });
{
  const snap = hh.h.serialize();
  A.guest.clear(); A.host.clear();
  A.hub.handle(A.guest, { t: 'huntSnapshot', version: 1, snapshot: snap });
  check('a guest cannot send the hunt', /only the host/.test(A.guest.errors()[0] || ''));
  A.hub.handle(A.host, { t: 'huntSnapshot', version: 1, snapshot: snap });
  const got = A.guest.last('huntState');
  check('the host\'s snapshot reaches the guest, stored as sent', got?.version === 1 && JSON.stringify(got.snapshot) === JSON.stringify(snap), `${JSON.stringify(snap).length} bytes`);
  check('...and is not echoed back to the host', !A.host.last('huntState') && !A.host.errors().length);
  A.hub.handle(A.host, { t: 'huntSnapshot', version: 1, snapshot: snap });
  check('a snapshot that does not raise the version is refused', /not newer/.test(A.host.errors()[0] || ''));
  A.host.clear();
  A.hub.handle(A.host, { t: 'huntSnapshot', version: 2, snapshot: { junk: 'x'.repeat(600 * 1024) } });
  check('a snapshot over the size limit is refused, and the stored one kept', /limit/.test(A.host.errors()[0] || '') && A.lobby.hunt.version === 1);
}

console.log('=== moves ===');
{
  A.host.clear(); A.guest.clear();
  const tile = hh.h.view().moves[0]?.tile;
  A.hub.handle(A.guest, { t: 'move', tile, version: 1 });
  const intent = A.host.last('moveIntent');
  check('a guest\'s move at the current version reaches the host as an intent', intent?.from === 'p2' && intent.tile === tile && intent.version === 1, JSON.stringify(intent));
  A.hub.handle(A.guest, { t: 'move', tile, version: 0 });
  check('a stale move is refused, to the guest only', /moved on/.test(A.guest.errors()[0] || '') && A.host.all('moveIntent').length === 1);
  A.hub.handle(A.host, { t: 'huntRefuse', to: 'p2', reason: 'that tile is out of reach' });
  check('the host can refuse a move back to the asker', A.guest.errors().includes('that tile is out of reach'));
}

console.log('=== a fight from the host\'s real spec ===');
{
  // The host moved the party onto the encounter earlier (hostHunt); send the
  // current state, then begin the fight at that version. The map left the
  // party hurt: the fight must start there, not at full health.
  hh.party.forEach((c, i) => { c.currentHP = Math.max(1, Math.floor(c.maxHP * (0.4 + i * 0.1))); });
  A.hub.handle(A.host, { t: 'huntSnapshot', version: 2, snapshot: hh.h.serialize() });
  A.host.clear(); A.guest.clear();
  const spec = sendFight(A.hub, A.host, hh, 2);
  const st = A.guest.last('started');
  check('everyone gets the fight, with the hunt\'s spec to build the board', !!A.host.last('started') && st?.huntFight?.scenario?.id === spec.scenario.id, A.host.errors().join('; '));
  const s = A.lobby.session;
  check('the board holds the hunt\'s own enemies', s && s.host.enemies.length === spec.scenario.enemies.length, `${s?.host.enemies.length} of ${spec.scenario.enemies.length}`);
  check('every hunter starts with the HP the map left them (vitals)', s && hh.party.every(c => s.party.find(p => (p.instanceId || p.id) === (c.instanceId || c.id))?.currentHP === c.currentHP));
  check('the party\'s initiative decided who opens, as on the map', s && s.host.turnOrder[0].isEnemy === (spec.first === 'enemy'), spec.first);
  A.guest.clear(); A.host.clear();
  A.hub.handle(A.guest, { t: 'move', tile: 'x', version: 2 });
  A.hub.handle(A.host, { t: 'huntSnapshot', version: 3, snapshot: hh.h.serialize() });
  check('the hunt is frozen while it is live: a move and a snapshot are refused',
    /waits while the fight/.test(A.guest.errors()[0] || '') && /waits while the fight/.test(A.host.errors()[0] || ''));

  // Won: the party is made strong so the checks are about the hand-back.
  for (const u of s.party) { u.maxHP = 9999; u.currentHP = 9999; }
  A.host.clear(); A.guest.clear();
  const occId = hh.h.getState().encounter.occId;
  playFight(A.hub, A.lobby, A.connOf);
  const over = A.host.last('over');
  check('won: everyone is told, with huntOutcome "won" and every hunter\'s vitals', over?.hunt && over.huntOutcome?.result === 'won' && !!A.guest.last('over')
    && Object.keys(over.vitals || {}).length === 6, JSON.stringify(over?.huntOutcome)?.slice(0, 80));
  check('...rewards carry the XP pool, not a scenario XP', over?.rewards?.hunt === true && over.rewards.xpPool === spec.xpPool);
  const won = hh.h.winEncounter({ loot: over.rewards.loot, knockedOut: over.huntOutcome.knockedOut });
  check('applied to the host\'s real hunt, the kill is recorded', won.ok && hh.h.getState().kills.some(k => k.occId === occId));
  check('the lobby is still open, with no fight on', A.hub.lobbies.has('HUNT') && !A.lobby.session && !A.lobby.finished);
  A.hub.handle(A.host, { t: 'huntSnapshot', version: 3, snapshot: hh.h.serialize() });
  A.guest.clear();
  A.hub.handle(A.guest, { t: 'move', tile: hh.h.view().moves[0]?.tile, version: 3 });
  check('moves resume after the fight', !A.guest.errors().length && A.host.last('moveIntent')?.version === 3, A.guest.errors().join('; '));
}

console.log('=== fleeing ===');
{
  const F = huntLobby('FLEE');
  const fh = hostHunt(F.host.last('huntStarted').roster, { from: 200 });
  F.hub.handle(F.host, { t: 'huntSnapshot', version: 1, snapshot: fh.h.serialize() });
  sendFight(F.hub, F.host, fh, 1);
  const s = F.lobby.session;
  for (const u of s.party) { u.maxHP = 9999; u.currentHP = 9999; }
  // To a hunter's turn, so the retreat can be called.
  for (let i = 0; i < 20 && s.current()?.ownerId == null; i++) s.host.__drain();
  F.guest.clear(); F.host.clear();
  F.hub.handle(F.guest, { t: 'flee' });
  check('a guest cannot call the retreat', /only the host/.test(F.guest.errors()[0] || '') && !!F.lobby.session);
  F.hub.handle(F.host, { t: 'flee' });
  const over = F.host.last('over');
  check('the host calls it: the free round plays and the fight ends as fled', over?.huntOutcome?.result === 'fled' && over.outcome === 'fled', JSON.stringify(over?.huntOutcome) + ' ' + F.host.errors().join('; '));
  const tile0 = fh.h.getState().pos;
  const r = fh.h.flee({ knockedOut: over.huntOutcome.knockedOut });
  check('applied to the host\'s hunt as a flee (the encounter cleared)', r.ok !== false && !fh.h.getState().encounter, JSON.stringify(tile0));
}

console.log('=== a cultist fight: its gear crosses the wire into the pack ===');
{
  const C = huntLobby('CULT');
  const ch = hostHunt(C.host.last('huntStarted').roster, { kind: 'cultist', from: 100 });
  C.hub.handle(C.host, { t: 'huntSnapshot', version: 1, snapshot: ch.h.serialize() });
  const spec = sendFight(C.hub, C.host, ch, 1);
  for (const u of C.lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
  playFight(C.hub, C.lobby, C.connOf);
  const over = C.host.last('over');
  const armour = spec.scenario.enemies.flatMap(e => Object.values(e.gear || {}));
  check("won, and the rewards list the cultists' armour", over?.huntOutcome?.result === 'won' && over.rewards.loot.length === armour.length && armour.length > 0,
    `${over?.rewards?.loot?.length} of ${armour.length}`);
  const before = ch.h.getState().pack.found.length;
  ch.h.winEncounter({ loot: over.rewards.loot, knockedOut: over.huntOutcome.knockedOut });
  const found = ch.h.getState().pack.found;
  check('applied by the host, every piece goes into the hunt pack', found.length - before === armour.length
    && armour.every(a => found.some(i => i.id === a.id && i.rarity === a.rarity)));
}

console.log('=== a wipe ===');
{
  const W = huntLobby('WIPE');
  const wh = hostHunt(W.host.last('huntStarted').roster, { from: 300 });
  W.hub.handle(W.host, { t: 'huntSnapshot', version: 1, snapshot: wh.h.serialize() });
  sendFight(W.hub, W.host, wh, 1);
  const s = W.lobby.session;
  for (const u of s.party) u.currentHP = 1;
  for (const e of s.host.enemies) { e.maxHP = 99999; e.currentHP = 99999; }
  playFight(W.hub, W.lobby, W.connOf, { attack: false });
  const over = W.host.last('over');
  check('the fight ends in a wipe, with the region\'s death rule', over?.huntOutcome?.result === 'wipe' && over.huntOutcome.deathRule === wh.h.getState().deathRule,
    JSON.stringify(over?.huntOutcome));
  check('no intercession was offered on the server (co-op v1)', !s.host.__logLines().some(l => /speak for/.test(l)));
  wh.h.wipe();
  check('applied to the host\'s hunt, the hunt is over', wh.h.getState().finished === 'wipe');
  W.host.clear(); W.guest.clear();
  W.hub.handle(W.guest, { t: 'huntEnd', reason: 'wipe' });
  check('a guest cannot end the hunt', /only the host/.test(W.guest.errors()[0] || ''));
  W.hub.handle(W.host, { t: 'huntEnd', reason: 'wipe', report: { note: 'for 12d' } });
  const ended = W.guest.last('huntEnded');
  check('huntEnd: the guest gets the reason and the report, and the lobby is gone', ended?.reason === 'wipe' && ended.report?.note === 'for 12d' && !W.hub.lobbies.has('WIPE'));
}

console.log('=== a Watched wipe on the server ===');
{
  // The death rule travels in the spec. On a Watched wipe the fallen are
  // reported for each client to apply to its OWN hunters (12d); the server
  // puts nobody on its own Slain roster (chunk 12a).
  const GameState = (await import('../src/systems/GameState.js')).default;
  const slain0 = GameState.slain.length;
  const W = huntLobby('WTCH');
  const wh = hostHunt(W.host.last('huntStarted').roster, { from: 300 });
  W.hub.handle(W.host, { t: 'huntSnapshot', version: 1, snapshot: wh.h.serialize() });
  const spec = wh.h.beginFight();
  W.hub.handle(W.host, { t: 'huntFight', version: 1, spec: JSON.parse(JSON.stringify({ ...spec, deathRule: 'watched', zoneId: wh.zoneId })), vitals: vitalsOf(wh.party) });
  const s = W.lobby.session;
  for (const u of s.party) u.currentHP = 1;
  for (const e of s.host.enemies) { e.maxHP = 99999; e.currentHP = 99999; }
  playFight(W.hub, W.lobby, W.connOf, { attack: false });
  const over = W.host.last('over');
  check('the outcome is a wipe under the Watched rule', over?.huntOutcome?.result === 'wipe' && over.huntOutcome.deathRule === 'watched', JSON.stringify(over?.huntOutcome));
  check('...with every hunter\'s status for the clients to apply', Object.values(over?.vitals || {}).length === 6 && Object.values(over.vitals).every(v => v.status === 'dead'),
    Object.values(over?.vitals || {}).map(v => v.status).join(','));
  check('the server put nobody on its own Slain roster', GameState.slain.length === slain0);
}

console.log('=== two hunt fights at once in one hub ===');
{
  let i = 0;
  const hub = createHub({ CombatScene, codeFactory: () => ['TWO1', 'TWO2'][i++] });
  const mk = (code) => {
    const h = conn(code), g = conn(code + 'g');
    hub.handle(h, { t: 'create', mode: 'hunt', name: 'H', hunters: clone(2, 0) });
    hub.handle(g, { t: 'join', code, name: 'G', hunters: clone(2, 2) });
    hub.handle(h, { t: 'ready', ready: true }); hub.handle(g, { t: 'ready', ready: true });
    hub.handle(h, { t: 'start' });
    return { host: h, guest: g, lobby: hub.lobbies.get(code), connOf: { p1: h, p2: g } };
  };
  const one = mk('TWO1'), two = mk('TWO2');
  const h1 = hostHunt(one.host.last('huntStarted').roster, { from: 100 });
  const h2 = hostHunt(two.host.last('huntStarted').roster, { from: 300 });
  hub.handle(one.host, { t: 'huntSnapshot', version: 1, snapshot: h1.h.serialize() });
  hub.handle(two.host, { t: 'huntSnapshot', version: 1, snapshot: h2.h.serialize() });
  sendFight(hub, one.host, h1, 1);
  sendFight(hub, two.host, h2, 1);
  check('both fights are live at once', !!one.lobby.session && !!two.lobby.session, one.host.errors().concat(two.host.errors()).join('; '));
  for (const u of one.lobby.session.party) u.currentHP = 1;
  for (const e of one.lobby.session.host.enemies) { e.maxHP = 99999; e.currentHP = 99999; }
  for (const u of two.lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
  for (let t = 0; t < 400 && (one.lobby.session || two.lobby.session); t++) {
    playFight(hub, one.lobby, one.connOf, { attack: false, maxTurns: 1 });
    playFight(hub, two.lobby, two.connOf, { maxTurns: 1 });
  }
  check('the first ends in its wipe, the second in its win', one.host.last('over')?.huntOutcome?.result === 'wipe' && two.host.last('over')?.huntOutcome?.result === 'won',
    `${one.host.last('over')?.huntOutcome?.result} / ${two.host.last('over')?.huntOutcome?.result}`);
}

console.log('=== vitals keep every hunter on their feet ===');
{
  // Nobody is ever down on the map, so a 0 handed in stands at 1 HP rather
  // than sitting in the turn order unable to act (a fight could open on an
  // unconscious hunter's turn, found writing this test).
  const V = huntLobby('VITL');
  const vh = hostHunt(V.host.last('huntStarted').roster, { from: 100, first: 'party' });
  vh.party[0].currentHP = 0; vh.party[0].status = 'incapacitated';
  V.hub.handle(V.host, { t: 'huntSnapshot', version: 1, snapshot: vh.h.serialize() });
  sendFight(V.hub, V.host, vh, 1);
  const c = V.lobby.session.party.find(p => (p.instanceId || p.id) === (vh.party[0].instanceId || vh.party[0].id));
  check('a hunter handed in at 0 HP stands at 1, able to act', c.currentHP === 1 && c.status !== 'incapacitated', c.currentHP + ' ' + c.status);
  check('the fight does not open on a hunter who cannot act', !V.lobby.session.party.some(p => p.status === 'incapacitated'));
}

console.log('=== reconnecting ===');
{
  const R = huntLobby('BACK');
  const rh = hostHunt(R.host.last('huntStarted').roster, { from: 100 });
  R.hub.handle(R.host, { t: 'huntSnapshot', version: 1, snapshot: rh.h.serialize() });
  sendFight(R.hub, R.host, rh, 1);

  R.hub.disconnect(R.guest);
  const back = conn('guest2');
  R.hub.handle(back, { t: 'join', code: 'BACK', name: 'Gus', hunters: [], clientId: 'gus' });
  check('a guest back mid-fight gets the roster, the hunt and the fight',
    back.last('joined')?.resumed && !!back.last('huntStarted') && back.last('huntState')?.version === 1 && !!back.last('started')?.huntFight?.scenario);
  R.connOf.p2 = back;

  // The host's socket goes quiet (half-open: its messages still arrive, but
  // nothing reaches it), the fight is won, then the drop is noticed.
  for (const u of R.lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
  R.host.send = () => { throw new Error('socket closed'); };
  playFight(R.hub, R.lobby, R.connOf);
  check('the fight ends; the guest hears it', !R.lobby.session && back.last('over')?.huntOutcome?.result === 'won');
  R.hub.disconnect(R.host);
  const host2 = conn('host2');
  R.hub.handle(host2, { t: 'join', code: 'BACK', name: 'Hana', hunters: [], clientId: 'hana' });
  check('the returning host is told how the fight ended (it missed it)', host2.last('over')?.huntOutcome?.result === 'won');
  R.hub.handle(host2, { t: 'huntSnapshot', version: 2, snapshot: rh.h.serialize() });
  const host3 = conn('host3');
  R.hub.disconnect(host2);
  R.hub.handle(host3, { t: 'join', code: 'BACK', name: 'Hana', hunters: [], clientId: 'hana' });
  check('...but not again once it sent its next snapshot', !host3.last('over') && host3.last('huntState')?.version === 2);
}

console.log('=== the host gone ===');
{
  const G = huntLobby('GONE', { resumeGraceMs: 30 });
  const gh = hostHunt(G.host.last('huntStarted').roster, { from: 100 });
  G.hub.handle(G.host, { t: 'huntSnapshot', version: 1, snapshot: gh.h.serialize() });
  G.hub.disconnect(G.host);
  await wait(10);
  check('within the grace period the hunt holds', G.hub.lobbies.has('GONE') && !G.guest.last('huntEnded'));
  await wait(60);
  const ended = G.guest.last('huntEnded');
  check('past it, the guests get huntEnded "host_gone" with the last snapshot', ended?.reason === 'host_gone' && ended.version === 1 && !!ended.snapshot);
  check('...and the lobby is gone', !G.hub.lobbies.has('GONE'));

  const K = huntLobby('KEEP', { resumeGraceMs: 30 });
  K.hub.disconnect(K.host);
  await wait(10);
  K.hub.handle(conn('hostback'), { t: 'join', code: 'KEEP', name: 'Hana', hunters: [], clientId: 'hana' });
  await wait(60);
  check('a host back in time keeps the hunt going', K.hub.lobbies.has('KEEP') && !K.guest.last('huntEnded'));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
