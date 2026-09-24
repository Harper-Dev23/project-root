// tools/headless/events.mjs
//
// The events engine (Exploration System v2, chunk 11a): data/events.js,
// src/systems/EventEffects.js, and event sites on real map hunts (HuntEngine).
//
// Two halves:
//   1. THE VALIDATOR (EVENTS: "a validator over every event, in npm run
//      verify"). Every template in data/events.js is checked: a known shape
//      with the fields it needs; only known `appears` keys, real zones,
//      houses, grounds, hunger stages; every role known, and every nullable
//      role declared in appears.needs; every effect one known verb with a
//      valid value; every item real (trade items stackable); every quest flag
//      one src/data/quests.js reads; every lore effect a journal entry that is
//      hidden behind that effect's flag. Every zone's set pieces exist, and
//      every zone has events to draw. The validator is proved to catch each
//      kind of mistake on deliberately broken templates.
//   2. THE ENGINE, on real hunts: a site opens when the party steps on it; a
//      site whose moment is not right stays quiet and unspent; an open event
//      freezes the hunt, survives a reload, and can be walked away from; every
//      branch of every real template resolves; and every verb moves the number
//      its reader holds (recorded through the world, or read off the hunt).
//      The old Advance loop no longer rolls events, and an old save's pending
//      one is dropped.
//
// USAGE
//   node tools/headless/events.mjs                 run the checks
//   node tools/headless/events.mjs --json <path>   write the golden
//   node tools/headless/events.mjs --diff <path>   compare against it

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const { installPhaserStub } = await import('./phaserStub.js');
installPhaserStub(11);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { EVENT_TEMPLATES } = await import('../../data/events.js');
const E = await import('../../src/systems/EventEffects.js');
const { ZONES } = await import('../../data/zones.js');
const { GROUNDS } = await import('../../data/grounds.js');
const { Items } = await import('../../data/items.js');
const { HOUSES } = await import('../../data/standing.js');
const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
const { clockAt } = await import('../../src/systems/HuntRules.js');
const { countInList, makeStack } = await import('../../src/systems/ItemStacks.js');
const { GRADE_HP_SCALE } = await import('../../data/beastParts.js');
const { EncounterRoller } = await import('../../src/systems/EncounterRoller.js');
const { restoreHunt } = await import('../../src/systems/HuntManager.js');
const { makeParty } = await import('./fixtures.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const { parseTileId, distance } = await import('../../src/systems/HexGrid.js');

// ── What the validator checks against ────────────────────────────────────────
const QUESTS_SRC = fs.readFileSync(path.join(REPO, 'src/data/quests.js'), 'utf8');
const JOURNAL = new Map();   // entry id -> its requires
for (const rel of JSON.parse(fs.readFileSync(path.join(REPO, 'data/journal/md/index.json'), 'utf8'))) {
  const txt = fs.readFileSync(path.join(REPO, 'data/journal/md', rel), 'utf8');
  const id = /^id:\s*(.+)$/m.exec(txt)?.[1]?.trim().replace(/^"|"$/g, '');
  const req = /^requires:\s*\[(.*)\]$/m.exec(txt)?.[1] || '';
  if (id) JOURNAL.set(id, req.split(',').map(x => x.trim().replace(/^"|"$|^'|'$/g, '')).filter(Boolean));
}

/** Every problem with one template, as strings. Empty when it is sound. */
function validateTemplate(id, t) {
  const bad = [];
  const say = (m) => bad.push(`${id}: ${m}`);
  if (!E.SHAPES.includes(t.shape)) say(`unknown shape '${t.shape}'`);
  if (!t.name || !t.text) say('needs a name and a text');
  const a = t.appears || {};
  for (const k of Object.keys(a)) if (!E.APPEARS_KEYS.includes(k)) say(`unknown appears key '${k}'`);
  for (const z of a.zones || []) if (!ZONES[z]) say(`unknown zone '${z}'`);
  if (a.houses !== undefined && a.houses !== 'any' && a.houses !== 'none'
      && !(Array.isArray(a.houses) && a.houses.every(h => HOUSES.includes(h)))) say(`bad houses ${JSON.stringify(a.houses)}`);
  for (const g of a.grounds || []) if (!GROUNDS[g]) say(`unknown ground '${g}'`);
  for (const h of a.hunger || []) if (!E.HUNGER_STAGES.includes(h)) say(`unknown hunger stage '${h}'`);
  for (const r of a.needs || []) if (!E.NULLABLE_ROLES.includes(r)) say(`needs '${r}', which is not a nullable role`);
  if (a.danger && !(Array.isArray(a.danger) && a.danger.length === 2)) say('danger is [min, max]');
  for (const k of ['weight', 'maxPerMap']) if (a[k] !== undefined && !(a[k] > 0)) say(`${k} must be positive`);
  for (const k of ['questFlag', 'notQuestFlag']) if (a[k] && !QUESTS_SRC.includes(`'${a[k]}'`)) say(`${k} '${a[k]}' is read by no quest`);

  // The outcomes, by shape.
  const outcomes = [];
  const texts = [t.name, t.text];
  if (t.shape === 'choice') {
    if (!Array.isArray(t.options) || !t.options.length) say('a choice needs options');
    for (const o of t.options || []) { if (!o.label) say('an option needs a label'); texts.push(o.label); outcomes.push(['option', o.effects]); }
  }
  if (t.shape === 'check') {
    if (![...E.CORE_STATS, ...E.PARTY_CHECK_STATS].includes(t.check?.stat)) say(`check.stat '${t.check?.stat}' is not a stat`);
    try { E.evalNumber(t.check?.dc, { danger: 1 }); } catch (e) { say(`check.dc: ${e.message}`); }
    outcomes.push(['success', t.success], ['failure', t.failure]);
  }
  if (t.shape === 'puzzle') {
    if (!Array.isArray(t.answers) || t.answers.length < 2) say('a puzzle needs two answers or more');
    if (!Number.isInteger(t.correct) || !t.answers?.[t.correct]) say('puzzle.correct is not an answer');
    texts.push(t.prompt, ...(t.answers || []));
    outcomes.push(['success', t.success], ['failure', t.failure]);
  }
  if (t.shape === 'offer') {
    if (!t.offer) say('an offer needs its accept label (offer)');
    texts.push(t.offer);
    outcomes.push(['price', t.price || []], ['reward', t.reward], ['refuse', t.refuse || []]);
  }
  if (t.shape === 'trade') {
    if (!Array.isArray(t.give) || !t.give.length) say('a trade needs something to give');
    for (const g of t.give || []) {
      if (!Items[g.id]) say(`trade gives unknown item '${g.id}'`);
      else if (!Items[g.id].stackable) say(`trade gives '${g.id}', which does not stack`);
      if (!(Number.isInteger(g.qty) && g.qty > 0)) say('trade qty must be a whole number above 0');
    }
    outcomes.push(['receive', t.receive], ['refuse', t.refuse || []]);
  }
  const exprs = [];
  for (const [label, list] of outcomes) {
    if (!Array.isArray(list)) { say(`${label} must be a list of effects`); continue; }
    for (const eff of list) {
      const { verb, value, error } = E.verbOf(eff);
      if (error) { say(`${label}: ${error}`); continue; }
      const err = E.VERBS[verb].validate(value);
      if (err) say(`${label}: ${verb}: ${err}`);
      if (verb === 'text') texts.push(value);
      if (verb === 'questFlag') { const f = typeof value === 'string' ? value : value?.clear; if (f && !QUESTS_SRC.includes(`'${f}'`)) say(`${label}: quest flag '${f}' is read by no quest`); }
      if (verb === 'lore') {
        if (!JOURNAL.has(value)) say(`${label}: lore '${value}' is not a journal entry`);
        else if (!JOURNAL.get(value).includes(E.loreFlag(value))) say(`${label}: journal entry '${value}' is not hidden behind '${E.loreFlag(value)}', so it would unlock nothing`);
      }
      for (const v of Object.values(typeof value === 'object' && value ? value : { v: value })) if (typeof v === 'string' && verb !== 'text') exprs.push(v);
    }
  }
  // Roles: known, and every nullable one declared in appears.needs.
  const used = [...texts, ...exprs, t.check?.dc].flatMap(x => E.rolesIn(x));
  for (const r of new Set(used)) {
    if (!E.ROLES.includes(r)) say(`unknown role {${r}}`);
    else if (E.NULLABLE_ROLES.includes(r) && !(a.needs || []).includes(r)) say(`uses {${r}}, which can be missing, without appears.needs`);
  }
  return bad;
}

// =============================================================================
console.log('=== the validator, over every template ===');
{
  const all = Object.entries(EVENT_TEMPLATES).flatMap(([id, t]) => validateTemplate(id, t));
  check(`every template in data/events.js is sound (${Object.keys(EVENT_TEMPLATES).length} templates)`, all.length === 0, all.join(' | '));
  const zoneBad = [];
  for (const z of Object.values(ZONES)) {
    for (const [k, id] of Object.entries(z.setPieces || {})) {
      const t = EVENT_TEMPLATES[id];
      if (!t) zoneBad.push(`${z.id}: set piece ${k} '${id}' is not a template`);
      else if (!t.appears?.setPiece) zoneBad.push(`${z.id}: set piece '${id}' is not marked setPiece`);
      else if (!E.staticEligible(t, { zoneId: z.id, house: null, followed: false, danger: z.danger || 1, ground: null }) && !(t.appears?.zones || []).includes(z.id)) zoneBad.push(`${z.id}: set piece '${id}' may not appear there`);
    }
    const random = Object.values(EVENT_TEMPLATES).filter(t => !t.appears?.setPiece && (!t.appears?.zones || t.appears.zones.includes(z.id)));
    if (!random.length) zoneBad.push(`${z.id}: no events to draw`);
  }
  check('every zone\'s set pieces are real set-piece templates, and every zone has events to draw', zoneBad.length === 0, zoneBad.join(' | '));
  check('every verb names its reader', Object.values(E.VERBS).every(v => typeof v.reader === 'string' && v.reader.length > 10));
  golden.verbs = Object.keys(E.VERBS);

  // The validator catches each kind of mistake.
  const base = { name: 'T', shape: 'choice', text: 'T', options: [{ label: 'L', effects: [{ text: 'ok' }] }] };
  const broken = {
    'an unknown verb': { ...base, options: [{ label: 'L', effects: [{ gold: 5 }] }] },
    'two verbs in one effect': { ...base, options: [{ label: 'L', effects: [{ xp: 1, huntPoints: 1 }] }] },
    'a bad number': { ...base, options: [{ label: 'L', effects: [{ xp: 'lots' }] }] },
    'an unknown role': { ...base, text: 'A {weather} day' },
    'a nullable role without needs': { ...base, text: 'A shrine to {house}' },
    'an unknown item': { ...base, options: [{ label: 'L', effects: [{ item: { id: 'no_such_thing' } }] }] },
    'a quest flag nothing reads': { ...base, options: [{ label: 'L', effects: [{ questFlag: 'made_up_flag' }] }] },
    'lore for an entry that is not hidden': { ...base, options: [{ label: 'L', effects: [{ lore: 'divinity/jeremiah' }] }] },
    'lore for no entry': { ...base, options: [{ label: 'L', effects: [{ lore: 'divinity/nobody' }] }] },
    'an unknown shape': { ...base, shape: 'dance' },
    'an unknown zone': { ...base, appears: { zones: ['atlantis'] } },
    'an unknown appears key': { ...base, appears: { season: 'winter' } },
    'a puzzle answer out of range': { name: 'T', shape: 'puzzle', text: 'T', prompt: 'P', answers: ['a', 'b'], correct: 5, success: [], failure: [] },
    'a trade of an unstackable item': { name: 'T', shape: 'trade', text: 'T', give: [{ id: 'bloodthirster', qty: 1 }], receive: [] },
    'a check on no stat': { name: 'T', shape: 'check', text: 'T', check: { stat: 'LUCK', dc: 10 }, success: [], failure: [] },
  };
  const missed = Object.entries(broken).filter(([, t]) => validateTemplate('x', t).length === 0).map(([k]) => k);
  check(`the validator catches each kind of mistake (${Object.keys(broken).length} kinds)`, missed.length === 0, missed.length ? `missed: ${missed.join(', ')}` : '');
}

// =============================================================================
console.log('=== the maps place only what may appear ===');
{
  // A ground-limited template the maps may draw, so the per-tile ground rule
  // is exercised (no starter template is ground-limited yet).
  EVENT_TEMPLATES.test_marsh_only = {
    name: 'Marsh Only', shape: 'choice', text: 'Only on marsh.', appears: { zones: ['reeds_of_gethsemane'], grounds: ['marsh'], weight: 4, maxPerMap: 2 },
    options: [{ label: 'Fine', effects: [] }],
  };
  const { generateHuntMap } = await import('../../src/systems/HuntMapGen.js');
  const { houseOf } = await import('../../src/systems/Standing.js');
  const bad = [];
  let sites = 0;
  const seen = {};
  for (const zoneId of Object.keys(ZONES)) for (const size of ['small', 'medium', 'large']) for (let seed = 1; seed <= 200; seed++) {
    const z = ZONES[zoneId];
    const m = generateHuntMap({ zoneId, objective: 'cull', size, seed });
    const per = {};
    for (const o of m.occupants.filter(x => x.kind === 'event')) {
      sites++;
      const t = EVENT_TEMPLATES[o.eventId];
      per[o.eventId] = (per[o.eventId] || 0) + 1;
      seen[o.eventId] = (seen[o.eventId] || 0) + 1;
      if (!t) { bad.push(`${o.eventId}: not a template`); continue; }
      if (t.appears?.setPiece) bad.push(`${o.eventId}: a set piece drawn at random`);
      if (!E.staticEligible(t, { zoneId, house: houseOf(z.divineAlignment), followed: false, danger: z.danger || 1, ground: m.tiles[o.tile].ground })) bad.push(`${o.eventId} on ${m.tiles[o.tile].ground} in ${zoneId}`);
    }
    for (const [id, n] of Object.entries(per)) if (n > (EVENT_TEMPLATES[id]?.appears?.maxPerMap ?? 1)) bad.push(`${id} ${n} times on one map`);
  }
  check(`1,200 generated maps: every event site is a template allowed there, on its ground, within maxPerMap (${sites} sites)`, bad.length === 0, bad.slice(0, 5).join(' | '));
  check('...including the ground-limited one, drawn only on marsh', (seen.test_marsh_only || 0) > 50, `${seen.test_marsh_only || 0} times`);
  delete EVENT_TEMPLATES.test_marsh_only;
  delete seen.test_marsh_only;
  golden.drawn = seen;
}

// =============================================================================
// Test templates for the engine: set pieces, so no map ever draws them.
EVENT_TEMPLATES.test_verbs = {
  name: 'Every Verb', shape: 'offer', text: 'A test of every verb in {region}.', appears: { setPiece: true },
  offer: 'Accept', price: [{ supplies: -2 }, { time: 1 }],
  reward: [
    { text: 'It is done.' }, { huntPoints: 5 }, { xp: 10 }, { hp: { amount: -3, who: 'all' } }, { hunger: 'sated' },
    { item: { id: 'rations', qty: 2 } }, { boon: 5 }, { standing: 2 }, { standing: { amount: -3, target: 'rival' } },
    { tribeRep: { tribe: 'own', amount: 3 } }, { questFlag: 'vendor_row' }, { reveal: { radius: 3 } },
    { blight: { spread: 2 } }, { blight: { cleanse: 1 } },
  ],
  refuse: [{ text: 'Refused.' }],
};
EVENT_TEMPLATES.test_trade = {
  name: 'A Trade', shape: 'trade', text: 'Two rations for news.', appears: { setPiece: true },
  give: [{ id: 'rations', qty: 2 }], receive: [{ huntPoints: 3 }], refuse: [{ text: 'Not today.' }],
};
EVENT_TEMPLATES.test_fight = {
  name: 'A Fight', shape: 'choice', text: 'Something stirs.', appears: { setPiece: true },
  options: [{ label: 'Rouse it', effects: [{ fight: { weaken: 50 } }] }, { label: 'Leave it', effects: [] }],
};
EVENT_TEMPLATES.test_needs_beast = {
  name: 'Fresh Tracks', shape: 'choice', text: 'Fresh tracks of a {beast}.', appears: { setPiece: true, needs: ['beast'] },
  options: [{ label: 'Note them', effects: [] }],
};
EVENT_TEMPLATES.test_party_check = {
  name: 'A Keen Eye', shape: 'check', text: 'Tracks, faint.', appears: { setPiece: true },
  check: { stat: 'perception', dc: 10 }, success: [{ huntPoints: 1 }], failure: [],
};
check('the test templates are sound too', ['test_verbs', 'test_trade', 'test_fight', 'test_party_check', 'test_needs_beast'].every(id => validateTemplate(id, EVENT_TEMPLATES[id]).length === 0),
  ['test_verbs', 'test_trade', 'test_fight', 'test_party_check', 'test_needs_beast'].flatMap(id => validateTemplate(id, EVENT_TEMPLATES[id])).join(' | '));

/** A world that records what the hunt asked of the game. */
function recordingWorld(party) {
  const w = { calls: [], flags: new Set() };
  const rec = (k) => (...a) => { w.calls.push([k, ...a]); };
  Object.assign(w, {
    party: () => party, nightFalls() {}, dayBreaks() {}, bankItems() {},
    awardHuntPoints: rec('huntPoints'), awardXP: rec('xp'), favor: rec('favor'), rivalDevotion: rec('rivalDevotion'),
    tribeRep: rec('tribeRep'), lore: rec('lore'),
    questFlag: (f, on) => { w.calls.push(['questFlag', f, on]); if (on) w.flags.add(f); else w.flags.delete(f); },
    hasQuestFlag: (f) => w.flags.has(f),
    followedHouse: () => null, houseHolder: () => 'zafaar', ownTribe: () => 'styx', tribeName: (t) => t.toUpperCase(),
  });
  return w;
}

/**
 * A real hunt with `templateId` placed on the first tile the party can step
 * to, through the save's own path; `night` sets the clock first. Returns the
 * hunt, its world, and that tile.
 */
function withSite(templateId, { zoneId = 'reeds_of_gethsemane', seed = 71, night = false, extra = null } = {}) {
  const party = makeParty();
  const w = recordingWorld(party);
  const h0 = createMapHunt(zoneId, { plan: { objective: 'scout', size: 'medium' }, supplies: 200, seed }, w);
  const d = h0.serialize();
  const tile = h0.view().moves[0].tile;
  d.map.occupants = d.map.occupants.filter(o => o.tile !== tile);
  d.map.occupants.push({ id: 'otest', kind: 'event', tile, eventId: templateId, concealment: 0 });
  if (night !== null) { let t = d.time; while (clockAt(t).isNight !== night) t += 1; d.time = t; d.world.time = t; }
  if (extra) extra(d, tile);
  return { h: restoreMapHunt(d, w), w, tile, party };
}

// =============================================================================
console.log('=== a site on a real hunt ===');
{
  const { h, tile } = withSite('reeds_distant_weeping');
  const r = h.move(tile);
  check('stepping onto a site opens its event', r.ok && r.event?.templateId === 'reeds_distant_weeping' && h.view().event?.shape === 'puzzle');
  check('...the hunt is frozen until it is seen through or walked away from', !h.move(h.view().moves[0].tile).ok && !h.forage().ok);
  const again = restoreMapHunt(h.serialize(), recordingWorld(makeParty()));
  check('...an open event survives a reload', again.view().event?.templateId === 'reeds_distant_weeping');
  const left = h.leaveEvent();
  check('walking away costs nothing and leaves the site', left.ok && !h.view().event && h.getState().map.occupants.some(o => o.id === 'otest'));
  const back = h.move(h.view().moves.find(m => m.tile !== tile).tile);
  const re = back.ok && h.move(tile);
  check('...and stepping onto it again opens it again', !!re?.event);

  const day = withSite('reeds_stranger_at_camp', { night: false });
  const rd = day.h.move(day.tile);
  check('a night-only event stays quiet by day, and is not spent', rd.ok && !rd.event && !!rd.quiet && day.h.getState().map.occupants.some(o => o.id === 'otest'));
  const night = withSite('reeds_stranger_at_camp', { night: true });
  check('...and opens at night', !!night.h.move(night.tile).event);
  const noBeast = withSite('test_needs_beast', { night: null, extra: (d) => { d.map.occupants = d.map.occupants.filter(o => o.kind !== 'beast'); } });
  const rn = noBeast.h.move(noBeast.tile);
  check('a template that needs a role the place lacks ({beast} with no beast near) stays quiet, unspent',
    rn.ok && !rn.event && !!rn.quiet && noBeast.h.getState().map.occupants.some(o => o.id === 'otest'));
  const withBeast = withSite('test_needs_beast', { night: null, extra: (d, t) => {
    const b = d.map.occupants.find(o => o.kind === 'beast');
    d.map.occupants = d.map.occupants.filter(o => o.kind !== 'beast');
    const T = parseTileId(t);
    const spot = Object.keys(d.map.tiles).find(id => { const P = parseTileId(id); return id !== t && id !== d.pos && P.section === T.section && distance(P, T) === 2 && !d.map.occupants.some(o => o.tile === id); });
    d.map.occupants.push({ ...JSON.parse(JSON.stringify(b)), id: 'onear', tile: spot, state: 'rooted', home: 'rooted' });
  } });
  const rb = withBeast.h.move(withBeast.tile);
  const nearName = ZONES.reeds_of_gethsemane.natives[withBeast.h.getState().map.occupants.find(o => o.id === 'onear').family]?.name;
  check('...and opens when one is near, naming it', !!rb.event && rb.event.text.includes(nearName), rb.event?.text);
}

// =============================================================================
console.log('=== every branch of every real template resolves ===');
{
  const lines = {};
  const problems = [];
  for (const [id, t] of Object.entries(EVENT_TEMPLATES)) {
    if (id.startsWith('test_')) continue;
    const zoneId = t.appears?.zones?.[0] || 'reeds_of_gethsemane';
    const picks = t.shape === 'choice' ? t.options.map((_, i) => ({ option: i }))
      : t.shape === 'check' ? [{ roll: 20 }, { roll: 1 }]
      : t.shape === 'puzzle' ? t.answers.map((_, i) => ({ answer: i }))
      : [{ accept: true }, { accept: false }];
    for (const pick of picks) {
      try {
        const { h, tile } = withSite(id, { zoneId, night: t.appears?.night ?? false });
        const opened = h.move(tile);
        if (!opened.event) { problems.push(`${id}: did not open (${opened.quiet || opened.reason})`); continue; }
        const r = h.resolveEvent(pick);
        if (!r.ok) { problems.push(`${id} ${JSON.stringify(pick)}: ${r.reason}`); continue; }
        if (h.getState().map.occupants.some(o => o.id === 'otest') || h.view().event) problems.push(`${id}: the site was not spent`);
        lines[`${id} ${JSON.stringify(pick)}`] = [r.branch, ...r.lines];
      } catch (e) { problems.push(`${id} ${JSON.stringify(pick)}: THREW ${e.message}`); }
    }
  }
  check(`every branch of the ${Object.keys(EVENT_TEMPLATES).filter(k => !k.startsWith('test_')).length} real templates resolves, and spends its site`, problems.length === 0, problems.join(' | '));
  const puzzles = Object.entries(lines).filter(([k]) => k.startsWith('reeds_distant_weeping'));
  check('a puzzle: the right answer succeeds, every other fails', puzzles.filter(([, v]) => v[0] === 'success').length === 1 && puzzles.filter(([, v]) => v[0] === 'failure').length === 3);
  check('a check: a 20 succeeds and a 1 fails (DC {danger}+11 in the Reeds)', lines['reeds_sinking_mud {"roll":20}']?.[0] === 'success' && lines['reeds_sinking_mud {"roll":1}']?.[0] === 'failure');
  golden.lines = lines;
}

// =============================================================================
console.log('=== every verb moves its reader ===');
{
  const { h, w, tile, party } = withSite('test_verbs', { night: null, extra: (d, t) => {
    // Some blight near the site, so both blight effects have something to do.
    const near = Object.keys(d.map.tiles).filter(id => id !== t && id !== d.pos && !d.map.tiles[id].exit && d.map.tiles[id].ground !== 'water').slice(0, 3);
    for (const id of near.slice(0, 1)) { d.map.tiles[id].blightedFrom = d.map.tiles[id].ground; d.map.tiles[id].ground = 'blight'; }
  } });
  h.move(tile);
  const s0 = h.getState();
  const hp0 = party.map(c => c.currentHP);
  const blight0 = Object.values(s0.map.tiles).filter(t => t.ground === 'blight').length;
  const fog0 = Object.keys(s0.fog).length;
  const r = h.resolveEvent({ accept: true });
  const s1 = h.getState();
  const called = (k) => w.calls.filter(c => c[0] === k);
  const blight1 = Object.values(s1.map.tiles).filter(t => t.ground === 'blight').length;
  check('an Offer accepted pays its price: supplies -2, time +1', r.ok && Math.abs(s1.supplies - (s0.supplies - 2)) < 1e-9 && s1.time >= s0.time + 1 - 1e-9, `${s0.supplies} -> ${s1.supplies}`);
  check('huntPoints: 5 through the world', same(called('huntPoints'), [['huntPoints', 5]]));
  check('xp: a pool of 10 through the world', same(called('xp'), [['xp', 10]]));
  check('hp: every hunter lost 3 (who: all), none below 1', party.every((c, i) => c.currentHP === Math.max(1, Math.min(c.maxHP, hp0[i] - 3))));
  check('hunger: the party is sated', s1.satedUntil > s1.time);
  check('item: two Rations in the pack\'s found list', countInList(s1.pack.found, 'rations') === countInList(s0.pack.found, 'rations') + 2);
  check('boon: favor with the region\'s house, booked and handed to the world', s1.boon.favor === s0.boon.favor + 5 && called('favor').some(c => c[1] === 'jeremiah' && c[2] === 5));
  check('standing: +2 with the house through the world (the Bond and devotion)', called('favor').some(c => c[1] === 'jeremiah' && c[2] === 2));
  check('standing on the rival: the holder\'s devotion -3', same(called('rivalDevotion'), [['rivalDevotion', 'zafaar', 'jeremiah', -3]]));
  check('tribeRep: +3 with your own tribe', same(called('tribeRep'), [['tribeRep', 'styx', 3]]));
  check('questFlag: set through the world', w.flags.has('vendor_row'));
  check('reveal: tiles within 3 steps are no longer unseen', Object.keys(s1.fog).length > fog0, `${fog0} -> ${Object.keys(s1.fog).length}`);
  check('blight: spread 2 then cleansed 1', blight1 === blight0 + 2 - 1, `${blight0} -> ${blight1}`);
  check('the lines read out every effect, the price first', r.lines.length >= 13 && r.lines[0] === '-2 supplies.' && r.lines[1] === 'It is done.', r.lines.join(' / '));
  const frail = [{ name: 'Frail', status: 'alive', currentHP: 2, maxHP: 40 }, { name: 'Hale', status: 'alive', currentHP: 40, maxHP: 40 }];
  E.VERBS.hp.apply({ amount: -10, who: 'all' }, { roles: { danger: 1 }, rng: () => 0, party: () => frail });
  check('hp never kills: a hunter at 2 HP hit for 10 is left at 1', frail[0].currentHP === 1 && frail[1].currentHP === 30);
  const loreCalls = [];
  E.VERBS.lore.apply('divinity/lake_genesis', { world: { lore: (f) => loreCalls.push(f) } });
  check('lore: unlocks the entry\'s own flag through the world', same(loreCalls, ['lore:divinity/lake_genesis']));

  const refused = withSite('test_verbs', { night: null });
  refused.h.move(refused.tile);
  const sr0 = refused.h.getState();
  const rr = refused.h.resolveEvent({ accept: false });
  check('an Offer refused runs only its refuse outcome', rr.ok && same(rr.lines, ['Refused.']) && refused.h.getState().supplies === sr0.supplies && refused.w.calls.length === 0);
  const poor = withSite('test_verbs', { night: null, extra: (d) => { d.supplies = 1; } });
  poor.h.move(poor.tile);
  check('an Offer the party cannot pay is refused, and says so', !poor.h.view().event.offer.canAccept && !poor.h.resolveEvent({ accept: true }).ok);

  const tr = withSite('test_trade', { night: null, extra: (d) => { d.pack.found.push(makeStack('rations', 3)); } });
  tr.h.move(tr.tile);
  const had = countInList(tr.h.getState().pack.brought, 'rations') + countInList(tr.h.getState().pack.found, 'rations');
  const noItems = withSite('test_trade', { night: null, extra: (d) => { d.pack.brought = []; d.pack.found = []; } });
  noItems.h.move(noItems.tile);
  check('a Trade without the goods cannot be accepted', !noItems.h.view().event.trade.canAccept && !noItems.h.resolveEvent({ accept: true }).ok);
  if (had >= 2) {
    const rt = tr.h.resolveEvent({ accept: true });
    const left = countInList(tr.h.getState().pack.brought, 'rations') + countInList(tr.h.getState().pack.found, 'rations');
    check('a Trade takes the goods from the pack and pays', rt.ok && left === had - 2 && same(tr.w.calls, [['huntPoints', 3]]), `${had} -> ${left}`);
  } else {
    check('a Trade takes the goods from the pack and pays (the hunt packed no Rations to test with)', false, `packed ${had}`);
  }

  // fight: the nearest hostile occupant within two steps, weakened.
  const f = withSite('test_fight', { night: null, extra: (d, t) => {
    const beast = d.map.occupants.find(o => o.kind === 'beast');
    const spot = Object.keys(d.map.tiles).find(id => id !== t && id !== d.pos && !d.map.occupants.some(o => o.tile === id)
      && d.map.tiles[id].ground !== 'water' && id.split(':')[0] === t.split(':')[0]
      && Math.abs(Number(id.split(':')[1].split(',')[0]) - Number(t.split(':')[1].split(',')[0])) <= 1
      && Math.abs(Number(id.split(':')[1].split(',')[1]) - Number(t.split(':')[1].split(',')[1])) <= 1);
    d.map.occupants = d.map.occupants.filter(o => o.id !== beast.id);
    d.map.occupants.push({ ...JSON.parse(JSON.stringify(beast)), id: 'obeast', tile: spot, state: 'rooted', home: 'rooted' });
  } });
  f.h.move(f.tile);
  const rf = f.h.resolveEvent({ option: 0 });
  const spec = f.h.fightSpec();
  const plain = spec.ok ? spec.scenario.enemies.map(e => e.hpMult) : [];
  check('fight: the event starts a fight with the occupant beside it', rf.ok && f.h.encounter()?.occId === 'obeast' && f.h.encounter().cause === 'event');
  const grades = f.h.getState().map.occupants.find(o => o.id === 'obeast').roster.map(m => m.grade);
  check("...weakened: every member's HP scale is its grade's, halved",
    spec.ok && plain.length === grades.length && [...plain].sort().join() === grades.map(g => GRADE_HP_SCALE[g] * 0.5).sort().join(),
    `${JSON.stringify(plain)} for ${grades.join(',')}`);

  const pc = withSite('test_party_check', { night: null });
  pc.h.move(pc.tile);
  const view = pc.h.view().event.check;
  check('a party-stat check reads the party\'s rating on the d20 scale', view.who === 'the party' && view.modifier === E.ratingModifier(pc.h.stats().perception), JSON.stringify(view));
}

// =============================================================================
console.log('=== the old Advance loop ===');
{
  const rng = makeRng(5);
  let events = 0, fights = 0;
  for (let i = 0; i < 400; i++) { const r = EncounterRoller.roll('reeds_of_gethsemane', 0, 0, i % 2 === 0, rng); if (r?.kind === 'event') events++; if (r?.kind === 'encounter') fights++; }
  check('the old Advance loop rolls fights or nothing, never an event', events === 0 && fights > 100, `${fights} fights in 400`);
  const { createHunt } = await import('../../src/systems/HuntManager.js');
  const party = makeParty();
  const world = recordingWorld(party);
  const old = createHunt('reeds_of_gethsemane', { supplies: 60, seed: 3 }, world).serialize();
  old.pendingEncounter = { kind: 'event', type: 'flexible', label: 'A faint, distant weeping.', eventDef: { id: 'reeds_distant_weeping', kind: 'puzzle' } };
  const back = restoreHunt(old, world);
  check("an old save's pending Advance-loop event is dropped on load, as a quiet turn", back.getState().pendingEncounter === null);
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
  check('event tables identical to the golden', changed.length === 0, changed.length ? `changed: ${changed.join(', ')}` : `${keys.size} tables`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
