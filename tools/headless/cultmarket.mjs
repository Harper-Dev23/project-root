// tools/headless/cultmarket.mjs
//
// The cult economy (vault CONTENT_INBOX "The cult economy", owner-approved
// 2026-09-27): Sin Tickets, the Corrupted renown origin, potions, the black
// markets, parley. Grows with each step.
//   node tools/headless/cultmarket.mjs

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
const { installPhaserStub } = await import('./phaserStub.js');
installPhaserStub(7);

const F = await import('../../src/systems/ItemFactory.js');
const { Items } = await import('../../data/items.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const ProgressionManager = (await import('../../src/systems/ProgressionManager.js')).default;
const GameState = (await import('../../src/systems/GameState.js')).default;

const CORE = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

// =============================================================================
console.log('=== Corrupted: armour only, a gain budget and a malus by base tier ===');
{
  const C = F.RENOWN_ORIGINS.corrupted;
  const bases = Object.values(Items).filter(i => i.type === 'armor' && !['ring', 'amulet'].includes(i.slot) && !i.unique && !i.historic && !i.natural && !i.locked);
  const bad = [];
  const malusSeen = new Set();
  for (const b of bases) {
    for (let k = 0; k < 40; k++) {
      const inst = F.createItemInstance(b.id, { rarity: 'common', itemLevel: 3, rng: makeRng(1000 + k), renownOrigin: 'corrupted' });
      const c = inst.corruption;
      const budget = C.budget[b.baseTier];
      const own = Object.keys(b.bonuses);
      const gains = Object.values(c.gain);
      const [mStat, mVal] = Object.entries(c.malus)[0];
      malusSeen.add(mStat);
      if (gains.reduce((t, x) => t + x, 0) !== budget.gain) bad.push(`${b.id}: gain ${gains}`);
      if (Math.max(...gains) - Math.min(...gains) > 1) bad.push(`${b.id}: uneven split ${gains}`);
      if (!own.every(s => s in c.gain) || Object.keys(c.gain).length !== own.length) bad.push(`${b.id}: gain off its own stats`);
      if (own.includes(mStat) || mVal !== -budget.malus || !CORE.includes(mStat)) bad.push(`${b.id}: malus ${mStat} ${mVal}`);
      const v = F.getItemComputedData(inst).bonuses;
      for (const s of own) if (v[s] !== b.bonuses[s] + c.gain[s]) bad.push(`${b.id}: ${s} shows ${v[s]}`);
      if (v[mStat] !== mVal) bad.push(`${b.id}: ${mStat} shows ${v[mStat]}`);
    }
  }
  check(`every armour base (${bases.length}), 40 rolls each: the tier's gain split evenly over its own stats, the malus on one it lacks, and the item shows both`,
    bad.length === 0 && bases.length === 30, bad.slice(0, 4).join(' | '));
  check('the malus can land on any core stat a base lacks, CHA included', CORE.every(s => malusSeen.has(s)), [...malusSeen].join(','));
  const net = (tier) => C.budget[tier].gain - C.budget[tier].malus;
  check('always a net gain, skewed to the positive (tier 1 +4/-2, tier 2 +6/-3)', net(1) === 2 && net(2) === 3 && C.budget[1].gain === 4 && C.budget[2].malus === 3);
  const a = F.createItemInstance('fitted_boots_dex_wis', { rarity: 'rare', itemLevel: 3, rng: makeRng(5), renownOrigin: 'corrupted' });
  const b = F.createItemInstance('fitted_boots_dex_wis', { rarity: 'rare', itemLevel: 3, rng: makeRng(5), renownOrigin: 'corrupted' });
  check('the same seed rolls the same corruption', JSON.stringify(a.corruption) === JSON.stringify(b.corruption) && JSON.stringify(a.instanceMods.stats) === JSON.stringify(b.instanceMods.stats));
  check('named "Corrupted <noun>", its rolled affixes kept', /Corrupted Boots/.test(a.displayName), a.displayName);
  const w = F.createItemInstance('crude_dagger', { rarity: 'rare', itemLevel: 3, rng: makeRng(5), renownOrigin: 'corrupted' });
  check('never a weapon (armour only)', !w.renownOrigin && !w.corruption && !/Corrupted/.test(w.displayName || ''));
  // Through the game's own save and load (its item serializer and migrations).
  GameState.inventory = [a];
  GameState.save('__cultmarket');
  GameState.inventory = [];
  GameState.load('__cultmarket');
  const back = (GameState.inventory || []).find(i => i.instanceId === a.instanceId) || null;
  check('it survives a real save and load: the corruption and its stats are on the loaded item', !!back && JSON.stringify(back.corruption) === JSON.stringify(a.corruption)
    && JSON.stringify(F.getItemComputedData(back).bonuses) === JSON.stringify(F.getItemComputedData(a).bonuses));
}

// =============================================================================
console.log('=== Sin Tickets ===');
{
  ProgressionManager.reset();
  check('a new save starts with none', ProgressionManager.sinTickets === 0);
  ProgressionManager.sinTickets = 7;
  const blob = JSON.parse(JSON.stringify(ProgressionManager.serialize()));
  ProgressionManager.reset();
  ProgressionManager.deserialize(blob);
  check('they survive a save and reload', ProgressionManager.sinTickets === 7);
  const old = { ...blob }; delete old.sinTickets;
  ProgressionManager.deserialize(old);
  check('a save from before them loads with none', ProgressionManager.sinTickets === 0);
  ProgressionManager.reset();
}

// =============================================================================
console.log('=== potions, in the real CombatScene ===');
{
  const { makeParty, slotMapFor } = await import('./fixtures.js');
  const { createCombatHost } = await import('./combatHost.js');
  const { startCombat, setActor, cast } = await import('./fight.js');
  const CSM = await import('../../src/scenes/CombatScene.js');
  const CombatScene = CSM.default || Object.values(CSM).find(v => typeof v === 'function');
  const board = (items) => {
    const party = makeParty();
    const host = createCombatHost(CombatScene);
    host.__begin({ party, partySlots: slotMapFor(party), scenarioId: 'training_encounter_1' });
    startCombat(host);
    GameState.inventory = items.map(id => F.createItemInstance(id));
    return { host, party };
  };
  // A potion is drunk by the hunter who uses it (owner's playtest, 2026-09-27):
  // `actor` drinks; `aimAt` is a target the harness offers anyway, ignored.
  const drink = (b, itemId, actor, aimAt = null) => {
    setActor(b.host, actor);
    actor.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
    const ab = b.host._getCombatUsableItemAbilities(actor).find(a => a.id === itemId);
    const r = cast(b.host, actor, ab, aimAt);
    return { r, ab, actor };
  };
  const held = (id) => GameState.inventory.filter(i => i.id === id).length;

  let b = board(['healing_draught', 'healing_draught']);
  const t = b.party[1];
  t.currentHP = 10;
  const d = drink(b, 'healing_draught', t);
  check('a Healing Draught is listed as an item the user drinks (no target, a bonus action)', d.ab?.targetRequirement === 'self' && d.ab.requiresTarget === false && d.ab.actionCost === 'bonus');
  check('...restores 30% of max HP, spends the bonus action and one draught', t.currentHP === Math.min(t.maxHP, 10 + Math.floor(t.maxHP * 0.3)) && d.actor.actionsLeft.bonus === 0 && held('healing_draught') === 1,
    `${10} -> ${t.currentHP} of ${t.maxHP}`);
  b = board(['healing_draught']);
  const full = b.party[2];
  const f = drink(b, 'healing_draught', full);
  check('on a hunter at full HP it fizzles: nothing spent', full.currentHP === full.maxHP && held('healing_draught') === 1 && f.actor.actionsLeft.bonus === 1);

  b = board(['healing_draught']);
  const giver = b.party[0], hurt = b.party[1];
  giver.currentHP = 10; hurt.currentHP = 10;
  drink(b, 'healing_draught', giver, hurt);
  check('aimed at a teammate, it is still the user who drinks it', giver.currentHP > 10 && hurt.currentHP === 10, `user ${giver.currentHP}, teammate ${hurt.currentHP}`);

  b = board(['mana_draught']);
  const m = b.party[1]; m.currentMP = 0;
  drink(b, 'mana_draught', m);
  check('a Mana Draught restores 30% of max MP', m.currentMP === Math.floor(m.maxMP * 0.3), `${m.currentMP}/${m.maxMP}`);

  b = board(['tincture_red_breath']);
  const rb = b.party[1]; rb.currentHP = 5; rb.currentMP = rb.maxMP;
  drink(b, 'tincture_red_breath', rb);
  check('Tincture of Red Breath: 50% of max HP, and 15% of max MP taken', rb.currentHP === Math.min(rb.maxHP, 5 + Math.floor(rb.maxHP * 0.5)) && rb.currentMP === rb.maxMP - Math.floor(rb.maxMP * 0.15),
    `HP ${rb.currentHP}/${rb.maxHP}, MP ${rb.currentMP}/${rb.maxMP}`);
  b = board(['tincture_deep_well']);
  const dw = b.party[1]; dw.currentMP = 0; dw.currentHP = 2;
  drink(b, 'tincture_deep_well', dw);
  check('Tincture of the Deep Well: 50% of max MP, and 15% of max HP taken, never below 1', dw.currentMP === Math.floor(dw.maxMP * 0.5) && dw.currentHP === 1, `HP ${dw.currentHP}, MP ${dw.currentMP}/${dw.maxMP}`);
  GameState.inventory = [];
}

// =============================================================================
console.log('=== the black markets ===');
{
  const M = await import('../../src/systems/Market.js');
  const { CULT_MARKETS } = await import('../../data/cultMarkets.js');
  const REEDS = 'reeds_of_gethsemane';
  const choir = M.marketView('yargaleth', { sinTickets: 5 });
  const gill = M.marketView('dagon', { sinTickets: 5 });
  check('the Tithe-Boat: the shared Gamble and Tinctures', choir.name === 'The Tithe-Boat' && choir.stalls.map(s => s.id).join() === 'gamble,tinctures');
  check('the Gill Market: the same two, and its own Smuggled Parts', gill.stalls.map(s => s.id).join() === 'gamble,tinctures,parts');

  const pm = { sinTickets: 0 };
  const bag = [];
  const poor = M.buy('yargaleth', 'gamble', { pm, bag, rng: makeRng(1) });
  check('without the tickets, refused, nothing spent or given', !poor.ok && /Sin Ticket/.test(poor.reason) && bag.length === 0 && pm.sinTickets === 0, poor.reason);
  pm.sinTickets = 3;
  const t = M.buy('yargaleth', 'tinctures', { pm, bag, rng: makeRng(2), goodsId: 'tincture_red_breath' });
  check('a tincture: 2 Sin Tickets, into the bag', t.ok && pm.sinTickets === 1 && bag[0]?.id === 'tincture_red_breath');
  check('a stall that does not sell it refuses', !M.buy('yargaleth', 'tinctures', { pm, bag, goodsId: 'healing_draught' }).ok && !M.buy('yargaleth', 'parts', { pm, bag }).ok);

  // The gamble over many rolls: the cult's lean, the rarity odds, Corrupted 1 in 100 armour.
  const roll = (cult, n, seed) => {
    const out = { armour: 0, weapon: 0, corrupted: 0, corruptWeapon: 0, rarity: {} };
    const rng = makeRng(seed);
    const p = { sinTickets: n }, b = [];
    for (let i = 0; i < n; i++) M.buy(cult, 'gamble', { pm: p, bag: b, rng, itemLevel: 3 });
    for (const it of b) {
      const base = Items[it.id];
      if (base.type === 'armor') out.armour++; else out.weapon++;
      if (it.renownOrigin === 'corrupted') { out.corrupted++; if (base.type !== 'armor') out.corruptWeapon++; }
      out.rarity[it.rarity] = (out.rarity[it.rarity] || 0) + 1;
    }
    return out;
  };
  const c = roll('yargaleth', 6000, 11), d = roll('dagon', 6000, 12);
  check(`the Choir's gamble leans to armour (${c.armour}/6000), the Temple's to weapons (${d.weapon}/6000)`, c.armour > 4300 && c.armour < 4700 && d.weapon > 4300 && d.weapon < 4700);
  const r = c.rarity;
  check(`uncommon 30 / rare 45 / epic 25 (${r.uncommon} / ${r.rare} / ${r.epic} of 6000)`, r.uncommon > 1650 && r.uncommon < 1950 && r.rare > 2550 && r.rare < 2850 && r.epic > 1350 && r.epic < 1650);
  const armourN = c.armour + d.armour, corrN = c.corrupted + d.corrupted;
  check(`about 1 armour piece in 100 comes up Corrupted (${corrN} of ${armourN})`, corrN / armourN > 0.005 && corrN / armourN < 0.016);
  const w3 = roll('dagon', 3000, 13);
  check(`weapons never do (${c.weapon + d.weapon + w3.weapon} weapons rolled, none Corrupted)`, c.corruptWeapon + d.corruptWeapon + w3.corruptWeapon === 0 && w3.weapon > 0);
  const pb = [], pp = { sinTickets: 300 };
  const prng = makeRng(14);
  for (let i = 0; i < 100; i++) M.buy('dagon', 'parts', { pm: pp, bag: pb, rng: prng, zoneId: REEDS, itemLevel: 3 });
  const natives = Object.keys((await import('../../data/zones.js')).getZone(REEDS).natives);
  check('Smuggled Parts: 3 each, a Reeds native\'s part, never below rare', pp.sinTickets === 0 && pb.length === 100
    && pb.every(p => ['rare', 'epic'].includes(p.rarity) && natives.includes(Items[p.id]?.part?.family)), [...new Set(pb.map(p => Items[p.id]?.part?.family))].join(','));

  // Its site: only once its questline opens it, on about 40% of hunts.
  const { questSitesFor } = await import('../../src/systems/HuntQuests.js');
  const { generateHuntMap } = await import('../../src/systems/HuntMapGen.js');
  const pmOf = (flags) => ({ tribe: 'styx', completedScenarios: [], hasQuestFlag: (f) => flags.includes(f) });
  check('no market site before its questline opens it', !questSitesFor(REEDS, pmOf([])).some(q => q.step.startsWith('market:')));
  const sites = questSitesFor(REEDS, pmOf([CULT_MARKETS.yargaleth.unlockFlag]));
  check('...then the Tithe-Boat is a site for Reeds hunts', sites.some(q => q.eventId === 'tithe_boat' && q.pct === 40));
  let on = 0;
  for (let k = 0; k < 500; k++) {
    const m = generateHuntMap({ zoneId: REEDS, objective: 'scout', size: ['small', 'medium', 'large'][k % 3], seed: 8800 + k, questSites: sites });
    if (m.occupants.some(o => o.kind === 'event' && o.eventId === 'tithe_boat')) on++;
  }
  check(`...on about 40% of them (${on} of 500)`, on > 170 && on < 230);

  // On a real hunt: it opens, it cannot be resolved, walking away leaves it.
  const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
  const { makeParty } = await import('./fixtures.js');
  const party = makeParty();
  const w = { party: () => party, nightFalls() {}, dayBreaks() {}, questSites: () => [], hasQuestFlag: () => false };
  const h0 = createMapHunt(REEDS, { plan: { objective: 'scout', size: 'medium' }, supplies: 200, seed: 71 }, w);
  const dd = h0.serialize();
  const tile = h0.view().moves[0].tile;
  dd.map.occupants = dd.map.occupants.filter(o => o.tile !== tile);
  dd.map.occupants.push({ id: 'omarket', kind: 'event', tile, eventId: 'tithe_boat', concealment: 0 });
  for (const o of dd.map.occupants) o.noticed = true;
  const h = restoreMapHunt(dd, w);
  const mv = h.move(tile);
  check('stepping onto it opens the market', mv.event?.shape === 'market' && mv.event.market === 'yargaleth');
  check('...it is browsed, not resolved', !h.resolveEvent({}).ok);
  h.leaveEvent();
  check('...and walking away leaves it there for later', h.getState().map.occupants.some(o => o.id === 'omarket') && !h.view().event);
}

// =============================================================================
console.log('=== parley and the Hymn Beneath the Water ===');
{
  const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
  const { mapNeighbors } = await import('../../src/systems/HuntMapGen.js');
  const { isPassable } = await import('../../data/grounds.js');
  const { makeParty } = await import('./fixtures.js');
  const { makeStack } = await import('../../src/systems/ItemStacks.js');
  const REEDS = 'reeds_of_gethsemane';
  /** A hunt standing next to a cult camp of `cult`, with the save's flags. */
  function besideCamp(cult, flags, { fish = 0 } = {}) {
    const party = makeParty();
    const set = new Set(flags);
    const w = { calls: [], party: () => party, nightFalls() {}, dayBreaks() {}, questSites: () => [], hasQuestFlag: (f) => set.has(f),
      questFlag: (f, on) => { w.calls.push(['questFlag', f, on]); if (on) set.add(f); },
      sinTickets: (n) => w.calls.push(['sinTickets', n]), falseGod: (g, n) => w.calls.push(['falseGod', g, n]),
      awardHuntPoints() {}, awardXP() {}, favor() {}, bankItems() {} };
    const h0 = createMapHunt(REEDS, { plan: { objective: 'scout', size: 'medium' }, supplies: 200, seed: 73 }, w);
    const d = h0.serialize();
    const tile = h0.view().moves[0].tile;
    d.map.occupants = d.map.occupants.filter(o => o.tile !== tile);
    d.map.occupants.push({ id: 'ocamp', kind: 'cultist', tile, cult, roster: [{ type: 'cultist', grade: null }, { type: 'cultist', grade: null }], state: 'rooted', concealment: 0 });
    for (const o of d.map.occupants) o.noticed = true;
    if (fish) d.pack.found.push(makeStack('raw_fish', fish));
    const h = restoreMapHunt(d, w);
    h.move(tile);
    return { h, w, set };
  }
  const stranger = besideCamp('yargaleth', []);
  check('a Choir camp the party has not met: an ordinary fight, no parley', stranger.h.encounter()?.kind === 'cultist' && stranger.h.view().parley === false && !stranger.h.parley().ok);
  const known = besideCamp('yargaleth', ['choir_heard'], { fish: 3 });
  check('once the Choir know you (choir_heard), their camp offers parley', known.h.view().parley === true);
  const pr = known.h.parley();
  check('parley: the fight ends, the camp leaves the map (not a kill), and the Choir\'s trade opens', pr.ok && !known.h.encounter() && known.h.view().event?.templateId === 'choir_parley'
    && !known.h.getState().map.occupants.some(o => o.id === 'ocamp') && !known.h.getState().kills.length);
  const tr = known.h.resolveEvent({ accept: true });
  check('...3 fish for 2 Sin Tickets (and a little hidden standing with Yar\'galeth)', tr.ok && known.w.calls.some(c => c[0] === 'sinTickets' && c[1] === 2) && known.w.calls.some(c => c[0] === 'falseGod' && c[1] === 'yargaleth' && c[2] === 1), (tr.lines || []).join(' '));
  const gill = besideCamp('dagon', ['choir_heard']);
  check('a Temple camp does not talk because the Choir know you', gill.h.view().parley === false);

  // A Choir band defeated: the cantor's step can be done that way.
  const fightThem = besideCamp('yargaleth', []);
  fightThem.h.winEncounter({});
  check('defeating a cult band records cult_slain:<its god>', fightThem.w.calls.some(c => c[0] === 'questFlag' && c[1] === 'cult_slain:yargaleth'));

  // The questline, step by step, and what each step places.
  const { questSitesFor } = await import('../../src/systems/HuntQuests.js');
  const { QUEST_LINES, getQuestState } = await import('../../src/data/quests.js');
  const q = QUEST_LINES.find(x => x.id === 'hymn_beneath_the_water');
  const flags = new Set(['hunted:' + REEDS]);
  const pmq = { tribe: 'styx', completedScenarios: [], hasQuestFlag: (f) => flags.has(f) };
  const choirSites = () => questSitesFor(REEDS, pmq).filter(s => s.step.startsWith('hb_') || s.step.startsWith('market:')).map(s => s.eventId);
  const walk = [choirSites()];
  flags.add('choir_heard'); walk.push(choirSites());
  flags.add('cult_slain:yargaleth'); walk.push(choirSites());
  flags.add('choir_hymn'); walk.push(choirSites());
  flags.add('choir_market_open'); walk.push(choirSites());
  check('Singing -> the Cantor (or any Choir band) -> the Hymn -> the Boat -> then the Tithe-Boat as a market',
    JSON.stringify(walk) === JSON.stringify([['choir_singing'], ['choir_cantor'], ['choir_unfinished_hymn'], ['choir_tithe_offer'], ['tithe_boat']]) && getQuestState(q, pmq) === 'completed', JSON.stringify(walk));
}

// =============================================================================
console.log('=== The Offered Breath (the Temple of the Gill) ===');
{
  const { questSitesFor } = await import('../../src/systems/HuntQuests.js');
  const { QUEST_LINES, getQuestState } = await import('../../src/data/quests.js');
  const REEDS = 'reeds_of_gethsemane';
  const q = QUEST_LINES.find(x => x.id === 'offered_breath');
  const flags = new Set(['hunted:' + REEDS]);
  const pmq = { tribe: 'styx', completedScenarios: [], hasQuestFlag: (f) => flags.has(f) };
  const sites = () => questSitesFor(REEDS, pmq).filter(s => s.step.startsWith('ob_') || s.step === 'market:dagon').map(s => s.eventId);
  const walk = [sites()];
  for (const f of ['gill_offerings_read', 'gill_baptised', 'gill_channel', 'gill_market_open']) { flags.add(f); walk.push(sites()); }
  check('Offerings -> Baptism -> the Smugglers -> the Deep Priest -> then the Gill Market',
    JSON.stringify(walk) === JSON.stringify([['gill_offerings'], ['gill_baptism'], ['gill_smugglers'], ['gill_deep_priest'], ['gill_market']]) && getQuestState(q, pmq) === 'completed', JSON.stringify(walk));
  const { CULT_PARLEY } = await import('../../data/cultMarkets.js');
  check("the first step's flag is the one that opens Temple parley", CULT_PARLEY.dagon.flag === 'gill_offerings_read');
}

// =============================================================================
console.log('=== events say what they do (clarity pass) ===');
{
  const E = await import('../../src/systems/EventEffects.js');
  const { EVENT_TEMPLATES } = await import('../../data/events.js');
  const parleyPays = E.previewEffects(EVENT_TEMPLATES.choir_parley.receive);
  check('a parley trade names what it pays, and not the hidden standing', JSON.stringify(parleyPays) === JSON.stringify(['2 Sin Tickets']), JSON.stringify(parleyPays));
  const boat = EVENT_TEMPLATES.choir_tithe_offer;
  const sing = E.previewEffects(boat.reward), burn = E.previewEffects(boat.refuse);
  check('an offer names each answer: sing (3 Sin Tickets, advances a quest), burn (advances a quest, prophet standing)',
    sing.includes('3 Sin Tickets') && sing.includes('advances a quest') && burn.includes('prophet standing') && !sing.some(x => /Yar|hidden/.test(x)), `${sing} | ${burn}`);
  const bap = E.previewEffects([...(EVENT_TEMPLATES.gill_baptism.price || []), ...EVENT_TEMPLATES.gill_baptism.reward], { danger: 1 });
  check('a price is named as one (the baptism costs HP)', bap.some(x => /costs 5 HP each/.test(x)), JSON.stringify(bap));
  check('an effect it cannot read is left out, never thrown', Array.isArray(E.previewEffects([{ hp: { amount: 'nonsense(' } }])));
  const lines = E.applyEffects([{ questFlag: 'mb_weeping_heard' }], { world: { questFlag() {} }, roles: {} });
  check('advancing a quest says so in the result', lines.includes('Your quest log is updated.'));

  // A quest site's panel names its quest line.
  const { createMapHunt, restoreMapHunt } = await import('../../src/systems/HuntEngine.js');
  const { makeParty } = await import('./fixtures.js');
  const party = makeParty();
  const w = { party: () => party, nightFalls() {}, dayBreaks() {}, questSites: () => [], hasQuestFlag: () => false };
  const h0 = createMapHunt('reeds_of_gethsemane', { plan: { objective: 'scout', size: 'medium' }, supplies: 200, seed: 71 }, w);
  const d = h0.serialize();
  const tile = h0.view().moves[0].tile;
  d.map.occupants = d.map.occupants.filter(o => o.tile !== tile);
  d.map.occupants.push({ id: 'oq', kind: 'event', tile, eventId: 'choir_cantor', quest: 'hb_cantor', concealment: 0 });
  for (const o of d.map.occupants) o.noticed = true;
  const h = restoreMapHunt(d, w);
  const ev = h.move(tile).event;
  check("a quest site's event names its quest line, and its trade names what it pays", ev?.quest === 'The Hymn Beneath the Water' && ev.trade?.pays?.includes('1 Sin Ticket'), JSON.stringify({ q: ev?.quest, pays: ev?.trade?.pays }));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
