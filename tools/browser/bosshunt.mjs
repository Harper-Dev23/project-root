// tools/browser/bosshunt.mjs
//
// Real-browser check of chunk 14b-4: a boss hunt's lair on the map, its
// warning in the dialogue bar, the fight it opens, and the Mourning Beast's
// board (four parts, the Head and Body on one pool). NOT part of
// `npm run verify` (needs Edge).
//
//   node tools/browser/bosshunt.mjs webgl  [outDir] [cdpPort]
//   node tools/browser/bosshunt.mjs canvas [outDir] [cdpPort]

import path from 'node:path';
import os from 'node:os';
import { startBrowser } from './lib.mjs';

const mode = process.argv[2] || 'webgl';
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'bosshunt-shots'));
const port = Number(process.argv[4] || 9333);
const B = await startBrowser({ mode, port, outDir: out });
const { evaluate, shot, click, check, sleep } = B;
await B.loadGame();
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GameState = (await import('/src/systems/GameState.js')).default;
  const party = makeParty(); GameState.characters = party; GameState.party = party;`);

await evaluate(`window.__hunt = await window.bmDevMapHunt({ zoneId: 'reeds_of_gethsemane', objective: 'boss', size: 'large', boss: 'mourning_beast', seed: 7, supplies: 200, besideLair: true });
  // The restore put the party beside the lair without a step, so look around
  // once, as the step there would have (a real move always does).
  window.__T.s().hunt._reveal(); window.__T.s()._refresh();
  await new Promise(r => setTimeout(r, 500)); return true;`);
const lair = await evaluate(`const s = window.__T.s(); const o = s.v.occupants.find(x => x.kind === 'boss'); const m = s.v.objectiveSites.find(x => x.objective === 'boss');
  return o ? { tile: o.tile, name: o.name, marked: m?.tile === o.tile, ...s.center(o.tile), here: s.v.layout.includes(o.tile) } : null;`);
check('the lair shows on the map, named, and marked as the objective', !!lair && lair.name === 'The Mourning Beast' && lair.marked && lair.here, JSON.stringify(lair));
await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = ${JSON.stringify(lair?.tile)}; s._refresh(); return true;`);
await sleep(200);
await shot('01-lair-selected');
check('selecting it says what it is', !!(await B.findText('in its lair', 'HuntFieldOverlay')));

// Move onto it (click it twice, as a player does): the warning, not a fight.
await click(lair.x, lair.y);
await sleep(300);
const warned = await evaluate(`const s = window.__T.s(); return { enc: !!s.v.encounter, pos: s.v.pos, bar: window.__T.textsOf('UIScene').map(t => t.text).join(' | ') };`);
await shot('02-lair-warning');
check('stepping onto the lair shows its warning in the dialogue bar, and no fight yet', !warned.enc && /Lair/.test(warned.bar) && /boss fight/.test(warned.bar), warned.bar.slice(0, 160));
const enter = await B.findText('Enter', 'UIScene');
if (enter) await click(enter.x, enter.y);
await sleep(400);
const inside = await evaluate(`const s = window.__T.s(); return { enc: s.v.encounter?.kind || null, pos: s.v.pos };`);
check('confirming steps in: the boss fight is on', inside.enc === 'boss' && inside.pos === lair.tile, JSON.stringify(inside));
await shot('03-encounter');

await B.clickText('^Fight$', 'HuntFieldOverlay');
const ready = "window.__T.g().scene.isActive('CombatScene') && (window.__T.g().scene.getScene('CombatScene').enemies || []).length > 0";
let ok = false;
for (let i = 0; i < 40 && !ok; i++) { ok = await evaluate(`return ${ready};`); if (!ok) await sleep(250); }
check('Fight opens the combat scene', ok);
await sleep(800);
await shot('04-board');
const board = await evaluate(`const c = window.__T.g().scene.getScene('CombatScene');
  return c.enemies.map(e => ({ name: e.name, slot: e._slot?.slotId, hp: e.currentHP, max: e.maxHP, pool: !!e._pool }));`);
check('the board holds the four parts in their slots', board.length === 4 && ['Head', 'Body', 'Left Limb', 'Right Limb'].every(n => board.some(b => b.name.includes(n))), JSON.stringify(board));
const head = board.find(b => b.name.includes('Head')), body = board.find(b => b.name.includes('Body'));
check('the Head and Body show one pool', head?.pool && body?.pool && head.hp === body.hp && head.max === body.max, `${head?.hp}/${head?.max} and ${body?.hp}/${body?.max}`);

// The win (owner's playtest, 2026-09-27: the chest's Historic item arrived
// unannounced): every part down, the victory screen shows Burden of Dreams,
// and the log says it came from the chest.
await evaluate(`const c = window.__T.g().scene.getScene('CombatScene');
  for (const e of c.enemies) { e.currentHP = 0; e.status = 'incapacitated'; }
  c._checkVictoryCondition(); await new Promise(r => setTimeout(r, 1800)); return true;`);
await shot('04b-victory');
const vic = await evaluate(`const c = window.__T.g().scene.getScene('CombatScene');
  return { texts: c.children.list.filter(o => o.type === 'Text').map(o => o.text).join(' | '),
    log: (c.combatEntries || []).map(e => (e.segments || []).map(g => g.text).join('')).join(' | ') };`);
check("the victory screen lists Burden of Dreams, and the log names the lair's chest", /Burden of Dreams[^|]*\[Historic\]/.test(vic.texts) && /chest holds a Historic item: Burden of Dreams/.test(vic.log),
  (vic.log.match(/[^|]*chest[^|]*/) || [''])[0].slice(0, 200));

// ---- The Ghost Party (14b-5): the Drowned Camp at night, six ghosts on the board ----
// A fresh page: stopping the first fight's CombatScene by hand leaves UIScene
// half-built (its dialogue bar off-screen), which a real fight never does.
await B.loadGame();
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GameState = (await import('/src/systems/GameState.js')).default;
  const party = makeParty(); GameState.characters = party; GameState.party = party;`);
await evaluate(`window.__hunt = await window.bmDevMapHunt({ zoneId: 'reeds_of_gethsemane', objective: 'boss', size: 'large', boss: 'ghost_party', seed: 8, supplies: 200, besideLair: true, night: true });
  window.__T.s().hunt._reveal(); window.__T.s()._refresh();
  await new Promise(r => setTimeout(r, 500)); return true;`);
const camp = await evaluate(`const s = window.__T.s(); const o = s.v.occupants.find(x => x.kind === 'boss'); return o ? { tile: o.tile, name: o.name, night: s.v.clock.isNight, ...s.center(o.tile) } : null;`);
check('the Drowned Camp shows on the map at night', !!camp && camp.name === 'The Ghost Party' && camp.night, JSON.stringify(camp));
await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = ${JSON.stringify(camp?.tile)}; s._refresh(); return true;`);
await sleep(200);
await click(camp.x, camp.y);
await sleep(300);
await shot('05-camp-warning');
const bar = await evaluate(`return window.__T.textsOf('UIScene').map(t => t.text).join(' | ');`);
check('its warning names the Drowned Camp', /Drowned Camp/.test(bar), bar.slice(0, 160));
const enter2 = await B.findText('Enter', 'UIScene');
if (enter2) await click(enter2.x, enter2.y);
await sleep(400);
await B.clickText('^Fight$', 'HuntFieldOverlay');
let ok2 = false;
for (let i = 0; i < 40 && !ok2; i++) { ok2 = await evaluate(`return ${ready};`); if (!ok2) await sleep(250); }
await sleep(800);
await shot('06-ghost-board');
const ghosts = await evaluate(`const c = window.__T.g().scene.getScene('CombatScene');
  return c.enemies.map(e => ({ name: e.name, slot: e._slot?.slotId, weapon: e.equipment?.weaponMain?.id || null, amulet: e.equipment?.amulet?.id || null }));`);
check('six ghosts on the board, each armed', ok2 && ghosts.length === 6 && ghosts.every(g => g.weapon), JSON.stringify(ghosts.map(g => g.name + '@' + g.slot)));
check('the Ghost Captain wears The Unconfessed', ghosts.find(g => g.name === 'Ghost Captain')?.amulet === 'the_unconfessed');

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail   shots: ${out}`);
await B.close();
process.exit(fails ? 1 : 0);
