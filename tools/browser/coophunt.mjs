// tools/browser/coophunt.mjs
//
// Real-browser check of a CO-OP map hunt (Exploration System v2, chunk 12c):
// two players, each a page in ONE headless Edge (the owner's RAM rule: one
// browser at a time), on a co-op server run inside this process. NOT part of
// `npm run verify`: it needs Edge. Run it alone, never beside verify.
//
//   node tools/browser/coophunt.mjs [webgl|canvas] [outDir] [cdpPort]
//
// What it proves, with real clicks where a player would click:
//   - the Hunt screen's "Depart with friends" opens the co-op lobby as a HUNT
//     lobby, labelled with the region and plan; nothing is spent yet
//   - a guest joins by code from the ordinary co-op entry and sees the label
//   - Start: the host's plan and packed Rations are spent (as a solo Depart
//     spends them), and BOTH players land on the map, the guest's marked co-op
//   - the guest's two clicks on a neighbouring tile move the party for
//     everyone: the host's hunt took it, both maps agree
//   - an encounter shows on both; the guest is told to wait, and the host's
//     Fight click takes BOTH players into the same server fight, with the
//     hunt's enemies; only the host gets Flee
//   - a won fight: both see Victory, and "Back to the Hunt" (clicked, each)
//     returns both to the map with the beasts gone
//   - the guest's Leave (clicked, confirmed) takes the guest back to town
//   - no uncaught errors on either page
// Setup may drive the engine (walking the host to a fight, and playing the
// fight's turns through each page's own co-op client); the server's copy of
// the fight is made quick to win from this process, since the check is the
// hand-over and the screens, not the battle.

import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startBrowser } from './lib.mjs';

// ── The co-op server, in this process ─────────────────────────────────────────
const { installPhaserStub } = await import('../headless/phaserStub.js');
installPhaserStub(0, { deterministic: false });
const { createHub } = await import('../../server/protocol.js');
const CSM = await import('../../src/scenes/CombatScene.js');
const CombatScene = CSM.default || Object.values(CSM).find(v => typeof v === 'function');
const { WebSocketServer } = await import('ws');
const hub = createHub({ CombatScene });
const httpServer = http.createServer();
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (socket) => {
  const conn = { send(m) { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m)); } };
  socket.on('message', (d) => { try { hub.handle(conn, String(d)); } catch (e) { console.error('[hub]', e); } });
  socket.on('close', () => hub.disconnect(conn));
});
await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
const WS_URL = `ws://127.0.0.1:${httpServer.address().port}`;
const T0 = Date.now();
const stage = (m) => console.log(`-- ${((Date.now() - T0) / 1000).toFixed(1)}s ${m}`);
stage('co-op server up at ' + WS_URL);

const mode = process.argv[2] || 'webgl';
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'coophunt-shots'));
const port = Number(process.argv[4] || 9353);
stage('starting Edge');
const B = await startBrowser({ mode, port, outDir: out, prefix: `${mode}-host` });
const H = B;                                   // the host's page
stage('host page up');
// Its own origin, so its own localStorage: two players, two saves (12d).
const G = await B.openPage(`${mode}-guest`, { hostName: 'localhost' });   // the guest's page
stage('guest page up');
const { check, sleep } = B;
const LOBBY = 'CoopLobbyScene', MAP = 'HuntFieldOverlay', HUB = 'HuntHubOverlay';

const waitFor = (P, expr, ms = 15000) => P.evaluate(`for (let i = 0; i < ${Math.ceil(ms / 200)}; i++) { if (${expr}) return true; await new Promise(r => setTimeout(r, 200)); } return false;`);
const active = (P, key) => P.evaluate(`return window.__T.g().scene.isActive('${key}');`);
const setInput = (P, field, name, value) => P.evaluate(`
  const s = window.__T.g().scene.getScene('${LOBBY}'); const el = s.${field}?.getChildByName('${name}');
  if (!el) return false; el.value = ${JSON.stringify(value)}; return true;`);
// Each page's own party, in memory: the two pages share a browser profile and
// so the save, and one hunter cannot be brought twice.
const bootWith = (P, from, extra = '') => P.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  const party = makeParty().slice(${from}, ${from + 3}); GS.characters = party; GS.party = party;
  ${extra}`);

try {
  // ── 1. The host: Hunt screen -> Depart with friends ─────────────────────────
  await H.loadGame();
  stage('host game loaded');
  await bootWith(H, 0, `
    const { InventorySystem } = await import('/src/systems/InventorySystem.js');
    const { makeStack } = await import('/src/systems/ItemStacks.js');
    const { createItemInstance } = await import('/src/systems/ItemFactory.js');
    InventorySystem.addGlobalItem(makeStack('rations', 100));
    window.__plan = createItemInstance('plan_retrieve_small', { rarity: 'rare', itemLevel: 3 });
    InventorySystem.addGlobalItem(window.__plan);`);
  await H.evaluate(`
    const Gm = window.__T.g(); Gm.scene.getScene('TownScene')._enterHuntGate();
    await new Promise(r => setTimeout(r, 900));
    const hub = Gm.scene.getScene('${HUB}'); const GS = (await import('/src/systems/GameState.js')).default;
    hub.setZone('reeds_of_gethsemane'); hub.setHuntPlan(GS.inventory.find(i => i.instanceId === window.__plan.instanceId));
    return true;`);
  for (let i = 0; i < 2; i++) await H.clickText('^[+]$', HUB);
  const bag = () => H.evaluate(`const GS = (await import('/src/systems/GameState.js')).default;
    return { rations: GS.inventory.filter(i => i.id === 'rations').reduce((t, i) => t + (i.qty || 1), 0), plan: GS.inventory.some(i => i.instanceId === window.__plan.instanceId) };`);
  const bag0 = await bag();
  await H.shot('01-hunt-screen');
  await H.clickText('^Depart with friends$', HUB);
  check('"Depart with friends" opens the co-op lobby', await waitFor(H, `window.__T.g().scene.isActive('${LOBBY}')`));
  await sleep(500);
  check('...as a HUNT lobby, labelled with the region and plan',
    !!(await H.findText('^CO-OP HUNT$', LOBBY)) && !!(await H.findText('^(The )?Reeds of Gethsemane: ', LOBBY)),
    (await H.findText('Reeds of Gethsemane: ', LOBBY))?.text);
  check('...and nothing is spent yet', JSON.stringify(await bag()) === JSON.stringify(bag0), JSON.stringify(bag0));
  await setInput(H, 'serverInput', 'server', WS_URL);
  await setInput(H, 'nameInput', 'playerName', 'Hana');
  await H.clickText('^Host$', LOBBY);
  check('the host has a lobby code', await waitFor(H, `!!window.__T.g().scene.getScene('${LOBBY}').client?.code`));
  const code = await H.evaluate(`return window.__T.g().scene.getScene('${LOBBY}').client.code;`);
  await H.shot('02-lobby');

  // ── 2. The guest joins from the ordinary co-op entry ────────────────────────
  await G.loadGame();
  await bootWith(G, 3, `
    const { InventorySystem } = await import('/src/systems/InventorySystem.js');
    const { makeStack } = await import('/src/systems/ItemStacks.js');
    InventorySystem.addGlobalItem(makeStack('rations', 30));`);
  const guestRations = () => G.evaluate(`const GS = (await import('/src/systems/GameState.js')).default;
    return GS.inventory.filter(i => i.id === 'rations').reduce((t, i) => t + (i.qty || 1), 0);`);
  await G.evaluate(`window.sceneManager.loadScene('${LOBBY}', 'Opening the lobby…', { scenarioIds: ['training_encounter_1'], scenarioId: 'training_encounter_1' }); return true;`);
  await waitFor(G, `window.__T.g().scene.isActive('${LOBBY}')`);
  await sleep(500);
  await setInput(G, 'serverInput', 'server', WS_URL);
  await setInput(G, 'nameInput', 'playerName', 'Gus');
  await setInput(G, 'codeInput', 'code', code);
  await G.clickText('^Join$', LOBBY);
  check('the guest joins by code', await waitFor(G, `!!window.__T.g().scene.getScene('${LOBBY}').client?.playerId`));
  await sleep(400);
  check('...and sees it is a hunt, and which', !!(await G.findText('^CO-OP HUNT$', LOBBY)) && !!(await G.findText('^(The )?Reeds of Gethsemane: ', LOBBY)));
  await G.shot('02-lobby');

  // ── 3. Ready, Start: both on the map ────────────────────────────────────────
  // 12d: the guest pledges 10 Rations (one click of +).
  await G.clickText('^[+]$', LOBBY);
  await sleep(400);
  check('the guest pledges Rations in the lobby, and the host sees it',
    !!(await G.findText('^Rations you bring: 10', LOBBY)) && await waitFor(H, `window.__T.g().scene.getScene('${LOBBY}').client.lobby.players.find(p => p.id !== 'p1')?.rations === 10`, 4000));
  await G.clickText('^Toggle Ready$', LOBBY);
  await H.clickText('^Toggle Ready$', LOBBY);
  await sleep(400);
  await H.clickText('^Start Hunt$', LOBBY);
  const onMap = (P) => waitFor(P, `window.__T.g().scene.isActive('${MAP}') && !!window.__T.s()?.coop?.view()`);
  check('Start: the host is on the map', await onMap(H));
  check('...and so is the guest', await onMap(G));
  const bag1 = await bag();
  check("the guest's pledged 10 Rations left the guest's bag at Start", (await guestRations()) === 20, `${await guestRations()}`);
  check("...and are in the hunt's pack with the host's 20",
    (await H.evaluate(`return window.__T.s().coop.hunt.getState().pack.brought.filter(i => i.id === 'rations').reduce((t, i) => t + (i.qty || 1), 0);`)) === 30);
  check('the host\'s plan and packed Rations were spent at the start', !bag1.plan && bag1.rations === bag0.rations - 20, `${JSON.stringify(bag0)} -> ${JSON.stringify(bag1)}`);
  await sleep(600);
  check('the guest\'s map says co-op, the host\'s says host',
    !!(await G.findText('co-op$')) && !!(await H.findText('co-op \\(host\\)$')));
  const posOf = (P) => P.evaluate(`return window.__T.s().coop.view().pos;`);
  check('both maps have the party on the same tile', (await posOf(H)) === (await posOf(G)));
  await H.shot('03-map');
  await G.shot('03-map');

  // ── 4. The guest moves the party (two real clicks) ──────────────────────────
  const target = await G.evaluate(`
    const s = window.__T.s(); const v = s.coop.view();
    const m = v.moves.find(x => v.layout.includes(x.tile)); if (!m) return null;
    const c = s.center(m.tile); return { tile: m.tile, x: c.x, y: c.y };`);
  check('the guest has a tile to move to', !!target);
  if (target) {
    await G.click(target.x, target.y);
    await G.click(target.x, target.y);
    await waitFor(H, `window.__T.s().coop.view().pos === ${JSON.stringify(target.tile)}`, 6000);
    await waitFor(G, `window.__T.s().coop.view().pos === ${JSON.stringify(target.tile)}`, 6000);
    const [hp, gp] = [await posOf(H), await posOf(G)];
    check('the guest\'s clicks moved the party: the host\'s hunt took it, both maps agree', hp === target.tile && gp === target.tile, `${hp} / ${gp}`);
    await G.shot('04-guest-moved');
  }

  // ── 5. To a fight; the host's Fight click takes both players there ──────────
  const walked = await H.evaluate(`
    const s = window.__T.s(); const coop = s.coop; const h = coop.hunt;
    const { mapNeighbors } = await import('/src/systems/HuntMapGen.js'); const { isPassable } = await import('/data/grounds.js');
    for (let i = 0; i < 400; i++) {
      const v = coop.view(); const st = h.getState();
      if (v.encounter) return v.encounter.kind;
      if (v.event) { s._act('leave', () => s.hunt.leaveEvent()); continue; }
      if (v.spoils) { s._act('leave', () => s.hunt.harvest({ take: [], meat: false })); continue; }
      const want = new Set(st.map.occupants.filter(o => o.kind === 'beast').map(o => o.tile));
      const prev = new Map([[st.pos, null]]); const q = [st.pos]; let g = null;
      for (let k = 0; k < q.length && !g; k++) for (const n of mapNeighbors(st.map, q[k])) {
        if (prev.has(n) || !isPassable(st.map.tiles[n])) continue; prev.set(n, q[k]); q.push(n); if (want.has(n)) { g = n; break; } }
      if (!g) return 'unreachable';
      let t = g; while (prev.get(t) !== st.pos) t = prev.get(t);
      s._act('move', () => s.hunt.move(t));
    }
    return 'gave up';`);
  check('the host walked the party into an encounter', walked === 'beast' || walked === 'cultist', walked);
  await waitFor(G, `!!window.__T.s().coop.view()?.encounter`, 6000);
  await sleep(500);
  check('the guest sees it, and is told to wait for the host', !!(await G.findText('^Waiting for the host to fight\\.$')));
  await G.shot('05-encounter-guest');
  await H.clickText('^Fight$');
  const inFight = (P) => waitFor(P, `window.__T.g().scene.isActive('CombatScene') && window.__T.g().scene.getScene('CombatScene').isCoop && (window.__T.g().scene.getScene('CombatScene').enemies || []).length > 0`, 20000);
  check('the host\'s Fight click takes the host into the co-op fight', await inFight(H));
  check('...and the guest into the same one', await inFight(G));
  const lobby = [...hub.lobbies.values()].find(l => l.code === code);
  const board = (P) => P.evaluate(`const c = window.__T.g().scene.getScene('CombatScene'); return { enemies: c.enemies.map(e => e.name).sort(), flee: !!c.fleeButton, scenario: c.scenarioData?.id };`);
  const [hb, gb] = [await board(H), await board(G)];
  check('both boards hold the hunt\'s enemies, as the server has them',
    JSON.stringify(hb.enemies) === JSON.stringify(gb.enemies) && JSON.stringify(hb.enemies) === JSON.stringify(lobby.session.host.enemies.map(e => e.name).sort()), hb.enemies.join(', '));
  check('only the host has Flee', hb.flee && !gb.flee);
  await sleep(800);
  await G.shot('06-fight-guest');

  // ── 6. Win it (quickly), back to the map ────────────────────────────────────
  for (const u of lobby.session.party) { u.maxHP = 9999; u.currentHP = 9999; }
  for (const e of lobby.session.host.enemies) { e.currentHP = 1; }
  const pageOf = { [lobby.hostId]: H, [lobby.players.find(p => p.id !== lobby.hostId).id]: G };
  for (let t = 0; t < 200 && lobby.session; t++) {
    const cur = lobby.session.current();
    if (!cur || cur.ownerId == null) { await sleep(100); continue; }
    const foe = lobby.session.host.enemies.find(e => e.status !== 'incapacitated' && e.currentHP > 0);
    await pageOf[cur.ownerId].evaluate(`const c = window.__T.g().scene.getScene('CombatScene').coopClient;
      ${foe ? `c.act({ actor: ${JSON.stringify(cur.ref)}, skill: 'basic_attack', target: ${JSON.stringify(lobby.session.host._unitRef(foe))} });` : ''}
      await new Promise(r => setTimeout(r, 150)); c.endTurn(); return true;`);
    await sleep(250);
  }
  // The server clears its copy of the outcome once the host has applied it
  // and published again, so the host's hunt is where the win is read.
  check("the fight is over on the server, and the host's hunt has the kill", !lobby.session && await waitFor(H, "(window.__T.g().scene.getScene('CombatScene')?.coopHunt || window.__T.s()?.coop)?.hunt?.getState().kills.length > 0", 6000));
  const victory = (P) => waitFor(P, `window.__T.textsOf('CombatScene').some(t => t.text === 'Back to the Hunt')`, 8000);
  check('both see the victory screen with "Back to the Hunt"', (await victory(H)) && (await victory(G)));
  await G.shot('07-victory-guest');
  await H.clickText('^Back to the Hunt$', 'CombatScene');
  await G.clickText('^Back to the Hunt$', 'CombatScene');
  check('"Back to the Hunt" returns the host to the map', await onMap(H));
  check('...and the guest', await onMap(G));
  await sleep(600);
  const after = (P) => P.evaluate(`const v = window.__T.s().coop.view(); return { encounter: !!v.encounter, kills: v.log.filter(l => l.kind === 'win' || l.kind === 'kill').length, pos: v.pos };`);
  const [ha, ga] = [await after(H), await after(G)];
  check('both maps have the fight won and the encounter gone', !ha.encounter && !ga.encounter && JSON.stringify(ha) === JSON.stringify(ga), JSON.stringify(ga));
  await G.shot('08-back-on-map-guest');

  // ── 6b. The host reloads the page and rejoins (chunk 12d) ────────────────
  const guestPos = await posOf(G);
  await H.loadGame();
  await H.bootToTown(`const GS = (await import('/src/systems/GameState.js')).default; GS.load('autosave');`);
  check("the host's reloaded save holds its co-op hunt", await H.evaluate(`const GS = (await import('/src/systems/GameState.js')).default; return !!GS.flags?.coopActive?.isHost;`));
  check('the town offers to rejoin it', await waitFor(H, `window.__T.uiTexts().some(t => /You were in a co-op hunt/.test(t.text))`, 8000));
  await H.shot('10-rejoin-offer');
  // The button, not the message (which says "Enter to rejoin").
  await H.clickText('^\\[ Enter \\]$', 'UIScene');
  check('Enter: the host is back on the map', await onMap(H));
  await sleep(600);
  check("...where the party stood, the same map as the guest's", (await posOf(H)) === guestPos && (await posOf(G)) === guestPos, `${await posOf(H)} / ${guestPos}`);
  const next = await H.evaluate(`const s = window.__T.s(); const v = s.coop.view();
    if (v.spoils) s._act('leave', () => s.hunt.harvest({ take: [], meat: false }));
    const m = s.coop.view().moves.find(x => s.coop.view().layout.includes(x.tile)); if (!m) return null;
    s._act('move', () => s.hunt.move(m.tile)); return m.tile;`);
  check('...and carries on: its next move reaches the guest', !!next && await waitFor(G, `window.__T.s().coop.view().pos === ${JSON.stringify(next)}`, 6000), next);
  await H.shot('11-host-rejoined');

  // ── 7. The guest leaves ─────────────────────────────────────────────────────
  // Leave is offered on the party's own tile: select it first.
  const own = await G.evaluate(`const s = window.__T.s(); const c = s.center(s.coop.view().pos); return { x: c.x, y: c.y };`);
  await G.click(own.x, own.y);
  await sleep(300);
  await G.clickText('^Leave the co-op hunt$');
  await sleep(300);
  await G.clickText('^\\[ Enter \\]$', 'UIScene');
  check('the guest\'s Leave (confirmed) takes the guest back to town',
    await waitFor(G, `!window.__T.g().scene.isActive('${MAP}') && window.__T.g().scene.isActive('TownScene')`, 6000));
  await G.shot('09-guest-left');
  // A guest leaving early takes a clean exit home (rule 7): the Rations left,
  // split by what each brought, and the pack's finds, into the REAL save.
  const home = await G.evaluate(`const GS = (await import('/src/systems/GameState.js')).default;
    const rec = GS.flags?.coopHunts || {}; const r = Object.values(rec)[0];
    const saved = JSON.parse(localStorage.getItem('bmSave_autosave') || 'null');
    return { closed: !!r?.closed, rations: GS.inventory.filter(i => i.id === 'rations').reduce((t, i) => t + (i.qty || 1), 0),
      savedClosed: !!Object.values(saved?.flags?.coopHunts || {})[0]?.closed };`);
  check("the guest's save took its share home once, and saved it", home.closed && home.savedClosed, JSON.stringify(home));
  check("...Rations came back to the guest's bag (a share of what was left)", home.rations > 20 && home.rations <= 30, `${home.rations}`);

  check('no uncaught errors on the host\'s page', H.errors.length === 0, H.errors.slice(0, 3).join(' | '));
  check('no uncaught errors on the guest\'s page', G.errors.length === 0, G.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('the run completed', false, e.message);
} finally {
  await B.close();
  wss.close(); httpServer.close();
}

const all = [...B.checks];
const failed = all.filter(c => !c.ok).length;
console.log(`\n${all.length - failed} / ${all.length} passed (${mode}); screenshots in ${out}`);
process.exit(failed ? 1 : 0);
