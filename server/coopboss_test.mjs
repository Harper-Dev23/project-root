// @ts-nocheck
// server/coopboss_test.mjs
//
// Chunk 14b on a co-op hunt, end to end (14f): the real CoopHunt controller on
// a host and a guest, the real CoopClient, the real hub (in-memory sockets, as
// coophunt_test.mjs), the boss fight run by the server's own CombatScene.
//
// What it proves:
//   - quest sites come from the HOST's save, and both players see them
//   - omens ride the ledger: at a clean exit every save books them
//   - a boss hunt: a guest's move onto the lair is refused (the warning is the
//     host's to accept); only the host can go in (enterLair)
//   - the server's board: the Mourning Beast's Head and Body share one pool
//   - the boss plan is spent once, through the ledger (the host's save has it)
//   - a win: the kill as the boss, boss_slain in the ledger, the lair's chest
//     (Burden of Dreams, read from the host's save) and the boss's parts in the
//     pack, and both saves take them home
//   - the Ghost Party at night: the Captain wears The Unconfessed on the
//     server's board, and it works on him there
//
// Run: node server/coopboss_test.mjs

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(0, { deterministic: false });

const { createHub } = await import('./protocol.js');
const { createCoopClient } = await import('../src/systems/CoopClient.js');
const { createCoopHunt } = await import('../src/systems/CoopHunt.js');
const { toWireCharacter, fromWireCharacter } = await import('../src/systems/CoopWire.js');
const { makeParty } = await import('../tools/headless/fixtures.js');
const { restoreMapHunt } = await import('../src/systems/HuntEngine.js');
const { mapNeighbors } = await import('../src/systems/HuntMapGen.js');
const { isPassable } = await import('../data/grounds.js');
const { clockAt } = await import('../src/systems/HuntRules.js');
const { questSitesFor, regionFlag } = await import('../src/systems/HuntQuests.js');
const { BOSSES, OMEN_SOURCES } = await import('../data/bosses.js');
const GameState = (await import('../src/systems/GameState.js')).default;
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default || Object.values(CombatSceneMod).find(v => typeof v === 'function');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const tick = () => new Promise(r => setImmediate(r));
async function until(fn, label, rounds = 6000) {
  for (let i = 0; i < rounds; i++) { if (fn()) return true; await tick(); }
  throw new Error('timed out waiting for ' + label);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const REEDS = 'reeds_of_gethsemane';

/** A WebSocket that is really the hub, in this process (as coophunt_test.mjs). */
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

/** The HOST's save for the engine's reads: its quest flags decide the sites. */
function hostReads(flags) {
  const pm = { tribe: 'zafaar', completedScenarios: [], hasQuestFlag: (f) => flags.has(f) };
  return {
    followedHouse: () => null, houseHolder: () => null, ownTribe: () => 'zafaar', tribeName: (t) => t,
    hasQuestFlag: (f) => flags.has(f),
    questSites: (z) => questSitesFor(z, pm),
    historicInWild: () => true,
  };
}

/** One player's save as a take-home target, recording what it is paid. */
function saveFor(from, ownTribe) {
  const chars = clone(3, from).map(w => fromWireCharacter(w));
  const got = { huntPoints: 0, found: [], brought: [], flags: [], omens: [], spent: [] };
  const world = {
    nightFalls() {}, dayBreaks() {},
    awardHuntPoints(n) { got.huntPoints += n; },
    bankItems(items, { found }) { (found ? got.found : got.brought).push(...items); },
    favor() {}, falseGod() {}, bond() {}, rivalDevotion() {}, tribeRep() {}, lore() {},
    questFlag(...a) { got.flags.push(a); },
    omens(...a) { got.omens.push(a); },
    spendBossPlan(id) { got.spent.push(id); },
    ownTribe: () => ownTribe,
  };
  const rec = {};
  return {
    chars, got, world,
    hunter: (ref) => chars.find(c => (c.instanceId || c.id) === ref) || null,
    awardXPTo: (cs, n) => GameState.awardXPTo(cs, n),
    moveToSlain() {}, day: () => 1, record: () => rec, save() {},
    active: null, remember(r) { this.active = JSON.parse(JSON.stringify(r)); }, forget() { this.active = null; },
  };
}

async function setup(code, reads) {
  const hub = createHub({ CombatScene, codeFactory: () => code });
  const WS = socketsFor(hub);
  const hostC = createCoopClient({ url: 'mem://', WebSocketImpl: WS });
  const guestC = createCoopClient({ url: 'mem://', WebSocketImpl: WS });
  await hostC.connect(); await guestC.connect();
  hostC.send({ t: 'create', mode: 'hunt', name: 'Hana', hunters: clone(3, 0), clientId: code + '-host' });
  await until(() => hostC.code, 'the host seated');
  hostC.clientId = code + '-host';
  guestC.send({ t: 'join', code, name: 'Gus', hunters: clone(3, 3), clientId: code + '-guest' });
  await until(() => guestC.playerId, 'the guest seated');
  guestC.clientId = code + '-guest';
  hostC.setReady(true); guestC.setReady(true);
  await until(() => hostC.lobby?.players?.every(p => p.ready), 'both ready');
  hostC.startHunt();
  await until(() => hostC.status === 'hunting' && guestC.status === 'hunting', 'huntStarted');
  const hostSave = saveFor(0, 'zafaar'), guestSave = saveFor(3, 'elseth');
  const host = createCoopHunt({ client: hostC, reads, target: hostSave });
  const guest = createCoopHunt({ client: guestC, target: guestSave });
  return { hub, hostC, guestC, host, guest, hostSave, guestSave, lobby: hub.lobbies.get(code) };
}

/** Restore the host's hunt with the party beside its lair (and at night if asked), and publish it. */
async function besideLair(S, { night = false } = {}) {
  const d = S.host.hunt.serialize();
  const lair = d.map.occupants.find(o => o.kind === 'boss');
  const next = mapNeighbors(d.map, lair.tile).find(id => isPassable(d.map.tiles[id]));
  d.map.occupants = d.map.occupants.filter(o => o.tile !== next);
  for (const o of d.map.occupants) o.noticed = true;
  d.pos = next; d.fog[next] = 'visible';
  if (night) { let t = d.time; while (!clockAt(t).isNight) t += 1; d.time = t; d.world.time = t; }
  S.host.hunt = restoreMapHunt(d, S.host.hostWorld);
  S.host.act(() => ({ ok: true }));   // publish, as any accepted action does
  await until(() => S.guest.version === S.host.version, 'the guest caught up');
  return lair;
}

/** Play the live fight through the clients, each owner on its own turn (as coophunt_test.mjs). */
async function playFight(S) {
  const byOwner = { [S.hostC.playerId]: S.hostC, [S.guestC.playerId]: S.guestC };
  for (let t = 0; t < 800 && S.lobby.session; t++) {
    const cur = S.lobby.session.current();
    if (!cur || cur.ownerId == null) { await tick(); continue; }
    const c = byOwner[cur.ownerId];
    const foe = (c.state?.units || []).find(u => u.side === 'enemy' && u.hp > 0);
    const version = c.state?.version;
    if (foe) { c.act({ actor: cur.ref, skill: 'basic_attack', target: foe.ref }); await until(() => !S.lobby.session || c.state?.version > version, 'the act'); }
    if (!S.lobby.session) break;
    const v2 = c.state?.version;
    c.lastError = null;
    c.endTurn();
    await until(() => !S.lobby.session || c.state?.version > v2 || c.lastError, 'the end of turn');
    if (c.lastError) throw new Error(`endTurn refused for ${cur.name}: ${c.lastError}`);
  }
}

/** Walk the host out by the shortest way, fleeing anything met, then leave. */
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

// =============================================================================
console.log('=== quest sites and omens on a co-op hunt ===');
{
  const flags = new Set([regionFlag('hunted', REEDS), regionFlag('apex_slain', REEDS)]);
  const S = await setup('QST', hostReads(flags));
  S.host.begin({ zoneId: REEDS, plan: { objective: 'scout', size: 'small', mods: {}, bonusObjectives: [] }, supplies: 200, bring: [], seed: 4401 });
  await until(() => S.guest.version === S.host.version, 'the guest caught up');
  const hostSites = (S.host.hunt.getState().map.questSites || []).map(q => q.eventId).sort();
  check("the host's save decides the quest sites: both Reeds questlines' next steps", same(hostSites, ['reeds_drowned_camp', 'reeds_lament_pools']), JSON.stringify(hostSites));
  const gMarks = S.guest.view().objectiveSites.filter(s => s.objective === 'quest').map(s => s.name).sort();
  check('...and the guest sees them marked too', same(gMarks, ['The Drowned Camp', 'The Lament Pools']), JSON.stringify(gMarks));
  check('the host walks the party out', walkOut(S) && S.host.view().finished === 'exit');
  await until(() => S.host.tookHome && S.guest.tookHome, 'both took home');
  check('a hunt that did nothing books no omens (none in the ledger, none in either save)', !S.host.ledger.some(e => e.verb === 'omens') && !S.hostSave.got.omens.length && !S.guestSave.got.omens.length);
  S.hostC.disconnect(); S.guestC.disconnect();
}

// =============================================================================
console.log('=== the Mourning Beast on a co-op hunt ===');
{
  const S = await setup('MBC', hostReads(new Set()));
  S.host.begin({ zoneId: REEDS, plan: { objective: 'boss', size: 'large', boss: 'mourning_beast', bossPlanId: 'plan-MB-1', mods: {}, bonusObjectives: [] }, supplies: 200, bring: [], seed: 4402 });
  await until(() => S.guest.version === S.host.version, 'the guest caught up');
  const lair = await besideLair(S);
  const gSees = S.guest.view().objectiveSites.find(s => s.objective === 'boss');
  check('both see the lair marked', gSees?.tile === lair.tile && S.host.view().objectiveSites.some(s => s.objective === 'boss'));

  S.guestC.lastError = null;
  S.guest.move(lair.tile);
  await until(() => S.guestC.lastError, 'the refusal');
  check("a guest's move onto the lair is refused: the warning is the host's to accept", /lair/i.test(S.guestC.lastError) && !S.host.view().encounter, S.guestC.lastError);
  check('...and a guest cannot go in', /only the host/.test(S.guest.act(h => h.enterLair(lair.tile)).reason || ''));
  const hm = S.host.move(lair.tile);
  check("the host's plain move shows the warning", !hm.ok && !!hm.lair);
  const inside = S.host.act(h => h.enterLair(lair.tile));
  await until(() => S.guest.version === S.host.version, 'the guest caught up');
  check('the host goes in: the boss fight, on both sides', inside.ok && S.host.view().encounter?.kind === 'boss' && S.guest.view().encounter?.kind === 'boss');

  const f = S.host.fight();
  await until(() => S.host.fighting && S.guest.fighting, 'the fight');
  check('the boss plan is spent once it is fought, through the ledger', f.ok && same(S.host.ledger.filter(e => e.verb === 'spendBossPlan').map(e => e.args[0]), ['plan-MB-1']));
  const enemies = S.lobby.session.host.enemies;
  const head = enemies.find(e => e.name === 'Head'), body = enemies.find(e => e.name === 'Body');
  check("the server's board: four parts, the Head and Body on one pool", enemies.length === 4 && head?._pool && head._pool === body?._pool && head.currentHP === body.currentHP, `${head?.currentHP}/${head?.maxHP}`);

  // Strong hunters and a boss at its last points: this is about the hand-back.
  for (const u of S.lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
  head._pool.hp = 5;
  for (const e of enemies) if (!e._pool) e.currentHP = 1;
  await playFight(S);
  await until(() => !S.host.fighting && S.guest.version === S.host.version, 'the win applied');
  const st = S.host.hunt.getState();
  check('won: the kill is the boss, the Boss objective done', st.kills.some(k => k.boss === 'mourning_beast') && S.host.view().objectives[0].done);
  check('boss_slain is in the ledger (every save learns it)', S.host.ledger.some(e => e.verb === 'questFlag' && e.args[0] === 'boss_slain:mourning_beast'));
  check("the lair's chest (read from the host's save) is in the pack: Burden of Dreams", st.pack.found.some(i => i.id === BOSSES.mourning_beast.historic));
  check("...and the boss's parts wait to be harvested", st.spoils?.family === 'mourning_beast' && st.spoils.parts.length === 6);
  check("the guest's copy agrees", same(S.guest.view(), S.host.view()));

  const sp = S.host.view().spoils;
  S.host.act(h => h.harvest({ take: sp.parts.map(p => p.id), meat: true }));
  // Clear the way out: this is about the take-home, and a pack that keeps
  // catching a fleeing party loops the walker (measured: 198 flees).
  { const d = S.host.hunt.serialize(); d.map.occupants = d.map.occupants.filter(o => o.kind === 'event'); S.host.hunt = restoreMapHunt(d, S.host.hostWorld); S.host.act(() => ({ ok: true })); }
  check('the host walks the party out', walkOut(S) && S.host.view().finished === 'exit');
  await until(() => S.host.tookHome && S.guest.tookHome, 'both took home');
  const has = (got, id) => got.found.some(i => i.id === id);
  check('both saves take home Burden of Dreams and the parts (each bank keeps a Historic item only where it is wild: GAME_WORLD.bankItems)',
    has(S.hostSave.got, 'burden_of_dreams') && has(S.guestSave.got, 'burden_of_dreams') && has(S.hostSave.got, 'part_mourning_beast_amulet') && has(S.guestSave.got, 'part_mourning_beast_amulet'));
  const om = S.host.ledger.filter(e => e.verb === 'omens');
  check('omens ride the ledger, once, for the region (the kill and the objective)', om.length === 1 && om[0].args[0] === REEDS && om[0].args[1] === OMEN_SOURCES.primary + OMEN_SOURCES.fight, JSON.stringify(om));
  check('...and both saves book them', same(S.hostSave.got.omens, [om[0]?.args]) && same(S.guestSave.got.omens, [om[0]?.args]));
  check("the boss plan is spent from the host's save (on the guest's it finds nothing)", same(S.hostSave.got.spent, ['plan-MB-1']));
  S.hostC.disconnect(); S.guestC.disconnect();
}

// =============================================================================
console.log('=== the Ghost Party on a co-op hunt, at night ===');
{
  const S = await setup('GPC', hostReads(new Set()));
  S.host.begin({ zoneId: REEDS, plan: { objective: 'boss', size: 'large', boss: 'ghost_party', bossPlanId: 'plan-GP-1', mods: {}, bonusObjectives: [] }, supplies: 200, bring: [], seed: 4403 });
  await until(() => S.guest.version === S.host.version, 'the guest caught up');
  const lair = await besideLair(S, { night: true });
  const inside = S.host.act(h => h.enterLair(lair.tile));
  const f = inside.ok && S.host.fight();
  await until(() => S.host.fighting && S.guest.fighting, 'the fight');
  const cap = S.lobby.session.host.enemies.find(e => e.name === 'Ghost Captain');
  check("the server's board: six ghosts, the Captain in The Unconfessed", f?.ok && S.lobby.session.host.enemies.length === 6 && cap?.equipment?.amulet?.id === 'the_unconfessed');
  check('...and it works on him there (Curse of the Unshriven)', !!cap?.gearEffects?.historic?.unshrivenPct);
  S.hostC.disconnect(); S.guestC.disconnect();
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
