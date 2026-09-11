// tools/weakness_snapshot.js
//
// Golden-master snapshot of every weakness family's behaviour.
//
// WHY THIS EXISTS
// ---------------
// The weakness config is the messiest surface in the project: 42 effect keys
// across 9 families, five families with a custom intensity curve and four
// without, three base/cap pairs whose names break the shared convention, and
// — worst of all — *which intensity curve an effect uses is decided at its
// call site, not in the config*. That last one has already caused a real bug
// (toxic's decayBypassChance was changed on the assumption it used toxic's own
// curve; it uses the global one).
//
// So: never re-implement a curve to check it. This file imports the REAL
// exported functions and calls them. The only thing it hard-codes is the
// EFFECT_CURVE table below, which records which curve each effect actually
// uses at its call site — information that exists nowhere else and should
// eventually move into StatusEffects.js itself.
//
// USAGE
//   node tools/weakness_snapshot.js                  print the report
//   node tools/weakness_snapshot.js --json out.json  write a machine diffable
//                                                    snapshot
//   node tools/weakness_snapshot.js --diff old.json  compare against one
//
// The intended workflow for any curve change is:
//   1. snapshot --json before.json     (no code changes yet)
//   2. make the change
//   3. --diff before.json              every delta must be intentional
//
import fs from 'fs';

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.Phaser = { Math: { Between: (a, b) => Math.round((a + b) / 2) } };

const SE = await import('../src/systems/StatusEffects.js');
const { WeaknessV3, WeaknessFamilies, weaknessIntensityMult, familyIntensityMult, weaknessDecayAmount, weaknessDotTick, lightningJoltOdds } = SE;

// Read decay the way the ENGINE does — from the DERIVED WeaknessFamilies, not
// from WeaknessV3.families directly. They disagree: curse has no `baseDecay`
// at all (just a dead `decay: {base,overflow}` object the engine never reads),
// so WeaknessV3 gives undefined while WeaknessFamilies correctly gives the
// `?? 35` fallback. Reading the wrong one produced NaN on the first run of
// this harness — exactly the class of drift it exists to catch.
const decayOf = (fam, m) =>
  weaknessDecayAmount(WeaknessFamilies[fam]?.decay, m, WeaknessFamilies[fam]?.decayCurve);

const METERS = [200, 300, 400, 600, 800, 1000, 1200, 1600, 2400];

// Which intensity curve each effect ACTUALLY uses at its call site.
// 'family' = familyIntensityMult(fam, m)   'global' = weaknessIntensityMult(m)
// Verified by reading the call sites in CombatScene.js / CombatLogic.js.
// A '?' means the call site could not be determined and needs a human look.
const EFFECT_CURVE = {
  'toxic.t1.decayBypassChance': 'global',   // CombatScene ~8833 — NOT toxic's own curve
  // Both DOT ticks are no longer intensity-scaled at all: they run the shaped
  // curve in weaknessDotTick (base + K * (overflow/100)**exp). Reporting them
  // as 'family' would show a multiplier the engine stopped applying.
  'toxic.t2.startTickBase': 'none',         // see FLAT below
  'fire.t2.startTickBase': 'none',          // see FLAT below
  'lacerate.t2.startPctHP': 'family',       // CombatScene ~10218
  'cold.t1.initiativePenalty': 'family',    // CombatLogic 151
  'cold.t1.gaugeRegenPenalty': 'family',    // CombatScene ~10359
  'cold.t2.dmgDealtPenalty': 'family',      // CombatLogic 383
  'cold.t2.evasionPenalty': 'family',       // CombatLogic 181
  'disorient.t1.costMultiplier': 'family',  // CombatScene ~10471
  'expose.t1.physDRPen': 'family',          // CombatLogic 264/316
  'expose.t2.critChanceBonus': 'global',    // CombatLogic 214
  'expose.t2.critDamageBonus': 'global',    // CombatLogic 215
  'lightning.t2.multiJoltChance': 'family', // CombatLogic 411/427
  'curse.t1.decayReduction': 'global',      // CombatScene ~8831
  'curse.t2.decayReduction': 'global',
  'disease.t1.healRecvPenalty': 'global',   // CombatLogic 344
  // Verified 2026-09-06 while checking the curse riders:
  'curse.t2.curseAmpMult': 'global',        // CombatLogic ~482, weaknessIntensityMult
  // Lightning's T2 odds are no longer `base * intensity`: each axis has its
  // own exponent, so they are reported through lightningJoltOdds itself (see
  // CUSTOM_FORMULA). Modelling them as 'family' here would record numbers the
  // engine stopped computing -- the exact failure this harness exists to catch.
  'lightning.t2.extraJoltsMax': 'own',
  'lightning.t2.multiJoltChance': 'own',
  'lightning.t2.extraJoltsExp': 'none',        // see FLAT
  'lightning.t2.multiJoltChanceExp': 'none',   // see FLAT
  'lightning.t1.joltDieMax': 'flat',        // read raw, never multiplied
  'fire.t2.startTickCurveK': 'flat',        // own formula, see CUSTOM_FORMULA
  'toxic.t2.startTickCurveK': 'flat',       // own formula, see CUSTOM_FORMULA
};

// Read FLAT at their call sites — never multiplied by intensity. Listing them
// stops the report implying a scaling that does not exist (joltDieMax is the
// 1-4 die skills read directly; showing it climbing to 25 was misleading).
const FLAT = new Set([
  'lightning.t1.joltDieMax',
  // Curve shape parameters, not damage. Multiplying an exponent by intensity
  // would be meaningless; the tick they describe is reported by CUSTOM_FORMULA.
  'fire.t2.startTickCurveExp', 'toxic.t2.startTickCurveExp',
  // The DOT bases are read RAW by weaknessDotTick and never multiplied. Left
  // on the family curve they reported a climb the engine stopped applying --
  // which is precisely the drift this harness exists to catch, so it must not
  // introduce it. EFFECT_CURVE only names WHICH curve; membership here is what
  // decides that there is no curve at all.
  'fire.t2.startTickBase', 'toxic.t2.startTickBase',
  // Curve-shape exponents for Lightning's jolt odds -- parameters, not damage.
  'lightning.t2.extraJoltsExp', 'lightning.t2.multiJoltChanceExp',
]);

// Effects whose engine formula is NOT `base * intensity`. Reporting them on
// the default model is actively misleading — fire's perHundred term is
// `base * (meter - 200) / 100`, added to the intensity-scaled part, and
// treating it as scaled is what caused it to be mis-rebased once already.
const CUSTOM_FORMULA = {
  // The jolt's real odds, straight from the one function the engine calls.
  'lightning.t2.extraJoltsMax': (_b, m) => lightningJoltOdds(m).rolls,
  'lightning.t2.multiJoltChance': (_b, m) => lightningJoltOdds(m).chance,
  // The whole tick, not just this term -- reported against the K entry so the
  // snapshot records the number the fight actually deals at each meter. Both
  // families share one shape; see weaknessDotTick, which is what the engine,
  // both tooltips and Venom Bloom all call.
  'fire.t2.startTickCurveK': (_K, m) => weaknessDotTick('fire', m),
  'toxic.t2.startTickCurveK': (_K, m) => weaknessDotTick('toxic', m),
};

const I = (fam, key, m) =>
  (EFFECT_CURVE[key] === 'global' ? weaknessIntensityMult(m) : familyIntensityMult(fam, m));

/**
 * What an effect is actually worth at `meter`, capped.
 *
 * ONE definition, used by both the printed report and the JSON snapshot.
 * They used to disagree: report() honoured CUSTOM_FORMULA and FLAT while
 * collect() -- the half that writes the golden master and performs the diff --
 * unconditionally computed `base * intensity`. So the printout was right and
 * THE GUARD WAS WRONG, recording numbers the engine never computes for exactly
 * the entries this file documents as special (joltDieMax, fire's add-on term).
 * A drift-catching harness that quietly models the wrong formula is worse than
 * none, because it reports IDENTICAL while the real value moves.
 */
function valueAt(fam, tier, key, base, cap, m) {
  const raw = CUSTOM_FORMULA[key] ? CUSTOM_FORMULA[key](base, m)
    : FLAT.has(key) ? base
      : base * I(fam, key, m);
  return cap == null ? raw : Math.min(cap, raw);
}

/** Pair a base key with its cap key, tolerating the three inconsistent names. */
function capKeyFor(tierObj, baseKey) {
  const direct = baseKey + 'Cap';
  if (direct in tierObj) return direct;
  // startPctHP -> startPctCap, gaugeStartDrainBase -> gaugeStartDrainCap, ...
  const stem = baseKey.replace(/(HP|Base|MP)$/, '');
  if ((stem + 'Cap') in tierObj) return stem + 'Cap';
  return null;
}

function collect() {
  const out = { effects: {}, decay: {}, intensity: {} };

  for (const m of METERS) out.intensity['global@' + m] = +weaknessIntensityMult(m).toFixed(4);

  for (const [fam, cfg] of Object.entries(WeaknessV3.families)) {
    for (const m of METERS) {
      out.intensity[`${fam}@${m}`] = +familyIntensityMult(fam, m).toFixed(4);
      out.decay[`${fam}@${m}`] = decayOf(fam, m);
    }
    for (const tier of ['t1', 't2']) {
      const t = cfg[tier];
      if (!t) continue;
      for (const [k, base] of Object.entries(t)) {
        if (typeof base !== 'number') continue;
        if (/Cap$/.test(k)) continue;
        const key = `${fam}.${tier}.${k}`;
        const capKey = capKeyFor(t, k);
        const cap = capKey ? t[capKey] : null;
        for (const m of METERS) {
          out.effects[`${key}@${m}`] = +valueAt(fam, tier, key, base, cap, m).toFixed(4);
        }
      }
    }
  }
  return out;
}

function report() {
  console.log('WEAKNESS SNAPSHOT — all values from the REAL exported functions\n');
  console.log('meter'.padEnd(12) + METERS.map(m => String(m).padStart(8)).join(''));
  console.log('-'.repeat(12 + METERS.length * 8));
  console.log('global I'.padEnd(12) + METERS.map(m => weaknessIntensityMult(m).toFixed(2).padStart(8)).join(''));
  for (const fam of Object.keys(WeaknessV3.families)) {
    const custom = WeaknessV3.families[fam].intensity ? '' : '  (no custom curve)';
    console.log((fam + ' I').padEnd(12) + METERS.map(m => familyIntensityMult(fam, m).toFixed(2).padStart(8)).join('') + custom);
  }

  console.log('\n\nDECAY PER TURN (weaknessDecayAmount, the real one)\n');
  console.log('family'.padEnd(12) + METERS.map(m => String(m).padStart(8)).join(''));
  console.log('-'.repeat(12 + METERS.length * 8));
  for (const [fam, cfg] of Object.entries(WeaknessV3.families)) {
    console.log(fam.padEnd(12) + METERS.map(m => String(decayOf(fam, m)).padStart(8)).join(''));
  }

  console.log('\n\nEVERY SCALED EFFECT (capped values shown; * = at its cap)\n');
  for (const [fam, cfg] of Object.entries(WeaknessV3.families)) {
    for (const tier of ['t1', 't2']) {
      const t = cfg[tier];
      if (!t) continue;
      for (const [k, base] of Object.entries(t)) {
        if (typeof base !== 'number' || /Cap$/.test(k)) continue;
        const key = `${fam}.${tier}.${k}`;
        const capKey = capKeyFor(t, k);
        const cap = capKey ? t[capKey] : null;
        const curve = EFFECT_CURVE[key] || '?';
        const cells = METERS.map(m => {
          const v = valueAt(fam, tier, key, base, cap, m);
          const atCap = cap != null && valueAt(fam, tier, key, base, null, m) >= cap;
          return (v.toFixed(2) + (atCap ? '*' : ' ')).padStart(8);
        });
        const tag = CUSTOM_FORMULA[key] ? 'own-formula' : FLAT.has(key) ? 'FLAT' : (cap == null ? 'UNCAPPED' : `cap ${cap}`);
        console.log(`${key.padEnd(34)} [${curve.padEnd(6)}] ${tag.padEnd(10)}` + cells.join(''));
      }
    }
  }
  const unknown = Object.entries(WeaknessV3.families).flatMap(([fam, cfg]) =>
    ['t1', 't2'].flatMap(tier => Object.entries(cfg[tier] || {})
      .filter(([k, v]) => typeof v === 'number' && !/Cap$/.test(k))
      .map(([k]) => `${fam}.${tier}.${k}`)))
    .filter(k => !EFFECT_CURVE[k]);
  if (unknown.length) {
    console.log('\n\nCALL SITE NOT YET IDENTIFIED (assumed family curve) — needs a human look:');
    unknown.forEach(k => console.log('  ' + k));
  }
}

const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const diffIdx = args.indexOf('--diff');

if (diffIdx !== -1) {
  const before = JSON.parse(fs.readFileSync(args[diffIdx + 1], 'utf8'));
  const after = collect();
  let n = 0;
  for (const section of ['intensity', 'decay', 'effects']) {
    for (const k of new Set([...Object.keys(before[section] || {}), ...Object.keys(after[section] || {})])) {
      const a = before[section]?.[k], b = after[section]?.[k];
      if (a !== b) { console.log(`  ${section.padEnd(10)} ${k.padEnd(44)} ${String(a).padStart(9)} -> ${String(b).padStart(9)}`); n++; }
    }
  }
  console.log(n ? `\n${n} value(s) changed. Every one must be intentional.` : '\nIDENTICAL — behaviour-neutral.');
} else if (jsonIdx !== -1) {
  fs.writeFileSync(args[jsonIdx + 1], JSON.stringify(collect(), null, 1));
  console.log('snapshot written to ' + args[jsonIdx + 1]);
} else {
  report();
}
