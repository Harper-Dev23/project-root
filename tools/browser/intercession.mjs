// tools/browser/intercession.mjs
//
// Real-browser check of intercession on the spot (Exploration System v2,
// chunk 10c-2). NOT part of `npm run verify`: it needs Microsoft Edge.
//
//   node tools/browser/intercession.mjs webgl  [outDir] [cdpPort]
//   node tools/browser/intercession.mjs canvas [outDir] [cdpPort]
//
// No region is Watched yet, so it uses the game's own dev hook,
// window.bmDevDeathRule('watched'), before departing. Then, with real clicks:
//   - a map hunt in the Reeds while the tribe follows Jeremiah, walked into a
//     fight, Fight clicked, the party falls (forced from the page, as
//     huntflow.mjs forces a win)
//   - the prophet's choice appears; one hunter is spoken for (Intercede, then
//     Confirm), the screen says so, and Back to the Hunt returns to the map
//   - the hunt goes on: the party (one hunter) stands on a way out, the Bond
//     paid, the other five are Slain with where they fell, and it is saved
//   - no uncaught errors
//
// Plumbing (Edge, DevTools, the static server, boot like a player): lib.mjs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startBrowser } from './lib.mjs';

const mode = process.argv[2] || 'webgl';
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'intercession-shots'));
const port = Number(process.argv[4] || 9373);
const B = await startBrowser({ mode, port, outDir: out });
const { evaluate, shot, check, sleep, clickText, findText } = B;
const waitFor = (expr, ms = 15000) => evaluate(`for (let i = 0; i < ${Math.ceil(ms / 200)}; i++) { if (${expr}) return true; await new Promise(r => setTimeout(r, 200)); } return false;`);
const texts = (key) => evaluate(`return window.__T.textsOf('${key}').map(t => t.text);`);

await B.loadGame();
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  const PM = (await import('/src/systems/ProgressionManager.js')).default;
  const S = await import('/src/systems/Standing.js');
  const party = makeParty(); GS.characters = [...party]; GS.party = party; GS.slain = [];
  PM.tribe = null; PM.setTribe('styx');
  const st = PM.getStanding();
  S.earnFavor(st, 'styx', 'jeremiah', 100); S.acceptHouse(st, 'styx', 'jeremiah');
  st.bond.jeremiah = 1000;
`);
check(`renderer is ${mode === 'canvas' ? 'CANVAS' : 'WEBGL'}`, (await evaluate('return window.__T.g().renderer.type;')) === (mode === 'canvas' ? 1 : 2));

// ---- 1. A Watched hunt in Jeremiah's reeds, through the dev hook --------------
const rules = await evaluate(`return await window.bmDevDeathRule('watched');`);
check('the dev hook makes every region Watched', Object.values(rules).every(r => r === 'watched'), JSON.stringify(rules));
const dep = await evaluate(`
  const { HuntManager } = await import('/src/systems/HuntManager.js');
  const { launchMapHunt } = await import('/src/scenes/overlays/HuntFieldOverlay.js');
  HuntManager.startMap('reeds_of_gethsemane', { plan: { objective: 'cull', size: 'medium', itemLevel: 1 }, supplies: 300, seed: 1301 });
  launchMapHunt(window.__T.g().scene.getScene('TownScene'));
  await new Promise(r => setTimeout(r, 900));
  return { rule: HuntManager.current().getState().deathRule, field: window.__T.g().scene.isActive('HuntFieldOverlay') };`);
check('a map hunt departs in the Reeds under the Watched rule', dep.rule === 'watched' && dep.field, JSON.stringify(dep));

const walked = await evaluate(`
  const s = window.__T.s(); const h = s.hunt; (await import('/tools/headless/walkAway.js')).walkAway(h);
  const { mapNeighbors } = await import('/src/systems/HuntMapGen.js');
  const { isPassable } = await import('/data/grounds.js');
  for (let i = 0; i < 400; i++) {
    const st = h.getState();
    if (h.encounter()) { const occ = st.map.occupants.find(o => o.id === h.encounter().occId); if (occ.kind === 'beast') return 'fight'; s._act('flee', () => h.flee()); continue; }
    const want = new Set(st.map.occupants.filter(o => o.kind === 'beast').map(o => o.tile));
    const prev = new Map([[st.pos, null]]); const q = [st.pos]; let g = null;
    for (let k = 0; k < q.length && !g; k++) for (const n of mapNeighbors(st.map, q[k])) {
      if (prev.has(n) || !isPassable(st.map.tiles[n])) continue; prev.set(n, q[k]); q.push(n); if (want.has(n)) { g = n; break; } }
    if (!g) return 'unreachable';
    let t = g; while (prev.get(t) !== st.pos) t = prev.get(t);
    s._act('move', () => h.move(t));
  }
  return 'gave up';`);
check('walked into a beast fight', walked === 'fight', walked);
await sleep(500);
await clickText('^Fight$', 'HuntFieldOverlay');
check('Fight (clicked) starts CombatScene', await waitFor("window.__T.g().scene.isActive('CombatScene') && (window.__T.g().scene.getScene('CombatScene').turnOrder || []).length > 0"));
await sleep(800);

// ---- 2. The party falls; the prophet's choice --------------------------------
await evaluate(`const c = window.__T.g().scene.getScene('CombatScene');
  for (const u of c.huntFight ? (await import('/src/systems/GameState.js')).default.party : []) { u.currentHP = 0; u.status = 'incapacitated'; }
  c._checkVictoryCondition(); return 1;`);
check('the prophet\'s choice appears', await waitFor("window.__T.textsOf('CombatScene').some(t => t.text === 'Your party has fallen')", 8000));
let t = await texts('CombatScene');
check('...naming Jeremiah and the Bond to spend, and one Intercede per fallen hunter',
  t.some(x => x.startsWith('Jeremiah watches these lands') && x.includes('1000 Bond standing')) && t.filter(x => x === 'Intercede (50)').length === 6,
  t.filter(x => /Intercede|watches/.test(x)).join(' | '));
await shot('01-choice');
await clickText('^Intercede \\(50\\)$', 'CombatScene');
await sleep(400);
t = await texts('CombatScene');
check('Intercede (clicked) marks that hunter spoken for and the button turns to Confirm',
  t.includes('Spoken for (50)') && t.includes('Confirm') && t.some(x => x.startsWith('50 of 1000 standing')));
await shot('02-one-chosen');
await clickText('^Confirm$', 'CombatScene');
check('Confirm (clicked): the screen says the prophet spoke for them', await waitFor("window.__T.textsOf('CombatScene').some(t => t.text === 'Spoken For')", 8000));
await shot('03-spoken-for');
await clickText('^Back to the Hunt$', 'CombatScene');
check('Back to the Hunt (clicked) returns to the map', await waitFor("window.__T.g().scene.isActive('HuntFieldOverlay') && !window.__T.g().scene.isActive('CombatScene')"));
await sleep(700);

// ---- 3. The hunt goes on ----------------------------------------------------
const after = await evaluate(`
  const GS = (await import('/src/systems/GameState.js')).default; const PM = (await import('/src/systems/ProgressionManager.js')).default;
  const h = window.__T.s().hunt; const st = h.getState();
  const sv = JSON.parse(localStorage.getItem('bmSave_autosave') || 'null');
  return { finished: st.finished, onExit: !!st.map.tiles[st.pos].exit, party: GS.party.map(c => c.name + '@' + c.currentHP),
    slain: GS.slain.map(c => c.fell?.house + '/' + c.fell?.rule), bond: PM.getStanding().bond.jeremiah,
    saved: { hunt: sv?.hunt?.mode, slain: sv?.slain?.length } };`);
check('the hunt goes on, the party standing on a way out', !after.finished && after.onExit, JSON.stringify(after));
check('...one hunter at 1 HP, five Slain in Jeremiah\'s Watched lands, the Bond 50 lighter',
  after.party.length === 1 && after.party[0].endsWith('@1') && after.slain.length === 5 && after.slain.every(x => x === 'jeremiah/watched') && after.bond === 950);
check('...and all of it saved', after.saved.hunt === 'map' && after.saved.slain === 5);
await shot('04-back-on-map');

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
fs.writeFileSync(path.join(out, `${mode}-results.json`), JSON.stringify({ mode, checks: B.checks, errors: B.errors }, null, 1));
await B.close();
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
