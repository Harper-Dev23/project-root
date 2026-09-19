// tools/headless/plans.mjs
//
// Hunt Plans v2 (Exploration System v2, chunk 4). Every number here comes from
// calling the REAL exported functions -- createItemInstance, rollWeather,
// createHunt, GameState.load -- with a seeded stream. No formula is re-derived
// to check it.
//
// What it proves (IMPLEMENTATION_PLAN, chunk 4 "proves"):
//   - affix rolls measured at item levels 1-10, for every rarity the vendor
//     sells: no zero-affix plans, and the affix counts RARITY_RULES promise
//   - item level makes affixes stronger (every family's mean roll climbs)
//   - base tier comes from item level (I 1-4, II 5-7, III 8-10), and Tier III
//     always carries a guaranteed bonus objective, different from a rolled one
//   - at most one rolled bonus objective, never one above its unlock level
//   - every bonus objective has a placement rule the generator knows
//   - every plan field names its reader; the live ones really are read
//     (Foul Weather through rollWeather, of Provision through createHunt)
//   - the basic plan: free, Small, Scout, no modifiers; "None" is gone
//   - the vendor: stock up to party level, price rising with item level,
//     rolled once per in-game day (saved), each slot sold once
//   - a real v4 save holding a plan migrates to v7: item level 1, Tier I
//   - chunk 8c: the 15 plan base types (objective + size), a base in every
//     vendor slot, an old stock without bases rolled again once, and which
//     fields are live now that every new hunt is a hunt on the map
//
// USAGE
//   node tools/headless/plans.mjs                  run the checks
//   node tools/headless/plans.mjs --json out.json  also write the golden
//   node tools/headless/plans.mjs --diff old.json  also compare against one

import fs from 'node:fs';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

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
installPhaserStub(13);

const GameState = (await import('../../src/systems/GameState.js')).default;
const { SAVE_VERSION } = await import('../../src/systems/GameState.js');
const { createItemInstance, getHuntPlanPools, huntPlanView, RARITY_RULES, getAffixIndex } =
  await import('../../src/systems/ItemFactory.js');
const { makeBasicPlan, isBasicPlan, describePlan, describePlanHeader, planPrice, planStockLevels, currentPlanStock, markPlanSold, PLAN_BASE_IDS } =
  await import('../../src/systems/HuntPlans.js');
const { planMapInputs } = await import('../../src/systems/HuntMapGen.js');
const { combineModifiers } = await import('../../src/systems/HuntModifiers.js');
const { createHunt } = await import('../../src/systems/HuntManager.js');
const { rollWeather, WEATHER_TYPES } = await import('../../data/weather.js');
const { makeRng } = await import('../../src/systems/seededRng.js');
const { ZONES } = await import('../../data/zones.js');
const { Items } = await import('../../data/items.js');
const {
  PLAN_FIELDS, PLAN_PREFIX_FAMILIES, PLAN_SUFFIX_FAMILIES, BONUS_OBJECTIVES, PLACEMENT_NEEDS,
  PLAN_TIER_BANDS, PLAN_TIER_IMPLICITS,
} = await import('../../data/planAffixes.js');

const golden = {};
const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const SOLD_RARITIES = ['uncommon', 'rare', 'epic'];
const N = 4000;
const FAMILIES = [...PLAN_PREFIX_FAMILIES.map(f => ({ ...f, slot: 'prefix' })),
                  ...PLAN_SUFFIX_FAMILIES.map(f => ({ ...f, slot: 'suffix' }))];
const pools = getHuntPlanPools();
const defByKey = new Map([...pools.prefixes, ...pools.suffixes].map(d => [d.key, d]));

// =============================================================================
console.log('=== the pools: all five tiers, stronger at every tier ===');
{
  for (const fam of FAMILIES) {
    const tiers = [5, 4, 3, 2, 1].map(t => fam.tiers[t]);
    const all = tiers.every(r => Array.isArray(r) && r[0] <= r[1]);
    const climbs = tiers.every((r, i) => i === 0 || (r[0] >= tiers[i - 1][0] && r[1] > tiers[i - 1][1]));
    check(`${fam.label}: tiers 5-1 all present and climbing`, all && climbs, tiers.map(r => r.join('-')).join(' | '));
    check(`${fam.label}: writes a declared field (${fam.field})`, !!PLAN_FIELDS[fam.field]);
  }
  check('six prefix families and eight suffix families (PLAN_AFFIXES)',
    PLAN_PREFIX_FAMILIES.length === 6 && PLAN_SUFFIX_FAMILIES.length === 8);
  check('pools hold every family at 5 tiers, plus the 9 objectives as prefixes',
    pools.prefixes.length === 6 * 5 + 9 && pools.suffixes.length === 8 * 5 && pools.objectives.length === 9);
  check('every pool key is unique', new Set([...pools.prefixes, ...pools.suffixes].map(d => d.key)).size
    === pools.prefixes.length + pools.suffixes.length);
  check('the Alt tooltip index knows every new key and the six v1 keys',
    [...pools.prefixes, ...pools.suffixes].every(d => getAffixIndex()[d.key])
    && ['Keen-Eyed', 'Bold', 'Studious', 'of Swift Travel', 'of the Hunt', 'of Plenty'].every(k => getAffixIndex()[k]));
  golden.families = Object.fromEntries(FAMILIES.map(f => [f.id, { field: f.field, tiers: f.tiers }]));
}

// =============================================================================
console.log('=== every plan field names its reader ===');
{
  for (const [f, d] of Object.entries(PLAN_FIELDS)) {
    check(`${f}: ${d.live ? 'live' : 'not yet'} -> ${d.reader}`, typeof d.reader === 'string' && d.reader.length > 10);
  }
  // Chunk 8c: every new hunt is a map hunt. Summed fields reach its bundle
  // through combineModifiers; plan-only fields through huntMods; the
  // generator's fields through planMapInputs. The three fight rewards have no
  // reader on the map until fights start there (chunk 9), so they are not live.
  const { huntMods } = await import('../../src/systems/HuntRules.js');
  const combined = combineModifiers({ encounterChancePercent: 1, supplyEfficiencyPercent: 1 });
  check('live summed fields reach the hunt\'s combined modifiers',
    ['encounterChancePercent', 'supplyEfficiencyPercent'].every(f => PLAN_FIELDS[f].live && combined[f] === 1));
  const bundle = huntMods({}, {}, { travelTimePercent: 1, perceptionBonus: 1, harvestYieldPercent: 1 });
  check('live plan-only fields reach the map hunt\'s bundle (huntMods)',
    ['travelTimePercent', 'perceptionBonus', 'harvestYieldPercent'].every(f => PLAN_FIELDS[f].live && bundle[f] === 1));
  const inputs = planMapInputs({ objective: 'scout', size: 'small', bonusObjectives: [], mods: { gradeShiftPercent: 1, leanCountryPercent: 1, blightPatches: 1, restlessPercent: 1 } });
  check('live generator fields reach the generator (planMapInputs)',
    ['gradeShiftPercent', 'leanCountryPercent', 'blightPatches', 'restlessPercent'].every(f => PLAN_FIELDS[f].live && inputs.mods[f] === 1));
  check('fight rewards are not live until fights start on the map (chunk 9)',
    ['lootQualityPercent', 'huntPointsPercent', 'xpPercent'].every(f => !PLAN_FIELDS[f].live && /chunk 9/.test(PLAN_FIELDS[f].reader)));
  golden.fields = Object.fromEntries(Object.entries(PLAN_FIELDS).map(([f, d]) => [f, d.live]));
}

// =============================================================================
console.log(`=== affix rolls at item levels 1-10 (${N} plans per row, seeded) ===`);
{
  const table = {};
  const strength = {};           // family -> level -> mean rolled value
  const objectivesByLevel = {};
  let zeroAffix = 0, badCount = 0, twoRolled = 0, aboveUnlock = 0, badTier = 0, t3NoImplicit = 0,
      implicitDup = 0, implicitOutside = 0, over2 = 0, nonTierIIIImplicit = 0;
  let seed = 1;

  console.log('    ' + 'iLvl'.padEnd(6) + 'tier  ' + SOLD_RARITIES.map(r => `${r} avg / zero% / bonus%`.padEnd(30)).join(''));
  for (const lvl of LEVELS) {
    const row = {};
    objectivesByLevel[lvl] = new Set();
    for (const fam of FAMILIES) (strength[fam.id] ||= {})[lvl] = { sum: 0, n: 0 };
    for (const rarity of SOLD_RARITIES) {
      const rule = RARITY_RULES[rarity];
      let affixes = 0, zero = 0, withBonus = 0;
      const tiers = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (let i = 0; i < N; i++) {
        const inst = createItemInstance('hunt_plan', { rarity, itemLevel: lvl, rng: makeRng(seed++) });
        const n = inst.prefixes.length + inst.suffixes.length;
        affixes += n;
        if (n === 0) zero++;
        if (rule.force ? (inst.prefixes.length !== rule.force.prefixes || inst.suffixes.length !== rule.force.suffixes)
                       : (n < rule.min || n > rule.max)) badCount++;

        const view = huntPlanView(inst);
        const band = PLAN_TIER_BANDS.find(b => lvl >= b.minItemLevel && lvl <= b.maxItemLevel);
        if (view.tier !== band.tier || !inst.displayName.includes(` ${['', 'I', 'II', 'III'][band.tier]}`)) badTier++;

        const rolledObj = inst.bonusObjectives.filter(o => o.from === 'affix');
        const implicitObj = inst.bonusObjectives.filter(o => o.from === 'implicit');
        if (rolledObj.length > 1) twoRolled++;
        if (inst.bonusObjectives.length > 2) over2++;
        if (inst.bonusObjectives.length) withBonus++;
        for (const o of inst.bonusObjectives) {
          objectivesByLevel[lvl].add(o.id);
          if (BONUS_OBJECTIVES[o.id].unlockItemLevel > lvl) aboveUnlock++;
        }
        if (PLAN_TIER_IMPLICITS[view.tier].bonusObjective) {
          if (implicitObj.length !== 1) t3NoImplicit++;
          if (implicitObj.length && rolledObj.some(o => o.id === implicitObj[0].id)) implicitDup++;
        } else if (implicitObj.length) nonTierIIIImplicit++;
        // the rolled objective really is a prefix on the plan
        if (rolledObj.length && !inst.prefixes.includes(BONUS_OBJECTIVES[rolledObj[0].id].name)) implicitOutside++;

        for (const key of [...inst.prefixes, ...inst.suffixes]) {
          const d = defByKey.get(key);
          if (!d) continue;
          if (d.tier) tiers[d.tier]++;
          const fam = FAMILIES.find(f => `plan_${f.id}` === d.family);
          if (fam) {
            strength[fam.id][lvl].sum += inst.instanceMods.misc[fam.field];
            strength[fam.id][lvl].n++;
          }
        }
      }
      row[rarity] = { avgAffixes: round(affixes / N), zeroPct: round(100 * zero / N), bonusPct: round(100 * withBonus / N), tiers };
      zeroAffix += zero;
    }
    table[lvl] = { tier: huntPlanView({ itemLevel: lvl }).tier, ...row };
    console.log('    ' + String(lvl).padEnd(6) + String(table[lvl].tier).padEnd(6)
      + SOLD_RARITIES.map(r => `${row[r].avgAffixes.toFixed(2)} / ${row[r].zeroPct}% / ${row[r].bonusPct}%`.padEnd(30)).join(''));
  }
  golden.rollsByLevel = table;

  check('no zero-affix plans at any item level 1-10, any rarity sold', zeroAffix === 0, `${zeroAffix} of ${N * 30}`);
  check('every plan rolled exactly the affix count RARITY_RULES promise', badCount === 0, `${badCount} off`);
  check('base tier set by item level band, and shown in the name', badTier === 0, `${badTier} off`);
  check('never more than one rolled bonus objective', twoRolled === 0, `${twoRolled}`);
  check('never more than two bonus objectives in all', over2 === 0);
  check('no bonus objective ever rolled below its unlock level', aboveUnlock === 0, `${aboveUnlock}`);
  check('every Tier III plan carries exactly one implicit bonus objective', t3NoImplicit === 0, `${t3NoImplicit}`);
  check('...always a different objective from the rolled one', implicitDup === 0, `${implicitDup}`);
  check('Tier I and II plans never get the implicit objective', nonTierIIIImplicit === 0);
  check('a rolled bonus objective is a prefix on the plan', implicitOutside === 0);

  // Which objectives appear at which level, measured.
  golden.objectivesSeen = Object.fromEntries(LEVELS.map(l => [l, [...objectivesByLevel[l]].sort()]));
  for (const [id, o] of Object.entries(BONUS_OBJECTIVES)) {
    const first = LEVELS.find(l => objectivesByLevel[l].has(id));
    check(`${o.name}: first seen at item level ${first}, unlocks at ${o.unlockItemLevel}`, first === o.unlockItemLevel);
  }

  // Fix B: item level makes the same affix stronger.
  const means = {};
  console.log('    mean roll by item level (all rarities):');
  for (const fam of FAMILIES) {
    means[fam.id] = Object.fromEntries(LEVELS.map(l => {
      const s = strength[fam.id][l];
      return [l, s.n ? round(s.sum / s.n) : null];
    }));
    console.log('      ' + fam.label.padEnd(16) + LEVELS.map(l => String(means[fam.id][l]).padStart(7)).join(''));
    check(`${fam.label}: rolls at item level 1, and stronger at 10 than at 1`,
      means[fam.id][1] != null && means[fam.id][10] > means[fam.id][1],
      `${means[fam.id][1]} -> ${means[fam.id][10]}`);
  }
  golden.meanRollByLevel = means;
}

// =============================================================================
console.log('=== bonus objectives: every one has a placement rule ===');
{
  for (const [id, o] of Object.entries(BONUS_OBJECTIVES)) {
    const needs = o.placement?.needs;
    const known = Array.isArray(needs) && needs.every(n => PLACEMENT_NEEDS[n]);
    const stated = Array.isArray(needs) && (needs.length > 0 || (typeof o.placement.because === 'string' && o.placement.because.length > 0));
    check(`${o.name} (unlock ${o.unlockItemLevel}): ${needs?.length ? needs.join(', ') : `nothing, because ${o.placement?.because}`}`,
      known && stated && typeof o.doneWhen === 'string');
  }
  check('nine bonus objectives, unlocking at 1 / 3 / 5 / 8',
    same(Object.values(BONUS_OBJECTIVES).map(o => o.unlockItemLevel), [1, 1, 1, 3, 3, 5, 5, 8, 8]));
  golden.objectives = Object.fromEntries(Object.entries(BONUS_OBJECTIVES)
    .map(([id, o]) => [id, { unlock: o.unlockItemLevel, needs: o.placement.needs }]));
}

// =============================================================================
console.log('=== the basic plan; "None" is gone ===');
{
  const basic = makeBasicPlan();
  const v = huntPlanView(basic);
  check('basic plan: item level 1, Tier I, no implicit', v.itemLevel === 1 && v.tier === 1 && v.implicitCompletionRewardPercent === 0);
  check('...Scout, Small', v.objective === 'scout' && v.size === 'small');
  check('...no affixes and no bonus objectives', basic.prefixes.length === 0 && basic.suffixes.length === 0 && basic.bonusObjectives.length === 0);
  check('...recognised as basic (departing does not use it up)', isBasicPlan(basic) && !isBasicPlan(createItemInstance('hunt_plan', { rarity: 'rare', itemLevel: 3 })));
  const epicBasic = createItemInstance('basic_hunt_plan', { rarity: 'epic', itemLevel: 10 });
  check('...even forced to epic at item level 10, it rolls nothing', epicBasic.prefixes.length + epicBasic.suffixes.length === 0);
  check('a plan made without an item level gets 1, never an ungated roll',
    createItemInstance('hunt_plan', { rarity: 'rare' }).itemLevel === 1);
  const picker = fs.readFileSync(new URL('../../src/scenes/overlays/HuntPlanPickerOverlay.js', import.meta.url), 'utf8');
  check('the picker offers the basic plan and no "None" row', /makeBasicPlan\(\)/.test(picker) && !/'None'/.test(picker) && !/_pick\(null\)/.test(picker));
  console.log('    ' + describePlan(basic).join(' | '));
}

// =============================================================================
console.log('=== the vendor: up to party level, price rising with item level ===');
{
  const prices = Object.fromEntries(LEVELS.map(l => [l, planPrice(l)]));
  check('price rises with item level', LEVELS.every((l, i) => i === 0 || prices[l] > prices[LEVELS[i - 1]]), JSON.stringify(prices));
  let over = 0, topMissing = 0;
  for (const party of LEVELS) {
    for (let s = 1; s <= 200; s++) {
      const levels = planStockLevels(party, 3, makeRng(s));
      if (levels.some(l => l < 1 || l > party)) over++;
      if (levels[0] !== party) topMissing++;
    }
  }
  check('stock never above party level (2,000 stocks)', over === 0);
  check('the first slot is always at party level', topMissing === 0);
  golden.price = prices;

  // The stock is rolled once per in-game day, not on every redraw.
  const PM = (await import('../../src/systems/ProgressionManager.js')).default;
  PM.reset();
  let rolls = 0;
  const rollRarity = () => { rolls++; return ['uncommon', 'rare', 'epic'][rolls % 3]; };
  const first = JSON.stringify(currentPlanStock(PM, { partyLevel: 6, rollRarity, rng: makeRng(3) }));
  for (let i = 0; i < 50; i++) currentPlanStock(PM, { partyLevel: 6, rollRarity, rng: makeRng(100 + i) });
  check('50 more redraws on the same day return the same stock, rolling nothing',
    JSON.stringify(PM.planVendorStock) === first && rolls === 3);
  markPlanSold(PM, 1);
  const saved = JSON.parse(JSON.stringify(PM.serialize()));
  PM.reset();
  PM.deserialize(saved);
  const back = currentPlanStock(PM, { partyLevel: 6, rollRarity, rng: makeRng(999) });
  check('it survives a save and reload, sold slot included',
    rolls === 3 && back.slots[1].sold === true && JSON.stringify(back.slots.map(s => s.itemLevel)) === JSON.stringify(JSON.parse(first).slots.map(s => s.itemLevel)));
  PM.advanceDay();
  const next = currentPlanStock(PM, { partyLevel: 6, rollRarity, rng: makeRng(4) });
  check('a new day rolls a new stock, nothing sold', rolls === 6 && next.day === 1 && next.slots.every(s => !s.sold));
  const { planVendorStock, ...older } = saved;
  PM.deserialize(older);
  check('a save from before the stock existed loads with none, and rolls one', PM.planVendorStock === null
    && currentPlanStock(PM, { partyLevel: 2, rollRarity, rng: makeRng(5) }).slots.every(s => s.itemLevel <= 2));

  // Chunk 8c: every slot sells a base type (objective + size).
  const combos = new Set(PLAN_BASE_IDS.map(id => `${Items[id].objective}/${Items[id].size}`));
  check('15 plan base types: every objective x every size, once each; the basic and legacy plans are not sold',
    PLAN_BASE_IDS.length === 15 && combos.size === 15 && !PLAN_BASE_IDS.includes('hunt_plan') && !PLAN_BASE_IDS.includes('basic_hunt_plan'));
  const baseTally = {};
  for (let d = 0; d < 400; d++) {
    PM.reset();
    for (const sl of currentPlanStock(PM, { partyLevel: 5, rollRarity, rng: makeRng(7000 + d) }).slots) baseTally[sl.base] = (baseTally[sl.base] || 0) + 1;
  }
  check('over 400 days of stock, every slot has a base and all 15 are sold', Object.keys(baseTally).length === 15
    && Object.keys(baseTally).every(b => PLAN_BASE_IDS.includes(b)), `min ${Math.min(...Object.values(baseTally))} / max ${Math.max(...Object.values(baseTally))} of 1200 slots`);
  PM.reset();
  const today = currentPlanStock(PM, { partyLevel: 4, rollRarity, rng: makeRng(11) });
  PM.planVendorStock = { day: today.day, slots: today.slots.map(({ base, ...rest }) => ({ ...rest })) };
  const rerolled = currentPlanStock(PM, { partyLevel: 4, rollRarity, rng: makeRng(12) });
  const again = currentPlanStock(PM, { partyLevel: 4, rollRarity, rng: makeRng(13) });
  check('a stock saved before 8c (no bases) is rolled again once, then kept',
    rerolled.slots.every(sl => PLAN_BASE_IDS.includes(sl.base)) && JSON.stringify(again) === JSON.stringify(rerolled));
  const bought = createItemInstance(rerolled.slots[0].base, { rarity: 'rare', itemLevel: 4, rng: makeRng(14) });
  const bv = huntPlanView(bought);
  check('a bought plan carries its base\'s objective and size into the map hunt\'s inputs',
    bv.objective === Items[bought.id].objective && bv.size === Items[bought.id].size
    && planMapInputs(bv).objective === bv.objective && planMapInputs(bv).size === bv.size);
  const legacy = huntPlanView(createItemInstance('hunt_plan', { rarity: 'rare', itemLevel: 3, rng: makeRng(15) }));
  check('the legacy hunt_plan reads as Scout on a Small map', legacy.objective === 'scout' && legacy.size === 'small');
  check('no plan says "(no effect yet)" about its objective, size, bonus objectives or tier implicit',
    PLAN_BASE_IDS.every(id => !describePlanHeader(createItemInstance(id, { rarity: 'epic', itemLevel: 9, rng: makeRng(16) })).some(l => /no effect yet/.test(l))));
  golden.bases = Object.fromEntries(PLAN_BASE_IDS.map(id => [id, `${Items[id].objective}/${Items[id].size}: ${Items[id].name}`]));
  PM.reset();
}

// =============================================================================
console.log('=== live readers: Foul Weather, of Provision ===');
{
  const dist = {};
  for (const pct of [0, 50, 85]) {
    const rng = makeRng(77);
    const counts = Object.fromEntries(WEATHER_TYPES.map(w => [w.id, 0]));
    for (let i = 0; i < 20000; i++) counts[rollWeather(rng, pct).id]++;
    dist[pct] = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, round(100 * n / 20000, 1)]));
    console.log(`    foulWeatherPercent ${String(pct).padStart(2)}: ` + JSON.stringify(dist[pct]));
  }
  check('Foul Weather makes Clear Skies rarer through the real roll', dist[0].clear > dist[50].clear && dist[50].clear > dist[85].clear);
  const s1 = makeRng(5), s2 = makeRng(5);
  rollWeather(s1, 0); rollWeather(s2, 85);
  check('...and draws exactly one number, so nothing after it shifts', s1() === s2());
  golden.weather = dist;

  const zoneId = Object.keys(ZONES)[0];
  const world = { party: () => [], bankItems: (items) => banked.push(...items) };
  const banked = [];
  const plain = createHunt(zoneId, { supplies: 60, seed: 9 }, world).getState();
  const hunt = createHunt(zoneId, { supplies: 60, seed: 9, huntPlanModifiers: { provisionRations: 25 } }, world);
  const st = hunt.getState();
  const rations = st.pack.brought.find(i => i.id === 'rations');
  check('of Provision: 25 Rations in the pack at departure', rations?.qty === 25);
  check('...and 25 more supplies to burn', st.supplies === plain.supplies + 25 * Items.rations.supply);
  check('...and the same weather (the stream is untouched)', st.weather.id === plain.weather.id);
  const out = hunt.finish('exit');
  check('...unspent, they come home on a clean exit', out.rationsLeft === 25 && banked.some(i => i.id === 'rations' && i.qty === 25));
}

// =============================================================================
console.log('=== a real v4 save holding a plan migrates to v6 ===');
{
  const fixture = JSON.parse(fs.readFileSync(new URL('../snapshots/save-v4-fixture.json', import.meta.url), 'utf8'));
  const oldPlan = fixture.inventory.find(i => i.id === 'hunt_plan');
  check('the fixture is a v4 save holding a plan with no item level',
    fixture.version === 4 && oldPlan && oldPlan.itemLevel == null && !('bonusObjectives' in oldPlan));
  check(`this build writes v${SAVE_VERSION}`, SAVE_VERSION === 7);

  // Plans in a character's own bag and in a tribe stash must migrate too.
  const withMore = JSON.parse(JSON.stringify(fixture));
  withMore.characters[0].inventory = [...(withMore.characters[0].inventory || []), { ...oldPlan, instanceId: 'itm_charplan' }];
  withMore.tribeStash = { ...(withMore.tribeStash || {}), lesse: [{ ...oldPlan, instanceId: 'itm_stashplan' }] };

  store.set('bmSave_v4plan', JSON.stringify(withMore));
  const loaded = GameState.load('v4plan');
  check('load() accepts it', loaded === true, GameState.lastLoadError || '');
  const plan = GameState.inventory.find(i => i.id === 'hunt_plan');
  check('its plan is item level 1 with no bonus objectives', plan?.itemLevel === 1 && same(plan.bonusObjectives, []));
  const { itemLevel, bonusObjectives, ...rest } = plan;
  const { itemLevel: _il, ...oldRest } = oldPlan;
  check('...everything else about it unchanged (affixes, name, mods, id)', same(rest, oldRest));
  check('...and reads as Tier I', huntPlanView(plan).tier === 1 && describePlan(plan)[0] === 'Item Level 1, Tier I');
  const charPlan = GameState.characters[0].inventory.find(i => i.instanceId === 'itm_charplan');
  const stashPlan = GameState.tribeStash.lesse?.find(i => i.instanceId === 'itm_stashplan');
  check('a plan in a character\'s bag migrated too', charPlan?.itemLevel === 1 && same(charPlan.bonusObjectives, []));
  check('a plan in a tribe stash migrated too', stashPlan?.itemLevel === 1 && same(stashPlan.bonusObjectives, []));
  check('the hunt in it still came back', !!GameState._huntHooks && !!JSON.parse(JSON.stringify(GameState._huntHooks.serialize())));

  GameState.save('v4plan');
  const rewritten = JSON.parse(store.get('bmSave_v4plan'));
  check('re-saved as v7, the plan keeping its item level', rewritten.version === 7
    && rewritten.inventory.find(i => i.id === 'hunt_plan')?.itemLevel === 1);

  const reloaded = GameState.load('v4plan');
  check('a v7 save loads again unchanged', reloaded === true
    && GameState.inventory.find(i => i.id === 'hunt_plan')?.itemLevel === 1);
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
  check('plan tables identical to the golden', changed.length === 0, changed.length ? `changed: ${changed.join(', ')}` : '');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
