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

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail   shots: ${out}`);
await B.close();
process.exit(fails ? 1 : 0);
