// tools/browser/questsites.mjs
//
// Real-browser check of chunk 14b-2: the Quest Log's Regions tab shows The
// Weeping in the Reeds at the save's step, and a hunt map marks the step's
// quest site with its hover line. NOT part of `npm run verify` (needs Edge).
//
//   node tools/browser/questsites.mjs webgl  [outDir] [cdpPort]
//   node tools/browser/questsites.mjs canvas [outDir] [cdpPort]
//
// Plumbing (Edge, DevTools, the static server, boot like a player): lib.mjs.

import path from 'node:path';
import os from 'node:os';
import { startBrowser } from './lib.mjs';

const mode = process.argv[2] || 'webgl';
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'questsites-shots'));
const port = Number(process.argv[4] || 9333);
const B = await startBrowser({ mode, port, outDir: out });
const { evaluate, shot, check, sleep } = B;
await B.loadGame();
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GameState = (await import('/src/systems/GameState.js')).default;
  const PM = (await import('/src/systems/ProgressionManager.js')).default;
  const party = makeParty(); GameState.characters = party; GameState.party = party;
  PM.tribe = PM.tribe || 'styx';
  PM.setQuestFlag('hunted:reeds_of_gethsemane');
  PM.setQuestFlag('apex_slain:reeds_of_gethsemane');`);

// ---- 1. The Quest Log's Regions tab ------------------------------------------
await evaluate(`window.__T.g().scene.getScene('UIScene').openOverlay('QuestOverlay'); await new Promise(r => setTimeout(r, 500)); return true;`);
const tabs = await evaluate(`
  const q = window.__T.g().scene.getScene('QuestOverlay');
  const b = q._bounds; const out = {};
  for (const [id, t] of Object.entries(q._tabBtns)) { const r = t.bg.getBounds(); out[id] = { l: Math.round(r.left), r: Math.round(r.right) }; }
  return { frame: { l: Math.round(b.x), r: Math.round(b.right) }, tabs: out };`);
const inside = Object.values(tabs.tabs).every(t => t.l >= tabs.frame.l && t.r <= tabs.frame.r);
check('six tabs, Regions among them, all inside the frame', Object.keys(tabs.tabs).length === 6 && !!tabs.tabs.region && inside, JSON.stringify(tabs));
await evaluate(`window.__T.g().scene.getScene('QuestOverlay')._showTab('region'); await new Promise(r => setTimeout(r, 300)); return true;`);
await shot('01-regions-tab');
// Expand the quest by clicking its title, as a player does.
const title = await evaluate(`
  const q = window.__T.g().scene.getScene('QuestOverlay'); let hit = null;
  const walk = (o) => { if (!o || hit) return; if (o.type === 'Text' && /Weeping in the Reeds/.test(o.text)) hit = o.getBounds(); if (o.list) o.list.forEach(walk); };
  q.children.list.forEach(walk); return hit && { x: hit.centerX, y: hit.centerY };`);
if (title) await B.click(title.x, title.y);
await sleep(300);
await shot('01b-quest-expanded');
const texts = await evaluate(`
  const q = window.__T.g().scene.getScene('QuestOverlay'); const out = [];
  const walk = (o) => { if (!o) return; if (o.type === 'Text' && o.visible) out.push(o.text); if (o.list) o.list.forEach(walk); };
  q.children.list.forEach(walk); return out;`);
check('the Regions tab shows The Weeping in the Reeds', texts.some(t => /Weeping in the Reeds/.test(t)), texts.slice(0, 12).join(' | '));
check('...at the save\'s step: The Lament Pools', texts.some(t => /Lament Pools/.test(t)));
await evaluate(`window.__T.g().scene.getScene('UIScene').closeOverlay?.('QuestOverlay'); window.__T.g().scene.stop('QuestOverlay'); await new Promise(r => setTimeout(r, 300)); return true;`);

// ---- 2. A hunt map marks the quest site ---------------------------------------
await evaluate(`window.__hunt = await window.bmDevMapHunt({ zoneId: 'reeds_of_gethsemane', objective: 'scout', size: 'medium', seed: 7,
  questSites: [{ step: 'wr_pools', eventId: 'reeds_lament_pools', far: true }] }); await new Promise(r => setTimeout(r, 400)); return true;`);
const site = await evaluate(`const s = window.__T.s(); return s.v.objectiveSites.find(o => o.objective === 'quest') || null;`);
check('the hunt view marks the quest site', site?.name === 'The Lament Pools' && site.night && !site.done, JSON.stringify(site));
await evaluate(`const s = window.__T.s(); s.panel = null; s.selected = ${JSON.stringify(site?.tile || null)}; s._refresh(); return true;`);
await sleep(200);
await shot('02-quest-site-selected');
check('selecting it reads "Quest: The Lament Pools (after dark)."', !!(await B.findText('Quest: The Lament Pools \\(after dark\\)')));

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail   shots: ${out}`);
await B.close();
process.exit(fails ? 1 : 0);
