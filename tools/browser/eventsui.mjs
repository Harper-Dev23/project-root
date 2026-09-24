// tools/browser/eventsui.mjs
//
// Real-browser check of the event screens on the hunt map (Exploration System
// v2, chunk 11b). NOT part of `npm run verify`: it needs Microsoft Edge.
//
//   node tools/browser/eventsui.mjs webgl  [outDir] [cdpPort]
//   node tools/browser/eventsui.mjs canvas [outDir] [cdpPort]
//
// A real map hunt in the Reeds. Each event is placed beside the party through
// the real save and load (the site added to the saved hunt), the party steps
// onto it, and every choice is made with a real click:
//   - a choice: the option, then its result and Continue; the site is spent
//   - a check (Sinking Mud): Roll, the dice token, the roll against the DC
//   - a puzzle (Distant Weeping): the right answer
//   - an offer: one it cannot pay (refused, and it says so) then Refuse; one
//     it can: Accept, and the supplies go
//   - a trade: Trade, and the goods leave the pack
//   - an event that starts a fight: after Continue, the fight panel
// Offer, trade and fight use test templates added to the page's own
// EVENT_TEMPLATES, since no starter event has those shapes yet (11d).
//
// Plumbing (Edge, DevTools, the static server, boot like a player): lib.mjs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startBrowser } from './lib.mjs';

const mode = process.argv[2] || 'webgl';
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'eventsui-shots'));
const port = Number(process.argv[4] || 9383);
const B = await startBrowser({ mode, port, outDir: out });
const { evaluate, shot, check, sleep, clickText } = B;
const FIELD = 'HuntFieldOverlay';
const texts = () => evaluate(`return window.__T.textsOf('${FIELD}').map(t => t.text);`);
const waitFor = (expr, ms = 8000) => evaluate(`for (let i = 0; i < ${Math.ceil(ms / 200)}; i++) { if (${expr}) return true; await new Promise(r => setTimeout(r, 200)); } return false;`);

await B.loadGame();
await B.bootToTown(`
  const { makeParty } = await import('/tools/headless/fixtures.js');
  const GS = (await import('/src/systems/GameState.js')).default;
  const party = makeParty(); GS.characters = [...party]; GS.party = party;
  const { EVENT_TEMPLATES } = await import('/data/events.js');
  EVENT_TEMPLATES.test_choice = { name: 'A Test Choice', shape: 'choice', text: 'Something waits here.', appears: { setPiece: true },
    options: [{ label: 'Take it', effects: [{ text: 'You take it.' }, { huntPoints: 3 }] }, { label: 'Leave it', effects: [] }] };
  EVENT_TEMPLATES.test_offer_poor = { name: 'A Costly Offer', shape: 'offer', text: 'A price too high.', appears: { setPiece: true },
    offer: 'Pay it', price: [{ supplies: -9999 }], reward: [{ huntPoints: 50 }], refuse: [] };
  EVENT_TEMPLATES.test_offer = { name: 'A Fair Offer', shape: 'offer', text: 'Two supplies for a blessing.', appears: { setPiece: true },
    offer: 'Pay it', price: [{ supplies: -2 }], reward: [{ text: 'It is done.' }, { huntPoints: 4 }], refuse: [{ text: 'You keep your supplies.' }] };
  EVENT_TEMPLATES.test_trade = { name: 'A Trader', shape: 'trade', text: 'A ration for news.', appears: { setPiece: true },
    give: [{ id: 'rations', qty: 1 }], receive: [{ text: 'They tell you where the herons feed.' }, { huntPoints: 2 }], refuse: [] };
  EVENT_TEMPLATES.test_fight = { name: 'A Rustle', shape: 'choice', text: 'Something stirs nearby.', appears: { setPiece: true },
    options: [{ label: 'Rouse it', effects: [{ fight: { weaken: 25 } }] }] };
  const { HuntManager } = await import('/src/systems/HuntManager.js');
  HuntManager.startMap('reeds_of_gethsemane', { plan: { objective: 'scout', size: 'medium', itemLevel: 1 }, supplies: 200, seed: 2211 });
`);
check(`renderer is ${mode === 'canvas' ? 'CANVAS' : 'WEBGL'}`, (await evaluate('return window.__T.g().renderer.type;')) === (mode === 'canvas' ? 1 : 2));

/**
 * Put `templateId` on a free tile beside the party through the real save and
 * load, reopen the map, and step onto it. `beside` also puts a beast next to
 * that tile (for the fight event). Returns what the engine says opened.
 */
const place = (templateId, { beside = false, pack = null } = {}) => evaluate(`
  const GS = (await import('/src/systems/GameState.js')).default;
  const { HuntManager } = await import('/src/systems/HuntManager.js');
  const { launchMapHunt } = await import('/src/scenes/overlays/HuntFieldOverlay.js');
  const { mapNeighbors } = await import('/src/systems/HuntMapGen.js');
  const { isPassable } = await import('/data/grounds.js');
  const { makeStack } = await import('/src/systems/ItemStacks.js');
  GS.save('autosave');
  const save = JSON.parse(localStorage.getItem('bmSave_autosave'));
  const d = save.hunt;
  d.event = null; d.encounter = null;
  const free = (id) => d.map.tiles[id] && isPassable(d.map.tiles[id]) && id !== d.pos && !d.map.tiles[id].exit && !d.map.occupants.some(o => o.tile === id);
  const tile = [...mapNeighbors(d.map, d.pos)].find(free);
  d.map.occupants.push({ id: 'oui_' + Math.floor(Math.random() * 1e9), kind: 'event', tile, eventId: ${JSON.stringify(templateId)}, concealment: 0 });
  if (${beside}) {
    const b = d.map.occupants.find(o => o.kind === 'beast');
    const spot = [...mapNeighbors(d.map, tile)].find(free);
    b.tile = spot; b.state = 'rooted'; b.home = 'rooted';
  }
  if (${JSON.stringify(pack)}) d.pack.found.push(makeStack(${JSON.stringify(pack?.id)}, ${pack?.qty || 0}));
  localStorage.setItem('bmSave_autosave', JSON.stringify(save));
  GS.load('autosave');
  const G = window.__T.g();
  if (G.scene.isActive('HuntFieldOverlay')) G.scene.stop('HuntFieldOverlay');
  launchMapHunt(G.scene.getScene('TownScene'));
  await new Promise(r => setTimeout(r, 700));
  const s = window.__T.s();
  s._act('move', () => s.hunt.move(tile));
  await new Promise(r => setTimeout(r, 400));
  return { tile, open: s.hunt.view().event?.templateId || null };`);
const spent = (tile) => evaluate(`const st = window.__T.s().hunt.getState(); return !st.map.occupants.some(o => o.kind === 'event' && o.tile === ${JSON.stringify(tile)}) && !window.__T.s().hunt.view().event;`);
const hp = () => evaluate(`return (await import('/src/systems/ProgressionManager.js')).default.huntPoints;`);

// ---- 1. A choice --------------------------------------------------------------
let at = await place('test_choice');
check('a choice opens when the party steps onto it', at.open === 'test_choice', JSON.stringify(at));
let t = await texts();
check('...its panel shows the name, text, each option and Walk away', ['A Test Choice', 'Something waits here.', 'Take it', 'Leave it', 'Walk away'].every(x => t.includes(x)));
await shot('01-choice');
let hp0 = await hp();
await clickText('^Take it$', FIELD);
await sleep(500);
t = await texts();
check('Take it (clicked): the result shows its lines and Continue', t.includes('You take it.') && t.includes('+3 Hunt Points.') && t.includes('Continue'));
check('...the Hunt Points are paid, and the site is spent', (await hp()) === hp0 + 3 && await spent(at.tile));
await shot('02-choice-result');
await clickText('^Continue$', FIELD);
await sleep(300);
check('Continue (clicked) closes the result', !(await texts()).includes('Continue'));

// ---- 2. A check, with the dice ------------------------------------------------
at = await place('reeds_sinking_mud');
t = await texts();
check('a check shows the stat, who rolls and the DC, and a Roll button', t.some(x => /^Dexterity check, DC \d+: .+ rolls d20 [+-]\d+\.$/.test(x)) && t.includes('Roll'), t.find(x => x.includes('check')));
await shot('03-check');
await clickText('^Roll$', FIELD);
check('Roll (clicked): the dice token lands, then the roll against the DC shows',
  await waitFor(`window.__T.textsOf('${FIELD}').some(t => /^Rolled \\d+ [+-] \\d+ = \\d+ against DC \\d+: (success|failure)\\.$/.test(t.text))`));
await shot('04-check-result');
check('...and the site is spent', await spent(at.tile));
await clickText('^Continue$', FIELD);
await sleep(300);

// ---- 3. A puzzle ----------------------------------------------------------------
at = await place('reeds_distant_weeping');
t = await texts();
check('a puzzle shows its prompt and every answer', t.some(x => x.startsWith('A voice rises from the mist')) && ['Breath', 'A name', 'Time', 'Grief'].every(x => t.includes(x)));
await clickText('^A name$', FIELD);
await sleep(500);
t = await texts();
check('the right answer (clicked): its success lines', t.includes('The weeping pauses, as if heard. You feel strangely lighter.'));
await clickText('^Continue$', FIELD);
await sleep(300);

// ---- 4. Offers ----------------------------------------------------------------------
at = await place('test_offer_poor');
t = await texts();
check('an offer the party cannot pay says so', t.some(x => x.includes('(you have too few)')));
await clickText('^Pay it$', FIELD);
await sleep(400);
const stillOpen = await evaluate(`return !!window.__T.s().hunt.view().event;`);
const said = await evaluate(`return window.__T.textsOf('UIScene').map(t => t.text).find(t => t.includes('cannot pay')) || null;`);
check('...clicking Pay it refuses, and the dialogue bar says why; the event stays open', stillOpen && !!said, said);
await clickText('^Refuse$', FIELD);
await sleep(400);
check('Refuse (clicked): "You leave it be."', (await texts()).includes('You leave it be.'));
await clickText('^Continue$', FIELD);
await sleep(300);

at = await place('test_offer');
const sup0 = await evaluate(`return window.__T.s().hunt.getState().supplies;`);
await shot('05-offer');
await clickText('^Pay it$', FIELD);
await sleep(500);
const sup1 = await evaluate(`return window.__T.s().hunt.getState().supplies;`);
t = await texts();
check('an offer accepted: 2 supplies paid, and its reward shown', Math.abs(sup0 - 2 - sup1) < 1e-6 && t.includes('It is done.'), `${sup0} -> ${sup1}`);
await clickText('^Continue$', FIELD);
await sleep(300);

// ---- 5. A trade -------------------------------------------------------------------
at = await place('test_trade', { pack: { id: 'rations', qty: 2 } });
t = await texts();
check('a trade shows what is asked and what the pack holds', t.some(x => /They ask for 1 × Rations \(you carry \d+\)\./.test(x)), t.find(x => x.startsWith('They ask')));
const r0 = await evaluate(`const { countInList } = await import('/src/systems/ItemStacks.js'); const p = window.__T.s().hunt.getState().pack; return countInList(p.found, 'rations') + countInList(p.brought, 'rations');`);
await shot('06-trade');
await clickText('^Trade$', FIELD);
await sleep(500);
const r1 = await evaluate(`const { countInList } = await import('/src/systems/ItemStacks.js'); const p = window.__T.s().hunt.getState().pack; return countInList(p.found, 'rations') + countInList(p.brought, 'rations');`);
check('Trade (clicked): one Ration leaves the pack, and the news is shown', r1 === r0 - 1 && (await texts()).includes('They tell you where the herons feed.'), `${r0} -> ${r1}`);
await clickText('^Continue$', FIELD);
await sleep(300);

// ---- 6. An event that starts a fight ---------------------------------------------
at = await place('test_fight', { beside: true });
await clickText('^Rouse it$', FIELD);
await sleep(500);
t = await texts();
check('an event that starts a fight shows its result first', t.includes('It comes to a fight.') && t.includes('Continue'));
await clickText('^Continue$', FIELD);
await sleep(400);
check('...and after Continue, the fight panel offers Fight', (await texts()).includes('Fight'));
await shot('07-fight-after-event');

check('no uncaught errors in the page', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));
fs.writeFileSync(path.join(out, `${mode}-results.json`), JSON.stringify({ mode, checks: B.checks, errors: B.errors }, null, 1));
await B.close();
const fails = B.checks.filter(c => !c.ok).length;
console.log(`\n${mode}: ${B.checks.length - fails} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
