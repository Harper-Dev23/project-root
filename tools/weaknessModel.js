// tools/weaknessModel.js
//
// What every weakness effect is actually worth at a given meter.
//
// ONE definition, imported by both tools that need it:
//   - tools/weakness_snapshot.js     the golden master that catches drift
//   - tools/gen_weakness_journal.js  the player-facing numbers in the Journal
//
// This used to live inside weakness_snapshot.js alone. The moment the Journal
// needed the same numbers there were two options: copy the model, or share it.
// Copying is how this project keeps breaking — a second definition drifts from
// the first and nothing notices — so the model moved here and both import it.
// A Journal that disagreed with the golden master would be worse than a stale
// one, because it would look verified.
//
// NEVER re-implement a curve here. Everything below imports the REAL exported
// functions from StatusEffects.js and calls them. The only things this file
// states by hand are facts that exist nowhere in the config:
//
//   EFFECT_CURVE   which intensity curve each effect uses AT ITS CALL SITE
//   FLAT           effects read raw, never multiplied
//   CUSTOM_FORMULA effects whose engine formula is not `base * intensity`
//   ENGINE_CAPS    ceilings hardcoded in the engine with no config key
//
// Each carries the engine line it was read from. When an engine call site
// changes, the matching entry here must change with it.

globalThis.localStorage ??= { getItem: () => null, setItem() {} };
globalThis.Phaser ??= { Math: { Between: (a, b) => Math.round((a + b) / 2) } };

const SE = await import('../src/systems/StatusEffects.js');
export const {
  WeaknessV3, WeaknessFamilies, WeaknessTierNames, WeaknessIDs,
  WEAKNESS_T1, WEAKNESS_T2,
  weaknessIntensityMult, familyIntensityMult, weaknessDecayAmount,
  weaknessDotTick, lightningJoltOdds,
} = SE;

export const METERS = [200, 300, 400, 600, 800, 1000, 1200, 1600, 2400];

// Which intensity curve each effect ACTUALLY uses at its call site.
// 'family' = familyIntensityMult(fam, m)   'global' = weaknessIntensityMult(m)
// 'own'    = computed by its own function, see CUSTOM_FORMULA
// 'none'   = a curve PARAMETER, not an effect; see FLAT
//
// For six families family and global are the same shape (pow, S 250, exp 0.78),
// so the distinction only changes a number for fire, toxic and lacerate. It is
// recorded for all of them anyway: "same by coincidence" is exactly what broke
// toxic's decayBypassChance, which reasonably looked like it used toxic's own
// curve and does not.
export const EFFECT_CURVE = {
  'toxic.t1.decayBypassChance': 'global',   // CombatScene ~9993, via intensityForEffect — NOT toxic's own curve
  'toxic.t2.startTickBase': 'none',         // tick is weaknessDotTick; see FLAT
  'fire.t2.startTickBase': 'none',
  'lacerate.t2.startPctHP': 'family',       // CombatScene ~11421
  'cold.t1.initiativePenalty': 'family',    // CombatLogic ~230
  'cold.t1.gaugeRegenPenalty': 'family',    // CombatScene gauge regen
  'cold.t2.dmgDealtPenalty': 'family',      // CombatLogic
  'cold.t2.evasionPenalty': 'family',       // CombatLogic
  'disorient.t1.costMultiplier': 'family',  // CombatScene cost path
  'expose.t1.physDRPen': 'family',          // CombatLogic
  'expose.t2.critChanceBonus': 'global',    // CombatLogic
  'expose.t2.critDamageBonus': 'global',    // CombatLogic
  'lightning.t2.extraJoltsMax': 'own',      // lightningJoltOdds
  'lightning.t2.multiJoltChance': 'own',
  'lightning.t2.extraJoltsExp': 'none',
  'lightning.t2.multiJoltChanceExp': 'none',
  'lightning.t1.joltDieMax': 'flat',        // read raw, never multiplied
  'curse.t1.decayReduction': 'global',      // CombatScene ~9965, weaknessIntensityMult
  'curse.t2.decayReduction': 'global',
  'curse.t2.curseAmpMult': 'global',        // CombatLogic ~557
  'disease.t1.healRecvPenalty': 'global',   // CombatLogic
  'fire.t2.startTickCurveK': 'flat',        // own formula, see CUSTOM_FORMULA
  'toxic.t2.startTickCurveK': 'flat',

  // Resolved 2026-09-12 by reading each ENGINE call site (not the tooltip
  // block in _weaknessTooltipData, which reads the same keys with different
  // fallbacks). Until then the snapshot reported these as '?', assumed family.
  'cold.t2.gaugeStartDrainBase': 'family',  // CombatScene ~11567, floor, capped
  'fire.t1.onActLoss': 'family',            // CombatScene ~7129, floor, min 1
  'fire.t1.incomingFireBonus': 'family',    // CombatScene ~9820 — incoming fire BUILDUP, not damage
  'disorient.t2.startDrainMPBase': 'family',// CombatScene ~11323, floor, capped
  'lacerate.t1.onActBuildupFlat': 'family', // CombatScene ~7148, round, min 1
  'expose.t1.physBuildupAmp': 'family',     // CombatScene ~9831 — Disorient + Lacerate buildup only
  'disease.t2.maxHPDown': 'global',         // CombatScene ~11619, weaknessIntensityMult
  'fire.t2.startTickCurveExp': 'none',
  'toxic.t2.startTickCurveExp': 'none',
};

// Read FLAT at their call sites — never multiplied by intensity.
export const FLAT = new Set([
  'lightning.t1.joltDieMax',
  'fire.t2.startTickCurveExp', 'toxic.t2.startTickCurveExp',
  'fire.t2.startTickBase', 'toxic.t2.startTickBase',
  'lightning.t2.extraJoltsExp', 'lightning.t2.multiJoltChanceExp',
]);

// Effects whose engine formula is NOT `base * intensity`, computed by the one
// function the engine itself calls.
export const CUSTOM_FORMULA = {
  'lightning.t2.extraJoltsMax': (_b, m) => lightningJoltOdds(m).rolls,
  'lightning.t2.multiJoltChance': (_b, m) => lightningJoltOdds(m).chance,
  'fire.t2.startTickCurveK': (_K, m) => weaknessDotTick('fire', m),
  'toxic.t2.startTickCurveK': (_K, m) => weaknessDotTick('toxic', m),
};

// Ceilings the ENGINE enforces with a literal, no config key behind them.
//
// Invisible to anything that reads caps from the config, which is why the
// snapshot recorded Disease's max-HP loss as uncapped — 54% at meter 2400 —
// while the engine stops it at 40%. A cap listed here overrides the config.
export const ENGINE_CAPS = {
  'disease.t2.maxHPDown': 0.40,             // CombatScene ~11622: Math.min(..., 0.40)
};

export const intensityFor = (fam, key, m) =>
  (EFFECT_CURVE[key] === 'global' ? weaknessIntensityMult(m) : familyIntensityMult(fam, m));

/** Pair a base key with its cap key, tolerating the three inconsistent names. */
export function capKeyFor(tierObj, baseKey) {
  const direct = baseKey + 'Cap';
  if (direct in tierObj) return direct;
  // startPctHP -> startPctCap, gaugeStartDrainBase -> gaugeStartDrainCap, ...
  const stem = baseKey.replace(/(HP|Base|MP)$/, '');
  if ((stem + 'Cap') in tierObj) return stem + 'Cap';
  return null;
}

/** The ceiling an effect actually hits: the engine's literal first, then config. */
export function capFor(fam, tier, key) {
  const full = `${fam}.${tier}.${key}`;
  if (full in ENGINE_CAPS) return ENGINE_CAPS[full];
  const t = WeaknessV3.families?.[fam]?.[tier] || {};
  const ck = capKeyFor(t, key);
  return ck ? t[ck] : null;
}

/**
 * What an effect is worth at `m`, capped.
 *
 * ONE definition for the report, the JSON snapshot and the Journal. The report
 * and the snapshot once disagreed (the guard modelled `base * intensity` for
 * entries the report knew were special), so a drift-catching harness reported
 * IDENTICAL while real values moved. Everything goes through here.
 */
export function valueAt(fam, tier, key, base, cap, m) {
  const full = `${fam}.${tier}.${key}`;
  const raw = CUSTOM_FORMULA[full] ? CUSTOM_FORMULA[full](base, m)
    : FLAT.has(full) ? base
      : base * intensityFor(fam, full, m);
  return cap == null ? raw : Math.min(cap, raw);
}

/** An effect's value at `m` straight from the live config, capped as the engine caps it. */
export function effectValue(fam, tier, key, m) {
  const base = WeaknessV3.families?.[fam]?.[tier]?.[key];
  if (typeof base !== 'number') return null;
  return valueAt(fam, tier, key, base, capFor(fam, tier, key), m);
}

/**
 * Decay read the way the ENGINE reads it — from the DERIVED WeaknessFamilies,
 * not WeaknessV3.families. They disagree: curse has no `baseDecay`, so V3 gives
 * undefined while WeaknessFamilies gives the `?? 35` fallback.
 */
export const decayOf = (fam, m) =>
  weaknessDecayAmount(WeaknessFamilies[fam]?.decay, m, WeaknessFamilies[fam]?.decayCurve);

/** The first meter at which an effect reaches its cap, or null if it never does by `limit`. */
export function meterAtCap(fam, tier, key, limit = 5000) {
  const cap = capFor(fam, tier, key);
  if (cap == null) return null;
  const base = WeaknessV3.families?.[fam]?.[tier]?.[key];
  for (let m = WEAKNESS_T2; m <= limit; m += 10) {
    if (valueAt(fam, tier, key, base, null, m) >= cap) return m;
  }
  return null;
}
