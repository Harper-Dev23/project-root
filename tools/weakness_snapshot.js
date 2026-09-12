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

// The scaling model lives in tools/weaknessModel.js so the Journal generator
// reads the same numbers this golden master guards. See that file's header for
// why a copy here would be the wrong move.
const {
  WeaknessV3, weaknessIntensityMult, familyIntensityMult,
  METERS, EFFECT_CURVE, FLAT, CUSTOM_FORMULA, valueAt: modelValueAt, capFor, decayOf,
} = await import('./weaknessModel.js');

// Local adapter keeping this file's (fam, tier, fullKey, base, cap, m) call
// shape, while the model itself takes the bare key.
const valueAt = (fam, tier, key, base, cap, m) =>
  modelValueAt(fam, tier, key.split('.').pop(), base, cap, m);

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
        const cap = capFor(fam, tier, k);
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
        const cap = capFor(fam, tier, k);
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
