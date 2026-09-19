// tools/headless/partystats.mjs
//
// The party stats model (Exploration System v2, chunk 6). Every number comes
// from calling the REAL exported function (PartyStats.js, CharacterBuilder.js,
// CombatLogic.js, GameState.js); no curve or formula is re-derived to check it.
// Checks are about SHAPE (monotonic, bounded, diminishing, size-neutral), and
// the golden records every curve so any later change shows up as a diff —
// the weakness_snapshot pattern.
//
// What it proves:
//   - every race's and class's ratings sum to their budget; no pairing is ahead
//   - all 36 race x class starting profiles (golden)
//   - every curve at ratings 0-300 (golden): 0 at 0, rising, diminishing, under
//     its ceiling
//   - the drop curve: unchanged at 0, the old ceiling never passed, one rng
//     draw per roll, and seeded rolls land on the odds
//   - level-up picks: owed by level, options, refusals, passives once, and
//     picks survive a real GameState save/load
//   - partyStats: best-of with the providing hunter, averages, the dead left
//     out, modifiers after aggregation (size-neutral), each passive once, gear
//     rarity softened and the party pool added straight
//   - CombatScene rolls hunt drops with this module's function, not its own
//
// USAGE
//   node tools/headless/partystats.mjs                  run the checks
//   node tools/headless/partystats.mjs --json out.json  also write the golden
//   node tools/headless/partystats.mjs --diff old.json  also compare against one

import fs from 'node:fs';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : ''));
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const r4 = (x) => +(+x).toFixed(4);

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
installPhaserStub(12);

const CB = await import('../../src/systems/CharacterBuilder.js');
const {
  EXPLORATION_STATS, EXPLORATION_RACE_BUDGET, EXPLORATION_CLASS_BUDGET,
  RACE_EXPLORATION, CLASS_EXPLORATION, EXPLORATION_PICK_LEVELS, EXPLORATION_RATING_PICK,
  EXPLORATION_PASSIVES, RACE_BONUSES, CLASS_BONUSES,
} = CB;
const PS = await import('../../src/systems/PartyStats.js');
const {
  hunterExploration, partyStats, owedExplorationPicks, explorationPickOptions, applyExplorationPick,
  RATING_CURVES, ratingToPercent, softenGearRarity, huntDropOdds, rollHuntDropRarity,
  DROP_BASE_ODDS, DROP_MAX_SHIFT, PASSIVE_FIELDS, PARTY_STAT_OUTPUTS,
} = PS;
const { computeEffectiveInitiative } = await import('../../src/systems/CombatLogic.js');
const GameState = (await import('../../src/systems/GameState.js')).default;
const { makeRng } = await import('../../src/systems/seededRng.js');
const { makeParty } = await import('./fixtures.js');

const golden = {};
const RATINGS = [0, 10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 200, 300];

// =============================================================================
console.log('=== rating tables and budgets ===');
{
  const sum = (o) => Object.values(o).reduce((t, v) => t + v, 0);
  const raceSums = Object.fromEntries(Object.entries(RACE_EXPLORATION).map(([k, v]) => [k, sum(v)]));
  const classSums = Object.fromEntries(Object.entries(CLASS_EXPLORATION).map(([k, v]) => [k, sum(v.ratings)]));
  console.log('    race totals  ' + JSON.stringify(raceSums));
  console.log('    class totals ' + JSON.stringify(classSums));
  check(`every race sums to ${EXPLORATION_RACE_BUDGET}`, Object.values(raceSums).every(s => s === EXPLORATION_RACE_BUDGET));
  check(`every class sums to ${EXPLORATION_CLASS_BUDGET}`, Object.values(classSums).every(s => s === EXPLORATION_CLASS_BUDGET));
  check('the same six races and classes as the combat tables',
    same(Object.keys(RACE_EXPLORATION).sort(), Object.keys(RACE_BONUSES).sort()) &&
    same(Object.keys(CLASS_EXPLORATION).sort(), Object.keys(CLASS_BONUSES).sort()));
  const allRatings = [...Object.values(RACE_EXPLORATION), ...Object.values(CLASS_EXPLORATION).map(c => c.ratings)];
  check('every rating key is a real stat, and none is negative',
    allRatings.every(o => Object.entries(o).every(([k, v]) => EXPLORATION_STATS.includes(k) && Number.isInteger(v) && v >= 0)));
  check('every class passive exists',
    Object.values(CLASS_EXPLORATION).every(c => c.passives.every(id => EXPLORATION_PASSIVES[id])));
  check('every passive belongs to exactly one class',
    Object.keys(EXPLORATION_PASSIVES).every(id => Object.values(CLASS_EXPLORATION).filter(c => c.passives.includes(id)).length === 1));
  check('every passive writes only fields that name a reader (PASSIVE_FIELDS)',
    Object.values(EXPLORATION_PASSIVES).every(p => Object.keys(p.effect).every(f => PASSIVE_FIELDS[f])));
  check('every PASSIVE_FIELDS entry is written by some passive (no dead field)',
    Object.keys(PASSIVE_FIELDS).every(f => Object.values(EXPLORATION_PASSIVES).some(p => f in p.effect)));
  golden.pickLevels = EXPLORATION_PICK_LEVELS;
  golden.ratingPick = EXPLORATION_RATING_PICK;
  golden.passives = EXPLORATION_PASSIVES;
  check('pick levels are 2/4/6/8/10 (owner, 2026-09-19)', same(EXPLORATION_PICK_LEVELS, [2, 4, 6, 8, 10]));
}

// =============================================================================
console.log('=== all 36 starting profiles (hunterExploration) ===');
{
  const profiles = {};
  let allOnBudget = true;
  for (const race of Object.keys(RACE_EXPLORATION)) {
    for (const baseClass of Object.keys(CLASS_EXPLORATION)) {
      const e = hunterExploration({ race, baseClass, level: 1 });
      profiles[`${race} ${baseClass}`] = e.ratings;
      const total = Object.values(e.ratings).reduce((t, v) => t + v, 0);
      if (total !== EXPLORATION_RACE_BUDGET + EXPLORATION_CLASS_BUDGET) allOnBudget = false;
    }
  }
  golden.startingProfiles = profiles;
  check('every pairing starts on exactly the same total', allOnBudget);
  const bestPer = {};
  for (const s of EXPLORATION_STATS) {
    const [who, r] = Object.entries(profiles).reduce((a, b) => (b[1][s] > a[1][s] ? b : a));
    bestPer[s] = `${who} ${r[s]}`;
  }
  golden.bestStartingPerStat = bestPer;
  console.log('    best start per stat: ' + JSON.stringify(bestPer));
  check('an unknown race/class gives zeros, not a crash',
    Object.values(hunterExploration({ race: 'Nope', baseClass: 'Nope' }).ratings).every(v => v === 0));
}

// =============================================================================
console.log('=== conversion curves ===');
{
  golden.curves = {};
  for (const [id, c] of Object.entries(RATING_CURVES)) {
    const row = Object.fromEntries(RATINGS.map(r => [r, r4(ratingToPercent(id, r))]));
    golden.curves[id] = { ...c, at: row };
    console.log(`    ${id.padEnd(17)} (${c.stat}) ` + RATINGS.map(r => `${r}:${row[r]}`).join(' '));
    const vals = RATINGS.map(r => ratingToPercent(id, r));
    const gains = vals.slice(1).map((v, i) => (v - vals[i]) / (RATINGS[i + 1] - RATINGS[i]));
    check(`${id}: 0 at 0, rising, diminishing, under its ceiling of ${c.ceiling}`,
      vals[0] === 0 && vals.every((v, i) => i === 0 || v > vals[i - 1]) &&
      gains.every((g, i) => i === 0 || g < gains[i - 1]) && vals.every(v => v < c.ceiling));
  }
  check('negative or missing ratings convert to 0', ratingToPercent('supplyEfficiency', -20) === 0 && ratingToPercent('supplyEfficiency', undefined) === 0);

  const soft = Object.fromEntries([0, 10, 25, 50, 100, 200, 300, 600].map(g => [g, r4(softenGearRarity(g))]));
  golden.gearRaritySoften = soft;
  console.log('    gear rarity pool -> softened ' + JSON.stringify(soft));
  check('gear pool: 100 softens to 50 (the Resilience shape), always below the raw pool and below 100',
    soft[100] === 50 && [10, 25, 50, 100, 200, 300, 600].every(g => soft[g] < g && soft[g] < 100));
}

// =============================================================================
console.log('=== hunt drop rarity (the new curve) ===');
{
  const IR = [0, 5, 10, 25, 50, 83, 100, 150, 200, 500, 5000];
  const odds = Object.fromEntries(IR.map(x => [x, Object.fromEntries(Object.entries(huntDropOdds(x)).map(([k, v]) => [k, r4(v)]))]));
  golden.dropOdds = odds;
  for (const x of IR) console.log(`    IR ${String(x).padStart(4)}  uncommon ${odds[x].uncommon}  rare ${odds[x].rare}  epic ${odds[x].epic}`);
  check('at 0 the odds are the old 55/33/12', same(odds[0], DROP_BASE_ODDS));
  check('odds always sum to 100', IR.every(x => Math.abs(odds[x].uncommon + odds[x].rare + odds[x].epic - 100) < 1e-9));
  const ceiling = { uncommon: DROP_BASE_ODDS.uncommon - DROP_MAX_SHIFT, rare: DROP_BASE_ODDS.rare + DROP_MAX_SHIFT * 0.6, epic: DROP_BASE_ODDS.epic + DROP_MAX_SHIFT * 0.4 };
  check('never past the old ceiling (5 / 63 / 32), even at 5000',
    IR.every(x => odds[x].uncommon > ceiling.uncommon && odds[x].epic < ceiling.epic), JSON.stringify(ceiling));
  check('epic rises and uncommon falls with every step', IR.slice(1).every((x, i) => odds[x].epic > odds[IR[i]].epic && odds[x].uncommon < odds[IR[i]].uncommon));
  const epicGain = IR.slice(1, 8).map((x, i) => (odds[x].epic - odds[IR[i]].epic) / (x - IR[i]));
  check('diminishing: each Item Rarity point is worth less than the one before', epicGain.every((g, i) => i === 0 || g < epicGain[i - 1]));
  check('negative Item Rarity is treated as 0', same(huntDropOdds(-40), huntDropOdds(0)));

  // One draw per roll, so a seeded stream stays in step with the old function.
  let draws = 0;
  const counting = () => { draws++; return 0.5; };
  for (let i = 0; i < 100; i++) rollHuntDropRarity(i, counting);
  check('exactly one rng draw per roll', draws === 100, `${draws} draws for 100 rolls`);

  // Seeded rolls land on the odds.
  const measured = {};
  for (const x of [0, 25, 100]) {
    const rng = makeRng(20260919 + x);
    const n = 100000, tally = { uncommon: 0, rare: 0, epic: 0 };
    for (let i = 0; i < n; i++) tally[rollHuntDropRarity(x, rng)]++;
    measured[x] = Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, +(v / n * 100).toFixed(2)]));
  }
  golden.dropRollsSeeded = measured;
  console.log('    100,000 seeded rolls: ' + JSON.stringify(measured));
  check('seeded rolls land within 0.5 points of the odds',
    Object.entries(measured).every(([x, m]) => Object.keys(m).every(k => Math.abs(m[k] - huntDropOdds(+x)[k]) < 0.5)));
}

// =============================================================================
console.log('=== CombatScene uses this function ===');
{
  const src = fs.readFileSync(new URL('../../src/scenes/CombatScene.js', import.meta.url), 'utf8');
  check('CombatScene imports rollHuntDropRarity from PartyStats.js',
    /import \{ rollHuntDropRarity \} from '\.\.\/systems\/PartyStats\.js'/.test(src));
  check('...and no longer defines its own', !/function rollHuntDropRarity\s*\(/.test(src));
}

// =============================================================================
console.log('=== level-up picks ===');
{
  const [h] = makeParty();          // Bran, Dwarf Grunt
  h.level = 1; delete h.exploration;
  check('level 1: nothing owed', owedExplorationPicks(h).length === 0);
  h.level = 5;
  check('level 5: picks owed at 2 and 4', same(owedExplorationPicks(h), [2, 4]));
  check('a pick not owed is refused', !applyExplorationPick(h, 6, { rating: 'endurance' }).ok);
  check('a rating that is not a stat is refused', !applyExplorationPick(h, 2, { rating: 'charm' }).ok);
  check('another class\'s passive is refused', !applyExplorationPick(h, 2, { passive: 'far_sight' }).ok);
  const before = hunterExploration(h).ratings.endurance;
  check('+10 Endurance at level 2 is accepted', applyExplorationPick(h, 2, { rating: 'endurance' }).ok);
  check('...and adds exactly EXPLORATION_RATING_PICK', hunterExploration(h).ratings.endurance === before + EXPLORATION_RATING_PICK);
  check('the same level cannot be picked twice', !applyExplorationPick(h, 2, { rating: 'cooking' }).ok);
  check('Pack Mule at level 4 is accepted', applyExplorationPick(h, 4, { passive: 'pack_mule' }).ok);
  h.level = 6;
  check('a taken passive is no longer offered', !explorationPickOptions(h, 6).passives.includes('pack_mule'));
  check('...and is refused if asked for again', !applyExplorationPick(h, 6, { passive: 'pack_mule' }).ok);
  check('hunterExploration lists the passive', same(hunterExploration(h).passives, ['pack_mule']));

  const [, , , , ilse] = makeParty();   // Ferrow Shepherd
  check('fixture: the fifth hunter is a Shepherd', ilse.baseClass === 'Shepherd', ilse.baseClass);
  ilse.level = 4; delete ilse.exploration;
  check('Far Sight (minLevel 6) is not offered at level 4', !explorationPickOptions(ilse, 4).passives.includes('far_sight'));
  check('...and is refused there', !applyExplorationPick(ilse, 4, { passive: 'far_sight' }).ok);
  ilse.level = 6;
  check('...but is offered and accepted at level 6', explorationPickOptions(ilse, 6).passives.includes('far_sight') &&
    applyExplorationPick(ilse, 6, { passive: 'far_sight' }).ok);
  check('owed after that: 2 and 4 (missed picks stay owed)', same(owedExplorationPicks(ilse), [2, 4]));

  // A pick recorded above a hunter's level (a hand-edited or co-op save) does nothing.
  const odd = { race: 'Human', baseClass: 'Scholar', level: 3, exploration: { picks: { 8: { rating: 'fishing' }, 3: { rating: 'fishing' } } } };
  check('picks above the hunter\'s level, or at a non-pick level, are ignored',
    hunterExploration(odd).ratings.fishing === hunterExploration({ race: 'Human', baseClass: 'Scholar' }).ratings.fishing);

  // Real save / load.
  const party = makeParty();
  party[0].level = 5; party[0].exploration = { picks: { 2: { rating: 'endurance' }, 4: { passive: 'pack_mule' } } };
  GameState.characters = party;
  GameState.party = party;
  const beforeSave = hunterExploration(party[0]);
  GameState.save('partystats_rt');
  GameState.load('partystats_rt');
  const loaded = GameState.characters.find(c => c.name === party[0].name);
  check('picks survive a real GameState save and load',
    same(loaded?.exploration, party[0].exploration) && same(hunterExploration(loaded), beforeSave));
  const oldSave = makeParty()[0]; oldSave.level = 9; delete oldSave.exploration;
  check('a level-9 hunter from an old save is owed 2/4/6/8', same(owedExplorationPicks(oldSave), [2, 4, 6, 8]));
}

// =============================================================================
console.log('=== partyStats ===');
{
  const party = makeParty();
  party.forEach(c => { c.level = 1; delete c.exploration; });
  const ps = partyStats(party, {});
  const each = party.map(c => ({ name: c.name, race: c.race, cls: c.baseClass, ...hunterExploration(c).ratings }));
  golden.fixtureParty = each;
  golden.fixturePartyStats = Object.fromEntries(Object.entries(ps).map(([k, v]) => [k, typeof v === 'number' ? r4(v) : v]));
  console.log('    ' + JSON.stringify(golden.fixturePartyStats));

  for (const s of ['perception', 'cooking', 'fishing', 'foraging']) {
    const top = Math.max(...each.map(e => e[s]));
    const provider = each.find(e => e[s] === top).name;
    check(`${s}: the best hunter's rating, provided by ${provider}`, ps.ratings[s] === top && ps.providers[s] === provider);
  }
  for (const s of ['endurance', 'speed']) {
    check(`${s}: the party average`, Math.abs(ps.ratings[s] - each.reduce((t, e) => t + e[s], 0) / each.length) < 1e-9);
  }
  check('conversions are the curve of the aggregate',
    ps.supplyEfficiencyPercent === ratingToPercent('supplyEfficiency', ps.ratings.endurance) &&
    ps.travelTimePercent === ratingToPercent('travelTime', ps.ratings.speed) &&
    ps.forageYieldPercent === ratingToPercent('forageYield', ps.ratings.foraging) &&
    ps.fishYieldPercent === ratingToPercent('fishYield', ps.ratings.fishing));
  const inits = party.map(c => computeEffectiveInitiative(c));
  check('party initiative is the average of the real computeEffectiveInitiative',
    Math.abs(ps.partyInitiative - inits.reduce((t, v) => t + v, 0) / inits.length) < 1e-9, `members ${inits.join('/')}`);

  // Size-neutral: three hunters, and the same three twice over.
  const three = makeParty().slice(0, 3);
  const six = [...makeParty().slice(0, 3), ...makeParty().slice(0, 3)];
  const mods = { supplyEfficiencyPercent: 10, travelTimePercent: 5, perceptionBonus: 7, partyInitiativeBonus: 4, lootQualityPercent: 20, harvestYieldPercent: 8 };
  const a = partyStats(three, mods), b = partyStats(six, mods), bare = partyStats(three, {});
  check('size-neutral: 3 hunters and the same 3 doubled give identical stats',
    ['perception', 'speed', 'partyInitiative', 'supplyEfficiencyPercent', 'travelTimePercent', 'itemRarity'].every(k => a[k] === b[k]));
  const deltas = {
    supplyEfficiencyPercent: a.supplyEfficiencyPercent - bare.supplyEfficiencyPercent,
    travelTimePercent: a.travelTimePercent - bare.travelTimePercent,
    perception: a.perception - bare.perception,
    partyInitiative: a.partyInitiative - bare.partyInitiative,
    itemRarity: a.itemRarity - bare.itemRarity,
    forageYieldPercent: a.forageYieldPercent - bare.forageYieldPercent,
  };
  const want = { supplyEfficiencyPercent: 10, travelTimePercent: 5, perception: 7, partyInitiative: 4, itemRarity: 20, forageYieldPercent: 8 };
  check('flat mods land after aggregation, at full value',
    Object.keys(want).every(k => Math.abs(deltas[k] - want[k]) < 1e-9), JSON.stringify(Object.fromEntries(Object.entries(deltas).map(([k, v]) => [k, r4(v)]))));

  // The dead are left out.
  const withDead = makeParty();
  const bestP = partyStats(withDead).providers.perception;
  withDead.find(c => c.name === bestP).status = 'dead';
  const pd = partyStats(withDead);
  check('a dead hunter provides nothing and is not averaged', pd.size === withDead.length - 1 && pd.providers.perception !== bestP,
    `${bestP} dead -> ${pd.providers.perception}`);
  check('an empty party gives zeros, not NaN', Object.values(partyStats([])).every(v => typeof v !== 'number' || v === 0));

  // Passives: each once per party.
  const sheps = makeParty().slice(0, 2);
  sheps.forEach(c => { c.baseClass = 'Shepherd'; c.level = 6; c.exploration = { picks: { 6: { passive: 'far_sight' } } }; });
  const shepStats = partyStats(sheps);
  check('two hunters with Far Sight give +1 sight, not +2', shepStats.passives.sightRangeBonus === 1);
  const song = makeParty().slice(0, 2);
  song[0].baseClass = 'Performer'; song[0].level = 2; song[0].exploration = { picks: { 2: { passive: 'rallying_song' } } };
  const songLess = makeParty().slice(0, 2); songLess[0].baseClass = 'Performer';
  check('Rallying Song adds +5 party initiative after the average',
    partyStats(song).partyInitiative - partyStats(songLess).partyInitiative === 5);

  // Item Rarity: gear pool softened, party pool straight.
  const gear = makeParty();
  gear.forEach(c => { c.gearEffects = { ...(c.gearEffects || {}), itemRarityPercent: 20 }; });
  const g = partyStats(gear, { lootQualityPercent: 15 });
  check('item rarity = softened gear pool + the party pool added straight',
    g.gearRarityPool === 20 * gear.length && g.itemRarity === softenGearRarity(20 * gear.length) + 15, `${r4(g.itemRarity)}`);
  golden.itemRarityExample = { hunters: gear.length, gearEach: 20, partyPool: 15, itemRarity: r4(g.itemRarity) };
  check('every partyStats output that feeds a later chunk names its reader',
    Object.keys(PARTY_STAT_OUTPUTS).every(k => k in ps));
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
  check('party stats tables identical to the golden', changed.length === 0,
    changed.length ? `changed: ${changed.join(', ')}` : `${keys.size} tables`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
