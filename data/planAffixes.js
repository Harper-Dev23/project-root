// data/planAffixes.js
// Hunt Plans v2 (Exploration System v2, chunk 4). The design lives in the
// vault: HUNT_PLANS.md (base tiers, implicits, the basic plan) and
// PLAN_AFFIXES.md (the families and the bonus objectives).
//
// Plain data. ItemFactory builds the actual affix pools from it, so the rules
// for rolling (item-level gate, weights, one affix per family) are the same
// ones gear uses and live in one place.
//
// ── The shape ───────────────────────────────────────────────────────────────
// Prefixes are the hunt's DEMANDS: harder land, or a bonus objective. Every
// prefix tier also raises the completion reward.
// Suffixes are the party's EDGE: supplies, travel, sight, loot. The help is the
// reward; they pay nothing extra.
//
// Every family has all five tiers (T5 weakest ... T1 strongest), so a plan of
// any item level has something to roll (the 2026-09-17 measurement: with only
// T1-T3 affixes, every plan below item level 3 rolled nothing).
//
// ── Every field names its reader ────────────────────────────────────────────
// `reader` says what consumes a field. Where that system is a later chunk the
// field is `live: false`, and HuntModifiers shows it as "(no effect yet)"
// rather than letting it quietly do nothing. All numbers are placeholders
// until chunk 13 (tuning).

/** Plan base tier comes from item level, never rolled (HUNT_PLANS, Fix A). */
export const PLAN_TIER_BANDS = [
  { tier: 1, minItemLevel: 1, maxItemLevel: 4 },
  { tier: 2, minItemLevel: 5, maxItemLevel: 7 },
  { tier: 3, minItemLevel: 8, maxItemLevel: 10 },
];

/**
 * Each tier's implicit: on every plan of that tier, whatever its affixes roll.
 * Reward-side only; a plan never makes a hunt harder through its tier.
 * Reader of completionRewardPercent: the completion reward at a clean exit
 * (HuntObjectives.exitReward). Reader of bonusObjective: ItemFactory, which rolls it at creation.
 */
export const PLAN_TIER_IMPLICITS = {
  1: { completionRewardPercent: 0,  bonusObjective: false },
  2: { completionRewardPercent: 10, bonusObjective: false },
  3: { completionRewardPercent: 20, bonusObjective: true },
};

/** Completion reward each prefix adds, by its tier. */
export const PREFIX_COMPLETION_REWARD = { 5: 4, 4: 6, 3: 9, 2: 12, 1: 15 };

/**
 * Every field a plan affix can write, what reads it, and whether that reader
 * exists yet. HuntModifiers labels these; the plans harness checks that every
 * family writes a field listed here.
 */
export const PLAN_FIELDS = {
  // Live: read by hunts on the hex map (chunk 8c: every new hunt is a map hunt)
  encounterChancePercent: { label: "Encounter Chance", unit: "%", live: true,
    reader: "HuntMapGen: pack density on the map (the old Advance roll still reads it for hunts saved before chunk 8c)" },
  foulWeatherPercent: { label: "Harsher Weather", unit: "%", live: true,
    reader: "rollWeather (data/weather.js), first draw of createMapHunt: takes this share of Clear Skies' weight" },
  supplyEfficiencyPercent: { label: "Travel Efficiency", unit: "%", live: true,
    reader: "partyStats adds it after the Endurance curve; HuntRules.moveCost (HuntEngine.move): supplies per move" },
  provisionRations: { label: "Rations in the Pack", unit: "", live: true,
    reader: "packAtDeparture (createMapHunt): added to the hunt pack as Rations at departure" },
  gradeShiftPercent: { label: "Elder Beasts", unit: "%", live: true,
    reader: "HuntMapGen: grade weights toward Prime and Great" },
  restlessPercent: { label: "Restless Packs", unit: "%", live: true,
    reader: "HuntWorld.initWorld at departure: that share of Rooted packs Roaming" },
  leanCountryPercent: { label: "Fewer Forage Spots", unit: "%", live: true,
    reader: "HuntMapGen: forage and fishing spots" },
  blightPatches: { label: "Blight Patches", unit: "", live: true,
    reader: "HuntMapGen: blight placement" },
  travelTimePercent: { label: "Travel Time Saved", unit: "%", live: true,
    reader: "partyStats adds it after the Speed curve; HuntRules.moveCost (HuntEngine.move): time per move" },
  perceptionBonus: { label: "Perception", unit: "", live: true,
    reader: "partyStats adds it after best-of; Detection (HuntRules.occupantBand, via HuntEngine)" },
  harvestYieldPercent: { label: "Harvest & Forage Yield", unit: "%", live: true,
    reader: "partyStats adds it to forageYieldPercent, read by HuntEngine.forage; chunk 9 harvest" },
  completionRewardPercent: { label: "Completion Reward", unit: "%", live: true,
    reader: "HuntObjectives.completionRewardPercent -> exitReward, paid at a clean exit" },
  // Fight rewards: live again since fights run on the map (chunk 9b). They were
  // set not-live in 8c, when the map had no fights to read them.
  lootQualityPercent: { label: "Loot Quality", unit: "%", live: true,
    reader: "partyStats().itemRarity -> HuntBeasts.rollLoadout (a map occupant's part and gear rarity, rolled on scout or contact); the old Advance hunt still reads it" },
  huntPointsPercent: { label: "Hunt Points", unit: "%", live: true,
    reader: "HuntEngine.winEncounter: a won beast fight's Hunt Points; the old Advance hunt still reads it. Does not scale the completion reward (chunk 7d)" },
  xpPercent: { label: "Experience Gained", unit: "%", live: true,
    reader: "HuntEngine.fightSpec -> the fight's xpPool, paid by CombatScene._calculateXPReward; the old Advance hunt still reads it" },
};

// tiers: { tier: [min, max] }, T5 weakest.
export const PLAN_PREFIX_FAMILIES = [
  { id: 'teeming',       label: 'Teeming',       field: 'encounterChancePercent',
    tiers: { 5: [3, 5], 4: [6, 8], 3: [9, 12], 2: [13, 16], 1: [17, 20] } },
  { id: 'elder_grounds', label: 'Elder Grounds', field: 'gradeShiftPercent',
    tiers: { 5: [5, 8], 4: [9, 12], 3: [13, 17], 2: [18, 23], 1: [24, 30] } },
  { id: 'restless',      label: 'Restless',      field: 'restlessPercent',
    tiers: { 5: [5, 8], 4: [9, 12], 3: [13, 17], 2: [18, 23], 1: [24, 30] } },
  { id: 'lean_country',  label: 'Lean Country',  field: 'leanCountryPercent',
    tiers: { 5: [10, 15], 4: [16, 22], 3: [23, 30], 2: [31, 40], 1: [41, 50] } },
  { id: 'blighted',      label: 'Blighted',      field: 'blightPatches',
    tiers: { 5: [1, 1], 4: [1, 2], 3: [2, 3], 2: [3, 4], 1: [4, 5] } },
  { id: 'foul_weather',  label: 'Foul Weather',  field: 'foulWeatherPercent',
    tiers: { 5: [15, 25], 4: [26, 40], 3: [41, 55], 2: [56, 70], 1: [71, 85] } },
];

export const PLAN_SUFFIX_FAMILIES = [
  { id: 'plenty',        label: 'of Plenty',       field: 'lootQualityPercent',
    tiers: { 5: [4, 6], 4: [7, 10], 3: [11, 15], 2: [16, 20], 1: [21, 25] } },
  { id: 'swift_travel',  label: 'of Swift Travel', field: 'supplyEfficiencyPercent',
    tiers: { 5: [3, 5], 4: [6, 8], 3: [9, 12], 2: [13, 16], 1: [17, 20] } },
  { id: 'trail',         label: 'of the Trail',    field: 'travelTimePercent',
    tiers: { 5: [3, 5], 4: [6, 8], 3: [9, 12], 2: [13, 16], 1: [17, 20] } },
  { id: 'keen_eyes',     label: 'of Keen Eyes',    field: 'perceptionBonus',
    tiers: { 5: [2, 3], 4: [4, 6], 3: [7, 10], 2: [11, 15], 1: [16, 20] } },
  { id: 'provision',     label: 'of Provision',    field: 'provisionRations',
    tiers: { 5: [5, 10], 4: [11, 20], 3: [21, 30], 2: [31, 40], 1: [41, 50] } },
  { id: 'harvest',       label: 'of the Harvest',  field: 'harvestYieldPercent',
    tiers: { 5: [5, 8], 4: [9, 12], 3: [13, 18], 2: [19, 26], 1: [27, 35] } },
  // Kept provisionally (owner, 2026-09-18): drop either if it distorts the
  // economy or the levelling pace.
  { id: 'hunt',          label: 'of the Hunt',     field: 'huntPointsPercent',
    tiers: { 5: [3, 5], 4: [6, 8], 3: [9, 12], 2: [13, 16], 1: [17, 20] } },
  { id: 'learning',      label: 'of Learning',     field: 'xpPercent',
    tiers: { 5: [4, 6], 4: [7, 10], 3: [11, 15], 2: [16, 20], 1: [21, 25] } },
];

/**
 * What an objective can ask the generator to place. Reader:
 * HuntMapGen.generateHuntMap (required placements, then its reachability
 * check); tools/headless/huntmap.mjs fails if any key here has no handler.
 * Bonus objectives use the first eight. The primary objectives
 * (PRIMARY_OBJECTIVES, data/huntMapGen.js) use native_family and exit too, plus
 * the last four. An objective whose `needs` is empty must say `because`, so
 * "needs nothing" is a stated decision and never an omission.
 */
export const PLACEMENT_NEEDS = {
  reachable_tiles:    'enough reachable tiles to reveal the share asked for',
  native_family:      'at least N beasts of one native family, reachable',
  forage_spots:       'enough forage and fishing spots to gather N foods',
  prime_beast:        'a Prime-or-better beast carrying a core part, reachable',
  blight_tile:        'at least one cleansable blight tile, reachable',
  great_beast:        'a Great-grade beast, reachable',
  concealed_occupant: 'an occupant with concealment above 100, reachable',
  exit:               'an exit reachable before the deadline day',
  // Primary objectives (chunk 5)
  scout_sites:        'the sites a Scout plan asks to reveal, reachable and spread out',
  apex_beast:         "the region's apex beast, Great and Rooted, reachable",
  retrieve_site:      'the site holding the item a Retrieve plan asks for, reachable',
  shrine:             "the region's shrine set piece, reachable",
};

/**
 * Bonus objectives are prefixes with no numeric tiers: the unlock level IS the
 * tier. At most one rolls as a prefix (they share one family), plus the Tier
 * III implicit's guaranteed one, which is always a different objective.
 * "Carried home" objectives count at a clean exit, like the completion reward.
 * Readers of `params`: HuntObjectives.objectiveProgress (the completion check).
 */
export const BONUS_OBJECTIVES = {
  pathfinder:    { name: 'Pathfinder',    unlockItemLevel: 1, params: { revealPct: 70 },
    doneWhen: 'Reveal 70% of the map.',
    placement: { needs: ['reachable_tiles'] } },
  named_quarry:  { name: 'Named Quarry',  unlockItemLevel: 1, params: { count: 5 },
    doneWhen: 'Kill 5 beasts of a named native family.',
    placement: { needs: ['native_family'] } },
  provisioner:   { name: 'Provisioner',   unlockItemLevel: 1, params: { count: 6 },
    doneWhen: 'Carry home 6 foraged or fished foods.',
    placement: { needs: ['forage_spots'] } },
  trophy:        { name: 'Trophy',        unlockItemLevel: 3, params: {},
    doneWhen: 'Carry home a core part from a Prime-or-better beast.',
    placement: { needs: ['prime_beast'] } },
  unbroken:      { name: 'Unbroken',      unlockItemLevel: 3, params: {},
    doneWhen: 'No hunter is knocked out in any fight this hunt.',
    placement: { needs: [], because: 'a rule on how fights go; nothing on the map' } },
  // The deadline is set by the map (PLAN_AFFIXES: "exit before day N"): the
  // generator measures the route through the objectives and out, allows
  // routeSlack for fights and actions, and never sets it before beforeDay.
  // A fixed day 4 was impossible on bigger maps (measured in chunk 5: the
  // longest Small route takes 5.4 days, the longest Large one 10.8).
  swift_return:  { name: 'Swift Return',  unlockItemLevel: 5, params: { beforeDay: 4, routeSlack: 1.5 },
    doneWhen: 'Leave the hunt before the deadline the map sets (day 4 at the earliest).',
    placement: { needs: ['exit'] } },
  cleanse:       { name: 'Cleanse',       unlockItemLevel: 5, params: {},
    doneWhen: 'Cleanse a blight tile.',
    placement: { needs: ['blight_tile'] } },
  great_quarry:  { name: 'Great Quarry',  unlockItemLevel: 8, params: {},
    doneWhen: 'Kill a Great-grade beast.',
    placement: { needs: ['great_beast'] } },
  unmask:        { name: 'Unmask',        unlockItemLevel: 8, params: {},
    doneWhen: 'Identify an occupant with concealment above 100.',
    placement: { needs: ['concealed_occupant'] } },
};

/** Plan base tier for an item level. Out-of-range levels clamp into 1-10. */
export function planTierFor(itemLevel) {
  const lvl = Math.max(1, Math.min(10, Math.floor(Number(itemLevel) || 1)));
  return PLAN_TIER_BANDS.find(b => lvl >= b.minItemLevel && lvl <= b.maxItemLevel).tier;
}
