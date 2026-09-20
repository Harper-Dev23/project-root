// tools/browser/partysheet.mjs
//
// Real-browser check of the party sheet (PartyManagementScene, Exploration
// System v2 chunk 8d). NOT part of `npm run verify`: it needs Microsoft Edge.
//
//   node tools/browser/partysheet.mjs webgl  [outDir] [cdpPort]
//   node tools/browser/partysheet.mjs canvas [outDir] [cdpPort]
//
// What it proves, with real clicks:
//   - the sheet shows all eight party stats, and who provides each best-of one
//   - clicking a hunter in the list shows that hunter's six ratings
//   - an exploration pick can be taken: the modal offers the ratings and the
//     class's passives, taking one raises the rating by 10, the sheet follows,
//     and the pick is saved (it survives a reload)
//   - a hunter with no pick owed says so
//   - nothing the sheet draws reaches into the formation slots (y 344+)
//   - the map's HUD opens the same sheet mid-hunt, and closing it leaves the
//     map up with the town still asleep
//   - three visits in a row leave no objects or listeners behind
//   - no uncaught errors
//
// Plumbing (Edge, DevTools, the static server, boot like a player): lib.mjs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startBrowser } from './lib.mjs';

const mode = process.argv[2] || 'webgl';
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'partysheet-shots'));
const port = Number(process.argv[4] || 9353);
const B = await startBrowser({ mode, port, outDir: out });
const { evaluate, shot, click, check, sleep, clickText, findText, key } = B;
const PM = 'PartyManagementScene';

const openSheet = () => evaluate(`
  const G = window.__T.g();
  G.scene.run('${PM}'); G.scene.bringToTop('${PM}');
  await new Promise(r => setTimeout(r, 900));
  return G.scene.isActive('${PM}');`);

await B.loadGame();
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  const party = makeParty(); GS.characters = party; GS.party = party;
  // One hunter at level 9 owes picks at 2, 4, 6 and 8; one at level 1 owes
  // none (the fixtures are all level 5, which owes 2 and 4).
  GS.party[2].level = 9; GS.party[0].level = 1;
`);
check(`renderer is ${mode === 'canvas' ? 'CANVAS' : 'WEBGL'}`, (await evaluate('return window.__T.g().renderer.type;')) === (mode === 'canvas' ? 1 : 2));

// ---- 1. The eight party stats ------------------------------------------------
check('the party sheet opens', await openSheet());
await shot('01-sheet');
const texts = await evaluate(`return window.__T.textsOf('${PM}').map(t => t.text);`);
const STATS = ['Perception', 'Endurance', 'Speed', 'Cooking', 'Fishing', 'Foraging', 'Item Rarity', 'Party Initiative'];
check('all eight party stats are on the sheet', STATS.every(s => texts.some(t => t.startsWith(s + ' '))),
  texts.filter(t => STATS.some(s => t.startsWith(s + ' '))).join(' | '));
check('...each best-of stat names the hunter providing it',
  ['Perception', 'Cooking', 'Fishing', 'Foraging'].every(s => texts.some(t => t.startsWith(s + ' ') && /\(\w+\)/.test(t))));
const real = await evaluate(`
  const { partyStats } = await import('/src/systems/PartyStats.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  const st = partyStats(GS.party, {});
  return { p: Math.round(st.perception * 10) / 10, by: st.providers.perception, init: Math.round(st.partyInitiative * 10) / 10 };`);
check('...with the numbers partyStats gives', texts.some(t => t === `Perception ${real.p} (${real.by})`)
  && texts.some(t => t === `Party Initiative ${real.init}`), JSON.stringify(real));

// ---- 2. Selecting a hunter shows their ratings ---------------------------------
const who = await evaluate(`const GS = (await import('/src/systems/GameState.js')).default; return { name: GS.party[2].name, cls: GS.party[2].baseClass, level: GS.party[2].level };`);
await clickText(`^• ${who.name} `, PM);
await shot('02-hunter-selected');
const sel = await evaluate(`return window.__T.textsOf('${PM}').map(t => t.text);`);
check('clicking a hunter in the list shows that hunter on the sheet',
  sel.some(t => t.startsWith(`${who.name} — ${who.cls} (Lv ${who.level})`)), `${who.name} — ${who.cls}`);
const ratingsLine = sel.find(t => /Perception \d+ +· +Endurance \d+ +· +Speed \d+/.test(t));
const realRatings = await evaluate(`
  const { hunterExploration } = await import('/src/systems/PartyStats.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  return hunterExploration(GS.party[2]).ratings;`);
check('...and their six ratings, as hunterExploration gives them',
  !!ratingsLine && ratingsLine.includes(`Perception ${realRatings.perception}`) && sel.some(t => t.includes(`Foraging ${realRatings.foraging}`)),
  ratingsLine || sel.join(' | ').slice(0, 120));

// ---- 3. Taking an exploration pick ---------------------------------------------
const owedBefore = await evaluate(`
  const { owedExplorationPicks } = await import('/src/systems/PartyStats.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  return owedExplorationPicks(GS.party[2]);`);
check('the level-9 hunter is owed the picks from levels 2, 4, 6 and 8', JSON.stringify(owedBefore) === '[2,4,6,8]', JSON.stringify(owedBefore));
await clickText('^Exploration pick', PM);
await shot('03-pick-modal');
const modal = await evaluate(`return window.__T.textsOf('${PM}').map(t => t.text);`);
check('the pick modal offers all six ratings and at least one class passive',
  ['Perception', 'Endurance', 'Speed', 'Cooking', 'Fishing', 'Foraging'].every(s => modal.some(t => t.startsWith(`${s}  `) && t.includes('→')))
  && modal.some(t => t === 'Or a passive:'), modal.filter(t => t.includes('→')).join(' | '));
await clickText('^Perception  \\d+ → \\d+', PM);
await sleep(300);
const afterPick = await evaluate(`
  const { hunterExploration, owedExplorationPicks } = await import('/src/systems/PartyStats.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  const raw = JSON.parse(localStorage.getItem('bmSave_autosave') || 'null');
  return { rating: hunterExploration(GS.party[2]).ratings.perception, owed: owedExplorationPicks(GS.party[2]),
    saved: raw?.characters?.find(c => c.name === ${JSON.stringify(who.name)})?.exploration?.picks?.['2'] || null,
    texts: window.__T.textsOf('${PM}').map(t => t.text) };`);
check('taking the Perception pick raises the rating by 10 and clears that level',
  afterPick.rating === realRatings.perception + 10 && JSON.stringify(afterPick.owed) === '[4,6,8]', `${realRatings.perception} -> ${afterPick.rating}`);
check('...the sheet follows at once', afterPick.texts.some(t => t.includes(`Perception ${afterPick.rating}`)));
check('...and the pick is saved (autosave holds it)', afterPick.saved?.rating === 'perception', JSON.stringify(afterPick.saved));
await shot('04-after-pick');

// ---- 4. Nothing reaches into the formation ------------------------------------
const low = await evaluate(`
  const s = window.__T.g().scene.getScene('${PM}');
  const bad = []; const walk = (o) => { if (!o) return;
    // Text AND the pick button (a Container): the button was the one thing
    // that reached past the band into the formation's rows. Graphics have no
    // getBounds in Phaser 3, so they are measured through their container.
    if (s._sheet && o.parentContainer === s._sheet && typeof o.getBounds === 'function') {
      const b = o.getBounds(); if (b.bottom > 344) bad.push((o.text || o.type).slice(0, 24) + '@' + Math.round(b.bottom));
    }
    if (o.list) o.list.forEach(walk); };
  s.children.list.forEach(walk); return bad;`);
check('nothing the sheet draws reaches the formation slots (y 344+)', low.length === 0, low.join(', '));
// Nothing the sheet writes may print over anything else on the screen: a
// wrapped line did exactly that (the hint over the first stat row, Foraging
// over Party Initiative, the ratings over the passives).
const overlaps = await evaluate(`
  const s = window.__T.g().scene.getScene('${PM}');
  const all = []; const walk = (o) => { if (!o) return;
    if (o.type === 'Text' && o.visible !== false && o.alpha !== 0) all.push({ t: o.text, b: o.getBounds(), sheet: o.parentContainer === s._sheet, own: o.parentContainer, obj: o });
    // A button's BODY, not just its label: its background covered a line of
    // the sheet while every text bound stayed clear.
    if (o.type === 'Container' && o.parentContainer === s._sheet && typeof o.getBounds === 'function') all.push({ t: 'button', b: o.getBounds(), sheet: true, own: o.parentContainer, obj: o });
    if (o.list) o.list.forEach(walk); };
  s.children.list.forEach(walk);
  const bad = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (!all[i].sheet && !all[j].sheet) continue;
    if (all[i].own === all[j].obj || all[j].own === all[i].obj) continue;   // a button and its own label
    const a = all[i].b, b = all[j].b;
    if (a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1) bad.push(all[i].t.slice(0, 26) + ' / ' + all[j].t.slice(0, 26));
  }
  return bad;`);
check('no line on the sheet prints over another', overlaps.length === 0, overlaps.slice(0, 4).join(' | '));

// ---- 5. A hunter with no pick owed ---------------------------------------------
const plain = await evaluate(`const GS = (await import('/src/systems/GameState.js')).default; return GS.party[0].name;`);
await clickText(`^• ${plain} `, PM);
check('a hunter with no pick owed says so', !!(await findText('No exploration pick owed', PM)));

// ---- 6. Close, and three visits in a row ---------------------------------------
await key('Escape', 'Escape', 27);
await sleep(500);
check('Escape closes the sheet and gives the town its input back',
  !(await evaluate(`return window.__T.g().scene.isActive('${PM}');`))
  && (await evaluate(`return window.__T.g().scene.getScene('TownScene').input.enabled;`)) === true);
const counts = [];
for (let i = 0; i < 3; i++) {
  await openSheet();
  counts.push(await evaluate(`const s = window.__T.g().scene.getScene('${PM}'); return { kids: s.children.list.length, sheet: s._sheet?.list.length || 0 };`));
  await key('Escape', 'Escape', 27);
  await sleep(400);
}
check('three visits in a row: the same objects each time, nothing piling up',
  counts.every(c => c.kids === counts[0].kids && c.sheet === counts[0].sheet), JSON.stringify(counts));

// ---- 7. From the map's HUD, mid-hunt --------------------------------------------
await evaluate(`await window.bmDevMapHunt({ zoneId: 'reeds_of_gethsemane', objective: 'scout', size: 'medium', seed: 4 }); await new Promise(r => setTimeout(r, 700)); return 1;`);
await clickText('^Party$', 'HuntFieldOverlay');
await sleep(700);
await shot('05-sheet-over-the-map');
const overMap = await evaluate(`const G = window.__T.g(); return { pm: G.scene.isActive('${PM}'), field: G.scene.isActive('HuntFieldOverlay') };`);
check('the map HUD\'s Party button opens the sheet over the hunt', overMap.pm && overMap.field, JSON.stringify(overMap));
await key('Escape', 'Escape', 27);
await sleep(600);
const backToMap = await evaluate(`const G = window.__T.g(); return { pm: G.scene.isActive('${PM}'), field: G.scene.isActive('HuntFieldOverlay'), town: G.scene.getScene('TownScene').input.enabled };`);
check('closing it leaves the map up, with the town still asleep', !backToMap.pm && backToMap.field && backToMap.town === false, JSON.stringify(backToMap));
await shot('06-back-on-the-map');

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
fs.writeFileSync(path.join(out, `${mode}-results.json`), JSON.stringify({ mode, checks: B.checks, errors: B.errors }, null, 1));
await B.close();
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
