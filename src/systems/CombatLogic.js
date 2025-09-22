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

  const raw = 75 + (A.Accuracy | 0) - (evasionEff | 0);
  return Math.max(5, Math.min(95, raw));
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
  try {
    const base = 1000;
    let out = base;
    if (typeof applyDamageModifiers === 'function') {
      out = applyDamageModifiers(base, /*attacker*/ null, target, opts);
    }
    const red = 1 - (out / Math.max(1, base));
    return Math.max(0, Math.min(100, Math.round(red * 100)));
  } catch {
    return 0;
  }
}

// === Effective Physical Damage Reduction (additive model) ===
// Returns percent integer for UI (e.g., 15 => "15%"; -10 => "-10%")
export function getEffectivePDR(char) {
  // Base DR as decimal (e.g., 0.15 = 15%); use your real base source here
  let dr = Number(char.physDR ?? 0);

  // Add any other *additive* sources your engine uses here, e.g. armor pieces:
  // dr += (char.armorDR ?? 0) + (char.buffDR ?? 0) - (char.debuffDR ?? 0);

  // Expose T1+ subtracts additively
  const w = char?.weakness;
  if (w && (w.tiers?.expose | 0) >= 1) {
    const I = familyIntensityMult('expose', w.meters?.expose | 0);
    const sub = (WeaknessV3?.families?.expose?.t1?.physDRPen ?? 0) * I; // absolute points
    dr = dr - sub;
  }

  // Upper cap keeps invulnerability sane; **no lower cap** per your spec.
  if (dr > 0.95) dr = 0.95;

  return Math.round(dr * 100);
}


export function getEffectiveMDR(target) {
  // Magic pipeline; element doesn't matter if your MDR is global
  return estimateDRPercent(target, { isMagic: true, element: 'arcane' });
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

    if (!resultMutable.isCrit) {
      if (Math.random() < dChance) {
        resultMutable.isCrit = true;
        const baseCritMult = 1.5; // keep in sync with engine baseline
        resultMutable.amount = Math.floor((resultMutable.amount | 0) * baseCritMult * (1 + dCrit));
        dbg.critForced = true;
      }
    } else {
      resultMutable.amount = Math.floor((resultMutable.amount | 0) * (1 + dCrit));
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
// Weakness riders applied on hit (Lightning, Expose(T1 DR), Cold T2 dmg-out)
// --------------------------------------------------
function applyWeaknessDamagePipeline(base, attacker, target, ability) {
  let amount = base;
  // Magic-only flat damage we will add AFTER physical-only modifiers (e.g., PDR/Expose)
  let pendingMagicAdd = 0;

  const w = target?.weakness;
  if (!w) return amount;

  // Attacker under Cold T2 → deals less damage (overflow-scaled, capped)
  {
    const wa = attacker?.weakness;
    if (wa && ((wa.tiers?.cold | 0) >= 2)) {
      const m = wa.meters?.cold | 0;
      const I = familyIntensityMult('cold', m);
      const base = WeaknessV3?.families?.cold?.t2?.dmgDealtPenalty ?? 0;
      const cap = WeaknessV3?.families?.cold?.t2?.dmgDealtPenaltyCap ?? 0.35;

      const pen = Math.min(base * I, cap);       // fraction 0..cap
      const prev = amount;
      amount = Math.max(0, Math.floor(amount * (1 - pen)));
      try { _pushBreakdown?.({ label: 'Cold T2 damage-out', mult: (1 - pen), from: prev, to: amount }); } catch { }
    }
  }

  // Expose T1: physical vulnerability (reduce DR → we just amp final dmg a bit)
  if ((w.tiers[famKey(w, 'expose')] | 0) >= 1 && (ability?.isPhysical || ability?.tags?.includes('physical'))) {
    const pen = WeaknessV3.families.expose.t1.physDRPen;
    const prev_amt2 = amount; amount = Math.floor(amount * (1 + pen));
    try { _pushBreakdown({ label: 'Expose T1 phys vuln', mult: (1 + pen), from: prev_amt2, to: amount }); } catch { }
  }

  // Lightning: Zapped baseline dX jolt(s). Shocked may multi-proc jolts.
  // IMPORTANT: Do NOT add to `amount` here; stash into `pendingMagicAdd` so PDR/Expose won't touch it.
  if ((w.tiers[famKey(w, 'lightning')] | 0) >= 1) {
    const key = famKey(w, 'lightning');
    const t = w.tiers[key] | 0;
    const m = w.meters[key] | 0;

    const I = weaknessIntensityMult(m); // overflow intensity
    const dieMax = WeaknessV3.families.lightning.t1.joltDieMax ?? 0;
    const flat = WeaknessV3.families.lightning.t1.joltFlat ?? 0;

    let repeats = 1;               // T1 baseline: at least 1 jolt
    let joltTotal = 0;

    // T2: extra jolts — chance scales with overflow intensity
    if (t >= 2) {
      const baseP = WeaknessV3.families.lightning.t2.multiJoltChance ?? 0;
      const flatPI = WeaknessV3.families.lightning.t2.joltFlatChancePerIntensity ?? 0;
      const cap = WeaknessV3.families.lightning.t2.multiJoltChanceCap ?? 0.9;
      const extraMax = WeaknessV3.families.lightning.t2.extraJoltsMax ?? 3;

      // Effective per-extra roll probability:
      //   p = min(cap, baseP * I + flatPerIntensity * max(0, I - 1))
      const p = Math.min(cap, (baseP * I) + (flatPI * Math.max(0, I - 1)));

      let extra = 0;
      for (let i = 0; i < extraMax; i++) {
        if (Math.random() < p) extra++;
      }
      repeats += extra;

      // Log the chance used for visibility
      try { _pushBreakdown({ label: 'Lightning extra-proc chance', value: Math.round(p * 100) }); } catch { }
    }

    // Roll the actual jolt damage per repeat (dX or flat fallback)
    for (let r = 0; r < repeats; r++) {
      let j = 0;
      if (dieMax && dieMax > 0) {
        j = Phaser?.Math?.Between ? Phaser.Math.Between(1, dieMax) : (1 + Math.floor(Math.random() * dieMax));
      } else {
        j = flat;
      }
      joltTotal += j;
    }

    // Stash for later as MAGIC; don't add to amount here
    pendingMagicAdd += joltTotal;

    // Optional: pre-add breakdown line showing raw jolts count/total (we'll still push a final applied line too)
    try { if (joltTotal > 0) _pushBreakdown({ label: `Lightning Jolt (raw) x${repeats}`, flat: joltTotal }); } catch { }
  }

  // === Add MAGIC-TYPED pending damage now (bypasses PDR/Expose physical) ===
  if (pendingMagicAdd > 0) {
    let magicAdd = pendingMagicAdd;
    // If you want Curse (magic vuln) / elemental res to apply, run through modifiers as magic
    try {
      if (typeof applyDamageModifiers === 'function') {
        magicAdd = applyDamageModifiers(magicAdd, attacker, target, { element: 'lightning', isMagic: true });
      }
    } catch { }
    amount += magicAdd;
    try { _pushBreakdown({ label: 'Lightning Jolt (magic)', flat: magicAdd }); } catch { }
  }

  return amount;
}


// --------------------------------------------------
// Existing damage calcs (kept for compatibility)
// --------------------------------------------------
export function calculateDamage(attacker, target, ability = null) {
  try { _resetDamageBreakdown(); } catch { }
  let min = 1, max = 2;
  const weaponData = getEquippedWeaponData(attacker, 'weaponMain');
  if (weaponData?.damage) { min = weaponData.damage.min; max = weaponData.damage.max; }

  // STR scaling (your rule)
  const strengthMod = Math.floor((attacker.totalStats?.STR || 0) / 5);
  let baseDamage = Phaser.Math.Between(min, max) + strengthMod;
  try { _pushBreakdown({ label: 'base', value: baseDamage }); } catch { }

  // Crit chance from attacker + weapon; CritMult from derived (NOT hardcoded)
  const weaponCrit = weaponData?._derivedMods?.CritChance || 0;
  const critChance = (attacker.derived?.CritChance || 0) + weaponCrit;
  try { _pushBreakdown({ label: 'critChance', value: Math.round(critChance) }); } catch { }

  const cm = attacker?.derived?.CritMult ?? 1.5;

  const isCrit = Phaser.Math.Between(1, 100) <= critChance;
  if (isCrit) {
    const prev = baseDamage;
    baseDamage = Math.floor(baseDamage * cm);
    try { _pushBreakdown({ label: 'crit', from: prev, mult: cm, to: baseDamage }); } catch { }
  }

  const final = applyWeaknessDamagePipeline(baseDamage, attacker, target, ability);
  return { amount: final, isCrit };
}


export function calculateDualWieldDamage(attacker, target) {
  // Optional: clear then add a simple summary to the breakdown for the combat log
  try { _resetDamageBreakdown(); } catch { }

  let totalAmount = 0;
  let isCrit = false;

  const mainWeaponData = getEquippedWeaponData(attacker, 'weaponMain');
  const offWeaponData = getEquippedWeaponData(attacker, 'weaponOff');
  const mainIsTwoHand = mainWeaponData?.hands === 2;

  // Offhand counts only if it exists, isn't a shield, and main isn't 2H
  const offUsable = !!(offWeaponData && offWeaponData.weaponType !== 'shield' && !mainIsTwoHand);

  // --- Main hand swing ---
  const mainResult = calculateDamage(attacker, target);
  const mainSwing = offUsable ? Math.floor(mainResult.amount * 0.75) : mainResult.amount;
  totalAmount += mainSwing;
  if (mainResult.isCrit) isCrit = true;

  // --- Offhand swing (if valid) ---
  if (offUsable) {
    const originalMain = attacker.equipment.weaponMain;
    attacker.equipment.weaponMain = attacker.equipment.weaponOff; // temporarily treat offhand as main
    const offResult = calculateDamage(attacker, target);
    attacker.equipment.weaponMain = originalMain;

    const offSwing = Math.floor(offResult.amount * 0.75);
    totalAmount += offSwing;
    if (offResult.isCrit) isCrit = true;

    // Optional: breakdown entries so the log shows the two contributions
    try {
      _pushBreakdown({ label: 'Dual Main', flat: mainSwing });
      _pushBreakdown({ label: 'Dual Off', flat: offSwing });
    } catch { }
  } else {
    // Optional: still show main contribution if no offhand swing
    try { _pushBreakdown({ label: 'Dual Main', flat: mainSwing }); } catch { }
  }

  return { amount: totalAmount, isCrit };
}

// Fire spell (kept)
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
  return { amount, isCrit, isMagic: true };
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
  // 1) Roll to hit (uses Cold T2 evasion penalty internally)
  const { hit, chance } = rollToHit(attacker, target, ability);
  if (!hit) {
    return { hit: false, chance, amount: 0, isCrit: false };
  }

  // 2) Base weapon damage (no crit inside)
  let min = 1, max = 2;
  const weaponData = getEquippedWeaponData(attacker, 'weaponMain');
  if (weaponData?.damage) { min = weaponData.damage.min; max = weaponData.damage.max; }
  const strengthMod = Math.floor((attacker.totalStats?.STR || 0) / 5);
  let amount = Phaser.Math.Between(min, max) + strengthMod;

  // 3) Expose T2 crit bonuses then crit roll
  const baseCritChance = (attacker.derived?.CritChance || 0) + (weaponData?._derivedMods?.CritChance || 0);
  const baseCritMult = attacker?.derived?.CritMult ?? 1.5;
  const cb = applyExposeCritBonuses(attacker, target, baseCritChance, baseCritMult);
  const isCrit = (Phaser?.Math?.Between ? Phaser.Math.Between(1, 100) : (Math.floor(Math.random() * 100) + 1)) <= cb.critChance;
  try { _pushBreakdown({ label: 'critChance', value: Math.round(cb.critChance) }); } catch { }
  if (isCrit) amount = Math.floor(amount * cb.critMult);

  // 4) Apply weakness riders (Lightning, Expose T1 phys vuln, Cold T2 dmg-out)
  amount = applyWeaknessDamagePipeline(amount, attacker, target, ability);

  return { hit: true, chance, amount, isCrit };
}