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
const { fromWireCharacter } = await import('../src/systems/CoopWire.js');
const { makeStack, stackQty } = await import('../src/systems/ItemStacks.js');
const { xpShare } = await import('../data/xpTable.js');
const { Items } = await import('../data/items.js');
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
/**
 * One player's SAVE, as a take-home target (CoopRewards.applyTakeHome): their
 * own hunters (separate objects from the hunt's copies, as a real save's are)
 * and a world that records what it is paid. Two of these stand in for two
 * players' saves, which one Node process cannot otherwise hold.
 */
function saveFor(from, ownTribe) {
  const chars = clone(3, from).map(w => fromWireCharacter(w));
  const got = { huntPoints: 0, found: [], brought: [], days: 0, nights: 0, favor: [], rep: [], slain: [], flags: [] };
  const world = {
    nightFalls() { got.nights++; }, dayBreaks() { got.days++; },
    awardHuntPoints(n) { got.huntPoints += n; },
    bankItems(items, { found }) { (found ? got.found : got.brought).push(...items); },
    favor(...a) { got.favor.push(a); }, falseGod() {}, bond() {}, rivalDevotion() {},
    tribeRep(t, n) { got.rep.push([t, n]); }, questFlag(...a) { got.flags.push(a); }, lore() {},
    ownTribe: () => ownTribe,
  };
  const rec = {};
  return {
    chars, got, world,
    hunter: (ref) => chars.find(c => (c.instanceId || c.id) === ref) || null,
    awardXPTo: (cs, n) => GameState.awardXPTo(cs, n),
    moveToSlain: (c, fell) => { got.slain.push({ name: c.name, fell }); },
    day: () => 1, record: () => rec, save() {},
    active: null,
    remember(r) { this.active = JSON.parse(JSON.stringify(r)); }, forget() { this.active = null; },
  };
}

async function setup(code, { resumeGraceMs, rations = [0, 0] } = {}) {
  const hub = createHub({ CombatScene, codeFactory: () => code, ...(resumeGraceMs ? { resumeGraceMs } : {}) });
  const WS = socketsFor(hub);
  const hostC = createCoopClient({ url: 'mem://', WebSocketImpl: WS });
  const guestC = createCoopClient({ url: 'mem://', WebSocketImpl: WS });
  await hostC.connect(); await guestC.connect();
  // Explicit client ids: in Node there is no sessionStorage, and the ids are
  // what a returning tab reclaims its seat with.
  hostC.send({ t: 'create', mode: 'hunt', name: 'Hana', hunters: clone(3, 0), clientId: code + '-host' });
  await until(() => hostC.code, 'the host seated');
  hostC.clientId = code + '-host';      // as joinLobby records it
  guestC.send({ t: 'join', code, name: 'Gus', hunters: clone(3, 3), clientId: code + '-guest' });
  await until(() => guestC.playerId, 'the guest seated');
  guestC.clientId = code + '-guest';
  if (rations[0]) hostC.setRations(rations[0]);
  if (rations[1]) guestC.setRations(rations[1]);
  hostC.setReady(true); guestC.setReady(true);
  await until(() => hostC.lobby?.players?.every(p => p.ready) && hostC.lobby.players.every((p, i) => (p.rations || 0) === rations[i]), 'both ready');
  hostC.startHunt();
  await until(() => hostC.status === 'hunting' && guestC.status === 'hunting', 'huntStarted');
  const hostSave = saveFor(0, 'zafaar'), guestSave = saveFor(3, 'elseth');
  const host = createCoopHunt({ client: hostC, reads, target: hostSave });
  const guest = createCoopHunt({ client: guestC, target: guestSave });
  return { hub, WS, hostC, guestC, host, guest, hostSave, guestSave, lobby: hub.lobbies.get(code) };
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
async function departToEncounter(code, kind, from, opts = {}) {
  for (let seed = from; seed < from + 60; seed++) {
    const S = await setup(code + seed, opts);
    const own = opts.rations?.[0] || 0;
    S.host.begin({ zoneId: 'reeds_of_gethsemane', plan: { objective: 'cull', size: 'medium', mods: {}, bonusObjectives: [] },
      supplies: 60 + own * (Items.rations?.supply ?? 1), bring: own ? [makeStack('rations', own)] : [], seed });
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

// =============================================================================
// Chunk 12d: what each save takes home (COOP_EXPLORATION's seven rules).
const { mapNeighbors } = await import('../src/systems/HuntMapGen.js');
const { isPassable } = await import('../data/grounds.js');
const { exitReward } = await import('../src/systems/HuntObjectives.js');
const { ZONES } = await import('../data/zones.js');
const K = Items.rations?.supply ?? 1;
const ledgerSum = (led, verb) => led.filter(e => e.verb === verb).reduce((t, e) => t + (e.args[0] || 0), 0);
const ids = (items) => items.map(i => i.id + '/' + (i.rarity || '') + '/' + stackQty(i)).sort();
const qtyOf = (items) => items.filter(i => i.id === 'rations').reduce((t, i) => t + stackQty(i), 0);
/** Walk the host to the nearest exit tile, fleeing anything met, then leave. */
function walkOut(S) {
  for (let i = 0; i < 400; i++) {
    const v = S.host.view();
    if (v.finished) return true;
    if (v.encounter) { S.host.act(h => h.flee()); continue; }
    if (v.event) { S.host.act(h => h.leaveEvent()); continue; }
    if (v.spoils) { S.host.act(h => h.harvest({ take: [], meat: false })); continue; }
    const st = S.host.hunt.getState();
    if (st.map.tiles[st.pos].exit) { S.host.act(h => h.exit()); continue; }
    const prev = new Map([[st.pos, null]]); const q = [st.pos]; let g = null;
    for (let k = 0; k < q.length && !g; k++) for (const n of mapNeighbors(st.map, q[k])) {
      if (prev.has(n) || !isPassable(st.map.tiles[n])) continue; prev.set(n, q[k]); q.push(n); if (st.map.tiles[n].exit) { g = n; break; } }
    if (!g) return false;
    let t = g; while (prev.get(t) !== st.pos) t = prev.get(t);
    S.host.move(t);
  }
  return false;
}

console.log('=== 12d: Rations from both players, a win, and a clean exit ===');
{
  const R = await departToEncounter('RAT', 'beast', 100, { rations: [20, 10] });
  const st0 = R.host.hunt.getState();
  check('the pack holds both players\' pledged Rations (20 + 10)', qtyOf(st0.pack.brought) === 30, `${qtyOf(st0.pack.brought)}`);
  check('...and the hunt started with the camp issue plus all 30', st0.maxSupplies === 60 + 30 * K, `${st0.maxSupplies}`);
  check('both sides know what each brought', same(R.host.contributions, { p1: 20, p2: 10 }) && same(R.guest.contributions, { p1: 20, p2: 10 }));
  R.host.fight();
  await until(() => R.host.fighting && R.guest.fighting, 'the fight');
  for (const u of R.lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
  await playFight(R);
  await until(() => !R.host.fighting && R.guest.version === R.host.version, 'the win applied');
  // Harvest everything, so the pack has finds to take home.
  const sp = R.host.view().spoils;
  const took = sp ? R.host.act(h => h.harvest({ take: sp.parts.map(p => p.id), meat: true })) : null;
  check('the host harvested the kill into the pack', took?.ok && R.host.hunt.getState().pack.found.length > 0, `${R.host.hunt.getState().pack.found.length} found`);
  check('the host walked the party out through an exit', walkOut(R) && R.host.view().finished === 'exit');
  await until(() => R.host.tookHome && R.guest.tookHome, 'both took home');
  const led = R.host.ledger, hg = R.hostSave.got, gg = R.guestSave.got;
  const hpAll = ledgerSum(led, 'awardHuntPoints');
  check('rule 1: every save gets the hunt\'s Hunt Points in full (fights and completion)', hg.huntPoints === hpAll && gg.huntPoints === hpAll && hpAll > 0, `${hpAll} each`);
  const found = led.filter(e => e.verb === 'bankItems' && e.args[1]?.found).flatMap(e => e.args[0]);
  check('rule 1: the finds are COPIED to every save', same(ids(hg.found), ids(found)) && same(ids(gg.found), ids(found)), `${found.length} items`);
  // Expected by the real awardXPTo on fresh copies: each pool's share, split
  // over all six, paid in order to that player's own three.
  const pools = led.filter(e => e.verb === 'awardXP').map(e => e.args[0]);
  const expect = (from) => { const cs = clone(3, from).map(w => fromWireCharacter(w)); for (const p of pools) GameState.awardXPTo(cs, xpShare(p, 6)); return cs.map(c => [c.level, c.experience || 0]); };
  const have = (save) => save.chars.map(c => [c.level, c.experience || 0]);
  check('rule 1: XP is the pool split over all six, each save paying only its own hunters',
    pools.length > 0 && same(have(R.hostSave), expect(0)) && same(have(R.guestSave), expect(3)), `pools ${pools.join(',')}`);
  const left = qtyOf(led.filter(e => e.verb === 'bankItems' && !e.args[1]?.found).flatMap(e => e.args[0]));
  const hr = qtyOf(hg.brought), gr = qtyOf(gg.brought);
  check('rule 2: the Rations left come back split by what each brought (the host takes the rounding)',
    left > 0 && hr + gr === left && gr === Math.floor(left * 10 / 30), `${left} left: host ${hr}, guest ${gr}`);
  const days = led.filter(e => e.verb === 'dayBreaks').length, nights = led.filter(e => e.verb === 'nightFalls').length;
  check('rule 5: every calendar advances by the hunt (each nightfall and daybreak)', hg.days === days && gg.days === days && hg.nights === nights && gg.nights === nights, `${nights} nights, ${days} days`);
  check('rule 4: every Bond records the hunt\'s favor', same(hg.favor, gg.favor) && hg.favor.length === led.filter(e => e.verb === 'favor').length, `${hg.favor.length} entries`);
  const again = R.guest.takeHome();
  check('taken home ONCE: a second take-home pays nothing', again === null && gg.huntPoints === hpAll);
}

console.log('=== two fights in one hunt ===');
{
  const T = await departToEncounter('TWO', 'beast', 100);
  T.host.fight();
  await until(() => T.host.fighting && T.guest.fighting, 'the first fight');
  for (const u of T.lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
  await playFight(T);
  await until(() => !T.host.fighting && T.guest.version === T.host.version, 'the first win applied');
  if (T.host.view().spoils) T.host.act(h => h.harvest({ take: [], meat: false }));
  // A SECOND fight in the same hunt. CoopClient once had a huntFight method
  // AND a huntFight property (the live spec): the first fight's spec
  // overwrote the method, and every guest read "a fight is on" from it.
  check('between fights no side thinks a fight is on', T.hostC.huntFight === null && T.guestC.huntFight === null && !T.guest.fighting);
  const second = await walkToEncounter(T, 555, 'beast') || await walkToEncounter(T, 556, 'cultist');
  if (second) {
    const r2 = T.host.fight();
    await until(() => T.host.fighting && T.guest.fighting, 'the second fight');
    for (const u of T.lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
    await playFight(T);
    await until(() => !T.host.fighting && T.guest.version === T.host.version, 'the second win applied');
    check('a second fight in the same hunt starts, is won and applied', r2.ok && T.host.hunt.getState().kills.length === 2, `${T.host.hunt.getState().kills.length} kills`);
    const sp2 = T.host.view().spoils;
    if (sp2) T.host.act(h => h.harvest({ take: [], meat: false }));
  } else check('a second encounter was found', false);
}

console.log('=== 12d: the Rations split, with a remainder ===');
{
  const { broughtShare } = await import('../src/systems/CoopRewards.js');
  const items = [makeStack('rations', 25)];
  const c = { p1: 20, p2: 10 };
  const h = qtyOf(broughtShare(items, { contributions: c, me: 'p1', hostId: 'p1' }));
  const g = qtyOf(broughtShare(items, { contributions: c, me: 'p2', hostId: 'p1' }));
  check('25 left of 20 + 10 brought: the guest gets floor(25 x 10/30) = 8, the host the other 17', g === 8 && h === 17, `host ${h}, guest ${g}`);
  const three = { p1: 0, p2: 7, p3: 7 };
  const s3 = ['p1', 'p2', 'p3'].map(me => qtyOf(broughtShare([makeStack('rations', 5)], { contributions: three, me, hostId: 'p1' })));
  check('...and nothing is lost or made up: a host who brought none still takes the rounding', s3.reduce((t, n) => t + n, 0) === 5 && s3[1] === 2 && s3[2] === 2, s3.join(','));
}

console.log('=== 12d: tribe regard goes to each player\'s own tribe ===');
{
  const { hostWorld } = await import('../src/systems/CoopHunt.js');
  const { applyTakeHome } = await import('../src/systems/CoopRewards.js');
  const led = [];
  const w = hostWorld([], { ownTribe: () => 'zafaar' }, led);
  w.tribeRep('zafaar', 2); w.tribeRep('elseth', -1);
  const g = saveFor(3, 'styx');
  applyTakeHome(led, { me: 'p2', hostId: 'p1', myRefs: [] }, g);
  check('the host\'s "own tribe +2" lands on the GUEST\'s own tribe; a named rival stays named', same(g.got.rep, [['styx', 2], ['elseth', -1]]), JSON.stringify(g.got.rep));
}

console.log('=== 12d: a Watched wipe: each save loses only its own ===');
{
  // The starter regions are Sheltered; for this hunt the Reeds are Watched,
  // the way the game's bmDevDeathRule hook does it (read at departure).
  const was = ZONES.reeds_of_gethsemane.deathRule;
  ZONES.reeds_of_gethsemane.deathRule = 'watched';
  const X = await departToEncounter('WAT', 'beast', 300);
  ZONES.reeds_of_gethsemane.deathRule = was;
  check('the hunt is Watched', X.host.hunt.getState().deathRule === 'watched');
  X.host.fight();
  await until(() => X.host.fighting && X.guest.fighting, 'the Watched fight');
  for (const u of X.lobby.session.party) u.currentHP = 1;
  for (const e of X.lobby.session.host.enemies) { e.maxHP = 99999; e.currentHP = 99999; }
  await playFight(X, { attack: false });
  await until(() => X.host.tookHome && X.guest.tookHome, 'both took home');
  const hs = X.hostSave.got.slain.map(s => s.name).sort(), gs = X.guestSave.got.slain.map(s => s.name).sort();
  check('rule 6: each save sends only its OWN fallen to the Slain, under the Watched rule',
    same(hs, X.hostSave.chars.map(c => c.name).sort()) && same(gs, X.guestSave.chars.map(c => c.name).sort())
    && [...X.hostSave.got.slain, ...X.guestSave.got.slain].every(s => s.fell.rule === 'watched' && s.fell.zoneId === 'reeds_of_gethsemane'),
    `host ${hs.join(',')} / guest ${gs.join(',')}`);
  check('...and a Watched wipe brings nothing home', X.guestSave.got.found.length === 0 && X.guestSave.got.brought.length === 0);
}

console.log('=== 12d: a guest who leaves early takes a clean exit, once ===');
{
  const L = await departToEncounter('LEA', 'beast', 100, { rations: [0, 20] });
  L.host.act(h => h.flee());
  await until(() => L.guest.version === L.host.version, 'caught up');
  const env = L.host.snapshot();
  const s = L.host.hunt.getState();
  const reward = exitReward(s);
  L.guest.leave();
  const gg = L.guestSave.got;
  check('the leaving guest takes the pack\'s finds so far (copied)', same(ids(gg.found), ids(s.pack.found)), `${s.pack.found.length} items`);
  check(`...the completion reward only if the objectives are done (here: ${reward.primaryDone ? 'done' : 'not done'})`,
    gg.huntPoints === ledgerSum(env.ledger, 'awardHuntPoints') + reward.huntPoints, `${gg.huntPoints}`);
  const rLeft = Math.min(20, Math.floor(s.supplies / K + 1e-9));
  check('...and the Rations left, being the only one who brought any', qtyOf(gg.brought) === rLeft, `${rLeft}`);
  const before = JSON.stringify(gg);
  L.guest.takeHome();
  check('...and never twice', JSON.stringify(gg) === before && L.guestSave.record()[L.guest.id]?.closed === true);
}

// =============================================================================
// Chunk 12d-2: the hunt survives a reload (each save keeps a record of it).
/** A new client for a returning player: the record's seat id, the same code. */
async function rejoin(S, rec, label) {
  const c = createCoopClient({ url: 'mem://', WebSocketImpl: S.WS });
  await c.connect();
  c.joinLobby({ code: rec.code, name: label, hunters: [], clientId: rec.clientId });
  await until(() => c.resumed && (c.status === 'hunting' || c.status === 'fighting') && c.hunt, `${label} back in the hunt`);
  return c;
}

console.log('=== 12d-2: the host reloads and carries on ===');
{
  const S = await setup('RLD', { rations: [0, 0] });
  S.host.begin({ zoneId: 'reeds_of_gethsemane', plan: { objective: 'scout', size: 'small', mods: {}, bonusObjectives: [] }, supplies: 100, seed: 11 });
  for (let i = 0; i < 3; i++) { const v = S.host.view(); if (v.encounter || v.event || !v.moves.length) break; S.host.move(v.moves[0].tile); }
  // Walk away from a site the walk ended on (13c's denser maps moved what
  // moves[0] reaches): an open event refuses the "next move" checked below.
  if (S.host.view().event) S.host.act(h => h.leaveEvent());
  await until(() => S.guest.version === S.host.version, 'caught up');
  const rec = S.hostSave.active;
  check('the host\'s save keeps a record of the hunt, current to the last snapshot',
    rec?.code === S.hostC.code && rec.version === S.host.version && rec.isHost && same(rec.env.ledger, S.host.ledger) && !!rec.clientId);
  check('...and so does the guest\'s', S.guestSave.active?.version === S.host.version && !S.guestSave.active.isHost);
  const posBefore = S.host.view().pos;
  S.host.dispose(); S.hostC.disconnect();
  const back = await rejoin(S, rec, 'Hana');
  const host2 = createCoopHunt({ client: back, reads, target: S.hostSave, resume: rec });
  check('the returning host rebuilds the hunt where it was, identical to the guest\'s', host2.view().pos === posBefore && same(host2.view(), S.guest.view()) && host2.version === S.guest.version);
  const v = host2.view();
  const t = v.moves.find(m => !v.occupants.some(o => o.tile === m.tile))?.tile ?? v.moves[0].tile;
  host2.move(t);
  await until(() => S.guest.version === host2.version, 'the guest sees the host\'s next move');
  check('...and carries on: its next move reaches the guest, the version going on from the server\'s', S.guest.view().pos === host2.view().pos && host2.version === rec.version + 1,
    JSON.stringify({ guestPos: S.guest.view().pos, hostPos: host2.view().pos, v: host2.version, rec: rec.version, enc: !!host2.view().encounter, ev: !!host2.view().event }));
}

console.log('=== 12d-2: the host misses a fight\'s end, then comes back ===');
{
  const M = await departToEncounter('MIS', 'beast', 100);
  M.host.fight();
  await until(() => M.host.fighting && M.guest.fighting, 'the fight');
  const rec = M.hostSave.active;
  // The host's game stops listening (a crash mid-fight); its client still
  // plays its turns here, so the fight can end without it.
  M.host.dispose();
  for (const u of M.lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
  await playFight(M);
  await until(() => M.guest.fighting === null, 'the fight over');
  check('the fight is over and the host never applied it (the server holds it)', !!M.lobby.hunt.lastOver && M.hostSave.active.version === rec.version);
  M.hostC.disconnect();
  const back = await rejoin(M, rec, 'Hana');
  await until(() => back.lastOver, 'the resent ending');
  const host2 = createCoopHunt({ client: back, reads, target: M.hostSave, resume: rec });
  await until(() => M.guest.version === host2.version, 'the applied win reaches the guest');
  const st = host2.hunt.getState();
  check('on its return the host applies the win it missed: the kill, the pool, published', st.kills.length === 1 && !st.encounter
    && host2.ledger.some(e => e.verb === 'awardXP') && same(M.guest.view(), host2.view()) && !M.lobby.hunt.lastOver);
}

console.log('=== 12d-2: the host returns while the fight is still on ===');
{
  const F = await departToEncounter('MID', 'beast', 300);
  F.host.fight();
  await until(() => F.host.fighting && F.guest.fighting, 'the fight');
  const rec = F.hostSave.active;
  F.host.dispose(); F.hostC.disconnect();
  const back = await rejoin(F, rec, 'Hana');
  await until(() => back.huntFight, 'the live fight');
  const host2 = createCoopHunt({ client: back, reads, target: F.hostSave, resume: rec });
  check('the returning host is back in the live fight', !!host2.fighting && host2.fighting.occId === F.guest.fighting.occId);
  F.hostC = back;
  for (const u of F.lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
  await playFight(F);
  await until(() => !host2.fighting && F.guest.version === host2.version, 'the win applied');
  check('...plays it out, and applies the win', host2.hunt.getState().kills.length === 1 && same(F.guest.view(), host2.view()));
}

console.log('=== 12d-2: a reload after the lobby is gone ===');
{
  const { takeHomeFromRecord } = await import('../src/systems/CoopRewards.js');
  const Z = await departToEncounter('GNE', 'beast', 100, { rations: [0, 20] });
  Z.host.act(h => h.flee());
  await until(() => Z.guest.version === Z.host.version, 'caught up');
  const rec = Z.guestSave.active;
  Z.guest.dispose(); Z.guestC.disconnect();   // the guest's browser crashed
  const s = Z.host.hunt.getState();
  const sum = takeHomeFromRecord(rec, Z.guestSave);
  check('the guest\'s save takes the clean exit from its record: the Rations left, the finds',
    !!sum && qtyOf(Z.guestSave.got.brought) === Math.min(20, Math.floor(s.supplies / K + 1e-9)) && same(ids(Z.guestSave.got.found), ids(s.pack.found)), JSON.stringify(sum));
  check('...clears the record', Z.guestSave.active === null && Z.guestSave.record()[rec.id]?.closed === true);
  check('...and never twice', takeHomeFromRecord(rec, Z.guestSave) === null);
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
  check('...and took that clean exit home (rule 7), once', !!G.guest.tookHome && G.guestSave.record()[G.guest.id]?.closed === true);
}

S.hostC.disconnect(); S.guestC.disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
