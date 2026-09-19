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
// Test setup may drive the engine directly (walking to a fight or an exit),
// but through the scene's own _act, so autosave runs as it does for a click.

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
  const s = window.__T.s(); const h = s.hunt;
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
check('...and saved at once: the autosave holds the map hunt', s0?.version === 7 && s0?.hunt?.mode === 'map');
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

// ---- 6. Leave through an exit -------------------------------------------------------
const walked = await walkTo("new Set(Object.entries(st.map.tiles).filter(([, t]) => t.exit).map(([id]) => id))");
check('walked to an exit', walked === 'there', walked);
await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = s.v.pos; s._refresh(); return 1;`);
const home0 = await bagRations();
const pts0 = await evaluate(`const PM = (await import('/src/systems/ProgressionManager.js')).default; return PM.huntPoints;`);
await clickText('^Leave the hunt$');
const enter = await findText('Enter', 'UIScene');
if (enter) await click(enter.x, enter.y);
await sleep(400);
await shot('06-left');
const after = await evaluate(`const { HuntManager } = await import('/src/systems/HuntManager.js'); const PM = (await import('/src/systems/ProgressionManager.js')).default;
  return { active: HuntManager.isActive(), finished: window.__T.s().v.finished, pts: PM.huntPoints };`);
const sv = await saved();
check('leaving ends the hunt: the holder drops it and the save holds no hunt', after.finished === 'exit' && !after.active && sv?.hunt === null);
check('...unspent Rations come home to the bag', (await bagRations()) >= home0, `${home0} -> ${await bagRations()}`);
check('...Hunt Points paid only if the objective was done (it was not: 0 more)', after.pts === pts0, `${pts0} -> ${after.pts}`);
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

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
fs.writeFileSync(path.join(out, `${mode}-results.json`), JSON.stringify({ mode, checks: B.checks, errors: B.errors }, null, 1));
await B.close();
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
