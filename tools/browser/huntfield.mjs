// tools/browser/huntfield.mjs
//
// Real-browser check of the hex-map hunt scene (HuntFieldOverlay, Exploration
// System v2 chunk 8b). NOT part of `npm run verify`: it needs Microsoft Edge.
// Headless Edge is driven over the DevTools protocol with Node's own
// WebSocket, and every click is a trusted mouse event at real game coordinates.
//
//   node tools/browser/huntfield.mjs webgl  [outDir] [cdpPort]
//   node tools/browser/huntfield.mjs canvas [outDir] [cdpPort]
//
// `canvas` disables WebGL so Phaser falls back to the Canvas renderer (the
// LibreWolf case: Rectangle masks draw nothing there). Screenshots land in
// outDir (default: <system temp>/huntfield-shots, so nothing lands in the repo).
// It serves the repo itself on a free port; no server needs to be running.
//
// What it proves: a click sweep over every hex of a section (and points near
// every hex corner), moving by clicks, every own-tile action, the eat and camp
// panels, the log, an encounter and Flee, crossing a passage into section 2,
// leaving through an exit with the dialogue-bar confirm, other regions and
// sizes, the bonus-objective hover, three visits in a row (nothing piles up),
// an Inventory opened and closed over the map (town input stays off and clicks
// still land on the map), no panel button under UIScene's dialogue bar, and no
// uncaught errors.
//
// Plumbing (Edge, DevTools, the static server, boot like a player): lib.mjs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startBrowser } from './lib.mjs';

const mode = process.argv[2] || 'webgl';
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'huntfield-shots'));
const port = Number(process.argv[4] || 9333);
const B = await startBrowser({ mode, port, outDir: out });
const { send, evaluate, shot, click, check, sleep } = B;
const consoleErrors = B.errors;
const results = { mode, checks: B.checks, errors: consoleErrors };
const WHERE = { texts: 'HuntFieldOverlay', uiTexts: 'UIScene' };
const findText = (re, where = 'texts') => B.findText(re, WHERE[where] || where);
const clickText = (re, where = 'texts') => B.clickText(re, WHERE[where] || where);
await B.loadGame();

const buttonsBelowBar = async () => evaluate(`
  const out = []; const walk = (o) => { if (!o) return; if (o.type === 'Text' && o.parentContainer?.input) { const b = o.getBounds(); if (b.bottom > 570) out.push(o.text + '@' + Math.round(b.bottom)); } if (o.list) o.list.forEach(walk); };
  window.__T.s().children.list.forEach(walk); return out;`);
const panelShots = [];
const _shot = shot;
const textOverlaps = async () => evaluate(`
  // Text lines inside one panel/box (a nested container) must never overlap.
  const bad = []; const layer = window.__T.s().layer;
  const walk = (c) => { if (!c?.list) return;
    if (c !== layer) { const ts = c.list.filter(o => o.type === 'Text').map(o => ({ t: o.text, b: o.getBounds() }));
      for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) { const a = ts[i].b, b = ts[j].b;
        if (a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1) bad.push(ts[i].t.slice(0, 30) + ' / ' + ts[j].t.slice(0, 30)); } }
    c.list.forEach(walk); };
  walk(layer); return bad;`);
const shotP = async (name) => { await _shot(name); const bad = await buttonsBelowBar(); const overlaps = await textOverlaps(); panelShots.push({ name, bad, overlaps }); };

// Boot: a real party, into town, the way a player leaves the menu.
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GameState = (await import('/src/systems/GameState.js')).default;
  const party = makeParty(); GameState.characters = party; GameState.party = party;`);
const renderer = await evaluate('return window.__T.g().renderer.type;');
check(`renderer is ${mode === 'canvas' ? 'CANVAS (1)' : 'WEBGL (2)'}`, renderer === (mode === 'canvas' ? 1 : 2), `type ${renderer}`);

const open = async (opts) => {
  await evaluate(`window.__hunt = await window.bmDevMapHunt(${JSON.stringify(opts)}); await new Promise(r => setTimeout(r, 400)); return true;`);
};
const refresh = () => evaluate(`window.__T.s()._refresh(); return true;`);

// ---- 1. A large two-section Reeds map, at departure --------------------------
await open({ zoneId: 'reeds_of_gethsemane', objective: 'scout', size: 'large', seed: 7 });
await shotP('01-departure-large');
const st1 = await evaluate(`const s = window.__T.s(); return { status: s.sys.settings.status, layout: s.v.layout.length, tiles: Object.keys(s.v.tiles).length };`);
check('the scene runs and draws the section shape', st1.status === 5 && st1.layout > 0, JSON.stringify(st1));

// ---- 2. Click sweep: every hex in the section, a real click at its centre ----
const sweep = await evaluate(`
  const s = window.__T.s();
  return s.v.layout.map(id => ({ id, ...s.center(id) }));
`);
let hit = 0, miss = [];
for (const h of sweep) {
  // close any open panel first so the click lands on the map, not a panel
  await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = null; s._refresh(); return true;`);
  await click(h.x, h.y);
  const sel = await evaluate(`return window.__T.s().selected;`);
  if (sel === h.id) hit++; else miss.push(`${h.id}->${sel}`);
}
check('click sweep: a click at every hex centre selects exactly that hex', miss.length === 0, `${hit}/${sweep.length}${miss.length ? ' misses: ' + miss.slice(0, 5).join(', ') : ''}`);
// Edge hits: points 80% of the way to each corner resolve to the same hex.
const edgeMiss = await evaluate(`
  const s = window.__T.s(); const bad = [];
  for (const id of s.v.layout) { const c = s.center(id); for (const p of s._corners(c.x, c.y, 36.95 * 0.8)) { const t = s.tileAt(p.x, p.y); if (t !== id) bad.push(id); } }
  return bad.length;
`);
check('hex picking: points near every corner of every hex pick that hex', edgeMiss === 0, `${edgeMiss} misses`);

// ---- 3. Inspect an unexplored tile and a seen one -------------------------------
await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = s.v.layout.find(id => !s.v.tiles[id]); s._refresh(); return true;`);
await shot('02-inspect-unexplored');
check('inspecting an unseen tile says only that it is unexplored', !!(await findText('^Unexplored$')));

// ---- 4. Move by clicking: select a neighbour, then click it again ---------------
const mv = await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = s.v.pos; s._refresh(); const m = s.v.moves.find(m => s.v.layout.includes(m.tile)); return { to: m.tile, ...s.center(m.tile), before: s.v.clock.time };`);
await click(mv.x, mv.y);
check('first click on a neighbour selects it and offers the move', !!(await findText('^Move here')));
await click(mv.x, mv.y);
const after = await evaluate(`const s = window.__T.s(); return { pos: s.v.pos, time: s.v.clock.time, enc: !!s.v.encounter };`);
check('second click on it moves the party there (time passes)', after.pos === mv.to && after.time > mv.before, JSON.stringify(after));
await shot('03-after-move');

// ---- 5. The own-tile buttons, clicked for real ----------------------------------
await evaluate(`const s = window.__T.s(); if (s.v.encounter) s.hunt.flee(); s.panel = null; s.selected = s.v.pos; s._refresh(); return true;`);
await clickText('^Forage');
const fr = await evaluate(`const s = window.__T.s(); return { gathered: s.v.tiles[s.v.pos]?.gathered || null, log: s.v.log.slice(-1)[0]?.kind };`);
const barAfterForage = await findText('.', 'uiTexts');
check('Forage button acts through the engine (tile gathered, or a refusal shown in the dialogue bar)', fr.gathered === 'forage' || !!barAfterForage, JSON.stringify(fr));
await shot('04-after-forage');
await clickText('^Forage');
const refusal = (await evaluate(`return window.__T.uiTexts().map(t => t.text).filter(t => /Cannot/.test(t));`));
check('a refused action shows the engine’s reason in the dialogue bar', refusal.length > 0, refusal[0] || '');
await shot('05-refusal-in-dialogue-bar');

// ---- 6. Eat panel -------------------------------------------------------------
await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = s.v.pos; s._refresh(); return true;`);
await clickText('^Eat');
await shotP('06-eat-panel');
const eatBtn = await findText('^Eat 1 ');
if (eatBtn) {
  const sup0 = await evaluate(`return window.__T.s().v.supplies;`);
  await click(eatBtn.x, eatBtn.y);
  const sup1 = await evaluate(`return window.__T.s().v.supplies;`);
  check('Eat 1 raises supplies by the food’s worth', sup1 > sup0, `${sup0} -> ${sup1}`);
} else check('Eat panel explains nothing is edible raw', !!(await findText('cannot be eaten raw|Nothing in the pack')));
await clickText('^Back$').catch(() => {});

// ---- 7. Camp panel, with fish in the pack -------------------------------------
// Walk (through the engine) until a tile can be fished, then fish by click.
await evaluate(`
  const s = window.__T.s(); const h = s.hunt;
  for (let i = 0; i < 60; i++) {
    if (h.encounter()) h.flee();
    const st = h.getState();
    if (st.map.tiles[st.pos].fishing && !st.gathered[st.pos]) break;
    const ms = h.view().moves; h.move(ms[i % ms.length].tile);
  }
  if (h.encounter()) h.flee();
  s.panel = null; s.selected = h.view().pos; s._refresh(); return true;
`);
await clickText('^Fish');
const encAfterFish = await evaluate(`const s = window.__T.s(); const e = !!s.v.encounter; if (e) s.hunt.flee(); s.panel = null; s.selected = s.hunt.view().pos; s._refresh(); return e;`);
if (encAfterFish) console.log('  (an encounter started while fishing; fled it to reach the camp panel)');
await clickText('^Camp');
await shotP('07-camp-panel');
const cook = await findText('^Cook ');
if (cook) { await click(cook.x, cook.y); await sleep(100); }
const addBtn = await findText('^…with ');
if (addBtn) { await click(addBtn.x, addBtn.y); await sleep(100); }
await shotP('08-camp-meal-queued');
const hp0 = await evaluate(`const s = window.__T.s(); return s.v.clock.time;`);
await clickText('^Make camp$');
const hp1 = await evaluate(`const s = window.__T.s(); return { time: s.v.clock.time, last: s.v.log.filter(l => l.kind === 'camp').slice(-1)[0] };`);
check('Make camp spends the camp’s time and logs the camp (with the cooked meal when one was queued)', hp1.time > hp0 && !!hp1.last, JSON.stringify(hp1.last));
await shot('09-after-camp');

// ---- 8. Log panel ----------------------------------------------------------------
await clickText('^Log$');
await shotP('10-log-open');
check('the Log button opens the hunt log', !!(await findText('^Hunt log')));
await clickText('^Log$');
check('the Log button closes it again', !(await findText('^Hunt log')));

// ---- 9. An encounter: walk until one starts, then flee by click ------------------
const gotEnc = await evaluate(`
  const s = window.__T.s(); const h = s.hunt;
  const { mapNeighbors } = await import('/src/systems/HuntMapGen.js');
  const { isPassable } = await import('/data/grounds.js');
  for (let i = 0; i < 300 && !h.encounter(); i++) {
    const st = h.getState();
    const targets = new Set(st.map.occupants.filter(o => o.kind === 'beast' || o.kind === 'cultist').map(o => o.tile));
    if (!targets.size) break;
    // step toward the nearest hostile occupant (breadth-first; test code may read the state)
    const prev = new Map([[st.pos, null]]); const q = [st.pos]; let goal = null;
    for (let k = 0; k < q.length && !goal; k++) for (const n of mapNeighbors(st.map, q[k])) {
      if (prev.has(n) || !isPassable(st.map.tiles[n])) continue;
      prev.set(n, q[k]); q.push(n); if (targets.has(n)) { goal = n; break; }
    }
    if (!goal) break;
    let t = goal; while (prev.get(t) !== st.pos) t = prev.get(t);
    h.move(t);
  }
  s.panel = null; s._refresh();
  return !!h.encounter();
`);
check('found an encounter to show', gotEnc);
if (gotEnc) {
  await shotP('11-encounter');
  check('the encounter panel shows who acts first and the Fight button (chunk 9b; no TEST button)', !!(await findText('acts first')) && !!(await findText('^Fight$')) && !(await findText('TEST')));
  await clickText('^Log$');
  const overlap = await evaluate(`
    const s = window.__T.s(); const pr = s._panelRect; let log = null;
    const walk = (o) => { if (!o) return; if (o.type === 'Text' && /^Hunt log/.test(o.text)) log = o.getBounds(); if (o.list) o.list.forEach(walk); };
    s.children.list.forEach(walk);
    if (!pr || !log) return 'missing';
    return (log.x < pr.x + pr.w && log.x + 340 > pr.x && log.y < pr.y + pr.h && log.y + 40 > pr.y) ? 'overlap' : 'clear';
  `);
  await shotP('11b-encounter-with-log');
  check('the log opens clear of the encounter panel', overlap === 'clear', overlap);
  await clickText('^Log$');
  await clickText('^Flee$');
  const fled = await evaluate(`return !window.__T.s().v.encounter;`);
  check('Flee (clicked) ends the encounter through the engine', fled);
  await shot('12-after-flee');
}

// ---- 10. Cross into section 2 through the passage --------------------------------
const crossed = await evaluate(`
  const s = window.__T.s(); const h = s.hunt;
  const { mapNeighbors } = await import('/src/systems/HuntMapGen.js');
  const { isPassable } = await import('/data/grounds.js');
  const st0 = h.getState(); if (!st0.map.passages.length) return 'no passage';
  const goal = st0.map.passages[0].a;
  for (let i = 0; i < 200 && h.getState().pos !== goal; i++) {
    if (h.encounter()) { h.winEncounter(); continue; }
    const st = h.getState();
    const prev = new Map([[st.pos, null]]); const q = [st.pos];
    for (let k = 0; k < q.length; k++) for (const n of mapNeighbors(st.map, q[k])) { if (prev.has(n) || !isPassable(st.map.tiles[n])) continue; prev.set(n, q[k]); q.push(n); }
    let t = goal; if (!prev.has(t)) return 'unreachable';
    while (prev.get(t) !== st.pos) t = prev.get(t);
    h.move(t);
  }
  if (h.encounter()) h.winEncounter();
  s.panel = null; s.selected = h.view().pos; s._refresh();
  return h.getState().pos === goal ? 'at passage' : 'not there';
`);
check('walked to the passage', crossed === 'at passage', crossed);
if (crossed === 'at passage') {
  await shotP('13-at-passage');
  const sec0 = await evaluate(`return window.__T.s().v.section;`);
  await clickText('^Cross to section');
  const sec1 = await evaluate(`const s = window.__T.s(); if (s.v.encounter) s.hunt.winEncounter(); s._refresh(); return s.v.section;`);
  check('Cross to section (clicked) redraws the other section in the same scene', sec1 !== sec0, `${sec0} -> ${sec1}`);
  await shot('14-section-2');
}

// ---- 11. Leave: walk back to an exit, click Leave, confirm in the dialogue bar ---
const atExit = await evaluate(`
  const s = window.__T.s(); const h = s.hunt;
  const { mapNeighbors } = await import('/src/systems/HuntMapGen.js');
  const { isPassable } = await import('/data/grounds.js');
  for (let i = 0; i < 300 && !h.getState().map.tiles[h.getState().pos].exit; i++) {
    if (h.encounter()) { h.winEncounter(); continue; }
    const st = h.getState();
    const prev = new Map([[st.pos, null]]); const q = [st.pos]; let goal = null;
    for (let k = 0; k < q.length && !goal; k++) for (const n of mapNeighbors(st.map, q[k])) { if (prev.has(n) || !isPassable(st.map.tiles[n])) continue; prev.set(n, q[k]); q.push(n); if (st.map.tiles[n].exit) { goal = n; break; } }
    if (!goal) return false;
    let t = goal; while (prev.get(t) !== st.pos) t = prev.get(t);
    h.move(t);
  }
  if (h.encounter()) h.winEncounter();
  s.panel = null; s.selected = h.view().pos; s._refresh();
  return !!h.getState().map.tiles[h.getState().pos].exit;
`);
check('walked to an exit', atExit);
if (atExit) {
  await clickText('^Leave the hunt$');
  await shot('15-leave-confirm');
  const enter = await findText('Enter', 'uiTexts');
  check('Leave asks for confirmation in the dialogue bar', !!enter);
  if (enter) await click(enter.x, enter.y);
  await sleep(200);
  const fin = await evaluate(`return window.__T.s().v.finished;`);
  check('confirming ends the hunt through exit()', fin === 'exit', String(fin));
  await shotP('16-finished');
  await clickText('^Return to camp$');
  const stopped = await evaluate(`return window.__T.g().scene.isActive('HuntFieldOverlay');`);
  check('Return to camp closes the scene and gives the town its input back', !stopped && await evaluate(`return window.__T.g().scene.getScene('TownScene').input.enabled;`));
}

// ---- 12. Small and Bay maps, centred ---------------------------------------------
await open({ zoneId: 'bay_of_solace', objective: 'retrieve', size: 'small', seed: 3 });
await shotP('17-bay-small-retrieve');
await open({ zoneId: 'reeds_of_gethsemane', objective: 'commune', size: 'medium', seed: 11, bonusObjectives: ['unmask'] });
await shot('18-reeds-medium-commune');
check('HUD bonus hover lists bonus objectives', !!(await findText('^Bonus ')));
const bonus = await findText('^Bonus ');
if (bonus) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bonus.x, y: bonus.y }); await sleep(200); await shot('19-bonus-hover'); }

// ---- 13. Scene reuse: open it three more times; nothing piles up -------------------
const counts = [];
for (let k = 0; k < 3; k++) {
  await open({ zoneId: 'reeds_of_gethsemane', objective: 'scout', size: 'medium', seed: 100 + k });
  counts.push(await evaluate(`const s = window.__T.s(); return { down: s.mapZone.listenerCount('pointerdown'), move: s.mapZone.listenerCount('pointermove'), kids: s.children.list.length, town: window.__T.g().scene.getScene('TownScene').input.enabled };`));
}
check('third visit: the same listeners and objects as the first (nothing survives a visit)',
  counts.every(c => c.down === counts[0].down && c.move === counts[0].move && c.kids === counts[0].kids) && counts.every(c => c.town === false),
  JSON.stringify(counts));
// click-sweep once more on the third visit
const sweep3 = await evaluate(`const s = window.__T.s(); return s.v.layout.slice(0, 12).map(id => ({ id, ...s.center(id) }));`);
let hit3 = 0;
for (const h of sweep3) { await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = null; s._refresh(); return true;`); await click(h.x, h.y); if ((await evaluate(`return window.__T.s().selected;`)) === h.id) hit3++; }
check('third visit: clicks still land on the hex clicked', hit3 === sweep3.length, `${hit3}/${sweep3.length}`);
await shot('20-third-visit');

// ---- 14. An overlay opened over the map and closed turns town input back on;
// the map must still take its own clicks and keep the town asleep.
await evaluate(`window.__T.g().scene.getScene('UIScene').openOverlay('InventoryOverlay'); await new Promise(r => setTimeout(r, 900)); return true;`);
await shot('21-inventory-over-map');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(700);
const afterInv = await evaluate(`const G = window.__T.g(); return { inv: G.scene.isActive('InventoryOverlay'), town: G.scene.getScene('TownScene').input.enabled, field: G.scene.isActive('HuntFieldOverlay') };`);
const pick = await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = null; s._refresh(); const id = s.v.layout[Math.floor(s.v.layout.length / 2)]; return { id, ...s.center(id) };`);
await click(pick.x, pick.y);
const afterPick = await evaluate(`const G = window.__T.g(); return { sel: window.__T.s().selected, scenes: G.scene.getScenes(true).map(x => x.sys.settings.key).join(',') };`);
check('after the Inventory opens over the map and closes, the town stays asleep and a click still lands on the map',
  !afterInv.inv && afterInv.field && afterInv.town === false && afterPick.sel === pick.id && !/Loading|CharacterCreation/.test(afterPick.scenes),
  JSON.stringify({ afterInv, afterPick }));

check('no panel button sits under the dialogue bar (y 570+) in any panel screenshot', panelShots.every(p => !p.bad.length), JSON.stringify(panelShots.filter(p => p.bad.length)));
check('no two lines of text overlap inside any panel, in any panel screenshot', panelShots.every(p => !p.overlaps.length), JSON.stringify(panelShots.filter(p => p.overlaps.length)).slice(0, 400));
check('no uncaught errors in the page', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
fs.writeFileSync(path.join(out, `${mode}-results.json`), JSON.stringify(results, null, 1));
await B.close();
const fails = results.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${results.checks.length - fails} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
