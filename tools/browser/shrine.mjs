// tools/browser/shrine.mjs
//
// Real-browser check of the lodge shrine (LodgeShrineOverlay, Exploration
// System v2 chunk 10c). NOT part of `npm run verify`: it needs Microsoft Edge.
//
//   node tools/browser/shrine.mjs webgl  [outDir] [cdpPort]
//   node tools/browser/shrine.mjs canvas [outDir] [cdpPort]
//
// What it proves, with real clicks:
//   - the lodge's Shrine button opens the shrine in its place, and closing
//     the shrine brings the lodge back
//   - the houses: your lodge follows none yet; the house you are eligible for
//     offers Accept, the others say how far off they are; accepting takes two
//     clicks, then your lodge follows it, and the autosave holds it
//   - the Slain: a hunter who fell in your house's lands offers intercession
//     and the rite, one who fell abroad only the rite; intercession (two
//     clicks) brings them back into camp and spends the Bond's standing; the
//     rite (two clicks) pays its tickets and shows the days left
//   - no uncaught errors
//
// Plumbing (Edge, DevTools, the static server, boot like a player): lib.mjs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startBrowser } from './lib.mjs';

const mode = process.argv[2] || 'webgl';
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'shrine-shots'));
const port = Number(process.argv[4] || 9363);
const B = await startBrowser({ mode, port, outDir: out });
const { evaluate, shot, check, sleep, clickText, findText } = B;
const SH = 'LodgeShrineOverlay';
const texts = (key = SH) => evaluate(`return window.__T.textsOf('${key}').map(t => t.text);`);
const saved = () => evaluate(`return JSON.parse(localStorage.getItem('bmSave_autosave') || 'null');`);
const twice = async (re) => { await clickText(re, SH); await sleep(350); await clickText('^Confirm$', SH); await sleep(450); };

await B.loadGame();
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  const PM = (await import('/src/systems/ProgressionManager.js')).default;
  const S = await import('/src/systems/Standing.js');
  const party = makeParty(); GS.characters = [...party]; GS.party = party.slice(0, 4); GS.slain = [];
  PM.tribe = null; PM.setTribe('styx');
  const st = PM.getStanding();
  S.earnFavor(st, 'styx', 'jeremiah', 110);   // eligible for Jeremiah (Bond 110 too)
  S.earnFavor(st, 'styx', 'ezekiel', 40);     // 60 short of Ezekiel
  PM.huntTickets = 50;
  // Two fallen: one in Jeremiah's reeds, one abroad in Ezekiel's bay (both Watched).
  const home = party[5], abroad = party[4];
  home.level = 2; abroad.level = 1;
  for (const c of [home, abroad]) { c.status = 'dead'; c.currentHP = 0; }
  GS.moveToSlain(home, S.fellRecord({ zoneId: 'reeds_of_gethsemane', prophet: 'jeremiah', rule: 'watched', day: 0 }));
  GS.moveToSlain(abroad, S.fellRecord({ zoneId: 'bay_of_solace', prophet: 'ezekiel', rule: 'watched', day: 0 }));
  window.__home = home.name; window.__abroad = abroad.name;
`);
check(`renderer is ${mode === 'canvas' ? 'CANVAS' : 'WEBGL'}`, (await evaluate('return window.__T.g().renderer.type;')) === (mode === 'canvas' ? 1 : 2));
const names = await evaluate('return { home: window.__home, abroad: window.__abroad };');

// ---- 1. The lodge's Shrine button -------------------------------------------
await evaluate(`const G = window.__T.g(); G.scene.run('TribeHQOverlay'); G.scene.bringToTop('TribeHQOverlay'); await new Promise(r => setTimeout(r, 800)); return 1;`);
check('the lodge offers a Shrine button', !!(await findText('^Shrine$', 'TribeHQOverlay')));
await clickText('^Shrine$', 'TribeHQOverlay');
await sleep(800);
const opened = await evaluate(`const G = window.__T.g(); return { sh: G.scene.isActive('${SH}'), hq: G.scene.isActive('TribeHQOverlay') };`);
check('Shrine (clicked) opens the shrine in the lodge\'s place', opened.sh && !opened.hq, JSON.stringify(opened));
await shot('01-shrine');

// ---- 2. The houses ----------------------------------------------------------
let t = await texts();
check('your lodge follows no house yet', t.includes('Your lodge follows no house yet.'));
check('Jeremiah, the house you are eligible for, offers Accept', t.includes('Accept Jeremiah'));
check('Ezekiel says how far off it is', t.some(x => x === '60 more devotion to claim'), t.filter(x => x.includes('more')).join(' | '));
await clickText('^Accept Jeremiah$', SH);
await sleep(350);
t = await texts();
check('the first click only arms it (Confirm)', t.includes('Confirm') && t.includes('Your lodge follows no house yet.'));
await clickText('^Confirm$', SH);
await sleep(450);
t = await texts();
const sv1 = await saved();
check('the second click accepts it: your lodge follows Jeremiah', t.includes("Your lodge's interpreters follow Jeremiah.") && t.some(x => x.startsWith('Jeremiah — your house')));
check('...and the autosave holds it', sv1?.progression?.standing?.holds?.jeremiah === 'styx');
await shot('02-accepted');

// ---- 3. The fallen ------------------------------------------------------------
check(`${names.home} (fell in Jeremiah's reeds) is offered intercession and the rite`,
  t.includes('Intercede: 20 standing') && t.includes('Rite: 4 days, 10 tickets'), t.filter(x => /Intercede|Rite/.test(x)).join(' | '));
check(`${names.abroad} (fell abroad) is offered only the rite`, t.filter(x => x.startsWith('Intercede')).length === 1 && t.includes('Rite: 3 days, 5 tickets'));
await twice('^Intercede: 20 standing$');
const afterI = await evaluate(`const GS = (await import('/src/systems/GameState.js')).default; const PM = (await import('/src/systems/ProgressionManager.js')).default;
  return { back: GS.characters.some(c => c.name === window.__home && c.status === 'alive' && c.currentHP === c.maxHP), slain: GS.slain.map(c => c.name), bond: PM.getStanding().bond.jeremiah };`);
check(`Intercede (two clicks): ${names.home} is back in camp at full HP, and the Bond paid 20`,
  afterI.back && !afterI.slain.includes(names.home) && afterI.bond === 90, JSON.stringify(afterI));
await twice('^Rite: 3 days, 5 tickets$');
t = await texts();
const afterR = await evaluate(`const GS = (await import('/src/systems/GameState.js')).default; const PM = (await import('/src/systems/ProgressionManager.js')).default;
  const c = GS.slain.find(x => x.name === window.__abroad); return { rite: c?.rite || null, tickets: PM.huntTickets };`);
check(`the rite (two clicks) for ${names.abroad}: 5 tickets paid, and the shrine shows the days left`,
  afterR.rite && afterR.tickets === 45 && t.includes('The rite: 3 days left'), JSON.stringify(afterR));
const sv2 = await saved();
check('...and both are in the autosave', !sv2.slain.some(c => c.name === names.home) && sv2.slain.find(c => c.name === names.abroad)?.rite?.untilDay === afterR.rite?.untilDay);
await shot('03-fallen');

// ---- 3b. Historic items: the return ritual (chunk 14b) -----------------------
await evaluate(`const GS = (await import('/src/systems/GameState.js')).default; const IF = await import('/src/systems/ItemFactory.js');
  window.__bod = IF.createItemInstance('burden_of_dreams'); GS.inventory.push(window.__bod); return 1;`);
await clickText('^Historic Items$', SH);
await sleep(450);
t = await texts();
const rolls = await evaluate(`return window.__bod.historicRolls;`);
check('the Historic Items tab lists Burden of Dreams from the camp bag, with this copy\'s rolled lines',
  t.includes('Burden of Dreams') && t.some(x => x.startsWith('This copy:') && x.includes(`STR +${rolls.stats.STR}`)) && t.includes("Return to the Mourning Beast's lair"),
  t.filter(x => x.startsWith('This copy') || x.startsWith('Return')).join(' | '));
await shot('03b-historic');
await twice("^Return to the Mourning Beast's lair$");
const after = await evaluate(`const GS = (await import('/src/systems/GameState.js')).default; const r = localStorage.getItem('bmSave_autosave');
  return { inBag: GS.inventory.includes(window.__bod), wild: GS.historicInWild('burden_of_dreams'), led: JSON.parse(r)?.flags?.historicLedger?.burden_of_dreams || null };`);
t = await texts();
check('Return (two clicks): the copy leaves the bag, the item is back in the wild, the return is in the autosave, and the shrine says so',
  !after.inBag && after.wild && after.led?.returned === 1 && t.some(x => x.startsWith('Burden of Dreams returns to')), JSON.stringify(after));
await shot('03c-returned');

// ---- 4. Closing brings the lodge back ---------------------------------------
await clickText('^✕$|^X$|^Close$', SH).catch(() => {});
await sleep(200);
let closed = await evaluate(`const G = window.__T.g(); return { sh: G.scene.isActive('${SH}'), hq: G.scene.isActive('TribeHQOverlay') };`);
if (closed.sh) {
  await evaluate(`window.__T.g().scene.getScene('${SH}')._close(); return 1;`);
  await sleep(600);
  closed = await evaluate(`const G = window.__T.g(); return { sh: G.scene.isActive('${SH}'), hq: G.scene.isActive('TribeHQOverlay'), how: 'the scene close hook' };`);
}
check('closing the shrine brings the lodge back', !closed.sh && closed.hq, JSON.stringify(closed));
await shot('04-lodge-again');

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
fs.writeFileSync(path.join(out, `${mode}-results.json`), JSON.stringify({ mode, checks: B.checks, errors: B.errors }, null, 1));
await B.close();
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
