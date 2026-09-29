// tools/headless/huntquests.mjs
//
// Quest sites and region flags (chunk 14b-2; src/systems/HuntQuests.js).
//   node tools/headless/huntquests.mjs
//
// Covers: the generator places what an active quest step needs (and a map
// with none is untouched); the Weeping in the Reeds walks step by step on a
// real ProgressionManager; a real hunt marks the site, keeps it quiet by day,
// opens it at night and sets the step's flag; the engine's region flags;
// save round trips mid-quest (the save, and a hunt saved on the map); co-op
// (the host's save decides the sites, the flags ride the ledger to each save).

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

const { generateHuntMap, mapNeighbors } = await import('../../src/systems/HuntMapGen.js');
const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
const { questSitesFor, regionFlag } = await import('../../src/systems/HuntQuests.js');
const { QUEST_LINES, getStepState, getQuestState } = await import('../../src/data/quests.js');
const { hostWorld } = await import('../../src/systems/CoopHunt.js');
const { clockAt } = await import('../../src/systems/HuntRules.js');
const { isPassable } = await import('../../data/grounds.js');
const ProgressionManager = (await import('../../src/systems/ProgressionManager.js')).default;
const { makeParty } = await import('./fixtures.js');

const REEDS = 'reeds_of_gethsemane';
const POOLS = { step: 'wr_pools', eventId: 'reeds_lament_pools', far: true };

/** A save's quest state: a bare object quest steps can read. */
function fakePM(flags = [], tribe = 'styx') {
  const set = new Set(flags);
  return { tribe, completedScenarios: [], hasQuestFlag: (f) => set.has(f), add(f) { set.add(f); return this; } };
}
function recordingWorld(party, pm = fakePM()) {
  const w = { calls: [], pm };
  Object.assign(w, {
    party: () => party, nightFalls() {}, dayBreaks() {}, bankItems() {},
    awardHuntPoints() {}, awardXP() {}, favor() {}, rivalDevotion() {}, tribeRep() {}, lore() {},
    questFlag: (f, on) => { w.calls.push(['questFlag', f, on]); if (on) pm.add(f); },
    hasQuestFlag: (f) => pm.hasQuestFlag(f),
    questSites: (zoneId) => questSitesFor(zoneId, pm),
    followedHouse: () => null, houseHolder: () => null, ownTribe: () => 'styx', tribeName: (t) => t,
  });
  return w;
}

// =============================================================================
console.log('=== the generator places quest sites ===');
{
  const base = { zoneId: REEDS, objective: 'scout', size: 'medium', seed: 4242 };
  const a = generateHuntMap(base);
  const b = generateHuntMap({ ...base, questSites: [] });
  check('no quest sites: the map is exactly the map without the option (seeds unchanged)', same(a, b) && a.questSites === undefined);

  let placed = 0, far = 0, reached = 0, n = 0;
  const { reachableFrom } = await import('../../src/systems/HuntMapGen.js');
  for (const size of ['small', 'medium', 'large']) {
    for (let k = 0; k < 20; k++) {
      const m = generateHuntMap({ zoneId: REEDS, objective: ['scout', 'apex', 'cull'][k % 3], size, seed: 9000 + k, questSites: [POOLS] });
      n++;
      const q = m.questSites?.[0];
      const occ = q && m.occupants.find(o => o.id === q.occId);
      if (occ && occ.kind === 'event' && occ.eventId === POOLS.eventId && occ.quest === 'wr_pools') placed++;
      const reach = reachableFrom ? reachableFrom(m) : null;
      if (q && reach?.has(q.tile)) {
        reached++;
        const max = Math.max(...reach.values());
        if (reach.get(q.tile) >= Math.max(2, Math.ceil(max * 0.5))) far++;
      }
      if (m.occupants.filter(o => o.tile === q?.tile).length > 1) placed = -999;
    }
  }
  check(`every map with an active step holds its site, alone on its tile (${n} maps, 3 sizes)`, placed === n, `${placed}/${n}`);
  check('...always reachable', reached === n, `${reached}/${n}`);
  check('...and far from the entry (at least half the walk), as the step asks', far === n, `${far}/${n}`);
  const again = generateHuntMap({ zoneId: REEDS, objective: 'scout', size: 'medium', seed: 9001, questSites: [POOLS] });
  check('...deterministic from the seed', same(again, generateHuntMap({ zoneId: REEDS, objective: 'scout', size: 'medium', seed: 9001, questSites: [POOLS] })));
  let threw = '';
  try { generateHuntMap({ ...base, questSites: [{ step: 'x', eventId: 'reeds_sinking_mud' }] }); } catch (e) { threw = e.message; }
  check('a quest site must name a set-piece event (a random one is refused)', /not a set-piece event/.test(threw), threw);
}

// =============================================================================
console.log('=== The Weeping in the Reeds, step by step ===');
{
  const quest = QUEST_LINES.find(q => q.id === 'weeping_in_the_reeds');
  const pm = fakePM();
  const active = () => quest.steps.filter(s => getStepState(s, pm) === 'active').map(s => s.id);
  // This questline's own sites (The Unconfessed Dead runs alongside it from the apex on).
  const WR = new Set(quest.steps.map(s => s.id));
  const sites = () => questSitesFor(REEDS, pm).filter(s => WR.has(s.step)).map(s => s.eventId || `beast:${s.beast?.family}`);
  const trail = [];
  trail.push([active(), sites()]);
  pm.add(regionFlag('hunted', REEDS)); trail.push([active(), sites()]);
  // A Cull hunt, then an Apex hunt (batch 4b chunk 2), before the Vowback.
  pm.add(regionFlag('hunted_cull', REEDS)); trail.push([active(), sites()]);
  pm.add(regionFlag('hunted_apex', REEDS)); trail.push([active(), sites()]);
  // The Vowback Crocodile is a quest beast (owner 2026-09-27), not the apex.
  pm.add('vowback_slain'); trail.push([active(), sites()]);
  pm.add('mb_weeping_heard'); trail.push([active(), sites()]);
  pm.add('mb_signs_found'); trail.push([active(), sites()]);
  pm.add('mb_offer_taken'); trail.push([active(), sites()]);
  const want = [
    [['wr_hunt'], []],
    [['wr_cull'], []],
    [['wr_apexpool'], []],
    [['wr_apex'], ['beast:vowback_crocodile']],
    [['wr_pools'], ['reeds_lament_pools']],
    [['wr_signs'], ['reeds_mourner_signs']],
    [['wr_offer'], []],
    [[], []],
  ];
  check('one active step at a time, and a site only while its step is active', same(trail, want), JSON.stringify(trail));
  check('...and the questline ends completed', getQuestState(quest, pm) === 'completed');
  check('no tribe yet: nothing is active and no site is placed', questSitesFor(REEDS, fakePM([], null)).length === 0
    && quest.steps.every(s => getStepState(s, fakePM([], null)) !== 'active'));
  const early = fakePM([regionFlag('apex_slain', REEDS)]);
  check('killing an apex first completes "Hunt the Reeds" too (no dead step); the Vowback Crocodile is next, as its own quest site', getStepState(quest.steps[0], early) === 'completed'
    && quest.steps.filter(s => getStepState(s, early) === 'active').map(s => s.id).join() === 'wr_apex'
    && questSitesFor(REEDS, early).some(q => q.step === 'wr_apex' && q.beast?.family === 'vowback_crocodile' && q.beast.flag === 'vowback_slain'));
  // A save from before (the Lament Pools reached through an apex kill) keeps its place.
  const older = fakePM([regionFlag('hunted', REEDS), regionFlag('apex_slain', REEDS), 'mb_weeping_heard']);
  check('an older save past the Lament Pools does not go back to the Vowback', getStepState(quest.steps[1], older) === 'completed'
    && quest.steps.filter(s => getStepState(s, older) === 'active').map(s => s.id).join() === 'wr_signs');
  // After its kill, the Vowback is a rare sight (zones rareBeasts): 10% of Reeds hunts, never marked as a quest.
  const rare = questSitesFor(REEDS, fakePM([regionFlag('hunted', REEDS), 'vowback_slain'])).find(q => q.step === 'rare:vowback');
  check('once slain, the Vowback turns up on 10% of Reeds hunts as a rare beast', !!rare && rare.pct === 10 && rare.beast.family === 'vowback_crocodile' && !rare.beast.flag
    && !questSitesFor(REEDS, fakePM([regionFlag('hunted', REEDS)])).some(q => q.step === 'rare:vowback'));
  check('a site is placed in its own region only', questSitesFor('bay_of_solace', fakePM([regionFlag('apex_slain', REEDS)])).length === 0);
}

// =============================================================================
console.log('=== a real hunt: marked, quiet by day, open at night ===');
{
  /** A hunt from a world whose save is at the Lament Pools step, standing next to the site. */
  function atPools({ night }) {
    const party = makeParty();
    const pm = fakePM([regionFlag('hunted', REEDS), regionFlag('apex_slain', REEDS), 'vowback_slain']);
    const w = recordingWorld(party, pm);
    const h0 = createMapHunt(REEDS, { plan: { objective: 'scout', size: 'medium' }, supplies: 300, seed: 515 }, w);
    const d = h0.serialize();
    const q = d.map.questSites.find(x => x.step === 'wr_pools');
    const next = mapNeighbors(d.map, q.tile).find(id => isPassable(d.map.tiles[id]) && !d.map.occupants.some(o => o.tile === id));
    d.map.occupants = d.map.occupants.filter(o => o.kind === 'event' ? true : o.tile !== next);
    for (const o of d.map.occupants) o.noticed = true;
    d.pos = next; d.fog[next] = 'visible';
    let t = d.time; while (clockAt(t).isNight !== night) t += 1; d.time = t; d.world.time = t;
    return { h: restoreMapHunt(d, w), w, pm, site: q.tile, h0 };
  }
  const day = atPools({ night: false });
  const marks = day.h0.view().objectiveSites.filter(s => s.objective === 'quest' && s.step === 'wr_pools');
  check('the site is marked from departure, named, and says after dark', marks.length === 1 && marks[0].name === 'The Lament Pools' && marks[0].night && !marks[0].done,
    JSON.stringify(marks));
  const rd = day.h.move(day.site);
  check('by day the Pools stay quiet, and the site is not spent', rd.ok && !rd.event && /after dark/.test(rd.quiet || '')
    && day.h.getState().map.occupants.some(o => o.quest === 'wr_pools'), rd.quiet);

  const night = atPools({ night: true });
  const rn = night.h.move(night.site);
  check('at night they open', rn.ok && rn.event?.templateId === 'reeds_lament_pools', JSON.stringify(rn.event?.templateId));
  const res = night.h.resolveEvent({ option: 0 });
  check('...either choice sets the step\'s flag, and the step is done', res.ok && night.pm.hasQuestFlag('mb_weeping_heard')
    && night.h.view().objectiveSites.find(s => s.objective === 'quest')?.done === true, JSON.stringify(night.w.calls));
  check('...and the next step\'s site is what the next hunt holds', questSitesFor(REEDS, night.pm).filter(s => s.step.startsWith('wr_')).map(s => s.eventId).join() === 'reeds_mourner_signs');

  const saved = restoreMapHunt(JSON.parse(JSON.stringify(day.h.serialize())), recordingWorld(makeParty()));
  check('a hunt saved on the map keeps its quest site through a reload', saved.view().objectiveSites.some(s => s.objective === 'quest' && s.tile === day.site && !s.done));
  const old = day.h.serialize(); delete old.map.questSites;
  check('a hunt saved before quest sites existed still loads, with none marked', restoreMapHunt(old, recordingWorld(makeParty())).view().objectiveSites.every(s => s.objective !== 'quest'));

  // A site whose step finishes another way is done (owner's playtest
  // 2026-09-29: the Cantor's fish trade stayed marked after a Choir band
  // gave up the page).
  {
    const pm = fakePM([regionFlag('hunted', REEDS), 'choir_heard']);
    const w = recordingWorld(makeParty(), pm);
    const h = createMapHunt(REEDS, { plan: { objective: 'scout', size: 'small' }, supplies: 300, seed: 515 }, w);
    const cantor = () => h.view().objectiveSites.find(s => s.step === 'hb_cantor');
    check("the Cantor's Price marks its trade", !!cantor() && !cantor().done);
    pm.add('cult_slain:yargaleth');
    check('...and it reads done once a Choir band gives up the page', cantor()?.done === true);
  }

  // Time passing on the tile wakes it (owner's playtest 2026-09-29: only Wait
  // looked again; camping until dark needed a step off and back on).
  /** Standing on the quiet Pools by day, `before` time short of nightfall. */
  function quietAtDusk(before) {
    const at = atPools({ night: false });
    at.h.move(at.site);
    const d = at.h.serialize();
    let t = d.time; while (!clockAt(t + before).isNight) t += 0.25; d.time = t; d.world.time = t;
    return { ...at, h: restoreMapHunt(d, at.w) };
  }
  for (const [kind, act] of [['camp', (h) => h.camp({ meals: [] })], ['forage', (h) => h.forage()], ['fish', (h) => h.fish()]]) {
    const q = quietAtDusk(0.1);
    const r = act(q.h);
    check(`${kind} into the night on the quiet Pools opens them`, r.ok && (r.encounter || r.event?.templateId === 'reeds_lament_pools'),
      JSON.stringify({ ok: r.ok, reason: r.reason, event: r.event?.templateId, enc: !!r.encounter }));
  }
  {
    const q = quietAtDusk(50);
    const quietLines = () => q.h.view().log.filter(l => l.kind === 'event_quiet').length;
    const n = quietLines();
    const r = q.h.forage();
    check('...still day: nothing opens, and the log does not say so twice', r.ok && !r.event && quietLines() === n);
  }
  {
    const night = atPools({ night: true });
    night.h.move(night.site);
    night.h.leaveEvent();
    const r = night.h.forage();
    check('an event walked away from does not open again by itself', r.ok && !r.event && !night.h.view().event);
  }
}

// =============================================================================
console.log('=== the engine sets region flags ===');
{
  const party = makeParty();
  const w = recordingWorld(party);
  const h = createMapHunt(REEDS, { plan: { objective: 'apex', size: 'small' }, supplies: 300, seed: 77 }, w);
  // Stand beside the apex, then step onto it: the engine's own engagement.
  const d = h.serialize();
  const apex = d.map.occupants.find(o => o.apex);
  const next = mapNeighbors(d.map, apex.tile).find(id => isPassable(d.map.tiles[id]) && !d.map.occupants.some(o => o.tile === id));
  for (const o of d.map.occupants) o.noticed = true;
  d.pos = next; d.fog[next] = 'visible';
  const h2 = restoreMapHunt(d, w);
  const met = h2.move(apex.tile);
  const won = h2.encounter()?.occId === apex.id ? h2.winEncounter({}) : { ok: false, met };
  check('killing the apex sets apex_slain:<region>', won.ok && w.pm.hasQuestFlag('apex_slain:' + REEDS), JSON.stringify(won.ok ? w.calls : won));
  const d2 = h2.serialize(); d2.pos = d2.map.entry;
  const h3 = restoreMapHunt(d2, w);
  const ex = h3.exit();
  check('a clean exit with the primary done sets hunted:<region>', ex.ok && ex.reward.primaryDone && w.pm.hasQuestFlag('hunted:' + REEDS));
  check('...and hunted_<objective>:<region> for its plan type (an Apex plan here)',
    w.pm.hasQuestFlag('hunted_apex:' + REEDS) && !w.pm.hasQuestFlag('hunted_cull:' + REEDS));

  // The Vowback Crocodile (owner 2026-09-27): a quest beast on the map while
  // its step is active, marked as a quest site; its kill sets vowback_slain.
  {
    const wv = recordingWorld(makeParty(), fakePM([regionFlag('hunted', REEDS), regionFlag('hunted_cull', REEDS), regionFlag('hunted_apex', REEDS)]));
    const hv = createMapHunt(REEDS, { plan: { objective: 'scout', size: 'medium' }, supplies: 300, seed: 91 }, wv);
    const dv = hv.serialize();
    const vb = dv.map.occupants.find(o => o.quest === 'wr_apex');
    const marked = hv.view().objectiveSites.find(o => o.step === 'wr_apex');
    const nx = vb && mapNeighbors(dv.map, vb.tile).find(id => isPassable(dv.map.tiles[id]) && !dv.map.occupants.some(o => o.tile === id));
    for (const o of dv.map.occupants) o.noticed = true;
    if (nx) { dv.pos = nx; dv.fog[nx] = 'visible'; }
    const hv2 = restoreMapHunt(dv, wv);
    const metV = vb && hv2.move(vb.tile);
    const wonV = vb && hv2.encounter()?.occId === vb.id ? hv2.winEncounter({}) : { ok: false, metV };
    check('the Vowback Crocodile is on the map as a marked quest site, and killing it sets vowback_slain (not apex_slain)',
      !!vb && marked?.objective === 'quest' && marked.name === 'the Vowback Crocodile' && wonV.ok
      && wv.pm.hasQuestFlag('vowback_slain') && !wv.pm.hasQuestFlag('apex_slain:' + REEDS), JSON.stringify({ vb: !!vb, marked, won: wonV.ok }));
  }

  const w2 = recordingWorld(makeParty());
  const h4 = createMapHunt(REEDS, { plan: { objective: 'apex', size: 'small' }, supplies: 300, seed: 78 }, w2);
  const ex2 = h4.exit();
  check('...and one without it does not', ex2.ok && !ex2.reward.primaryDone && !w2.pm.hasQuestFlag('hunted:' + REEDS));
}

// =============================================================================
console.log('=== the real save ===');
{
  ProgressionManager.questFlags = [];
  ProgressionManager.tribe = 'styx';
  ProgressionManager.setQuestFlag(regionFlag('hunted', REEDS));
  ProgressionManager.setQuestFlag(regionFlag('apex_slain', REEDS));
  ProgressionManager.setQuestFlag('vowback_slain');
  // At the Lament Pools: the two steps before it reported to the Elder (batch 4b chunk 1).
  ProgressionManager.completedQuestSteps = ['wr_hunt', 'wr_apex'];
  const before = questSitesFor(REEDS, ProgressionManager);
  const blob = JSON.parse(JSON.stringify(ProgressionManager.serialize()));
  ProgressionManager.questFlags = [];
  check('cleared, the save holds no site', questSitesFor(REEDS, ProgressionManager).length === 0);
  ProgressionManager.deserialize(blob);
  check('a mid-quest save reloads onto the same step and the same site', same(before, questSitesFor(REEDS, ProgressionManager)) && before[0]?.eventId === 'reeds_lament_pools');
  const { GAME_WORLD } = await import('../../src/systems/HuntManager.js');
  check('GAME_WORLD reads the site from the save', same(GAME_WORLD.questSites(REEDS), before));
}

// =============================================================================
console.log('=== co-op ===');
{
  const hostPM = fakePM([regionFlag('hunted', REEDS), regionFlag('apex_slain', REEDS), 'vowback_slain']);
  const reads = recordingWorld(makeParty(), hostPM);
  const ledger = [];
  const w = hostWorld(makeParty(), reads, ledger);
  const h = createMapHunt(REEDS, { plan: { objective: 'scout', size: 'medium' }, supplies: 300, seed: 515 }, w);
  check("the host's save decides the sites", (h.getState().map.questSites || []).map(q => q.eventId).sort().join() === 'choir_singing,gill_offerings,reeds_drowned_camp,reeds_lament_pools');
  w.questFlag('mb_weeping_heard', true);
  check('a flag set on the hunt goes to the ledger (each player applies it to their own save), not to the host directly',
    ledger.some(e => e.verb === 'questFlag' && e.args[0] === 'mb_weeping_heard') && !hostPM.hasQuestFlag('mb_weeping_heard'));
  check('...and the hunt already sees it', w.hasQuestFlag('mb_weeping_heard'));
}

// =============================================================================
console.log('=== 14b-6: the Cathedral Roots, a chance find ===');
{
  const { getZone } = await import('../../data/zones.js');
  const reeds = getZone(REEDS);
  const N = 1000;
  let withSite = 0, same = 0, sameOf = 0;
  const keep = reeds.chanceSites;
  for (let k = 0; k < N; k++) {
    const inp = { zoneId: REEDS, objective: ['scout', 'apex', 'cull', 'retrieve', 'commune'][k % 5], size: ['small', 'medium', 'large'][k % 3], seed: 60000 + k };
    const m = generateHuntMap(inp);
    const site = m.occupants.find(o => o.chance && o.eventId === 'reeds_cathedral_roots');
    if (site) { withSite++; continue; }
    if (k % 10) continue;   // every tenth map without one: identical to a map made with no chance sites at all
    reeds.chanceSites = [];
    const bare = generateHuntMap(inp);
    reeds.chanceSites = keep;
    sameOf++; if (JSON.stringify(bare) === JSON.stringify(m)) same++;
  }
  check(`about 5% of Reeds hunts hold the Cathedral Roots (${withSite} of ${N})`, withSite >= 30 && withSite <= 75, `${(100 * withSite / N).toFixed(1)}%`);
  check('a map without one is exactly the map it was before chance sites existed', same === sameOf, `${same}/${sameOf}`);
  let bay = 0;
  for (let k = 0; k < 200; k++) if (generateHuntMap({ zoneId: 'bay_of_solace', objective: 'scout', size: 'medium', seed: 61000 + k }).occupants.some(o => o.chance)) bay++;
  check('never in another region', bay === 0);

  // The event itself, on a real hunt: the site next to the party.
  function atRoots(inWild) {
    const party = makeParty();
    const w = recordingWorld(party);
    w.historicInWild = () => inWild;
    const omensPaid = []; w.omens = (z, n) => omensPaid.push([z, n]);
    const h0 = createMapHunt(REEDS, { plan: { objective: 'scout', size: 'medium' }, supplies: 300, seed: 71 }, w);
    const d = h0.serialize();
    const tile = h0.view().moves[0].tile;
    d.map.occupants = d.map.occupants.filter(o => o.tile !== tile);
    d.map.occupants.push({ id: 'oroots', kind: 'event', tile, eventId: 'reeds_cathedral_roots', chance: true, concealment: 0 });
    for (const o of d.map.occupants) o.noticed = true;
    const h = restoreMapHunt(d, w);
    h.move(tile);
    return { h, omensPaid };
  }
  const wild = atRoots(true);
  const rw = wild.h.resolveEvent({ roll: 20 });
  check('found (a good roll), while it is in the wild: Sunken Nave, into the pack', rw.ok && wild.h.getState().pack.found.some(i => i.id === 'sunken_nave'), (rw.lines || []).join(' '));
  const held = atRoots(false);
  const rh = held.h.resolveEvent({ roll: 20 });
  check('...while it is held: none, and the substitute instead (+30 Reeds omens and Hunt Points)', rh.ok && !held.h.getState().pack.found.some(i => i.id === 'sunken_nave')
    && JSON.stringify(held.omensPaid) === JSON.stringify([[REEDS, 30]]), (rh.lines || []).join(' '));
  const miss = atRoots(true);
  const rm = miss.h.resolveEvent({ roll: 1 });
  check('a bad roll finds nothing, even while it is in the wild (a chance find is never guaranteed)', rm.ok && !miss.h.getState().pack.found.some(i => i.id === 'sunken_nave'));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
