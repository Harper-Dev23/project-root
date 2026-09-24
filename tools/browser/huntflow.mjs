// tools/browser/huntflow.mjs
//
// Real-browser check of a hunt from departure to leaving (Exploration System
// v2, chunk 8c). NOT part of `npm run verify`: it needs Microsoft Edge.
//
//   node tools/browser/huntflow.mjs webgl  [outDir] [cdpPort]
//   node tools/browser/huntflow.mjs canvas [outDir] [cdpPort]
//
// What it proves, all in the real page with real clicks and real reloads:
//   - the Hunt screen shows all eight party stats and who provides each
//   - the Rations packing cap is 60
//   - Depart starts a hunt on the hex map with the plan's objective and size,
//     uses up the plan, packs the Rations, and opens the map scene
//   - every action autosaves: the saved position follows each move
//   - a page reload lands back on the map, where the party stood
//   - a reload with a fight pending comes back fled
//   - leaving through an exit pays, banks the pack, and the save then holds no
//     hunt; the Hunt screen opens on planning again
//   - an OLD save (tools/snapshots/save-v6-fixture.json, written by 8b's build)
//     holding an Advance hunt reopens the old Hunt screen, which still advances
//   - the Hunt screen bug 8b found is fixed: Inventory opened and closed
//     mid-hunt, then a click on the Hunt screen over the town's Bonfire does
//     nothing (it opened character creation before)
//   - no uncaught errors
//   - chunk 9b: a fight on the map is REAL: clicking Fight starts CombatScene
//     with the occupant's roster (the side the hunt said acts first opens it),
//     a won fight's "Back to the Hunt" (clicked) returns to the map with the
//     occupant gone and the win saved; a wipe in a Sheltered region kills
//     nobody, ends the hunt, and Exit (clicked) goes back to town
//   - chunk 9c: Flee is offered inside the fight on a hunter's turn (not on the
//     map panel); clicking it plays the enemy's free round and ends the fight
//     as fled, and Back to the Hunt returns to a map where the pack hunts you
// Test setup may drive the engine directly (walking to a fight or an exit),
// but through the scene's own _act, so autosave runs as it does for a click.
// A fight's OUTCOME is forced from the page (every enemy, or every hunter,
// knocked out, then the scene's own _checkVictoryCondition): the check is the
// hand-over and the screens, not the battle, which the headless combat golden
// runs in full.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startBrowser, REPO } from './lib.mjs';

const mode = process.argv[2] || 'webgl';
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'huntflow-shots'));
const port = Number(process.argv[4] || 9343);
const B = await startBrowser({ mode, port, outDir: out });
const { evaluate, shot, click, check, sleep, clickText, findText, key } = B;
const HUB = 'HuntHubOverlay';

const fixture = fs.readFileSync(path.join(REPO, 'tools/snapshots/save-v6-fixture.json'), 'utf8');
const saved = () => evaluate(`const r = localStorage.getItem('bmSave_autosave'); return r ? JSON.parse(r) : null;`);
const bagRations = () => evaluate(`const GS = (await import('/src/systems/GameState.js')).default; return GS.inventory.filter(i => i.id === 'rations').reduce((t, i) => t + (i.qty || 1), 0);`);

// Walk the map hunt toward a goal through the scene's own action path.
const walkTo = (goal) => evaluate(`
  const s = window.__T.s(); const h = s.hunt; (await import('/tools/headless/walkAway.js')).walkAway(h);
  const { mapNeighbors } = await import('/src/systems/HuntMapGen.js');
  const { isPassable } = await import('/data/grounds.js');
  const goalOf = (st) => ${goal};
  for (let i = 0; i < 400; i++) {
    const st = h.getState();
    if (h.encounter()) { if (${JSON.stringify(goal)}.includes('FIGHT')) return 'fight'; s._act('win', () => h.winEncounter()); continue; }
    const want = goalOf(st);
    if (want.has(st.pos)) return 'there';
    const prev = new Map([[st.pos, null]]); const q = [st.pos]; let g = null;
    for (let k = 0; k < q.length && !g; k++) for (const n of mapNeighbors(st.map, q[k])) {
      if (prev.has(n) || !isPassable(st.map.tiles[n])) continue; prev.set(n, q[k]); q.push(n); if (want.has(n)) { g = n; break; } }
    if (!g) return 'unreachable';
    let t = g; while (prev.get(t) !== st.pos) t = prev.get(t);
    s._act('move', () => h.move(t));
  }
  return 'gave up';
`);

const waitFor = (expr, ms = 15000) => evaluate(`for (let i = 0; i < ${Math.ceil(ms / 200)}; i++) { if (${expr}) return true; await new Promise(r => setTimeout(r, 200)); } return false;`);
const combatReady = "window.__T.g().scene.isActive('CombatScene') && (window.__T.g().scene.getScene('CombatScene').enemies || []).length > 0 && (window.__T.g().scene.getScene('CombatScene').turnOrder || []).length > 0";

await B.loadGame();
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  const { InventorySystem } = await import('/src/systems/InventorySystem.js');
  const { makeStack } = await import('/src/systems/ItemStacks.js');
  const { createItemInstance } = await import('/src/systems/ItemFactory.js');
  const party = makeParty(); GS.characters = party; GS.party = party;
  InventorySystem.addGlobalItem(makeStack('rations', 100));
  window.__plan = createItemInstance('plan_retrieve_small', { rarity: 'rare', itemLevel: 3 });
  InventorySystem.addGlobalItem(window.__plan);
`);
check(`renderer is ${mode === 'canvas' ? 'CANVAS' : 'WEBGL'}`, (await evaluate('return window.__T.g().renderer.type;')) === (mode === 'canvas' ? 1 : 2));

// ---- 1. The Hunt screen: zone, plan, packing, the eight stats -------------
await evaluate(`
  const G = window.__T.g(); G.scene.getScene('TownScene')._enterHuntGate();
  await new Promise(r => setTimeout(r, 900));
  const hub = G.scene.getScene('HuntHubOverlay');
  const GS = (await import('/src/systems/GameState.js')).default;
  hub.setZone('reeds_of_gethsemane');
  hub.setHuntPlan(GS.inventory.find(i => i.instanceId === window.__plan.instanceId));
  return true;`);
for (let i = 0; i < 9; i++) await clickText('^[+]$', HUB);
await shot('01-loadout');
const packedLine = (await findText('Rations packed', HUB))?.text || '';
check('the packing cap is 60: nine clicks of +10 with 100 in the bag pack 60', /\+ 60 Rations packed/.test(packedLine), packedLine);
const STATS = ['Perception', 'Endurance', 'Speed', 'Cooking', 'Fishing', 'Foraging', 'Item Rarity', 'Party Initiative'];
const statTexts = (await evaluate(`return window.__T.textsOf('${HUB}').map(t => t.text);`)).filter(t => STATS.some(s => t.startsWith(s + ' ')));
check('the Hunt screen shows all eight party stats', STATS.every(s => statTexts.some(t => t.startsWith(s + ' '))), statTexts.join(' | '));
check('...and who provides each best-of stat', ['Perception', 'Cooking', 'Fishing', 'Foraging'].every(s => statTexts.some(t => t.startsWith(s + ' ') && /\(\w+\)$/.test(t))));
const stats = await evaluate(`
  const { partyStats } = await import('/src/systems/PartyStats.js'); const { huntMods } = await import('/src/systems/HuntRules.js');
  const { getZone } = await import('/data/zones.js'); const GS = (await import('/src/systems/GameState.js')).default;
  const st = partyStats(GS.party, huntMods(getZone('reeds_of_gethsemane').modifiers, {}, window.__plan.instanceMods.misc));
  return { perception: st.perception, by: st.providers.perception };`);
check('...with the numbers partyStats gives (Perception)', statTexts.includes(`Perception ${Math.round(stats.perception * 10) / 10} (${stats.by})`), `${stats.perception} (${stats.by})`);

// ---- 2. Depart ---------------------------------------------------------------
const bagBefore = await bagRations();
await clickText('^Depart$', HUB);
await sleep(900);
const dep = await evaluate(`
  const { HuntManager } = await import('/src/systems/HuntManager.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  const G = window.__T.g(); const v = HuntManager.current()?.view();
  return { mode: HuntManager.mode(), field: G.scene.isActive('HuntFieldOverlay'), hub: G.scene.isActive('HuntHubOverlay'),
    objective: v?.plan.objective, size: v?.plan.size, level: v?.plan.itemLevel, layout: v?.layout.length,
    planInBag: GS.inventory.some(i => i.instanceId === window.__plan.instanceId), supplies: v?.supplies };`);
check('Depart starts a hunt on the hex map and opens the map scene (the Hunt screen closes)', dep.mode === 'map' && dep.field && !dep.hub, JSON.stringify(dep));
check('...with the plan\'s objective, size and item level (Retrieve, Small, 3)', dep.objective === 'retrieve' && dep.size === 'small' && dep.level === 3 && dep.layout === 37);
check('...the plan used up, 60 Rations packed', !dep.planInBag && bagBefore - (await bagRations()) === 60 && dep.supplies >= 120, `supplies ${dep.supplies}`);
const s0 = await saved();
check('...and saved at once: the autosave holds the map hunt', s0?.version === 8 && s0?.hunt?.mode === 'map', `v${s0?.version}`);
await shot('02-departed');

// ---- 3. Every action autosaves ------------------------------------------------
let followed = true;
for (let i = 0; i < 3; i++) {
  const mv = await evaluate(`const s = window.__T.s(); if (s.v.encounter) return null; s.panel = null; s.selected = s.v.pos; s._refresh(); const m = s.v.moves.find(m => s.v.layout.includes(m.tile)); return { to: m.tile, ...s.center(m.tile) };`);
  if (!mv) break;
  await click(mv.x, mv.y); await click(mv.x, mv.y);
  const pos = await evaluate('return window.__T.s().hunt.view().pos;');
  const sv = await saved();
  if (sv?.hunt?.pos !== pos) followed = false;
}
check('every move (by click) autosaves: the saved position follows the party', followed);
// Settle any fight the walk started: a reload with one pending is a flee (its
// own step below), and a flee retreats, which would move the party.
await evaluate(`const s = window.__T.s(); if (s.v.encounter) s._act('flee', () => s.hunt.flee()); return 1;`);
const posBefore = await evaluate('return window.__T.s().hunt.view().pos;');

// ---- 4. Reload the page ----------------------------------------------------------
await B.loadGame();
await B.bootToTown(`const GS = (await import('/src/systems/GameState.js')).default; GS.load('autosave');`);
await sleep(600);
const back = await evaluate(`
  const { HuntManager } = await import('/src/systems/HuntManager.js'); const G = window.__T.g();
  return { mode: HuntManager.mode(), field: G.scene.isActive('HuntFieldOverlay'), hub: G.scene.isActive('HuntHubOverlay'),
    pos: HuntManager.current()?.view().pos, same: window.__T.s()?.hunt === HuntManager.current() };`);
check('a page reload lands back on the map scene, where the party stood', back.mode === 'map' && back.field && !back.hub && back.pos === posBefore && back.same, JSON.stringify(back));
await shot('03-after-reload');

// ---- 5. Reload with a fight pending -------------------------------------------------
const fight = await walkTo("new Set(st.map.occupants.filter(o => o.kind === 'beast' || o.kind === 'cultist').map(o => o.tile)) /* FIGHT */");
check('walked into a fight', fight === 'fight', fight);
await shot('04-fight-pending');
check('...and it is saved with the fight pending', !!(await saved())?.hunt?.encounter);
await B.loadGame();
await B.bootToTown(`const GS = (await import('/src/systems/GameState.js')).default; GS.load('autosave');`);
await sleep(600);
const fled = await evaluate(`const { HuntManager } = await import('/src/systems/HuntManager.js'); const v = HuntManager.current().view();
  return { enc: !!v.encounter, reload: v.log.some(l => l.kind === 'flee' && l.reason === 'reload'), field: window.__T.g().scene.isActive('HuntFieldOverlay') };`);
check('a reload with a fight pending comes back fled (logged as a reload), on the map', !fled.enc && fled.reload && fled.field, JSON.stringify(fled));
await shot('05-reloaded-fled');

// ---- 5b. A real fight from the map (chunk 9b) ----------------------------------------
const fight2 = await walkTo("new Set(st.map.occupants.filter(o => o.kind === 'beast' || o.kind === 'cultist').map(o => o.tile)) /* FIGHT */");
check('walked into another fight', fight2 === 'fight', fight2);
const pre = await evaluate(`const h = window.__T.s().hunt; const e = h.encounter(); const occ = h.getState().map.occupants.find(o => o.id === e.occId);
  return { occId: e.occId, first: e.first, n: occ.roster.length, kills: h.getState().kills.length };`);
check('the encounter panel offers Fight, and no TEST button any more', !!(await findText('^Fight$', 'HuntFieldOverlay')) && !(await findText('TEST', 'HuntFieldOverlay')));
await clickText('^Fight$', 'HuntFieldOverlay');
check('clicking Fight starts CombatScene', await waitFor(combatReady));
await sleep(800);
const board = await evaluate(`const c = window.__T.g().scene.getScene('CombatScene');
  return { n: c.enemies.length, firstEnemy: !!c.turnOrder[0].isEnemy, map: !!c.huntFight, field: window.__T.g().scene.isActive('HuntFieldOverlay') };`);
check('...with one enemy per roster member, the map scene closed', board.map && board.n === pre.n && !board.field, JSON.stringify(board));
check(`...and the side the hunt said acts first (${pre.first}) opens the fight`, board.firstEnemy === (pre.first === 'enemy'));
await shot('05b-fight');
await evaluate(`const c = window.__T.g().scene.getScene('CombatScene');
  for (const e of c.enemies) { e.currentHP = 0; e.status = 'incapacitated'; } c._checkVictoryCondition(); return 1;`);
check('the fight is won: the victory screen offers Back to the Hunt', await waitFor("window.__T.textsOf('CombatScene').some(t => t.text === 'Back to the Hunt')"));
await shot('05c-victory');
await clickText('^Back to the Hunt$', 'CombatScene');
check('Back to the Hunt (clicked) returns to the map', await waitFor("window.__T.g().scene.isActive('HuntFieldOverlay') && !window.__T.g().scene.isActive('CombatScene')"));
await sleep(600);
const won = await evaluate(`const h = window.__T.s().hunt; const st = h.getState();
  return { gone: !st.map.occupants.some(o => o.id === ${JSON.stringify(pre.occId)}), kills: st.kills.length, enc: !!h.encounter() };`);
const svWon = await saved();
check('...the occupant is gone, the kill recorded, and the win saved', won.gone && won.kills === pre.kills + 1 && !won.enc
  && svWon?.hunt?.mode === 'map' && svWon.hunt.kills.length === pre.kills + 1, JSON.stringify(won));
await shot('05d-back-on-map');

// ---- 5b''. The prophet boon (chunk 10b): the HUD line, its hover, and the level-up notice ----
{
  const bv = await evaluate(`const h = window.__T.s().hunt; const b = h.view().boon; const k = h.getState().kills.at(-1);
    return { ...b, mark: k?.mark, kind: k?.kind };`);
  const line = await evaluate(`return window.__T.textsOf('HuntFieldOverlay').map(t => t.text).find(t => t.startsWith('✦ ')) || null;`);
  check(`the HUD shows the region's boon (${bv.house}, level ${bv.level}, favor ${bv.favor})`,
    !!line && line.includes(bv.house[0].toUpperCase() + bv.house.slice(1)) && (bv.level ? line.includes(`boon ${bv.level}`) : line.includes('watches')), line);
  check(`...and the win paid favor only for a marked beast (this kill: ${bv.kind}, ${bv.mark})`, (bv.kind === 'beast' && bv.mark === 'marked') === (bv.favor > 0));
  const tip = await evaluate(`const sc = window.__T.g().scene.getScene('HuntFieldOverlay');
    const t = sc.layer.list.find(o => typeof o.text === 'string' && o.text.startsWith('✦ ')); t.emit('pointerover');
    await new Promise(r => setTimeout(r, 200));
    const lines = window.__T.textsOf('HuntFieldOverlay').map(x => x.text).filter(x => /Tortoise|Visionary|marked beasts|Level 5 only/.test(x));
    t.emit('pointerout'); return lines;`);
  check('hovering it names the house and says how favor is earned', tip.length >= 2, JSON.stringify(tip));
  if (bv.level > 0) {
    const said = await evaluate(`return window.__T.textsOf('UIScene').map(t => t.text).find(t => t.includes('boon rises to level')) || null;`);
    check('...and the level earned in the fight was announced on the map', !!said, said);
  } else {
    console.log('    (this kill earned no level, so no level-up notice to check)');
  }
  // A level earned on the map, through the engine's own booking (as the shrine
  // does), then the scene's own redraw: the notice and the new HUD line.
  const lvl = await evaluate(`const sc = window.__T.s(); const b0 = sc.hunt.view().boon.level;
    sc.hunt._earnFavor(sc.hunt.view().boon.toNext, 'test'); sc._refresh();   // exactly what the next level needs
    await new Promise(r => setTimeout(r, 300));
    return { b0, b1: sc.hunt.view().boon.level, said: window.__T.textsOf('UIScene').map(t => t.text).find(t => t.includes('boon rises to level')) || null,
      line: window.__T.textsOf('HuntFieldOverlay').map(t => t.text).find(t => t.startsWith('✦ ')) || null };`);
  check('a level earned on the map is announced in the dialogue bar, and the HUD line shows it',
    lvl.b1 > lvl.b0 && !!lvl.said && lvl.said.includes(`level ${lvl.b1}`) && lvl.line.includes(`boon ${lvl.b1}`), JSON.stringify(lvl));
  await shot('05d1-boon');
}

// ---- 5b'. Harvest (chunk 9d): a beast fight leaves spoils on the map ---------------------
const kind5 = await evaluate(`const h = window.__T.s().hunt; const k = h.getState().kills.slice(-1)[0]; return k?.kind;`);
if (kind5 === 'beast') {
  check('after a won beast fight, the map shows the spoils to harvest', !!(await findText('^Spoils: ', 'HuntFieldOverlay')) && !!(await findText('^Harvest$', 'HuntFieldOverlay')));
  await shot('05d2-spoils');
  const before5 = await evaluate(`const st = window.__T.s().hunt.getState(); return { found: st.pack.found.reduce((t, i) => t + (i.qty || 1), 0), time: st.time, shown: window.__T.s().v.spoils.parts.filter(p => p.rarity !== 'common').length };`);
  await clickText('^Harvest$', 'HuntFieldOverlay');
  await sleep(500);
  const after5 = await evaluate(`const s = window.__T.s(); const st = s.hunt.getState();
    return { spoils: !!s.v.spoils, found: st.pack.found.reduce((t, i) => t + (i.qty || 1), 0), parts: st.pack.found.filter(i => i.id.startsWith('part_')).reduce((t, i) => t + (i.qty || 1), 0), time: st.time, log: st.log.some(l => l.kind === 'harvest') };`);
  const sv5 = await saved();
  check('Harvest (clicked) takes the shown parts and the meat into the pack, spends time, and is saved',
    !after5.spoils && after5.parts === before5.shown && after5.found > before5.found && after5.time > before5.time && after5.log
    && sv5?.hunt?.spoils === null && sv5.hunt.pack.found.some(i => i.id.startsWith('part_')), JSON.stringify({ ...before5, ...after5 }));
  await shot('05d3-harvested');
} else {
  check('after a won cultist fight there are no spoils to harvest', !(await findText('^Spoils: ', 'HuntFieldOverlay')));
}

// ---- 5c. Flee from inside a fight (chunk 9c) ---------------------------------------------
const fight4 = await walkTo("new Set(st.map.occupants.filter(o => o.kind === 'beast' || o.kind === 'cultist').map(o => o.tile)) /* FIGHT */");
check('walked into a fight to flee from', fight4 === 'fight', fight4);
check('the encounter panel has no Flee button (it lives in the fight now)', !(await findText('^Flee$', 'HuntFieldOverlay')));
const pre4 = await evaluate(`const h = window.__T.s().hunt; const st = h.getState(); return { occId: h.encounter().occId, kind: h.encounter().kind, flees: st.flees, pos: st.pos };`);
await clickText('^Fight$', 'HuntFieldOverlay');
check('...Fight starts CombatScene', await waitFor(combatReady));
// Wait for a hunter's turn: the Flee button shows with End Turn.
const partyTurn = await waitFor("(() => { const c = window.__T.g().scene.getScene('CombatScene'); const a = c._currentChar?.(); return a && !a.isEnemy && c.fleeButton?.visible; })()", 30000);
check('on a hunter\'s turn the fight offers Flee', partyTurn);
await shot('05e-flee-button');
await clickText('^Flee$', 'CombatScene');
check('Flee (clicked): the enemy gets its free round, then the fight ends as fled', await waitFor("window.__T.textsOf('CombatScene').some(t => t.text === 'Fled')", 30000));
await shot('05f-fled');
await clickText('^Back to the Hunt$', 'CombatScene');
check('Back to the Hunt (clicked) returns to the map', await waitFor("window.__T.g().scene.isActive('HuntFieldOverlay') && !window.__T.g().scene.isActive('CombatScene')"));
await sleep(600);
const after4 = await evaluate(`const h = window.__T.s().hunt; const st = h.getState(); const occ = st.map.occupants.find(o => o.id === ${JSON.stringify(pre4.occId)});
  return { enc: !!h.encounter(), flees: st.flees, hunting: occ?.state, fled: st.log.some(l => l.kind === 'flee' && l.reason === 'fled') };`);
const sv4 = await saved();
// A beast pack fled from hunts the party (7c: only beasts are alerted; a
// cultist camp stays where it is).
check('...the party fell back, a fled beast pack hunts it, and the flee is saved',
  !after4.enc && after4.flees === pre4.flees + 1 && (pre4.kind === 'beast' ? after4.hunting === 'hunting' : true) && after4.fled && sv4?.hunt?.flees === pre4.flees + 1,
  JSON.stringify({ kind: pre4.kind, ...after4 }));
await shot('05g-after-flee');

// ---- 5h. An event site (chunk 11a): it opens, and walking away leaves it ------------
{
  const opened = await evaluate(`
    const s = window.__T.s(); const h = s.hunt;
    const { mapNeighbors } = await import('/src/systems/HuntMapGen.js');
    const { isPassable } = await import('/data/grounds.js');
    if (h.encounter()) h.flee();
    for (let i = 0; i < 400; i++) {
      const st = h.getState();
      if (h.encounter()) { s._act('flee', () => h.flee()); continue; }
      const sites = new Set(st.map.occupants.filter(o => o.kind === 'event').map(o => o.tile));
      const prev = new Map([[st.pos, null]]); const q = [st.pos]; let g = null;
      for (let k = 0; k < q.length && !g; k++) for (const n of mapNeighbors(st.map, q[k])) {
        if (prev.has(n) || !isPassable(st.map.tiles[n])) continue; prev.set(n, q[k]); q.push(n); if (sites.has(n)) { g = n; break; } }
      if (!g) return { found: false };
      let t = g; while (prev.get(t) !== st.pos) t = prev.get(t);
      // The last step opens the site for real (the walker's own moves walk away).
      if (t === g) { s._act('move', () => (h.__rawMove || h.move)(t)); if (h.view().event) return { found: true, tile: g, id: h.view().event.templateId }; continue; }
      s._act('move', () => h.move(t));
    }
    return { found: false };`);
  check('walked onto an event site, and it opened', opened.found, JSON.stringify(opened));
  if (opened.found) {
    await sleep(400);
    const panel = await evaluate(`return window.__T.textsOf('HuntFieldOverlay').map(t => t.text);`);
    const ev = await evaluate(`return window.__T.s().hunt.view().event;`);
    check('the map shows its name and text, and offers Walk away', panel.includes(ev.name) && panel.includes(ev.text) && panel.includes('Walk away'), ev.name);
    await shot('05h-event');
    await clickText('^Walk away$');
    await sleep(400);
    const after = await evaluate(`const h = window.__T.s().hunt; return { open: !!h.view().event, still: h.getState().map.occupants.some(o => o.kind === 'event' && o.tile === ${JSON.stringify(opened.tile)}) };`);
    check('Walk away (clicked) closes it, and the site stays for later', !after.open && after.still, JSON.stringify(after));
  }
}

// ---- 6. Leave through an exit -------------------------------------------------------
const walked = await walkTo("new Set(Object.entries(st.map.tiles).filter(([, t]) => t.exit).map(([id]) => id))");
check('walked to an exit', walked === 'there', walked);
await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = s.v.pos; s._refresh(); return 1;`);
const home0 = await bagRations();
const pts0 = await evaluate(`const PM = (await import('/src/systems/ProgressionManager.js')).default;
  // Every Hunt Point paid from here to the check below, with who paid it.
  window.__hpCalls = []; const orig = PM.addHuntPoints.bind(PM);
  PM.addHuntPoints = (n) => { window.__hpCalls.push({ n, at: (new Error().stack || '').split(String.fromCharCode(10)).slice(2, 6).map(l => l.trim()).join(' < ') }); return orig(n); };
  return PM.huntPoints;`);
await clickText('^Leave the hunt$');
const enter = await findText('Enter', 'UIScene');
if (enter) await click(enter.x, enter.y);
await sleep(400);
await shot('06-left');
const after = await evaluate(`const { HuntManager } = await import('/src/systems/HuntManager.js'); const PM = (await import('/src/systems/ProgressionManager.js')).default;
  const rw = window.__T.s().hunt.getState().reward;
  return { active: HuntManager.isActive(), finished: window.__T.s().v.finished, pts: PM.huntPoints,
    completion: rw?.completion, primaryDone: rw?.primaryDone, bonusPts: (rw?.bonuses || []).reduce((t, b) => t + (b.huntPoints || 0), 0), bonuses: (rw?.bonuses || []).map(b => b.id) };`);
const sv = await saved();
check('leaving ends the hunt: the holder drops it and the save holds no hunt', after.finished === 'exit' && !after.active && sv?.hunt === null);
check('...unspent Rations come home to the bag', (await bagRations()) >= home0, `${home0} -> ${await bagRations()}`);
// What leaving pays is exactly what the engine reports: the completion reward
// if (and only if) the primary is done, plus each done bonus objective (7d).
// The plan is rolled unseeded and the walk is random, so the Retrieve site may
// or may not have been crossed on the way (a run on 2026-09-24 did: 21 + 15);
// the rule, not one outcome, is what is checked.
check('...leaving pays the completion reward only if the primary is done, plus the done bonus objectives',
  (after.primaryDone ? after.completion > 0 : after.completion === 0) && after.pts - pts0 === after.completion + after.bonusPts,
  `${pts0} -> ${after.pts}: primary ${after.primaryDone ? 'done' : 'not done'} ${after.completion}, bonuses ${JSON.stringify(after.bonuses)} = ${after.bonusPts}; paid: ${JSON.stringify(await evaluate('return window.__hpCalls;'))}`);
await clickText('^Return to camp$');
await sleep(500);
await evaluate(`window.__T.g().scene.getScene('TownScene')._enterHuntGate(); await new Promise(r => setTimeout(r, 900)); return 1;`);
const planning = await evaluate(`const G = window.__T.g(); return { hub: G.scene.isActive('HuntHubOverlay'), field: G.scene.isActive('HuntFieldOverlay') };`);
check('after leaving, the Hunt screen opens on planning again, not on a hunt', planning.hub && !planning.field && !!(await findText('Choose Location|No location chosen', HUB)));
await shot('07-planning-again');
await evaluate(`const G = window.__T.g(); G.scene.stop('HuntHubOverlay'); return 1;`);

// ---- 7. An old save with an Advance hunt -------------------------------------------
await B.loadGame();
await B.bootToTown(`localStorage.setItem('bmSave_fixture6', ${JSON.stringify(fixture)});
  const GS = (await import('/src/systems/GameState.js')).default; GS.load('fixture6');`);
await sleep(800);
const old = await evaluate(`const { HuntManager } = await import('/src/systems/HuntManager.js'); const G = window.__T.g();
  return { mode: HuntManager.mode(), hub: G.scene.isActive('HuntHubOverlay'), field: G.scene.isActive('HuntFieldOverlay'), depth: HuntManager.getState().depth };`);
check('an old save\'s Advance hunt reopens the old Hunt screen, not the map', old.mode === 'advance' && old.hub && !old.field, JSON.stringify(old));
await shot('08-old-advance-hunt');
await clickText('^Advance$', HUB);
const depth2 = await evaluate(`const { HuntManager } = await import('/src/systems/HuntManager.js'); return HuntManager.getState().depth;`);
check('...and it still advances (by click)', depth2 === old.depth + 1, `${old.depth} -> ${depth2}`);

// ---- 8. The Hunt screen bug from 8b: Inventory closed mid-hunt, then a click
//         over the Bonfire. It opened character creation behind the hunt.
await evaluate(`window.__T.g().scene.getScene('UIScene').openOverlay('InventoryOverlay'); await new Promise(r => setTimeout(r, 900)); return 1;`);
await key('Escape', 'Escape', 27);
await sleep(700);
const mid = await evaluate(`const G = window.__T.g(); return { inv: G.scene.isActive('InventoryOverlay'), hub: G.scene.isActive('HuntHubOverlay'), town: G.scene.getScene('TownScene').input.enabled };`);
check('closing the Inventory mid-hunt no longer wakes the town under the Hunt screen', !mid.inv && mid.hub && mid.town === false, JSON.stringify(mid));
await click(655, 327);
await sleep(2000);
const scenes = await evaluate('return window.__T.active().join(",");');
check('...and a click over the Bonfire does nothing (no character creation, no load)', !/CharacterCreation|Loading/.test(scenes) && /HuntHubOverlay/.test(scenes), scenes);
await shot('09-bonfire-click-after-inventory');

// ---- 9. A wipe in a Sheltered region (chunk 9b) ------------------------------------------
await B.loadGame();
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  const party = makeParty(); GS.characters = party; GS.party = party; GS.slain = [];
`);
await evaluate(`const { HuntManager } = await import('/src/systems/HuntManager.js');
  const { launchMapHunt } = await import('/src/scenes/overlays/HuntFieldOverlay.js');
  HuntManager.startMap('reeds_of_gethsemane', { plan: { objective: 'cull', size: 'small', bonusObjectives: [], mods: {}, itemLevel: 1 }, supplies: 60, seed: 4040 });
  launchMapHunt(window.__T.g().scene.getScene('TownScene')); await new Promise(r => setTimeout(r, 900)); return 1;`);
const fight3 = await walkTo("new Set(st.map.occupants.filter(o => o.kind === 'beast' || o.kind === 'cultist').map(o => o.tile)) /* FIGHT */");
check('a new hunt (Sheltered) walked into a fight', fight3 === 'fight', fight3);
await clickText('^Fight$', 'HuntFieldOverlay');
check('...Fight starts CombatScene', await waitFor(combatReady));
await sleep(800);
await evaluate(`const c = window.__T.g().scene.getScene('CombatScene'); const GS = (await import('/src/systems/GameState.js')).default;
  for (const p of GS.party) { p.currentHP = 0; p.status = 'incapacitated'; } c._checkVictoryCondition(); return 1;`);
check('the party wipes: the defeat screen says it is carried back to camp', await waitFor("window.__T.textsOf('CombatScene').some(t => /carried back to camp/.test(t.text))"));
await shot('10-sheltered-wipe');
const wiped = await evaluate(`const GS = (await import('/src/systems/GameState.js')).default; const { HuntManager } = await import('/src/systems/HuntManager.js');
  return { slain: GS.slain.length, alive: GS.party.length === 6 && GS.party.every(c => c.status === 'alive' && c.currentHP >= 1), mode: HuntManager.mode() };`);
const svWipe = await saved();
check('...nobody is Slain, all six stand at 1 HP+, and the hunt is gone from the holder and the save', wiped.slain === 0 && wiped.alive && wiped.mode === null && svWipe?.hunt === null, JSON.stringify(wiped));
await clickText('Exit', 'CombatScene');
check('Exit (clicked) goes back to town, with no map scene reopening', await waitFor("!window.__T.g().scene.isActive('CombatScene') && window.__T.g().scene.isActive('TownScene') && !window.__T.g().scene.isActive('HuntFieldOverlay')"));
await shot('11-back-in-town');

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
fs.writeFileSync(path.join(out, `${mode}-results.json`), JSON.stringify({ mode, checks: B.checks, errors: B.errors }, null, 1));
await B.close();
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
