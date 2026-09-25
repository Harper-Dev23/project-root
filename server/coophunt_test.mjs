// @ts-nocheck
// server/coophunt_test.mjs
//
// A co-op map hunt end to end on the CLIENT side (Exploration System v2, chunk
// 12c): the real CoopHunt controller on a host and a guest, each on the real
// CoopClient, talking to the real hub through an in-memory socket (every
// message JSON-encoded and delivered a tick later, in order, as a socket
// would). hunt_test.mjs proves the server; this proves what the game ships.
//
// What it proves:
//   - the host departs and the guest sees the SAME map (view() identical)
//   - a guest's move goes to the host, the hunt takes it, and both views agree;
//     a stale move and a move the hunt refuses come back to the guest only
//   - an encounter shows on the guest as it is (the view-only restore does not
//     resolve it as a flee, which a reload does)
//   - a fight: both sides are told, the hunt is frozen, the fight is played
//     through messages, and the host applies the win: the kill, the Hunt
//     Points and the XP pool land in the ledger, and the guest's copy agrees
//   - the ledger is the whole save-side record; nothing touched a save
//   - a wipe ends the hunt by itself: the fallen go in the ledger, the guest
//     gets huntEnded with the report
//   - a guest back in a new tab rebuilds the same hunt from the server
//   - the host gone: the guest ends with the last snapshot's ledger
//
// Run: node server/coophunt_test.mjs

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(0, { deterministic: false });

const { createHub } = await import('./protocol.js');
const { createCoopClient } = await import('../src/systems/CoopClient.js');
const { createCoopHunt, LEDGER_VERBS } = await import('../src/systems/CoopHunt.js');
const { toWireCharacter } = await import('../src/systems/CoopWire.js');
const { makeParty } = await import('../tools/headless/fixtures.js');
const { makeRng } = await import('../src/systems/seededRng.js');
const GameState = (await import('../src/systems/GameState.js')).default;
const ProgressionManager = (await import('../src/systems/ProgressionManager.js')).default;
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const tick = () => new Promise(r => setImmediate(r));
async function until(fn, label, rounds = 4000) {
  for (let i = 0; i < rounds; i++) { if (fn()) return true; await tick(); }
  throw new Error('timed out waiting for ' + label);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A WebSocket that is really the hub, in this process. */
function socketsFor(hub) {
  return class HubSocket {
    constructor() {
      this.readyState = 0;
      this._l = {};
      this.conn = { send: (m) => { const data = JSON.stringify(m); setImmediate(() => this._emit('message', { data })); } };
      setImmediate(() => { this.readyState = 1; this._emit('open', {}); });
    }
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
    _emit(t, e) { for (const fn of this._l[t] || []) fn(e); }
    send(s) { setImmediate(() => hub.handle(this.conn, s)); }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      hub.disconnect(this.conn);
      setImmediate(() => this._emit('close', {}));
    }
  };
}

const roster = makeParty().map(toWireCharacter);
const clone = (n, from = 0) => JSON.parse(JSON.stringify(roster.slice(from, from + n)));
// The host's save, for the engine's reads. A stub: this test is about the wire.
const reads = { followedHouse: () => null, houseHolder: () => null, ownTribe: () => 'zafaar', tribeName: (t) => t, hasQuestFlag: () => false };

/** Seat a host and a guest in a started hunt lobby; return both controllers. */
async function setup(code, { resumeGraceMs } = {}) {
  const hub = createHub({ CombatScene, codeFactory: () => code, ...(resumeGraceMs ? { resumeGraceMs } : {}) });
  const WS = socketsFor(hub);
  const hostC = createCoopClient({ url: 'mem://', WebSocketImpl: WS });
  const guestC = createCoopClient({ url: 'mem://', WebSocketImpl: WS });
  await hostC.connect(); await guestC.connect();
  // Explicit client ids: in Node there is no sessionStorage, and the ids are
  // what a returning tab reclaims its seat with.
  hostC.send({ t: 'create', mode: 'hunt', name: 'Hana', hunters: clone(3, 0), clientId: code + '-host' });
  await until(() => hostC.code, 'the host seated');
  guestC.send({ t: 'join', code, name: 'Gus', hunters: clone(3, 3), clientId: code + '-guest' });
  await until(() => guestC.playerId, 'the guest seated');
  hostC.setReady(true); guestC.setReady(true);
  await until(() => hostC.lobby?.players?.every(p => p.ready), 'both ready');
  hostC.startHunt();
  await until(() => hostC.status === 'hunting' && guestC.status === 'hunting', 'huntStarted');
  const host = createCoopHunt({ client: hostC, reads });
  const guest = createCoopHunt({ client: guestC });
  return { hub, WS, hostC, guestC, host, guest, lobby: hub.lobbies.get(code) };
}

/** Walk the host's hunt (as the host clicking) until it meets an encounter. */
async function walkToEncounter(S, seed, kind = 'beast') {
  const pick = makeRng(seed);
  for (let i = 0; i < 150; i++) {
    const v = S.host.view();
    if (v.encounter) { if (v.encounter.kind === kind) return v.encounter; return null; }
    if (v.event) { S.host.act(h => h.leaveEvent()); continue; }
    if (v.spoils) { S.host.act(h => h.harvest({ take: [], meat: false })); continue; }
    const mv = v.moves; if (!mv.length) return null;
    S.host.move(mv[Math.floor(pick() * mv.length)].tile);
  }
  return null;
}
/** A host whose walk meets the wanted encounter, trying seeds in turn. */
async function departToEncounter(code, kind, from, opts) {
  for (let seed = from; seed < from + 60; seed++) {
    const S = await setup(code + seed, opts);
    S.host.begin({ zoneId: 'reeds_of_gethsemane', plan: { objective: 'cull', size: 'medium', mods: {}, bonusObjectives: [] }, supplies: 300, seed });
    if (await walkToEncounter(S, seed, kind)) return S;
    S.hostC.disconnect(); S.guestC.disconnect();
  }
  throw new Error('no ' + kind + ' encounter');
}
/** Play the live fight through the clients, each owner on its own turn. */
async function playFight(S, { attack = true } = {}) {
  const byOwner = { [S.hostC.playerId]: S.hostC, [S.guestC.playerId]: S.guestC };
  for (let t = 0; t < 600 && S.lobby.session; t++) {
    const cur = S.lobby.session.current();
    if (!cur || cur.ownerId == null) { await tick(); continue; }
    const c = byOwner[cur.ownerId];
    const foe = (c.state?.units || []).find(u => u.side === 'enemy' && u.hp > 0);
    const version = c.state?.version;
    if (attack && foe) { c.act({ actor: cur.ref, skill: 'basic_attack', target: foe.ref }); await until(() => !S.lobby.session || c.state?.version > version, 'the act'); }
    if (!S.lobby.session) break;
    const v2 = c.state?.version;
    c.lastError = null;
    c.endTurn();
    await until(() => !S.lobby.session || c.state?.version > v2 || c.lastError, 'the end of turn');
    if (c.lastError) throw new Error(`endTurn refused for ${cur.name}: ${c.lastError}`);
  }
}

// What the saves hold before anything: none of it may move (12d applies).
const saveBefore = JSON.stringify({ hp: ProgressionManager.huntPoints, inv: GameState.inventory.length, days: ProgressionManager.getDaysElapsed?.() });

// =============================================================================
console.log('=== the host departs; the guest sees the same map ===');
const S = await departToEncounter('ONE', 'beast', 100);
{
  await until(() => S.guest.version === S.host.version, 'the guest caught up');
  check('the guest\'s view is the host\'s, field for field', same(S.guest.view(), S.host.view()), `version ${S.host.version}`);
  const e = S.guest.view().encounter;
  check('an encounter shows on the guest as it is (not resolved as a flee)', !!e && e.occId === S.host.view().encounter.occId);
  S.guest.move(S.guest.view().moves[0]?.tile ?? S.guest.view().pos);
  await until(() => S.guestC.lastError, 'the refusal');
  check('a guest\'s move into a pending encounter is refused by the hunt, to the guest', /fight|encounter|win it or flee/i.test(S.guestC.lastError || ''), S.guestC.lastError);
}

console.log('=== a fight, and the host applies the win ===');
{
  const occId = S.host.view().encounter.occId;
  const ledger0 = S.host.ledger.length;
  let told = 0;
  S.host.on('fight', () => told++); S.guest.on('fight', () => told++);
  let overMsg = null;
  S.host.on('fightOver', (m) => { overMsg = m; });
  const r = S.host.fight();
  check('the host starts it', r.ok, r.reason);
  await until(() => told === 2, 'both told of the fight');
  check('both sides are told, with the hunt\'s scenario', S.guest.fighting?.scenario?.id === r.spec.scenario.id);
  check('the hunt is frozen on the host while it is live', /waits while the fight/.test(S.host.act(h => h.view()).reason || ''));
  for (const u of S.lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
  await playFight(S);
  await until(() => S.guest.version === S.host.version && !S.host.fighting, 'the outcome published');
  const st = S.host.hunt.getState();
  check('applied by the host: the kill is recorded, the encounter gone', st.kills.some(k => k.occId === occId) && !st.encounter);
  const added = S.host.ledger.slice(ledger0).map(e => e.verb);
  check('the Hunt Points and the fight\'s XP pool are in the ledger', added.includes('awardHuntPoints') && added.includes('awardXP'), added.join(','));
  check('the guest\'s copy agrees, ledger included', same(S.guest.view(), S.host.view()) && same(S.guest.ledger, S.host.ledger));
  check('every hunter came back with the HP the fight left them, on both sides',
    !!overMsg && S.host.party.every(c => c.currentHP === overMsg.vitals[c.instanceId || c.id]?.hp)
    && same(S.guest.party.map(c => c.currentHP), S.host.party.map(c => c.currentHP)));
}

console.log('=== moves ===');
{
  let v = S.host.view();
  if (v.spoils) { S.host.act(h => h.harvest({ take: [], meat: false })); v = S.host.view(); }
  if (v.event) { S.host.act(h => h.leaveEvent()); v = S.host.view(); }
  await until(() => S.guest.version === S.host.version, 'caught up');
  const tile = S.guest.view().moves[0].tile;
  const before = S.host.version;
  S.guest.move(tile);
  await until(() => S.guest.version > before, 'the move published');
  check('a guest\'s move is taken by the host\'s hunt, and both views agree', S.host.view().pos === tile && same(S.guest.view(), S.host.view()), tile);
  S.guestC.lastError = null;
  S.guestC.move(S.guest.view().moves[0].tile, S.guest.version - 1);
  await until(() => S.guestC.lastError, 'the stale refusal');
  check('a stale move is refused back to the guest', /moved on/.test(S.guestC.lastError));
  check('only the host acts: a guest\'s other actions are refused locally', /only the host/.test(S.guest.act().reason) && /only the host/.test(S.guest.fight().reason));
}

console.log('=== nothing touched a save ===');
{
  check('Hunt Points, the bag and the calendar are as they were', JSON.stringify({ hp: ProgressionManager.huntPoints, inv: GameState.inventory.length, days: ProgressionManager.getDaysElapsed?.() }) === saveBefore);
  check('every ledger entry is a known save-side verb', S.host.ledger.every(e => LEDGER_VERBS.includes(e.verb) || e.verb === 'fell'));
}

console.log('=== the host\'s world ===');
{
  const { hostWorld } = await import('../src/systems/CoopHunt.js');
  const led = [];
  const w = hostWorld([], { hasQuestFlag: (f) => f === 'in_the_save' }, led);
  w.awardHuntPoints(5);
  check('a save-side call is recorded in the ledger, not applied', same(led, [{ verb: 'awardHuntPoints', args: [5] }]));
  check('a quest flag reads the host\'s save', w.hasQuestFlag('in_the_save') === true && w.hasQuestFlag('eel_catcher_owed') === false);
  w.questFlag('eel_catcher_owed', true);
  check('...and a flag set earlier in THIS hunt is seen (the eel-catcher\'s return reads its request)', w.hasQuestFlag('eel_catcher_owed') === true);
  w.questFlag('in_the_save', false);
  check('...and one cleared in this hunt reads as cleared', w.hasQuestFlag('in_the_save') === false);
}

console.log('=== a guest back in a new tab ===');
{
  S.guestC.disconnect();          // the old tab is closed
  await tick();
  const again = createCoopClient({ url: 'mem://', WebSocketImpl: S.WS });
  await again.connect();
  again.send({ t: 'join', code: S.hostC.code, name: 'Gus', hunters: [], clientId: S.hostC.code + '-guest' });
  await until(() => again.hunt?.version === S.host.version, 'the resumed snapshot');
  const back = createCoopHunt({ client: again });
  check('it rebuilds the same hunt from the server', same(back.view(), S.host.view()) && same(back.ledger, S.host.ledger));
}

console.log('=== a wipe ends the hunt by itself ===');
{
  const W = await departToEncounter('WIP', 'beast', 300);
  await until(() => W.guest.version === W.host.version, 'caught up');
  let ended = null;
  W.guest.on('ended', (m) => { ended = m; });
  W.host.fight();
  // Both CLIENTS must have the fight, not just the server: the turns are
  // played through them.
  await until(() => W.host.fighting && W.guest.fighting, 'the fight');
  for (const u of W.lobby.session.party) u.currentHP = 1;
  for (const e of W.lobby.session.host.enemies) { e.maxHP = 99999; e.currentHP = 99999; }
  await playFight(W, { attack: false });
  await until(() => ended, 'huntEnded');
  check('the host\'s hunt is over by the wipe', W.host.view().finished === 'wipe');
  check('the guest gets huntEnded "wipe" with the report', ended.reason === 'wipe' && ended.report?.finished === 'wipe' && Array.isArray(ended.report.ledger));
  check('the fallen are in the ledger, under the death rule', ended.report.ledger.some(e => e.verb === 'fell' && e.args[0] === W.host.hunt.getState().deathRule), JSON.stringify(ended.report.ledger.find(e => e.verb === 'fell')));
}

console.log('=== the host gone ===');
{
  const G = await setup('GONE', { resumeGraceMs: 30 });
  G.host.begin({ zoneId: 'reeds_of_gethsemane', plan: { objective: 'scout', size: 'small', mods: {}, bonusObjectives: [] }, supplies: 100, seed: 5 });
  const v = G.host.view();
  if (v.moves.length) G.host.move(v.moves[0].tile);
  await until(() => G.guest.version === G.host.version, 'caught up');
  const ledger = JSON.stringify(G.host.ledger);
  let ended = null;
  G.guest.on('ended', (m) => { ended = m; });
  G.hostC.disconnect();
  await new Promise(r => setTimeout(r, 80));
  await until(() => ended, 'host_gone');
  check('the guest ends "host_gone", holding the last snapshot\'s ledger', ended.reason === 'host_gone' && JSON.stringify(G.guest.ledger) === ledger && !!G.guest.view());
}

S.hostC.disconnect(); S.guestC.disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
