// tools/headless/revival.mjs
//
// The ways back for a Slain hunter (Exploration System v2, chunk 10c):
// src/systems/Revival.js on the real GameState and ProgressionManager, the
// lesser rite finishing through the real GAME_WORLD.dayBreaks, and all of it
// through a real save and load. Nothing is re-derived: costs are read off the
// real exports and checked against what the game did.
//
// What it proves:
//   - what each way costs, by level (golden)
//   - which way is open: intercession only for a Watched death in your
//     followed house's lands; the rite for any Watched death, old saves'
//     Slain included; neither for a Forsaken death; no intercession while a
//     rite is under way
//   - intercession: refused abroad or when the Bond cannot pay (and then
//     spends nothing); otherwise the Bond pays exactly its cost and the hunter
//     is back in camp, alive at full HP, off the Slain, their record cleared;
//     devotion and the hold are untouched
//   - the rite: refused without the tickets (spending nothing); otherwise the
//     tickets are paid, the hunter stays on the Slain, and comes back on
//     exactly the day it ends through GAME_WORLD.dayBreaks, not a day before
//   - both survive a real save and load, mid-rite included
//
// USAGE
//   node tools/headless/revival.mjs                 run the checks
//   node tools/headless/revival.mjs --json <path>   write the golden
//   node tools/headless/revival.mjs --diff <path>   compare against it

import fs from 'node:fs';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const golden = {};

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};

const { installPhaserStub, seed } = await import('./phaserStub.js');
installPhaserStub(13);

const { makeParty } = await import('./fixtures.js');
const GameState = (await import('../../src/systems/GameState.js')).default;
const PM = (await import('../../src/systems/ProgressionManager.js')).default;
const { GAME_WORLD } = await import('../../src/systems/HuntManager.js');
const R = await import('../../src/systems/Revival.js');
const S = await import('../../src/systems/Standing.js');
const D = await import('../../data/standing.js');

/** A fresh save: a pledged tribe following Jeremiah, and one fallen hunter per record given. */
function setup(fells, { tickets = 100, bond = 100 } = {}) {
  PM.reset();
  PM.setTribe('styx');
  const st = PM.getStanding();
  S.earnFavor(st, 'styx', 'jeremiah', 100);
  S.acceptHouse(st, 'styx', 'jeremiah');
  st.bond.jeremiah = bond;
  PM.huntTickets = tickets;
  const party = makeParty();
  GameState.characters = [...party];
  GameState.party = party.slice(0, fells.length ? 6 - fells.length : 6);
  GameState.slain = [];
  const fallen = fells.map((f, i) => {
    const c = party[5 - i];
    c.status = 'dead'; c.currentHP = 0;
    GameState.moveToSlain(c, f);
    return c;
  });
  return { st, fallen };
}
const home = S.fellRecord({ zoneId: 'reeds_of_gethsemane', prophet: 'jeremiah', rule: 'watched', day: 0 });
const abroad = S.fellRecord({ zoneId: 'bay_of_solace', prophet: 'ezekiel', rule: 'watched', day: 0 });
const forsaken = S.fellRecord({ zoneId: 'reeds_of_gethsemane', prophet: 'jeremiah', rule: 'forsaken', day: 0 });

// =============================================================================
console.log('=== what each way costs ===');
{
  golden.costs = [1, 2, 3, 5, 10].map(level => ({ level, intercession: R.intercessionCost({ level }), rite: R.riteTerms({ level }) }));
  check('a veteran costs more to bring back, both ways', golden.costs.every((c, i, a) => i === 0 || (c.intercession > a[i - 1].intercession && c.rite.days > a[i - 1].rite.days && c.rite.tickets > a[i - 1].rite.tickets)),
    golden.costs.map(c => `L${c.level} ${c.intercession}/${c.rite.days}d/${c.rite.tickets}t`).join(' '));
}

// =============================================================================
console.log('=== which way is open ===');
{
  const { fallen: [h, a, f] } = setup([home, abroad, forsaken]);
  const [oh, oa, of] = [h, a, f].map(c => R.revivalOptions(c));
  check('a Watched death in your followed house\'s lands: intercession and the rite', oh.intercession.open && oh.rite.open);
  check('a Watched death abroad: the rite only', !oa.intercession.open && oa.rite.open);
  check('a Forsaken death: neither (a False God\'s price, chunk 11)', !of.intercession.open && !of.rite.open);
  const legacy = { level: 3, fell: { ...S.LEGACY_FELL } };
  GameState.slain.push(legacy);
  const ol = R.revivalOptions(legacy);
  check('an old save\'s Slain: the rite only', !ol.intercession.open && ol.rite.open);
  golden.open = { home: [oh.intercession.open, oh.rite.open], abroad: [oa.intercession.open, oa.rite.open], forsaken: [of.intercession.open, of.rite.open], legacy: [ol.intercession.open, ol.rite.open] };
}

// =============================================================================
console.log("=== a False God's price (11c-2) ===");
{
  const reeds = S.fellRecord({ zoneId: 'reeds_of_gethsemane', prophet: 'jeremiah', rule: 'forsaken', day: 0, god: 'dagon' });
  let { st, fallen: [f] } = setup([reeds], { bond: 20 });
  f.level = 3;
  const o = R.revivalOptions(f);
  check("a Forsaken death: the region's false god offers its price (and nothing else does)",
    o.falseGod.open && o.falseGod.god === 'dagon' && o.falseGod.hidden === 30 && o.falseGod.bond === 15 && !o.intercession.open && !o.rite.open);
  const dev = st.devotion.styx.jeremiah;
  const r = R.acceptFalseGod(f);
  check('taking it: the hunter is back in camp at once, hidden standing +30 with Dagon, Bond -15 with your house, devotion untouched',
    r.ok && GameState.characters.includes(f) && !GameState.slain.includes(f) && f.status === 'alive'
    && st.falseGods?.dagon === 30 && st.bond.jeremiah === 5 && st.devotion.styx.jeremiah === dev);
  ({ st, fallen: [f] } = setup([reeds], { bond: 0 }));
  const r2 = R.acceptFalseGod(f);
  check('...never refused for lack of standing: the Bond goes below 0', r2.ok && st.bond.jeremiah < 0);
  ({ st, fallen: [f] } = setup([reeds]));
  const lg = R.letGo(f);
  const after = R.revivalOptions(f);
  check('letting them go is final: no way back is open, and the price is refused', lg.ok && after.falseGod.lost && !after.falseGod.open
    && !after.intercession.open && !after.rite.open && !R.acceptFalseGod(f).ok);
  GameState.save('rv3'); GameState.load('rv3');
  check('...and it survives a save and load', GameState.slain.some(c => c.id === f.id && c.fell?.lost === true));
  const watched = setup([S.fellRecord({ zoneId: 'reeds_of_gethsemane', prophet: 'jeremiah', rule: 'watched', day: 0, god: 'dagon' })]).fallen[0];
  check("a Watched death is never the false god's, nor can it be let go", !R.revivalOptions(watched).falseGod.open && !R.letGo(watched).ok);
}

console.log('=== intercession ===');
{
  let { st, fallen: [h, a] } = setup([home, abroad], { bond: 5 });
  const bond0 = st.bond.jeremiah;
  const poor = R.intercede(h);
  check('refused when the Bond cannot pay, and nothing is spent', !poor.ok && poor.reason === 'not enough standing' && st.bond.jeremiah === bond0 && GameState.slain.includes(h));
  const far = R.intercede(a);
  check('refused abroad', !far.ok && GameState.slain.includes(a));

  ({ st, fallen: [h] } = setup([home], { bond: 100 }));
  h.level = 3;
  const dev0 = st.devotion.styx.jeremiah;
  const r = R.intercede(h);
  check(`intercession spends exactly ${R.intercessionCost(h)} Bond standing`, r.ok && st.bond.jeremiah === 100 - R.intercessionCost(h));
  check('...and the hunter is back in camp: alive, full HP, off the Slain, the record cleared',
    !GameState.slain.includes(h) && GameState.characters.includes(h) && h.status === 'alive' && h.currentHP === h.maxHP && !('fell' in h) && !('rite' in h));
  check('...devotion and the hold are untouched (decision 1)', st.devotion.styx.jeremiah === dev0 && S.followedHouse(st, 'styx') === 'jeremiah');
  GameState.save('rv1');
  GameState.load('rv1');
  const back = GameState.characters.find(c => c.id === h.id);
  check('...and it survives a save and load', !!back && back.status === 'alive' && !GameState.slain.some(c => c.id === h.id) && PM.getStanding().bond.jeremiah === 100 - R.intercessionCost(h));
}

// =============================================================================
console.log('=== the lesser rite ===');
{
  let { fallen: [h] } = setup([abroad], { tickets: 3 });
  h.level = 2;
  const t0 = PM.huntTickets;
  const poor = R.beginRite(h);
  check('refused without the tickets, and nothing is spent', !poor.ok && PM.huntTickets === t0 && !h.rite);

  ({ fallen: [h] } = setup([home], { tickets: 100 }));
  h.level = 2;
  const terms = R.riteTerms(h);
  const day0 = PM.getDaysElapsed();
  const r = R.beginRite(h);
  check(`the rite takes ${terms.tickets} tickets and sets ${terms.days} days`, r.ok && PM.huntTickets === 100 - terms.tickets && h.rite?.untilDay === day0 + terms.days);
  check('...the hunter stays among the Slain meanwhile', GameState.slain.includes(h) && !GameState.characters.includes(h));
  check('...and is not offered intercession on top, nor a second rite', !R.revivalOptions(h).intercession.open && !R.revivalOptions(h).rite.open && !R.beginRite(h).ok);
  GameState.save('rv2');
  GameState.load('rv2');
  const h2 = GameState.slain.find(c => c.id === h.id);
  check('a save and load mid-rite keeps it', !!h2 && same(h2.rite, h.rite));
  seed(77);   // TribeHuntSimulator rolls Math.random each day
  const trace = [];
  for (let d = 1; d <= terms.days; d++) {
    const res = GAME_WORLD.dayBreaks();
    trace.push({ day: PM.getDaysElapsed(), revived: res.revived });
    if (d < terms.days) {
      if (!GameState.slain.some(c => c.id === h.id)) { trace.push('early'); break; }
    }
  }
  const back = GameState.characters.find(c => c.id === h.id);
  check(`...and the hunter returns on day ${day0 + terms.days} exactly, through the day's own tick, not a day before`,
    !trace.includes('early') && trace.at(-1).revived.includes(h2.name) && trace.slice(0, -1).every(t => !t.revived.length)
    && !!back && back.status === 'alive' && back.currentHP === back.maxHP && !GameState.slain.some(c => c.id === h.id), JSON.stringify(trace));
  golden.riteTrace = trace;
}

// =============================================================================
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const diffAt = args.indexOf('--diff');
if (jsonAt >= 0) {
  fs.writeFileSync(args[jsonAt + 1], JSON.stringify(golden, null, 1) + '\n');
  console.log(`golden written -> ${args[jsonAt + 1]}`);
}
if (diffAt >= 0) {
  console.log('=== golden diff ===');
  const old = JSON.parse(fs.readFileSync(args[diffAt + 1], 'utf8'));
  const keys = new Set([...Object.keys(old), ...Object.keys(golden)]);
  const changed = [...keys].filter(k => !same(old[k], golden[k]));
  check('revival tables identical to the golden', changed.length === 0,
    changed.length ? `changed: ${changed.join(', ')}` : `${keys.size} tables`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
