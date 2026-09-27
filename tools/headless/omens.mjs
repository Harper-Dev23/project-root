// tools/headless/omens.mjs
//
// The Omen meter and boss hunt plans (chunk 14b-3; data/bosses.js,
// src/systems/Omens.js).
//   node tools/headless/omens.mjs
//
// Covers: what a hunt books (each source, exact); booked at a clean exit and
// never on a wipe; the meter's cap before and after a boss unlocks; claiming
// a plan; the tribe's first offer ending the questline; the boss plan item
// (rolls nothing, never sold, one region only, not pickable before its lair
// exists); save round trips (and a save from before 14b-3); co-op (the ledger
// carries omens to each player's own save).

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

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

const { OMEN_FULL, OMEN_BANK, OMEN_SOURCES, BOSSES } = await import('../../data/bosses.js');
const O = await import('../../src/systems/Omens.js');
const { omensBooked, exitReward } = await import('../../src/systems/HuntObjectives.js');
const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
const { mapNeighbors } = await import('../../src/systems/HuntMapGen.js');
const { isPassable } = await import('../../data/grounds.js');
const { createItemInstance, getItemComputedData } = await import('../../src/systems/ItemFactory.js');
const { PLAN_BASE_IDS } = await import('../../src/systems/HuntPlans.js');
const { planFitsZone } = await import('../../src/scenes/overlays/HuntPlanPickerOverlay.js');
const { QUEST_LINES, getQuestState } = await import('../../src/data/quests.js');
const { hostWorld } = await import('../../src/systems/CoopHunt.js');
const { applyTakeHome } = await import('../../src/systems/CoopRewards.js');
const ProgressionManager = (await import('../../src/systems/ProgressionManager.js')).default;
const { makeParty } = await import('./fixtures.js');

const REEDS = 'reeds_of_gethsemane';
const MB = BOSSES.mourning_beast;
function fakePM(flags = []) {
  const set = new Set(flags);
  return { tribe: 'styx', completedScenarios: [], omens: {}, hasQuestFlag: (f) => set.has(f), setQuestFlag: (f) => set.add(f) };
}
function world(party) {
  const w = { omensPaid: [] };
  Object.assign(w, {
    party: () => party, nightFalls() {}, dayBreaks() {}, bankItems() {},
    awardHuntPoints() {}, awardXP() {}, favor() {}, rivalDevotion() {}, tribeRep() {}, lore() {}, questFlag() {},
    hasQuestFlag: () => false, followedHouse: () => null, houseHolder: () => null, ownTribe: () => 'styx', tribeName: (t) => t,
    omens: (zoneId, n) => w.omensPaid.push([zoneId, n]),
  });
  return w;
}

// =============================================================================
console.log('=== what a hunt books ===');
{
  const S = OMEN_SOURCES;
  check(`each source, exact: primary ${S.primary}, bonus ${S.bonus}, fight ${S.fight}, apex +${S.apex}, event ${S.event}`,
    omensBooked({ kills: [] }, true, 0) === S.primary
    && omensBooked({ kills: [] }, false, 2) === 2 * S.bonus
    && omensBooked({ kills: [{}, {}] }, false, 0) === 2 * S.fight
    && omensBooked({ kills: [{ apex: true }] }, false, 0) === S.fight + S.apex
    && omensBooked({ kills: [], eventsResolved: 3 }, false, 0) === 3 * S.event
    && omensBooked({}, false, 0) === 0);
  check('objectives pay more than kills (a primary outweighs any single fight, the apex included)', S.primary > S.fight + S.apex && S.bonus > S.fight);

  // A real apex hunt: engage the apex, win, walk out.
  const party = makeParty();
  const w = world(party);
  const h0 = createMapHunt(REEDS, { plan: { objective: 'apex', size: 'small' }, supplies: 300, seed: 77 }, w);
  const d = h0.serialize();
  const apex = d.map.occupants.find(o => o.apex);
  const next = mapNeighbors(d.map, apex.tile).find(id => isPassable(d.map.tiles[id]) && !d.map.occupants.some(o => o.tile === id));
  for (const o of d.map.occupants) o.noticed = true;
  d.pos = next; d.fog[next] = 'visible';
  const h = restoreMapHunt(d, w);
  h.move(apex.tile);
  const won = h.encounter()?.occId === apex.id && h.winEncounter({}).ok;
  const d2 = h.serialize(); d2.pos = d2.map.entry;
  const h2 = restoreMapHunt(d2, w);
  const want = exitReward(h2.getState()).omens;
  const ex = h2.exit();
  check('a clean exit books the hunt\'s omens to its region, once', won && ex.ok && w.omensPaid.length === 1 && w.omensPaid[0][0] === REEDS && w.omensPaid[0][1] === want,
    `${JSON.stringify(w.omensPaid)} (want ${want})`);
  check(`...an apex hunt won: primary + fight + apex = ${S.primary + S.fight + S.apex}`, want === S.primary + S.fight + S.apex && ex.reward.omens === want);
  check('...and a reload keeps what the hunt booked', restoreMapHunt(JSON.parse(JSON.stringify(h2.serialize())), world(makeParty())).getState().reward?.omens === want);

  const w2 = world(makeParty());
  const hw = createMapHunt(REEDS, { plan: { objective: 'scout', size: 'small' }, supplies: 300, seed: 78 }, w2);
  hw.wipe();
  check('a wipe books nothing', w2.omensPaid.length === 0);
}

// =============================================================================
console.log('=== the meter ===');
{
  const pm = fakePM();
  check('a region without bosses has none to show', O.bossesIn('bay_of_solace', pm).length === 0);
  check('the Reeds: the Mourning Beast and the Ghost Party, both locked', O.bossesIn(REEDS, pm).map(b => `${b.id}:${b.unlocked}`).sort().join() === 'ghost_party:false,mourning_beast:false');
  O.addOmens(pm, REEDS, 70); O.addOmens(pm, REEDS, 70);
  const m0 = O.omenMeter(REEDS, pm);
  check(`before any boss is known the meter stops at one full (${OMEN_FULL}), and nothing is ready to claim`, m0.have === OMEN_FULL && m0.ready === 0, JSON.stringify(m0));
  check('...claiming is refused', !O.claimBossPlan(pm, [], 'mourning_beast').ok);
  pm.setQuestFlag(MB.unlockFlag);
  O.addOmens(pm, REEDS, 1000);
  const m1 = O.omenMeter(REEDS, pm);
  check(`once known it banks up to ${OMEN_BANK} full meters`, m1.have === OMEN_FULL * OMEN_BANK && m1.ready === OMEN_BANK, JSON.stringify(m1));
  const bag = [];
  const c = O.claimBossPlan(pm, bag, 'mourning_beast');
  check('claiming spends one full meter for the boss\'s plan', c.ok && bag.length === 1 && bag[0].id === MB.plan && O.omenMeter(REEDS, pm).have === OMEN_FULL * (OMEN_BANK - 1));
  O.claimBossPlan(pm, bag, 'mourning_beast'); O.claimBossPlan(pm, bag, 'mourning_beast');
  const r = O.claimBossPlan(pm, bag, 'mourning_beast');
  check('plans can be saved up (three held); an empty meter refuses the fourth', bag.length === 3 && !r.ok && /not yet enough/.test(r.reason), r.reason);
  check('bad amounts add nothing', O.addOmens(pm, REEDS, -5) === 0 && O.addOmens(pm, REEDS, 'x') === 0 && O.addOmens(pm, null, 10) === 0);
}

// =============================================================================
console.log("=== the tribe's first offer ends the questline ===");
{
  const quest = QUEST_LINES.find(q => q.id === 'weeping_in_the_reeds');
  const pm = fakePM(['hunted:' + REEDS, 'apex_slain:' + REEDS, 'mb_weeping_heard']);
  const bag = [];
  check('not before the signs are found', O.offersReady(pm, REEDS).length === 0 && !O.takeFirstOffer(pm, bag, 'mourning_beast', pm.setQuestFlag).ok);
  pm.setQuestFlag('mb_signs_found');
  check('after them, the offer waits in the Reeds only', O.offersReady(pm, REEDS).length === 1 && O.offersReady(pm, 'bay_of_solace').length === 0);
  check('...the questline is on its last step', getQuestState(quest, pm) === 'active');
  const t = O.takeFirstOffer(pm, bag, 'mourning_beast', pm.setQuestFlag);
  check('taking it: a free plan, the boss unlocked, the questline complete', t.ok && bag.length === 1 && bag[0].id === MB.plan
    && pm.hasQuestFlag(MB.unlockFlag) && getQuestState(quest, pm) === 'completed' && O.bossesIn(REEDS, pm).find(b => b.id === 'mourning_beast').unlocked);
  check('...once only', !O.takeFirstOffer(pm, bag, 'mourning_beast', pm.setQuestFlag).ok && bag.length === 1 && O.offersReady(pm).length === 0);
}

// =============================================================================
console.log('=== the boss plan item ===');
{
  const inst = createItemInstance(MB.plan, { itemLevel: 1 });
  const view = getItemComputedData(inst);
  check("named plainly (no tier numeral): Mourner's Offering", view.name === "Mourner's Offering", view.name);
  check('rolls nothing: no affixes, no bonus objectives', !(inst.prefixes?.length) && !(inst.suffixes?.length) && (inst.bonusObjectives || []).length === 0);
  check('never sold by the plan vendor', !PLAN_BASE_IDS.includes(MB.plan));
  check('shown only for its own region', planFitsZone(inst, REEDS).show && !planFitsZone(inst, 'bay_of_solace').show);
  check('pickable for its region since its lair exists (14b-4), with a note on when it is used up', !planFitsZone(inst, REEDS).why && !!planFitsZone(inst, REEDS).note, planFitsZone(inst, REEDS).note);
  const plain = createItemInstance('plan_scout_small', { itemLevel: 1 });
  check('an ordinary plan fits every region, pickable', planFitsZone(plain, REEDS).show && !planFitsZone(plain, REEDS).why);
}

// =============================================================================
console.log('=== the save ===');
{
  ProgressionManager.reset();
  ProgressionManager.omens = { [REEDS]: 60 };
  const blob = JSON.parse(JSON.stringify(ProgressionManager.serialize()));
  ProgressionManager.reset();
  check('a reset empties every meter', Object.keys(ProgressionManager.omens).length === 0);
  ProgressionManager.deserialize(blob);
  check('the meter survives a save and reload', O.omenMeter(REEDS, ProgressionManager).have === 60);
  const old = { ...blob }; delete old.omens;
  ProgressionManager.deserialize(old);
  check('a save from before 14b-3 loads with empty meters', O.omenMeter(REEDS, ProgressionManager).have === 0);
  const { GAME_WORLD } = await import('../../src/systems/HuntManager.js');
  GAME_WORLD.omens(REEDS, 25);
  check('GAME_WORLD books onto the save', O.omenMeter(REEDS, ProgressionManager).have === 25);
  ProgressionManager.reset();
}

// =============================================================================
console.log('=== co-op ===');
{
  const ledger = [];
  const w = hostWorld(makeParty(), world(makeParty()), ledger);
  w.omens(REEDS, 48);
  check('on a co-op hunt omens go to the ledger', ledger.some(e => e.verb === 'omens' && e.args[0] === REEDS && e.args[1] === 48));
  const mine = [];
  applyTakeHome(ledger, { me: 'a', hostId: 'a', partySize: 2, zoneId: REEDS }, { world: { omens: (z, n) => mine.push([z, n]) } });
  check("...and each player's take-home books them to their own save", mine.length === 1 && mine[0][0] === REEDS && mine[0][1] === 48, JSON.stringify(mine));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
