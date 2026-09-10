// @ts-nocheck
// server/coop_scene_test.mjs
//
// Co-op mode in CombatScene itself, driven by a live server over real sockets.
//
// Two clients each build a board the way the scene does — `_placeCoopParty`
// from the roster, `_wireCoopClient` to listen — then play a fight by calling
// the scene's own `_resolveAction`. In co-op that must SEND rather than
// resolve, so the proof is twofold: the fight progresses, and neither client
// ever moved its own board except by applying a broadcast.
//
// The server runs in its own process, which also keeps the GameState singleton
// out of the way: only client boards exist here.
//
// Run: node server/coop_scene_test.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { installPhaserStub } from '../tools/headless/phaserStub.js';
installPhaserStub(4711, { deterministic: false });

const { createCombatHost } = await import('../tools/headless/combatHost.js');
const { createCoopClient } = await import('../src/systems/CoopClient.js');
const { toWireCharacter } = await import('../src/systems/CoopWire.js');
const { makeParty } = await import('../tools/headless/fixtures.js');
const GameState = (await import('../src/systems/GameState.js')).default;
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8793;
const URL = `ws://127.0.0.1:${PORT}`;
const SCENARIO = 'training_encounter_1';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(20); }
  throw new Error('timed out waiting for ' + label);
}

const server = spawn(process.execPath, [path.join(HERE, 'index.js')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => { serverOut += d; });
const stop = () => { try { server.kill(); } catch { } };
process.on('exit', stop);

/** Stand up the co-op half of CombatScene against a connected client. */
function buildScene(client) {
  const host = createCombatHost(CombatScene);
  host.isCoop = true;
  host.coopClient = client;
  host.coopParty = [];
  host._coopUnsubs = [];
  host.scenarioId = SCENARIO;

  host._placeCoopParty();          // the real method
  host._placeEnemies(SCENARIO);    // the real method
  host.turnOrder = [...host.coopParty, ...host.enemies];
  host._wireCoopClient();          // the real method
  return host;
}

try {
  await until(async () => {
    if (server.exitCode != null) throw new Error('server exited:\n' + serverOut);
    try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { return false; }
  }, 'the server to be healthy');

  const roster = makeParty().map(toWireCharacter);
  const take = (n, from) => JSON.parse(JSON.stringify(roster.slice(from, from + n)));

  const alice = createCoopClient({ url: URL });
  const bob = createCoopClient({ url: URL });
  await alice.connect();
  await bob.connect();

  alice.createLobby({ name: 'Alice', scenarioId: SCENARIO, hunters: take(3, 0) });
  await until(() => alice.code, 'a lobby code');
  bob.joinLobby({ code: alice.code, name: 'Bob', hunters: take(3, 3) });
  await until(() => bob.playerId, 'bob to join');
  // Claim a slot before readying, so the fight has a formation somebody chose
  // rather than the join order. Slot 1 is the front rank; without a claim
  // Alice's first hunter would land there anyway, so pick the BACK for her
  // first hunter -- a placement the fallback would never produce on its own.
  const aliceHunters = alice.lobby.players.find(p => p.id === alice.playerId).hunters;
  const bobHunters = bob.lobby.players.find(p => p.id === bob.playerId).hunters;
  const claimedRef = aliceHunters[0].ref;
  alice.claimSlot(claimedRef, 6);

  // Slots 7 and 8 specifically. The lobby offers all eight and the session
  // used to honour only 1-6, so a guest's back rank was silently rewritten
  // into whatever the fill handed out -- reported from real play as
  // "eee moved from 7 to 4, fff from 8 to 5".
  const backRank = [[bobHunters[0].ref, 7], [bobHunters[1].ref, 8]];
  for (const [ref, slot] of backRank) bob.claimSlot(ref, slot);

  await until(() => {
    const a = alice.lobby.players.find(p => p.id === alice.playerId).hunters;
    const b = alice.lobby.players.find(p => p.id === bob.playerId).hunters;
    return a.find(h => h.ref === claimedRef)?.slotId === 6
      && backRank.every(([ref, slot]) => b.find(h => h.ref === ref)?.slotId === slot);
  }, 'the claims to register');

  alice.setReady(true); bob.setReady(true);
  await until(() => alice.lobby?.players?.every(p => p.ready), 'everyone ready');
  alice.startHunt();
  await until(() => alice.state && bob.state && alice.roster.length, 'the opening board');

  console.log('=== the roster arrives and builds a board ===');
  check('the roster carries every hunter, not just ours',
    alice.roster.length === 6, alice.roster.length + ' hunters');
  check('each roster entry names its owner',
    alice.roster.every(h => h.ownerId), [...new Set(alice.roster.map(h => h.ownerId))].join(' + '));

  const scenes = { p1: buildScene(alice), p2: buildScene(bob) };

  // Positions must agree with the server's, or every VFX drawn between two
  // slots flies between the wrong two points on screen -- and adjacency, AoE
  // shapes and movement all read from the same place.
  const slotDisagreements = () => {
    const out = [];
    for (const [who, sc] of [['p1', scenes.p1], ['p2', scenes.p2]]) {
      const said = (who === 'p1' ? alice : bob).state?.units || [];
      for (const c of sc.coopParty) {
        const ref = c.instanceId || c.id;
        const server = said.find(u => u.ref === ref);
        const mine = c._slot?.slotId ?? null;
        if (server && server.slot !== mine) {
          out.push(`${who} ${c.name}: server ${server.slot}, client ${mine}`);
        }
      }
    }
    return out;
  };
  const bad = slotDisagreements();
  check('every hunter stands where the server says they stand',
    bad.length === 0, bad.slice(0, 4).join(' | ') || 'all agree');

  // The claim has to survive three hops to mean anything: the lobby, the
  // server's own board, and the client's drawing of it.
  const claimedUnit = scenes.p1.coopParty.find(c => (c.instanceId || c.id) === claimedRef);
  check('the slot chosen in the lobby is where that hunter actually stands',
    claimedUnit?._slot?.slotId === 6,
    claimedUnit?.name + ' in slot ' + (claimedUnit?._slot?.slotId ?? 'nowhere'));
  check('and the server agrees that is where they are',
    alice.state.units.find(u => u.ref === claimedRef)?.slot === 6);
  check('the back rank -- slots 7 and 8 -- survives the start of the hunt',
    backRank.every(([ref, slot]) =>
      alice.state.units.find(u => u.ref === ref)?.slot === slot),
    backRank.map(([ref, slot]) =>
      `wanted ${slot}, got ${alice.state.units.find(u => u.ref === ref)?.slot}`).join(' | '));

  check('_placeCoopParty built the whole shared party',
    scenes.p1.coopParty.length === 6, scenes.p1.coopParty.length + ' hunters on the board');
  check('hunters know whose they are',
    scenes.p1.coopParty.filter(c => c.isLocal).length === 3,
    scenes.p1.coopParty.filter(c => c.isLocal).length + ' local to Alice');
  check('their skills are real functions, not lost on the wire',
    scenes.p1.coopParty.every(c => c.skills.some(s => typeof s.apply === 'function')));
  // A real assertion, not a formality: _placeCoopParty must never write the
  // shared roster into the local player's saved party, or another player's
  // hunters would land in this player's save the next time anything autosaved.
  const coopIds = new Set(scenes.p1.coopParty.map(c => c.instanceId || c.id));
  check('the local saved party was NOT touched by the fight',
    !(GameState.party || []).some(c => coopIds.has(c.instanceId || c.id)),
    'GameState.party holds ' + (GameState.party || []).length);

  // ---- the crash that took out create() ------------------------------------
  //
  // `_updateHealthBars` iterated GameState.party — this player's SAVED
  // characters, who are not in a co-op fight at all. Those carry a stale
  // `hpBar` from whatever combat they were last in, so `if (char.hpBar)`
  // passed on a destroyed object and `.update()` threw, killing create() and
  // leaving the lobby on screen with the fight never starting.
  //
  // The harness stubs the drawing methods, so this calls the REAL one.
  console.log('=== drawing reads the board, not the saved party ===');
  {
    const scene = scenes.p1;
    check('_boardAllies returns the shared roster in co-op',
      scene._boardAllies().length === scene.coopParty.length && scene.coopParty.length > 0,
      scene._boardAllies().length + ' allies');

    // Plant exactly what a previous single-player combat leaves behind.
    GameState.party = [{ name: 'Stale', currentHP: 1, maxHP: 1, hpBar: { destroyed: true } }];

    let threw = null;
    try { CombatScene.prototype._updateHealthBars.call(scene); }
    catch (e) { threw = e.message; }
    check('a stale bar handle on a saved character cannot crash the board',
      threw === null, threw || 'no throw');

    GameState.party = [];
  }

  console.log('=== acting sends, and never resolves locally ===');
  {
    const client = alice.isMyTurn ? alice : bob;
    const scene = alice.isMyTurn ? scenes.p1 : scenes.p2;
    const before = JSON.stringify(scene.turnOrder.map(u => u.currentHP));
    const v = client.state.version;

    const foe = client.state.units.find(u => u.side === 'enemy' && u.hp > 0);
    const verdict = scene._resolveAction({
      actor: client.state.current.ref, skill: 'basic_attack', target: foe.ref,
    });
    check('_resolveAction reports that it sent rather than resolved',
      verdict.ok === true && verdict.sent === true, JSON.stringify(verdict.reason ?? 'sent'));
    check('the local board did not move on its own',
      JSON.stringify(scene.turnOrder.map(u => u.currentHP)) === before);

    await until(() => client.state.version > v, 'the server to answer');
    await sleep(50);
    check('and then the server\'s board landed',
      JSON.stringify(scene.turnOrder.map(u => u.currentHP)) !== before);
  }

  // The block above spent that hunter's major action, so hand the turn over
  // before the loop starts — otherwise its first act is refused and the test
  // waits for a board that is never coming.
  {
    const client = alice.isMyTurn ? alice : bob;
    const v = client.state.version;
    client.endTurn();
    await until(() => client.state.version > v, 'the turn to pass');
  }

  console.log('=== a whole fight, played through the scene ===');
  let over = null;
  alice.on('over', m => { over = m; });
  const refusals = [];
  const seenEvents = [];
  alice.on('events', evs => seenEvents.push(...evs));
  alice.on('error', r => refusals.push('alice: ' + r));
  bob.on('error', r => refusals.push('bob: ' + r));

  let turns = 0;
  while (!over && turns < 300) {
    const client = alice.isMyTurn ? alice : (bob.isMyTurn ? bob : null);
    if (!client) break;
    const scene = client === alice ? scenes.p1 : scenes.p2;

    const foe = client.state.units.find(u => u.side === 'enemy' && u.hp > 0);
    if (foe) {
      const v = client.state.version;
      const errs = refusals.length;
      scene._resolveAction({
        actor: client.state.current.ref, skill: 'basic_attack', target: foe.ref,
      });
      // Either the board moves or the server says why not. Waiting only for a
      // board turns any refusal into an eight-second hang that reports nothing.
      await until(() => client.state.version > v || refusals.length > errs || over,
        'the board, or a reason it did not move');
      // Run the client's scheduled replay. In the browser this happens on its
      // own clock; here it has to be drained, and doing so proves the recorded
      // events actually execute rather than merely arriving.
      scenes.p1.__drain(); scenes.p2.__drain();
    }
    if (over) break;

    const v2 = client.state.version;
    client.endTurn();
    await until(() => client.state.version > v2 || over, 'the board after the turn ended');
    turns++;
  }
  await sleep(100);

  check('the fight finished', !!over, over?.outcome + ' after ' + turns + ' turns');

  // ---- rewards reach the LOCAL save, and only the local hunters ------------
  //
  // Run for BOTH players. The host and the joiner reach this code by different
  // routes -- one created the lobby and one was handed a scenario it may never
  // have unlocked -- and testing only the host is what let a joiner-side
  // reward failure through to a real game.
  if (over?.outcome === 'victory') {
    const ProgressionManager = (await import('../src/systems/ProgressionManager.js')).default;

    for (const [who, scene] of [['HOST (Alice)', scenes.p1], ['JOINER (Bob)', scenes.p2]]) {
      console.log('');
      console.log('=== rewards -- ' + who + ' ===');
      check('the server reported what the fight was worth',
        !!over.rewards && typeof over.rewards.xpReward === 'number',
        'xp ' + over.rewards?.xpReward + ', loot ' + (over.rewards?.loot?.length ?? 0));

      // A fresh save for this player: their own three hunters, nobody else's.
      const mine = scene.coopParty.filter(c => c.isLocal);
      check('this client knows which hunters are its own', mine.length === 3,
        mine.length + ' local hunters');

      const mineIds = mine.map(c => c.instanceId || c.id);
      GameState.party = mine.map(c => ({
        ...c, currentHP: 1, status: 'active', experience: 0, level: 1,
      }));
      ProgressionManager.completedScenarios = [];
      ProgressionManager.questFlags = [];
      ProgressionManager.huntTickets = 0;
      const before = GameState.party.map(c => c.experience || 0);

      const earned = scene._applyCoopRewards(over);

      check('only MY hunters were paid, never the other players',
        GameState.party.every(c => mineIds.includes(c.instanceId || c.id))
        && GameState.party.length === 3,
        GameState.party.length + ' hunters in the save');
      check('experience actually landed on the saved characters',
        GameState.party.every((c, i) => (c.experience || 0) > before[i]),
        GameState.party.map(c => c.experience || 0).join('/'));
      check('the scenario was marked cleared for them',
        GameState.party.every(c => GameState.hasCharacterCleared(c, over.rewards.scenarioId)));
      check('the victory screen has something to show',
        earned.xpSummary.length > 0, earned.xpSummary.slice(0, 2).join(' | '));

      // The things the player counts afterwards: tickets, the completion
      // itself, and the quest flags that open the next conversation in town.
      check('the scenario was recorded as completed',
        ProgressionManager.completedScenarios.includes(over.rewards.scenarioId),
        ProgressionManager.completedScenarios.join(', ') || 'nothing recorded');
      check('hunt tickets were actually paid',
        ProgressionManager.huntTickets > 0,
        ProgressionManager.huntTickets + ' tickets');
      check('the quest flags for this clear were set',
        ProgressionManager.questFlags.length > 0,
        ProgressionManager.questFlags.join(', ') || 'no flags set');

      // A second clear must not pay again for a non-repeatable fight.
      const after = GameState.party.map(c => c.experience || 0);
      const second = scene._applyCoopRewards(over);
      check('a repeat clear of a one-time fight pays nothing',
        GameState.party.every((c, i) => (c.experience || 0) === after[i]),
        second.xpSummary.slice(0, 1).join('') || 'no summary');

      GameState.party = [];
    }
  }
  // ---- ground zones and lodged arrows ------------------------------------
  //
  // Both were invisible in co-op for different reasons. A ground zone lives in
  // scene state keyed by SLOT rather than on any unit, so nothing about it
  // crossed the wire at all. A lodged arrow needed no new data -- the client
  // had the statusEffects all along -- only the redraw.
  console.log('');
  console.log('=== ground zones and lodged arrows ===');
  {
    check('the broadcast carries ground-zone state at all',
      alice.state.slotEffects !== undefined,
      typeof alice.state.slotEffects);

    // Feed a board that has a zone on it and confirm the client takes it.
    const sc = scenes.p1;
    const fake = { ...alice.state, version: alice.state.version + 5000,
      slotEffects: { ally_3: [{ id: 'runic_zone', element: 'arcane', turns: 2 }] } };
    sc._applyNetState(fake);
    check('a zone the server reports is mirrored onto the client',
      sc.slotEffects?.ally_3?.[0]?.id === 'runic_zone',
      JSON.stringify(sc.slotEffects));

    // Status-driven visuals redraw only when the effects CHANGE. Redrawing on
    // every broadcast reshuffles lodged arrows, because each is positioned
    // with Math.random() -- they visibly jump around the portrait.
    let lodgeDraws = 0;
    const realLodge = sc._refreshLodgeSprites;
    sc._refreshLodgeSprites = function (u) { lodgeDraws++; return realLodge?.call(this, u); };

    const withLodge = { ...alice.state, version: alice.state.version + 6000,
      units: alice.state.units.map(u => u.side === 'ally'
        ? { ...u, effects: [...(u.effects || []), { id: 'lodged', turns: 3 }] } : u) };
    sc._applyNetState(withLodge);
    const first = lodgeDraws;
    check('a newly lodged arrow triggers a redraw', first > 0, first + ' redraws');

    // The same board again: nothing changed, so nothing should be redrawn.
    sc._applyNetState({ ...withLodge, version: withLodge.version + 1 });
    check('an unchanged board does NOT reshuffle them',
      lodgeDraws === first, (lodgeDraws - first) + ' extra redraws');

    // Spending the lodge must redraw, or the arrow would stay on screen.
    sc._applyNetState({ ...alice.state, version: withLodge.version + 2 });
    check('spending a lodge redraws so the arrow can go', lodgeDraws > first,
      (lodgeDraws - first) + ' redraws after it was spent');
    sc._refreshLodgeSprites = realLodge;

    // And it must GO AWAY again, or a dissipated ring would be drawn forever.
    sc._applyNetState({ ...fake, version: fake.version + 1, slotEffects: {} });
    check('and cleared again when the zone dissipates',
      !sc.slotEffects?.ally_3?.length, JSON.stringify(sc.slotEffects));
  }

  check('no action was refused along the way', refusals.length === 0,
    refusals.slice(0, 3).join(' | '));
  // Again at the END, after a whole fight of enemy repositioning. The opening
  // board agreeing proves placement; only this proves movement is applied.
  const badLate = slotDisagreements();
  check('positions still agree after the whole fight',
    badLate.length === 0, badLate.slice(0, 4).join(' | ') || 'all agree');

  check('both scenes ended in agreement',
    JSON.stringify(scenes.p1.turnOrder.map(u => [u.name, u.currentHP])) ===
    JSON.stringify(scenes.p2.turnOrder.map(u => [u.name, u.currentHP])));
  check('both scenes agree with the server\'s last word',
    scenes.p1.enemies.every(e => {
      const said = alice.state.units.find(u => u.ref === e.uid);
      return said && said.hp === e.currentHP;
    }));
  check('the combat log reached the scene', scenes.p1.combatEntries.length > 0,
    scenes.p1.combatEntries.length + ' lines');

  // Turn separators are a SHAPE, not text. Routed through the text path they
  // rendered as "[object Object]" after every single turn.
  const rendered = scenes.p1.combatEntries
    .flatMap(e => (e.segments || []).map(g => g.text || ''));
  check('nothing in the log renders as [object Object]',
    !rendered.some(t => t.includes('[object Object]')),
    rendered.filter(t => t.includes('[object Object]')).length + ' bad lines');
  check('separators arrived as separators',
    scenes.p1.combatEntries.some(e => e.separator),
    scenes.p1.combatEntries.filter(e => e.separator).length + ' separators');

  // The visual recording is what gives a co-op client its VFX and its pacing.
  // Without it the board simply jumps from before to after.
  check('visual events were recorded and delivered', seenEvents.length > 0,
    seenEvents.length + ' events');
  check('they name units by reference, never by copy',
    seenEvents.every(e => (e.args || []).every(a =>
      a == null || typeof a !== 'object' || !('currentHP' in a))),
    'no whole characters on the wire');
  check('they carry clock timestamps, so pacing can be restored',
    seenEvents.some(e => typeof e.at === 'number'),
    'first at=' + seenEvents[0]?.at);
  check('an attack VFX is among them',
    seenEvents.some(e => e.fn === '_playAttackVFX'),
    [...new Set(seenEvents.map(e => e.fn))].join(', '));

  // Arriving is not the same as playing. This asserts the scene actually
  // invoked the VFX methods while replaying, rather than silently swallowing
  // them on an unresolvable reference or a bad argument.
  // The detailed damage breakdown a player hovers lives on a log segment, so
  // it only survives if entries cross STRUCTURED rather than flattened to text.
  const tipSeg = scenes.p1.combatEntries
    .flatMap(e => e.segments || [])
    .find(g => g.tooltipData && (g.tooltipData.lines || []).length);
  check('damage breakdowns survive the wire and reach the scene', !!tipSeg,
    tipSeg ? tipSeg.tooltipData.title + ', ' + tipSeg.tooltipData.lines.length + ' lines' : 'none found');
  check('a hovered ability resolves back to a real skill, not a reference',
    scenes.p1.combatEntries.flatMap(e => e.segments || [])
      .filter(g => g.ability).every(g => typeof g.ability === 'object' && g.ability.id),
    'rehydrated');

  check('the client REPLAYED them, not just received them',
    (scenes.p1.__skipped._playAttackVFX || 0) > 0,
    (scenes.p1.__skipped._playAttackVFX || 0) + ' attack VFX played back');

  alice.disconnect(); bob.disconnect();

} catch (err) {
  console.log('  FAIL  ' + (err?.message || err?.type || String(err)));
  if (serverOut.trim()) {
    console.log('  server said:');
    serverOut.trim().split('\n').forEach(l => console.log('    ' + l));
  }
  failures++;
} finally {
  stop();
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
