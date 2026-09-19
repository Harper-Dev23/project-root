// src/systems/PartyStats.js
// The party stats model (Exploration System v2, chunk 6). Design: the vault's
// PARTY_STATS.md. Pure functions over data: no Phaser, no GameState, no
// randomness except the rng a caller hands rollHuntDropRarity.
//
//   hunterExploration(char)   one hunter's six ratings: race + class + picks
//   partyStats(party, mods)   the party's eight stats: best-of / average /
//                             pooled, then each stat's conversion
//
// Two shapes of stat (PARTY_STATS, "How each rating maps to its job"):
//   - CONTEST stats are compared against a number in the world on the same
//     scale, linear, no curve: Perception (vs concealment), Cooking (vs a dish's
//     difficulty), Speed for pursuit (vs a pack's speed).
//   - EFFICIENCY stats go through a diminishing curve so they never reach
//     "free": Endurance, Speed (time), Foraging, Fishing.
//
// Every curve is the Resilience shape, x / (x + K) (CombatScene's buildup
// mitigation), so the game has one diminishing-returns pattern. All ceilings
// and K values are placeholders until chunk 13. tools/headless/partystats.mjs
// snapshots every curve by calling these exports; never re-derive one to check it.
//
// Not wired into the hunt yet: chunk 6 is logic only. Each output names its
// reader in PARTY_STAT_OUTPUTS below.

import {
  EXPLORATION_STATS, RACE_EXPLORATION, CLASS_EXPLORATION,
  EXPLORATION_PICK_LEVELS, EXPLORATION_RATING_PICK, EXPLORATION_PASSIVES,
} from './CharacterBuilder.js';
import { computeEffectiveInitiative } from './CombatLogic.js';

// ── Curves ──────────────────────────────────────────────────────────────────

/** ceiling × r / (r + k). 0 at 0, half the ceiling at r = k, never reaches it. */
export function diminishing(rating, ceiling, k) {
  const r = Math.max(0, Number(rating) || 0);
  return ceiling * r / (r + k);
}

/** Each efficiency conversion: rating → percent. K 50 means a rating of 100 gets 2/3 of the ceiling. */
export const RATING_CURVES = {
  supplyEfficiency: { stat: 'endurance', ceiling: 40, k: 50 },  // % supplies saved per move
  travelTime:       { stat: 'speed',     ceiling: 40, k: 50 },  // % time saved per move
  forageYield:      { stat: 'foraging',  ceiling: 50, k: 50 },  // % more forage and harvest yield
  harvestTime:      { stat: 'foraging',  ceiling: 40, k: 50 },  // % less time to harvest
  fishYield:        { stat: 'fishing',   ceiling: 50, k: 50 },  // % more fish
};

export function ratingToPercent(curveId, rating) {
  const c = RATING_CURVES[curveId];
  if (!c) throw new Error(`unknown rating curve: ${curveId}`);
  return diminishing(rating, c.ceiling, c.k);
}

/**
 * The gear rarity pool is softened because it is the pool that grows with party
 * size (six hunters wear six rings). Same shape as Resilience, 100 → 50%:
 * 100 × G / (G + 100). Party-wide sources are NOT softened.
 */
export const GEAR_RARITY_SOFTEN_K = 100;
export function softenGearRarity(gearPool) {
  return diminishing(gearPool, GEAR_RARITY_SOFTEN_K, GEAR_RARITY_SOFTEN_K);
}

// ── Hunt drop rarity ────────────────────────────────────────────────────────
// Moved here from CombatScene (chunk 6), which imports it: the curve is party
// stats' Item Rarity conversion, and the harness can snapshot it without a
// fight. Base odds 55 / 33 / 12 (uncommon / rare / epic), the same spread as
// training drops. Item Rarity shifts weight out of uncommon, 60% of it to rare
// and 40% to epic.
//
// The shift used to be a straight line to a hard cap (0.6 per point, maxed at
// 50 from Item Rarity 83). Now it is diminishing toward the SAME ceiling, so
// early points matter most, stacking stays worthwhile but bounded, and the
// hardest beasts don't arrive in a sudden jump (owner, 2026-09-18). At 0 the
// odds are unchanged.
export const DROP_BASE_ODDS = { uncommon: 55, rare: 33, epic: 12 };
export const DROP_MAX_SHIFT = 50;
export const DROP_SHIFT_K = 50;

/** The odds table for an Item Rarity value, in percent. */
export function huntDropOdds(itemRarity = 0) {
  const shift = diminishing(itemRarity, DROP_MAX_SHIFT, DROP_SHIFT_K);
  return {
    uncommon: DROP_BASE_ODDS.uncommon - shift,
    rare: DROP_BASE_ODDS.rare + shift * 0.6,
    epic: DROP_BASE_ODDS.epic + shift * 0.4,
  };
}

/** One draw from `rng`, exactly as before the move, so a seeded stream is unchanged. */
export function rollHuntDropRarity(itemRarity = 0, rng = Math.random) {
  const odds = huntDropOdds(itemRarity);
  const r = rng() * 100;
  if (r < odds.uncommon) return 'uncommon';
  if (r < odds.uncommon + odds.rare) return 'rare';
  return 'epic';
}

// ── One hunter ──────────────────────────────────────────────────────────────

function picksOf(char) {
  return char?.exploration?.picks || {};
}

/**
 * A hunter's ratings and passives. Race and class come from data, never stored,
 * so every existing hunter has them; only chosen picks are saved.
 *
 * There is no gear term: nothing on gear writes an exploration rating yet. It
 * gets added with the first affix that does.
 */
export function hunterExploration(char) {
  const race = RACE_EXPLORATION[char?.race] || {};
  const cls = CLASS_EXPLORATION[char?.baseClass] || { ratings: {} };
  const ratings = {};
  const sources = {};
  for (const s of EXPLORATION_STATS) {
    const fromRace = race[s] || 0;
    const fromClass = cls.ratings[s] || 0;
    ratings[s] = fromRace + fromClass;
    sources[s] = { race: fromRace, class: fromClass, picks: 0 };
  }
  const passives = [];
  for (const [level, pick] of Object.entries(picksOf(char))) {
    if (!EXPLORATION_PICK_LEVELS.includes(+level) || +level > (char.level || 1)) continue;
    if (pick?.rating && EXPLORATION_STATS.includes(pick.rating)) {
      ratings[pick.rating] += EXPLORATION_RATING_PICK;
      sources[pick.rating].picks += EXPLORATION_RATING_PICK;
    } else if (pick?.passive && cls.passives?.includes(pick.passive) && !passives.includes(pick.passive)) {
      passives.push(pick.passive);
    }
  }
  return { ratings, passives, sources };
}

/** Pick levels this hunter has reached but not chosen for. Old saves' missed picks show up here. */
export function owedExplorationPicks(char) {
  const picks = picksOf(char);
  return EXPLORATION_PICK_LEVELS.filter(l => l <= (char?.level || 1) && !picks[l]);
}

/** What a pick at `level` may choose: any rating, or a class passive not yet taken whose minLevel is met. */
export function explorationPickOptions(char, level) {
  const taken = new Set(Object.values(picksOf(char)).map(p => p?.passive).filter(Boolean));
  const own = CLASS_EXPLORATION[char?.baseClass]?.passives || [];
  return {
    ratings: [...EXPLORATION_STATS],
    passives: own.filter(id => !taken.has(id) && (EXPLORATION_PASSIVES[id]?.minLevel || 0) <= level),
  };
}

/**
 * Records a pick: choice is { rating: 'perception' } or { passive: 'far_sight' }.
 * Refuses anything the options wouldn't offer. Returns { ok, reason? }.
 * Writer of character.exploration.picks; reader: hunterExploration.
 */
export function applyExplorationPick(char, level, choice) {
  if (!owedExplorationPicks(char).includes(level)) return { ok: false, reason: `no pick owed at level ${level}` };
  const opts = explorationPickOptions(char, level);
  let pick;
  if (choice?.rating && opts.ratings.includes(choice.rating)) pick = { rating: choice.rating };
  else if (choice?.passive && opts.passives.includes(choice.passive)) pick = { passive: choice.passive };
  else return { ok: false, reason: 'not an option for this pick' };
  char.exploration = char.exploration || {};
  char.exploration.picks = { ...(char.exploration.picks || {}), [level]: pick };
  return { ok: true };
}

// ── The party ───────────────────────────────────────────────────────────────

/**
 * Every field partyStats hands on, and what reads it. Only the Item Rarity
 * conversion has a reader today, and the hunt still passes it the raw
 * lootQualityPercent (the gear pool is always 0 until a gear affix writes it);
 * chunk 9 passes partyStats().itemRarity instead.
 */
export const PARTY_STAT_OUTPUTS = {
  perception:              'HuntRules.occupantBand (Detection, via HuntEngine): compared against occupantConcealment',
  cooking:                 'HuntRules.cookDish (camp, via HuntEngine.camp): compared against a dish difficulty',
  speed:                   'HuntWorld.trailLostTime (via HuntEngine): pursuit, against PACK_SPEED',
  partyInitiative:         'HuntWorld.makeEncounter / whoActsFirst (the encounter trigger); chunk 9 turn order',
  supplyEfficiencyPercent: 'HuntRules.moveCost (via HuntEngine.move): supplies per move',
  travelTimePercent:       'HuntRules.moveCost (via HuntEngine.move): time per move',
  forageYieldPercent:      'HuntRules.gatherQty (HuntEngine.forage); chunk 9 harvest yield',
  harvestTimePercent:      'chunk 9 harvest step',
  fishYieldPercent:        'HuntRules.gatherQty (HuntEngine.fish)',
  itemRarity:              'rollHuntDropRarity (chunk 9 swaps it in for the raw lootQualityPercent)',
};

/** The hunt-bundle fields a passive can write, and their readers — all read in chunk 7. */
export const PASSIVE_FIELDS = {
  sightRangeBonus:      'HuntRules.sightRange (Sight, via HuntEngine)',
  packRationsBonus:     'HuntRules.rationPackCap, read by the Hunt screen (HuntHubOverlay)',
  campConcealmentBonus: 'HuntEngine.camp: the found-in-camp check (HuntWorld.packFindsCamp)',
  campRecoveryPercent:  'HuntRules.campRecoveryPercent (HuntEngine.camp): HP and MP recovered',
  exactRoster:          'HuntEngine.occupantViewOf: what an identified pack shows',
  partyInitiativeBonus: 'partyStats itself: added after the initiative average',
};

const BEST_OF = ['perception', 'cooking', 'fishing', 'foraging'];
const AVERAGED = ['endurance', 'speed'];

/** A hunter counts toward party stats unless dead. */
function contributes(char) {
  return char && char.status !== 'dead';
}

/**
 * The party's stats. `mods` is the hunt modifier bundle (zone + weather + plan,
 * later boons, hunger and food); every mod is applied AFTER aggregation, so a
 * flat bonus is never scaled by party size (PARTY_STATS, Party Initiative).
 *
 * Aggregation (owner, 2026-09-17): best of the party for Perception, Cooking,
 * Fishing, Foraging; average for Endurance, Speed and Party Initiative; Item
 * Rarity pooled — gear pool softened, party pool added straight.
 */
export function partyStats(party, mods = {}) {
  const members = (party || []).filter(contributes);
  const hunters = members.map(c => ({ char: c, ...hunterExploration(c) }));
  const n = hunters.length;

  const best = {}, providers = {};
  for (const s of BEST_OF) {
    let top = null;
    for (const h of hunters) if (!top || h.ratings[s] > top.ratings[s]) top = h;
    best[s] = top ? top.ratings[s] : 0;
    providers[s] = top ? (top.char.name ?? top.char.id ?? null) : null;
  }
  const avg = {};
  for (const s of AVERAGED) avg[s] = n ? hunters.reduce((t, h) => t + h.ratings[s], 0) / n : 0;

  // Passives: summed across the party, each passive once.
  const passiveIds = [...new Set(hunters.flatMap(h => h.passives))];
  const passives = Object.fromEntries(Object.keys(PASSIVE_FIELDS).map(f => [f, 0]));
  for (const id of passiveIds) {
    for (const [f, v] of Object.entries(EXPLORATION_PASSIVES[id]?.effect || {})) passives[f] += v;
  }

  const initiativeAvg = n ? members.reduce((t, c) => t + computeEffectiveInitiative(c), 0) / n : 0;

  // NO WRITER YET: no gear affix sets gearEffects.itemRarityPercent (the
  // jewelry rarity affix is deferred, owner 2026-09-19 — adding it to the pools
  // changes every jewelry roll). Until it exists this pool is always 0.
  const gearPool = members.reduce((t, c) => t + (c.gearEffects?.itemRarityPercent || 0), 0);
  const partyPool = mods.lootQualityPercent || 0;

  return {
    size: n,
    ratings: { ...best, ...avg },
    providers,
    // Contest stats
    perception: best.perception + (mods.perceptionBonus || 0),
    cooking: best.cooking,
    speed: avg.speed,
    partyInitiative: initiativeAvg + passives.partyInitiativeBonus + (mods.partyInitiativeBonus || 0),
    // Efficiency stats: curve first, the plan's own value added straight after
    supplyEfficiencyPercent: ratingToPercent('supplyEfficiency', avg.endurance) + (mods.supplyEfficiencyPercent || 0),
    travelTimePercent: ratingToPercent('travelTime', avg.speed) + (mods.travelTimePercent || 0),
    forageYieldPercent: ratingToPercent('forageYield', best.foraging) + (mods.harvestYieldPercent || 0),
    harvestTimePercent: ratingToPercent('harvestTime', best.foraging),
    fishYieldPercent: ratingToPercent('fishYield', best.fishing),
    // Item Rarity
    gearRarityPool: gearPool,
    itemRarity: softenGearRarity(gearPool) + partyPool,
    passiveIds,
    passives,
  };
}
