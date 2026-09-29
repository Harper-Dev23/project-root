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
  PM.setQuestFlag('apex_slain:reeds_of_gethsemane'); PM.setQuestFlag('vowback_slain');
  // At the Lament Pools: the steps before it reported to the Elder (4b chunk 1).
  for (const id of ['wr_hunt', 'wr_cull', 'wr_apexpool', 'wr_apex']) PM.markStepDone(id);`);

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

// ---- 3. The Omen meter and the tribe's offer, at the lodge's Regions (4b chunk 6) --
await evaluate(`
  const g = window.__T.g(); g.scene.stop('HuntFieldOverlay');
  const PM = (await import('/src/systems/ProgressionManager.js')).default;
  PM.setQuestFlag('mb_weeping_heard'); PM.setQuestFlag('mb_signs_found'); PM.omens = { reeds_of_gethsemane: 40 };
  // The offer waits on Signs of the Mourner being reported to the Elder (4b chunk 1).
  for (const id of ['wr_hunt', 'wr_cull', 'wr_apexpool', 'wr_apex', 'wr_pools', 'wr_signs']) PM.markStepDone(id);
  g.scene.getScene('TownScene').scene.launch('HuntHubOverlay');
  await new Promise(r => setTimeout(r, 500));
  g.scene.getScene('HuntHubOverlay').setZone('reeds_of_gethsemane');
  await new Promise(r => setTimeout(r, 300)); return true;`);
await shot('03-hub-offer');
check('the hunt board no longer shows the meter, and points to the lodge', !(await B.findText('^Omens ', 'HuntHubOverlay'))
  && !!(await B.findText('Tribe HQ > Regions', 'HuntHubOverlay')));
await evaluate(`const g = window.__T.g(); g.scene.stop('HuntHubOverlay');
  g.scene.getScene('TownScene').scene.launch('TribeHQOverlay'); await new Promise(r => setTimeout(r, 500)); return true;`);
await shot('03b-lodge-header');
check('Tribe HQ stars Regions when something waits there', !!(await B.findText('^Regions ★', 'TribeHQOverlay')));
await B.clickText('^Regions', 'TribeHQOverlay');
await sleep(500);
await shot('03c-lodge-regions');
check('Regions shows the Reeds with its meter', !!(await B.findText('^The Reeds of Gethsemane', 'LodgeRegionsOverlay')) && !!(await B.findText('^Omens: ', 'LodgeRegionsOverlay')));
await B.clickText("^Take it: Mourner's Offering", 'LodgeRegionsOverlay');
await sleep(300);
const after = await evaluate(`
  const GS = (await import('/src/systems/GameState.js')).default; const PM = (await import('/src/systems/ProgressionManager.js')).default;
  return { plans: GS.inventory.filter(i => i.id === 'mourners_offering').length, unlocked: PM.hasQuestFlag('mb_offer_taken') };`);
check("taking the tribe's offer in Regions puts a Mourner's Offering in the bag and unlocks the boss", after.plans === 1 && after.unlocked, JSON.stringify(after));
check('...and says so, and the button is gone', !!(await B.findText("Mourner's Offering is in your camp bag", 'LodgeRegionsOverlay')) && !(await B.findText('^Take it:', 'LodgeRegionsOverlay')));
await evaluate(`const PM = (await import('/src/systems/ProgressionManager.js')).default; PM.omens = { reeds_of_gethsemane: 220 };
  window.__T.g().scene.getScene('LodgeRegionsOverlay')._render(); await new Promise(r => setTimeout(r, 200)); return true;`);
await shot('04-regions-full-meter');
check('with a full meter the claim button shows', !!(await B.findText('^Claim: The Mourning Beast', 'LodgeRegionsOverlay')));
await B.clickText('^Claim: The Mourning Beast', 'LodgeRegionsOverlay');
await sleep(300);
const claimed = await evaluate(`const GS = (await import('/src/systems/GameState.js')).default; const PM = (await import('/src/systems/ProgressionManager.js')).default;
  return { plans: GS.inventory.filter(i => i.id === 'mourners_offering').length, meter: PM.omens.reeds_of_gethsemane };`);
check('claiming spends a full meter (200 omens) for a second plan', claimed.plans === 2 && claimed.meter === 20, JSON.stringify(claimed));
await evaluate(`const g = window.__T.g(); g.scene.stop('LodgeRegionsOverlay');
  g.scene.getScene('TownScene').scene.launch('HuntHubOverlay');
  await new Promise(r => setTimeout(r, 500));
  g.scene.getScene('HuntHubOverlay').setZone('reeds_of_gethsemane');
  await new Promise(r => setTimeout(r, 300)); return true;`);
await B.clickText('^Choose Hunt Plan', 'HuntHubOverlay');
await sleep(500);
await shot('05-picker-boss-plan');
check('the picker lists the boss plan, pickable, saying when it is used up', !!(await B.findText('used up once the boss is fought', 'HuntPlanPickerOverlay')));
// The picker scrolls (owner's playtest, 2026-09-27): with many plans the last
// one is out of view, and the wheel brings it in to be picked.
await evaluate(`const g = window.__T.g(); g.scene.stop('HuntPlanPickerOverlay');
  const GS = (await import('/src/systems/GameState.js')).default; const F = await import('/src/systems/ItemFactory.js');
  for (let i = 0; i < 9; i++) GS.inventory.push(F.createItemInstance('tethered_soul'));
  g.scene.getScene('HuntHubOverlay').scene.pause(); g.scene.getScene('HuntHubOverlay').scene.launch('HuntPlanPickerOverlay');
  await new Promise(r => setTimeout(r, 500)); return true;`);
const sc = await evaluate(`const p = window.__T.g().scene.getScene('HuntPlanPickerOverlay');
  const before = p._scroll, max = p._max; p._setScroll(99999); await new Promise(r => setTimeout(r, 100));
  const last = p._list.list.filter(o => o.type === 'Rectangle').pop();
  const lastY = last.y + p._list.y;
  return { before, max, after: p._scroll, lastVisible: lastY < p._view.bottom && lastY > p._view.top };`);
await shot('05b-picker-scrolled');
check('the picker scrolls: the list is longer than the view, and scrolling brings the last plan into view', sc.max > 0 && sc.before === 0 && sc.after === sc.max && sc.lastVisible, JSON.stringify(sc));

// ---- 4. The journal's hunt entries (14f): the new one loads, the rewrites too --
await evaluate(`const g = window.__T.g(); g.scene.stop('HuntPlanPickerOverlay'); g.scene.stop('HuntHubOverlay');
  g.scene.getScene('UIScene').openOverlay('JournalOverlay'); await new Promise(r => setTimeout(r, 1500)); return true;`);
const jr = await evaluate(`const j = window.__T.g().scene.getScene('JournalOverlay')?.overlay; await j?._bootPromise; const es = j?._entries || [];
  const e = (id) => es.find(x => x.id === id);
  return { active: window.__T.active(), n: es.length, boss: !!e('hunt/bosses_and_historic')?.content, bossTitle: e('hunt/bosses_and_historic')?.title || null,
    synopsis: /hex map/.test(e('hunt/hunt_synopsis')?.content || ''), details: /Omen meter/.test(e('hunt/hunt_details')?.content || ''),
    resolves: !!j?._resolveEntryRef?.('Bosses and Historic Items') };`);
check('the journal loads "Bosses and Historic Items", and the hunt entries are the hex-map rewrites', jr.boss && jr.bossTitle === 'Bosses and Historic Items' && jr.synopsis && jr.details && jr.resolves, JSON.stringify(jr));
await shot('07-journal');

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail   shots: ${out}`);
await B.close();
process.exit(fails ? 1 : 0);
