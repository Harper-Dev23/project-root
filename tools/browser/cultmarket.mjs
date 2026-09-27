// tools/browser/cultmarket.mjs
//
// Real-browser check of the cult economy (owner, 2026-09-27): a black market's
// panel on the hunt map, a purchase that spends Sin Tickets and lands in the
// camp bag, and the Draughtwell's new potions. NOT part of `npm run verify`
// (needs Edge). One browser at a time (the owner's RAM rule).
//
//   node tools/browser/cultmarket.mjs webgl  [outDir] [cdpPort]
//   node tools/browser/cultmarket.mjs canvas [outDir] [cdpPort]

import path from 'node:path';
import os from 'node:os';
import { startBrowser } from './lib.mjs';

const mode = process.argv[2] || 'webgl';
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'cultmarket-shots'));
const port = Number(process.argv[4] || 9333);
const B = await startBrowser({ mode, port, outDir: out });
const { evaluate, shot, check, sleep } = B;
await B.loadGame();
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GameState = (await import('/src/systems/GameState.js')).default;
  const PM = (await import('/src/systems/ProgressionManager.js')).default;
  const party = makeParty(); GameState.characters = party; GameState.party = party;
  PM.sinTickets = 5; PM.huntTickets = 3;`);

// ---- 1. A black market on the hunt map --------------------------------------
await evaluate(`window.__hunt = await window.bmDevMapHunt({ zoneId: 'reeds_of_gethsemane', objective: 'scout', size: 'medium', seed: 21,
    questSites: [{ step: 'market:yargaleth', eventId: 'tithe_boat', far: false }] });
  await new Promise(r => setTimeout(r, 400));
  const s = window.__T.s(); const site = s.v.objectiveSites.find(o => o.objective === 'market');
  s.hunt._openEventAt(site.tile); s._refresh(); await new Promise(r => setTimeout(r, 300)); return true;`);
await shot('01-tithe-boat');
check('the Tithe-Boat opens as a market, with the Choir, the tickets carried and its stalls', !!(await B.findText('^The Tithe-Boat$', 'HuntFieldOverlay'))
  && !!(await B.findText('5 Sin Tickets', 'HuntFieldOverlay')) && !!(await B.findText('^Gamble \\(1\\)$', 'HuntFieldOverlay')) && !!(await B.findText('^Tincture of Red Breath \\(2\\)$', 'HuntFieldOverlay')));
const bag0 = await evaluate(`const GS = (await import('/src/systems/GameState.js')).default; return GS.inventory.length;`);
await B.clickText('^Tincture of Red Breath \\(2\\)$', 'HuntFieldOverlay');
await sleep(300);
const after = await evaluate(`const GS = (await import('/src/systems/GameState.js')).default; const PM = (await import('/src/systems/ProgressionManager.js')).default;
  return { tickets: PM.sinTickets, bag: GS.inventory.length, has: GS.inventory.some(i => i.id === 'tincture_red_breath'), bar: window.__T.textsOf('UIScene').map(t => t.text).join(' | ') };`);
check('buying a tincture: 2 Sin Tickets spent, the tincture in the camp bag, and the dialogue bar says so', after.tickets === 3 && after.bag === bag0 + 1 && after.has && /camp bag/.test(after.bar), JSON.stringify({ ...after, bar: undefined }));
await B.clickText('^Gamble \\(1\\)$', 'HuntFieldOverlay');
await sleep(300);
const g = await evaluate(`const PM = (await import('/src/systems/ProgressionManager.js')).default; const GS = (await import('/src/systems/GameState.js')).default; return { tickets: PM.sinTickets, bag: GS.inventory.length };`);
check('a gamble: 1 more Sin Ticket, one more item', g.tickets === 2 && g.bag === bag0 + 2, JSON.stringify(g));
await shot('02-after-buying');

// ---- 1b. A quest trade says whose quest it is and what it pays (clarity pass) ----
await evaluate(`window.__hunt = await window.bmDevMapHunt({ zoneId: 'reeds_of_gethsemane', objective: 'scout', size: 'medium', seed: 22,
    questSites: [{ step: 'hb_cantor', eventId: 'choir_cantor', far: false }] });
  await new Promise(r => setTimeout(r, 400));
  const s = window.__T.s(); const site = s.v.objectiveSites.find(o => o.objective === 'quest');
  s.hunt._openEventAt(site.tile); s._refresh(); await new Promise(r => setTimeout(r, 300)); return true;`);
await shot('01b-cantor-trade');
check('a quest trade names its quest line and what it pays', !!(await B.findText('^Quest: The Hymn Beneath the Water$', 'HuntFieldOverlay'))
  && !!(await B.findText('^They give: advances a quest, 1 Sin Ticket\\.$', 'HuntFieldOverlay')));

// ---- 2. The Draughtwell sells the draughts (its stock, as the vendor row reads it) ----
const dw = await evaluate(`const town = window.__T.g().scene.getScene('TownScene');
  return (town.getVendorDefinitions().greenhollow?.inventory || []).map(e => [e.id, e.cost, e.currency || null]);`);
check('the Draughtwell stocks a Healing Draught and a Mana Draught for a Hunt Ticket each', ['healing_draught', 'mana_draught'].every(id => dw.some(([i, c, cur]) => i === id && c === 1 && cur === 'huntTickets')), JSON.stringify(dw));

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail   shots: ${out}`);
await B.close();
process.exit(fails ? 1 : 0);
