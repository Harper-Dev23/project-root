import { Items } from '../../data/items.js';
import { getItemComputedData, isItemInstance } from '../systems/ItemFactory.js';
import { WeaknessV3, weaknessIntensityMult, WeaknessAliases, familyIntensityMult, } from '../systems/StatusEffects.js';

// --------------------------------------------------
// Small utils
// --------------------------------------------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function getEquippedWeaponData(character, slot) {
  const equipped = character.equipment?.[slot];
  if (!equipped) return null;
  return getItemComputedData(isItemInstance(equipped) ? equipped : equipped);
}
function famKey(w, k) { return (k in (w?.meters || {})) ? k : (WeaknessAliases[k] || k); }

// Debug breakdown side-channel (non-breaking API)
let _lastBreakdown = null;
export function _resetDamageBreakdown() { _lastBreakdown = []; }
export function _pushBreakdown(entry) { if (!_lastBreakdown) _lastBreakdown = []; _lastBreakdown.push(entry); }
export function getLastDamageBreakdown() { return _lastBreakdown ? [..._lastBreakdown] : null; }


// === Effective = baseline derived + runtime mods + (optionally) status mods ===
export function _sumStatusEffectMods(char) {
  // If your status effects don’t carry numeric mods, this returns zeros.
  // If they do, each effect can have: { mods: { Accuracy:+5, Evasion:-10, ... } }
  const out = {
    Accuracy: 0, Evasion: 0, Initiative: 0, CritChance: 0, CritMult: 0,
    ElementalResist: 0, PhysicalResist: 0, CritAvoid: 0
  };
  const list = Array.isArray(char?.statusEffects) ? char.statusEffects : [];
  for (const se of list) {
    const m = se?.mods; if (!m) continue;
    for (const k in out) if (m[k]) out[k] += m[k];
  }
  return out;
}

export function getEffectiveDerived(char) {
  const d = char?.derived || {};
  const b = char?.combatMods || {};
  const s = _sumStatusEffectMods(char);
  return {
    Accuracy: (d.Accuracy | 0) + (b.Accuracy | 0) + s.Accuracy,
    Evasion: (d.Evasion | 0) + (b.Evasion | 0) + s.Evasion,
    Initiative: (d.Initiative | 0) + (b.Initiative | 0) + s.Initiative,
    CritChance: (d.CritChance | 0) + (b.CritChance | 0) + s.CritChance,
    CritMult: (d.CritMult ?? 1.5) + (b.CritMult | 0) + s.CritMult,
    ElementalResist: (d.ElementalResist | 0) + (b.ElementalResist | 0) + s.ElementalResist,
    PhysicalResist: (d.PhysicalResist | 0) + (b.PhysicalResist | 0) + s.PhysicalResist,
    CritAvoid: (d.CritAvoid | 0) + (b.CritAvoid | 0) + s.CritAvoid,
  };
}

function getAttackerDamageMultiplier(attacker, opts = {}) {
  const ge = attacker?.gearEffects;
  if (!ge) return 1;

  let mult = 1;
  if (ge.globalDamagePercent) {
    mult *= 1 + (ge.globalDamagePercent / 100);
  }

  const element = opts.element;
  if (element && ['fire', 'cold', 'lightning'].includes(element)) {
    if (ge.elementalDamagePercent) {
      mult *= 1 + (ge.elementalDamagePercent / 100);
    }
  }

  if (element === 'necrotic' && ge.necroticDamagePercent) {
    mult *= 1 + (ge.necroticDamagePercent / 100);
  }

  return mult;
}


// CHA-based initiative with Cold T1 penalty applied at point of use
export function computeEffectiveInitiative(char) {
  const eff = getEffectiveDerived(char);
  let out = eff.Initiative | 0;

  const w = char?.weakness;
  if (w && ((w.tiers?.cold | 0) >= 1)) {
    const m = w.meters?.cold | 0;
    const I = familyIntensityMult('cold', m);
    const base = WeaknessV3?.families?.cold?.t1?.initiativePenalty ?? 0;
    const cap = WeaknessV3?.families?.cold?.t1?.initiativePenaltyCap ?? 0.5;
    const pen = Math.min(base * I, cap);        // 0..cap
    out = Math.max(0, Math.floor(out * (1 - pen)));
  }
  return out;
}



// --------------------------------------------------
// NEW: Accuracy / Evasion / Crit helpers
// --------------------------------------------------
function getAccuracy(attacker, ability) {
  const base = (attacker?.derived?.Accuracy ?? attacker?.stats?.accuracy ?? 0);
  const mod = (ability?.accuracyBonus ?? 0);
  return base + mod;
}
function getEvasion(target) {
  return (target?.derived?.Evasion ?? target?.stats?.evasion ?? 0);
}
// Cold T2 evasion penalty (overflow-scaled)
export function applyColdEvasionPenalty(target, evasion) {
  const w = target?.weakness;
  if (!w) return evasion;
  const t = w.tiers?.cold | 0;
  if (t < 2) return evasion;

  const m = w.meters?.cold | 0;
  const I = familyIntensityMult('cold', m);
  const base = WeaknessV3?.families?.cold?.t2?.evasionPenalty ?? 0;      // e.g., 0.25
  const cap = WeaknessV3?.families?.cold?.t2?.evasionPenaltyCap ?? 0.6; // e.g., 0.60

  const pen = Math.min(base * I, cap);         // fraction 0..cap
  const out = Math.floor((evasion | 0) * (1 - pen));
  return out;
}

export function computeHitChance(attacker, target, ability) {
  const A = getEffectiveDerived(attacker); // your helper that adds combatMods/status mods
  const T = getEffectiveDerived(target);

  // Apply Cold T2 evasion penalty at point-of-use
  const evasionEff = applyColdEvasionPenalty(target, T.Evasion | 0);

  const acc = (A.Accuracy | 0);
  const raw = 100 - (evasionEff | 0) + acc;
  return Math.max(5, Math.min(100, raw));
}


export function rollToHit(attacker, target, ability, rng = Math.random) {
  const chance = computeHitChance(attacker, target, ability);
  const roll = Math.floor(rng() * 100) + 1; // 1..100
  return { hit: roll <= chance, chance };
}
// Expose T2 crit bonuses (chance% & damage mult), overflow-scaled
export function applyExposeCritBonuses(attacker, target, baseCritChance, baseCritMult) {
  const w = target?.weakness;
  if (!w) return { critChance: baseCritChance, critMult: baseCritMult };
  if ((w.tiers.expose | 0) < 2) return { critChance: baseCritChance, critMult: baseCritMult };
  const m = w.meters.expose | 0;
  const addChance = WeaknessV3.families.expose.t2.critChanceBonus * weaknessIntensityMult(m);
  const addMult = WeaknessV3.families.expose.t2.critDamageBonus * weaknessIntensityMult(m);
  const finalChance = clamp(Math.floor(baseCritChance + (addChance * 100)), 0, 100);
  const finalMult = baseCritMult + addMult;
  return { critChance: finalChance, critMult: finalMult };
}


// === DR / Healing helpers for UI ===
export function estimateDRPercent(target, opts = {}) {
  const frac = getDamageReductionFraction(target, opts);
  return Math.round(frac * 100);
}

export function getDamageReductionFraction(target, opts = {}) {
  if (!target) return 0;

  const eff = getEffectiveDerived(target) || {};

  // Accept damageType:'physical'|'elemental'|'necrotic' as shorthand.
  // Necrotic uses ElementalResist for now (no dedicated stat yet).
  const damageType = opts.damageType;
  const isMagic = opts.isMagic != null
    ? !!opts.isMagic
    : (damageType === 'elemental' || damageType === 'necrotic');

  let dr = 0;
  if (isMagic) {
    dr += (eff.ElementalResist || 0) / 100;
    if (Number.isFinite(target.magDR)) dr += target.magDR;
  } else {
    dr += (eff.PhysicalResist || 0) / 100;
    if (Number.isFinite(target.physDR)) dr += target.physDR;
  }

  if (Number.isFinite(opts.extraAdd)) dr += opts.extraAdd;

  const includeExpose = opts.applyExpose !== false && !isMagic;
  if (includeExpose) {
    const w = target?.weakness;
    if (w && (w.tiers?.expose | 0) >= 1) {
      const I = familyIntensityMult('expose', w.meters?.expose | 0);
      const sub = (WeaknessV3?.families?.expose?.t1?.physDRPen ?? 0) * I;
      dr -= sub;
    }
  }

  const cap = 0.95;
  if (dr > cap) dr = cap;
  if (dr < -cap) dr = -cap;
  return dr;
}

// === Effective Physical Damage Reduction (additive model) ===
// Returns percent integer for UI (e.g., 15 => "15%"; -10 => "-10%")
export function getEffectivePDR(char) {
  return Math.round(getDamageReductionFraction(char, { isMagic: false }) * 100);
}


export function getEffectiveMDR(target) {
  return Math.round(getDamageReductionFraction(target, { isMagic: true }) * 100);
}

// === Expose pre-damage shaping (additive PDR model) ===
export function applyExposePreDamage({ user, target, resultMutable, intent, isWeaponSource, missed }) {
  if (missed) return;

  const differentTeams = (!!user?.isEnemy) !== (!!target?.isEnemy);
  const isPhysical = !resultMutable.isMagic && (isWeaponSource || (intent.tags || []).includes('attack'));
  if (!differentTeams || !isPhysical || !target?.weakness) return;

  const tiers = target.weakness.tiers || {};
  const meters = target.weakness.meters || {};
  const dbg = (resultMutable._expose ||= {});

  // T1 Expose: subtract additive PDR points
  if ((tiers.expose | 0) >= 1) {
    const I = familyIntensityMult('expose', meters.expose | 0);
    const sub = (WeaknessV3?.families?.expose?.t1?.physDRPen ?? 0) * I;   // e.g. 0.10
    const dr0 = Number(resultMutable.damageReduction ?? 0);
    const dr1 = dr0 - sub;
    resultMutable.damageReduction = (dr1 > 0.95 ? 0.95 : dr1);

    // debug annotation for log
    dbg.pdrBefore = dr0;
    dbg.pdrAfter = resultMutable.damageReduction;
    dbg.pdrSub = sub; // decimal
  }

  // T2 Expose: crit chance + crit damage
  if ((tiers.expose | 0) >= 2) {
    const I = familyIntensityMult('expose', meters.expose | 0);
    const dChance = Math.max(0, WeaknessV3?.families?.expose?.t2?.critChanceBonus ?? 0) * I; // 0..1
    const dCrit = Math.max(0, WeaknessV3?.families?.expose?.t2?.critDamageBonus ?? 0);     // 0..1

    // Helper: scale typed splits + amount together
    const _scaleTyped = (scale) => {
      const hasTyped = resultMutable.physical != null || resultMutable.elemental != null || resultMutable.necrotic != null;
      if (hasTyped) {
        if (resultMutable.physical != null) resultMutable.physical = Math.floor(resultMutable.physical * scale);
        if (resultMutable.elemental != null) resultMutable.elemental = Math.floor(resultMutable.elemental * scale);
        if (resultMutable.necrotic != null) resultMutable.necrotic = Math.floor(resultMutable.necrotic * scale);
        resultMutable.amount = (resultMutable.physical || 0) + (resultMutable.elemental || 0) + (resultMutable.necrotic || 0);
      } else {
        resultMutable.amount = Math.floor((resultMutable.amount | 0) * scale);
      }
    };

    if (!resultMutable.isCrit) {
      if (Math.random() < dChance) {
        resultMutable.isCrit = true;
        const baseCritMult = 1.5; // keep in sync with engine baseline
        _scaleTyped(baseCritMult * (1 + dCrit));
        dbg.critForced = true;
      }
    } else {
      _scaleTyped(1 + dCrit);
      dbg.critAmpOnly = true;
    }

    // annotate crit bonuses for log
    dbg.critChanceBonus = dChance; // decimal
    dbg.critDmgBonus = dCrit;   // decimal
  }
}

/** Return healing received multiplier as a percent integer (100 = normal). */
export function getHealingReceivedMult(char) {
  if (!char) return 100;

  // If scene already computed a per-turn bonus, honor it
  if (Number.isFinite(char.healingReceivedBonus)) {
    return Math.round(Math.max(0, char.healingReceivedBonus) * 100);
  }

  const w = char.weakness;
  if (!w) return 100;

  const t = (w.tiers?.disease | 0);
  if (t <= 0) return 100;

  // Use the canonical keys from StatusEffects.js
  const base = WeaknessV3?.families?.disease?.t1?.healRecvPenalty ?? 0;
  // Optional: T2 makes the T1 penalty harsher by 50%
  const tierMult = (t === 2) ? 1.5 : 1.0;
  const penalty = Math.max(0, base * tierMult);

  const mult = Math.max(0, 1 - penalty);
  return Math.round(mult * 100);
}

// --------------------------------------------------
// Weakness riders applied on hit (Cold T2 dmg-out, Lightning jolts → elemental bucket)
// Expose T1 DR penalty is a delta on resultMutable.damageReduction via applyExposePreDamage.
// Signature: (physical, elemental, attacker, target, ability) → { physical, elemental }
// --------------------------------------------------
function applyWeaknessDamagePipeline(physical, elemental, attacker, target, ability) {
  // Attacker under Cold T2 → deals less physical AND elemental damage (overflow-scaled, capped)
  {
    const wa = attacker?.weakness;
    if (wa && ((wa.tiers?.cold | 0) >= 2)) {
      const m = wa.meters?.cold | 0;
      const I = familyIntensityMult('cold', m);
      const basePen = WeaknessV3?.families?.cold?.t2?.dmgDealtPenalty ?? 0;
      const capPen = WeaknessV3?.families?.cold?.t2?.dmgDealtPenaltyCap ?? 0.35;
      const pen = Math.min(basePen * I, capPen);
      const prevTotal = physical + elemental;
      physical = Math.max(0, Math.floor(physical * (1 - pen)));
      elemental = Math.max(0, Math.floor(elemental * (1 - pen)));
      try { _pushBreakdown?.({ label: 'Cold T2 damage-out', mult: (1 - pen), from: prevTotal, to: physical + elemental }); } catch { }
    }
  }

  const w = target?.weakness;
  if (!w) return { physical: Math.max(0, physical), elemental: Math.max(0, elemental) };

  // Lightning jolts: magic-typed, added to elemental bucket (bypasses PhysicalResist)
  if ((w.tiers[famKey(w, 'lightning')] | 0) >= 1) {
    const key = famKey(w, 'lightning');
    const t = w.tiers[key] | 0;
    const m = w.meters[key] | 0;

    const I = weaknessIntensityMult(m);
    const dieMax = WeaknessV3.families.lightning.t1.joltDieMax ?? 0;
    const flat = WeaknessV3.families.lightning.t1.joltFlat ?? 0;

    let repeats = 1;
    let joltTotal = 0;

    if (t >= 2) {
      const baseP = WeaknessV3.families.lightning.t2.multiJoltChance ?? 0;
      const flatPI = WeaknessV3.families.lightning.t2.joltFlatChancePerIntensity ?? 0;
      const capP = WeaknessV3.families.lightning.t2.multiJoltChanceCap ?? 0.9;
      const extraMax = WeaknessV3.families.lightning.t2.extraJoltsMax ?? 3;
      const p = Math.min(capP, (baseP * I) + (flatPI * Math.max(0, I - 1)));
      let extra = 0;
      for (let i = 0; i < extraMax; i++) {
        if (Math.random() < p) extra++;
      }
      repeats += extra;
      try { _pushBreakdown({ label: 'Lightning extra-proc chance', value: Math.round(p * 100) }); } catch { }
    }

    for (let r = 0; r < repeats; r++) {
      let j = 0;
      if (dieMax && dieMax > 0) {
        j = Phaser?.Math?.Between ? Phaser.Math.Between(1, dieMax) : (1 + Math.floor(Math.random() * dieMax));
      } else {
        j = flat;
      }
      joltTotal += j;
    }

    elemental += joltTotal;
    try { if (joltTotal > 0) _pushBreakdown({ label: `Lightning Jolt x${repeats}`, flat: joltTotal }); } catch { }
  }

  return { physical: Math.max(0, physical), elemental: Math.max(0, elemental) };
}


// --------------------------------------------------
// Typed damage calculation — returns { physical, elemental, necrotic, amount, isCrit }
// physical   = weapon swing + STR scaling (gets PhysicalResist DR in CombatScene)
// elemental  = weapon elemental flats + lightning jolts (gets ElementalResist DR)
// necrotic   = converted from physical/elemental via jewelry (gets ElementalResist DR for now)
// amount     = physical + elemental + necrotic (may be further scaled by skill amps in skills.js)
// --------------------------------------------------
export function calculateDamage(attacker, target, ability = null) {
  try { _resetDamageBreakdown(); } catch { }
  let min = 1, max = 2;
  const weaponData = getEquippedWeaponData(attacker, 'weaponMain');
  if (weaponData?.damage) { min = weaponData.damage.min; max = weaponData.damage.max; }
  const weaponMods = weaponData?._weaponMods || {};
  const localDamageMult = 1 + ((weaponMods.localDamagePercent || 0) / 100);
  // STR scaling
  const strengthMod = Math.floor((attacker.totalStats?.STR || 0) / 5);
  let baseDamage = Phaser.Math.Between(min, max) + strengthMod;
  try { _pushBreakdown({ label: 'base', value: baseDamage }); } catch { }

  // Crit chance from attacker + weapon; CritMult from derived
  const weaponCrit = weaponData?._derivedMods?.CritChance || 0;
  const baseCritChance = (attacker.derived?.CritChance || 0) + weaponCrit;
  const baseCritMult = attacker?.derived?.CritMult ?? 1.5;
  const critBundle = applyExposeCritBonuses(attacker, target, baseCritChance, baseCritMult);
  try { _pushBreakdown({ label: 'critChance', value: Math.round(critBundle.critChance) }); } catch { }

  const critRoll = Phaser?.Math?.Between ? Phaser.Math.Between(1, 100) : (Math.floor(Math.random() * 100) + 1);
  const isCrit = critRoll <= critBundle.critChance;
  if (isCrit) {
    const prev = baseDamage;
    baseDamage = Math.floor(baseDamage * critBundle.critMult);
    try { _pushBreakdown({ label: 'crit', from: prev, mult: critBundle.critMult, to: baseDamage }); } catch { }
  }

  const gearMult = getAttackerDamageMultiplier(attacker);
  if (gearMult !== 1) {
    const prev = baseDamage;
    baseDamage = Math.max(0, Math.floor(baseDamage * gearMult));
    try { _pushBreakdown({ label: 'gear damage', from: prev, mult: gearMult, to: baseDamage }); } catch { }
  }

  // physical = weapon swing; elemental = weapon elemental flats; necrotic = from conversions
  let physical = baseDamage;
  let elemental = 0;
  let necrotic = 0;

  // Weapon elemental flat adds (Flay/Curse amps via applyDamageModifiers; no DR here)
  for (const [element, range] of Object.entries(weaponMods.elementalFlat || {})) {
    if (!range) continue;
    const minFlat = range.min || 0;
    const maxFlat = range.max || 0;
    if (minFlat === 0 && maxFlat === 0) continue;

    const rollFn = Phaser?.Math?.Between
      ? Phaser.Math.Between
      : ((lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1)));
    const rolled = rollFn(minFlat, maxFlat);
    let scaled = Math.max(0, Math.floor(rolled * localDamageMult));
    if (scaled <= 0) continue;

    const elementMult = getAttackerDamageMultiplier(attacker, { element });
    if (elementMult !== 1) {
      scaled = Math.max(0, Math.floor(scaled * elementMult));
    }

    // Apply Flay/Curse amps — DR is handled per-type at CombatScene apply step
    let applied = applyDamageModifiers(scaled, attacker, target, {
      element,
      isMagic: true,
      ability,
      skipGearMultiplier: true
    });

    if (applied > 0) {
      elemental += applied;
      try { _pushBreakdown({ label: `${element} flat`, flat: applied }); } catch { }
    }
  }

  // Jewelry damage conversions (from attacker's gearEffects — set by CharacterBuilder)
  const ge = attacker?.gearEffects || {};
  if (ge.physToElemPercent) {
    const conv = Math.floor(physical * ge.physToElemPercent / 100);
    physical -= conv;
    elemental += conv;
  }
  if (ge.physToNecroPercent) {
    const conv = Math.floor(physical * ge.physToNecroPercent / 100);
    physical -= conv;
    necrotic += conv;
  }
  if (ge.elemToNecroPercent) {
    const conv = Math.floor(elemental * ge.elemToNecroPercent / 100);
    elemental -= conv;
    necrotic += conv;
  }

  // Weakness pipeline: Cold T2 penalty + Lightning jolts (modifies physical & elemental)
  const pipeResult = applyWeaknessDamagePipeline(physical, elemental, attacker, target, ability);
  physical = pipeResult.physical;
  elemental = pipeResult.elemental;
  necrotic = Math.max(0, necrotic);

  if (attacker) attacker.__gearAppliedForLastDamage = true;

  const amount = physical + elemental + necrotic;
  return { physical, elemental, necrotic, amount, isCrit };
}


export function calculateDualWieldDamage(attacker, target) {
  try { _resetDamageBreakdown(); } catch { }

  let totalPhysical = 0, totalElemental = 0, totalNecrotic = 0;
  let isCrit = false;

  const mainWeaponData = getEquippedWeaponData(attacker, 'weaponMain');
  const offWeaponData = getEquippedWeaponData(attacker, 'weaponOff');
  const mainIsTwoHand = mainWeaponData?.hands === 2;
  const offUsable = !!(offWeaponData && offWeaponData.weaponType !== 'shield' && !mainIsTwoHand);

  // --- Main hand swing ---
  const mainResult = calculateDamage(attacker, target);
  const mainScale = offUsable ? 0.75 : 1.0;
  const mainP = Math.floor((mainResult.physical || 0) * mainScale);
  const mainE = Math.floor((mainResult.elemental || 0) * mainScale);
  const mainN = Math.floor((mainResult.necrotic || 0) * mainScale);
  totalPhysical += mainP;
  totalElemental += mainE;
  totalNecrotic += mainN;
  if (mainResult.isCrit) isCrit = true;

  // --- Offhand swing (if valid) ---
  if (offUsable) {
    const originalMain = attacker.equipment.weaponMain;
    attacker.equipment.weaponMain = attacker.equipment.weaponOff;
    const offResult = calculateDamage(attacker, target);
    attacker.equipment.weaponMain = originalMain;

    const offP = Math.floor((offResult.physical || 0) * 0.75);
    const offE = Math.floor((offResult.elemental || 0) * 0.75);
    const offN = Math.floor((offResult.necrotic || 0) * 0.75);
    totalPhysical += offP;
    totalElemental += offE;
    totalNecrotic += offN;
    if (offResult.isCrit) isCrit = true;

    try {
      _pushBreakdown({ label: 'Dual Main', flat: mainP + mainE + mainN });
      _pushBreakdown({ label: 'Dual Off', flat: offP + offE + offN });
    } catch { }
  } else {
    try { _pushBreakdown({ label: 'Dual Main', flat: mainP + mainE + mainN }); } catch { }
  }

  const amount = totalPhysical + totalElemental + totalNecrotic;
  return { physical: totalPhysical, elemental: totalElemental, necrotic: totalNecrotic, amount, isCrit };
}

// Fire spell — pure elemental; returns typed split
export function calculateFireballDamage(attacker, target) {
  try { _resetDamageBreakdown(); } catch { }
  const intMod = attacker.totalStats?.INT || 0;
  const base = 6 + Math.floor(intMod / 4);
  const critChance = attacker.derived?.CritChance || 0;
  try { _pushBreakdown({ label: 'critChance', value: Math.round(critChance) }); } catch { }

  const cm = attacker?.derived?.CritMult ?? 1.5;
  const isCrit = Phaser.Math.Between(1, 100) <= critChance;
  const amount = isCrit ? Math.floor(base * cm) : base;
  try {
    _pushBreakdown({ label: 'base', value: base });
    if (isCrit) _pushBreakdown({ label: 'crit', from: base, mult: cm, to: amount });
  } catch { }
  return { physical: 0, elemental: amount, necrotic: 0, amount, isCrit, isMagic: true };
}


// Legacy tag-based post modifiers (kept, but now via an options object)
export function applyDamageModifiers(amount, attacker, target, opts = {}) {
  // ---- Safe locals (prevents ReferenceError on ability/intents/tags) ----
  const ability = opts?.ability ?? null;
  const intent = opts?.intent ?? null;
  const isMagic = !!opts?.isMagic;
  const element = opts?.element ?? null;

  // Tags can come from several places:
  const tagsList =
    opts?.tags ??
    intent?.tags ??
    ability?.tags ??
    null; // may be null/undefined

  // If callers pass legacy boolean flags like { curse: true }, use them too:
  const tagFlags = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};

  let out = amount | 0;

  const autoSkip = attacker && attacker.__gearAppliedForLastDamage;
  if (autoSkip) attacker.__gearAppliedForLastDamage = false;

  if (!opts?.skipGearMultiplier && !autoSkip && attacker) {
    const mult = getAttackerDamageMultiplier(attacker, { element });
    if (mult !== 1) {
      const prev = out;
      out = Math.max(0, Math.floor(out * mult));
      try { _pushBreakdown({ label: 'gear damage', from: prev, mult, to: out }); } catch { }
    }
  }


  // ---- (Legacy) Flay universal amp (keep until you fully migrate) ----
  const flayTier = target?.weakness?.tiers?.flay || 0;
  if (flayTier === 1) {
    const prev = out; out = Math.floor(out * 1.10);
    try { _pushBreakdown({ label: 'Flay T1 amp', mult: 1.10, from: prev, to: out }); } catch { }
  } else if (flayTier === 2) {
    const prev = out; out = Math.floor(out * 1.20);
    try { _pushBreakdown({ label: 'Flay T2 amp', mult: 1.20, from: prev, to: out }); } catch { }
  }

  // ---- Curse T2 amplifies CURSE-tagged abilities (damage path) ----
  const curseTagged = !!(tagFlags.curse || (Array.isArray(tagsList) && tagsList.includes('curse')));
  const curseT = target?.weakness?.tiers?.curse | 0;
  if (curseTagged && curseT >= 2) {
    const m = target?.weakness?.meters?.curse | 0;
    const baseAmp = WeaknessV3?.families?.curse?.t2?.curseAmpMult ?? 1; // e.g. 1.25
    const I = (typeof weaknessIntensityMult === 'function') ? weaknessIntensityMult(m) : 1;
    const mult = Math.max(1, baseAmp * (I > 0 ? I : 1)); // optional clamp if you want
    const prev = out; out = Math.floor(out * mult);
    try { _pushBreakdown({ label: 'Curse T2 curse-amp', mult, from: prev, to: out }); } catch { }
  }

  // ---- Optional element hook (only if explicitly enabled) ----
  const enableElementBonus = !!opts?.enableElementBonus;
  if (element && enableElementBonus) {
    const t = target?.weakness?.tiers?.[element] | 0;
    if (t === 2) {
      const mult = opts?.elementBonusMult ?? 1.10;
      const prev = out; out = Math.floor(out * mult);
      try { _pushBreakdown({ label: `${element} T2 amp`, mult, from: prev, to: out }); } catch { }
    }
  }

  return out;
}


// --------------------------------------------------
// NEW: One-call attack resolver (hit → crit → riders)
// --------------------------------------------------
export function resolveAttack(attacker, target, ability = null) {
  const { hit, chance } = rollToHit(attacker, target, ability);
  if (!hit) {
    return { hit: false, chance, physical: 0, elemental: 0, necrotic: 0, amount: 0, isCrit: false };
  }

  const result = calculateDamage(attacker, target, ability);
  return { hit: true, chance, ...result };
}