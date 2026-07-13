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
  // Each effect can have: { mods: { Accuracy:+5, Evasion:-10, AttackPower:+15, ... } }
  const out = {
    Accuracy: 0, Evasion: 0, Initiative: 0, CritChance: 0, CritMult: 0,
    ElementalResist: 0, PhysicalResist: 0, NecroticResist: 0,
    AttackPower: 0, // % bonus to all outgoing damage (e.g. war_cry_buff)
    // % bonus to outgoing HEALING specifically — deliberately separate from
    // Proficiency (a highest-core-stat bonus that also touches healing) so
    // the two don't get conflated into one number; this one is purely a
    // combat-buff source. No skill grants it yet — architecture in place for
    // when one does.
    HealingPower: 0,
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
    NecroticResist: (d.NecroticResist | 0) + (b.NecroticResist | 0) + s.NecroticResist,
    AttackPower: (d.AttackPower | 0) + (b.AttackPower | 0) + s.AttackPower,
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

  // Balance-only dial (e.g. a boss's un-tuned overall damage trim) — applies
  // the same way globalDamagePercent does, but deliberately kept OUT of the
  // character sheet's PD/ED/ND display, which only reads globalDamagePercent.
  // Not a player-facing buff/debuff, just a dev lever.
  if (ge.hiddenDamagePercent) {
    mult *= 1 + (ge.hiddenDamagePercent / 100);
  }

  return mult;
}

// Proficiency — a %damage multiplier off the attacker's single highest core
// stat (STR/DEX/CON/INT/WIS/CHA), deliberately its own multiplicative step,
// separate from gear's globalDamagePercent above. Lets any build raise
// damage without specifically pumping STR (which still gates the flat
// base-damage floor in calculateDamage()) — a build's best stat, whatever it
// is, contributes here. +1% per point above 10, floored at 0 (no penalty for
// a low peak stat — that's the future "Deficiency" stat's job, not this one).
export function getProficiencyMultiplier(attacker) {
  const s = attacker?.totalStats || {};
  const highest = Math.max(s.STR || 0, s.DEX || 0, s.CON || 0, s.INT || 0, s.WIS || 0, s.CHA || 0);
  const bonusPct = Math.max(0, highest - 10);
  return 1 + (bonusPct / 100);
}
// Display-only helper (CombatScene.js equipment tab) — same formula as
// getProficiencyMultiplier above, but returns the raw %/driving-stat pair
// instead of a multiplier, so the UI doesn't need to reverse-engineer it.
export function getProficiencyBreakdown(char) {
  const s = char?.totalStats || {};
  const keys = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
  let bestKey = 'STR', bestVal = -Infinity;
  for (const k of keys) {
    const v = s[k] || 0;
    if (v > bestVal) { bestVal = v; bestKey = k; }
  }
  return { stat: bestKey, value: bestVal, bonusPct: Math.max(0, bestVal - 10) };
}

// Excess Accuracy beyond what's needed to reach 100% hit chance converts
// into bonus Crit Chance instead of being wasted (e.g. 12 Accuracy vs 8
// Evasion would already be a guaranteed hit at +4 to spare — that +4 buys
// extra precision on the crit roll instead of doing nothing).
export function getAccuracyOverflow(attacker, target) {
  const A = getEffectiveDerived(attacker);
  const T = getEffectiveDerived(target);
  const evasionEff = applyColdEvasionPenalty(target, T.Evasion | 0);
  const raw = 100 - (evasionEff | 0) + (A.Accuracy | 0);
  return Math.max(0, raw - 100);
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
  // Necrotic has its own NecroticResist stat — only routed here when the
  // caller explicitly says damageType:'necrotic'; a bare isMagic:true with no
  // damageType (e.g. a generic spell) still falls back to ElementalResist,
  // same as before.
  const damageType = opts.damageType;
  const isNecrotic = damageType === 'necrotic';
  const isMagic = opts.isMagic != null
    ? !!opts.isMagic
    : (damageType === 'elemental' || isNecrotic);

  let dr = 0;
  if (isNecrotic) {
    dr += (eff.NecroticResist || 0) / 100;
    if (Number.isFinite(target.magDR)) dr += target.magDR;
  } else if (isMagic) {
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

export function getEffectiveEDR(char) {
  return Math.round(getDamageReductionFraction(char, { damageType: 'elemental' }) * 100);
}

export function getEffectiveNDR(char) {
  return Math.round(getDamageReductionFraction(char, { damageType: 'necrotic' }) * 100);
}

// === Expose pre-damage shaping (additive PDR model) ===
// T1 (Raw) only: subtracts additive PDR points from the target's physical DR.
// T2 (Flayed) crit vulnerability is NOT handled here — it's a flat bonus to crit
// chance/mult added before the single crit roll in calculateDamage() via
// applyExposeCritBonuses(). An earlier version of this function also rolled a
// SEPARATE post-hoc chance to force/amplify a crit here, which double-counted
// on top of that pre-roll bonus (was test-only scaffolding, removed).
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
// Weakness riders applied on hit (Cold T2 dmg-out)
// Expose T1 DR penalty is a delta on resultMutable.damageReduction via applyExposePreDamage.
// Lightning jolts are NOT handled here — see applyLightningJolt() below, which
// is added after the crit multiplier in calculateDamage() so jolt damage can
// never itself be crit-amplified.
// Signature: (physical, elemental, necrotic, attacker, target, ability) → { physical, elemental, necrotic }
// --------------------------------------------------
function applyWeaknessDamagePipeline(physical, elemental, necrotic, attacker, target, ability) {
  // Attacker under Cold T2 → deals less physical, elemental, AND necrotic
  // damage (overflow-scaled, capped) — previously only reduced physical and
  // elemental, silently leaving necrotic output untouched.
  {
    const wa = attacker?.weakness;
    if (wa && ((wa.tiers?.cold | 0) >= 2)) {
      const m = wa.meters?.cold | 0;
      const I = familyIntensityMult('cold', m);
      const basePen = WeaknessV3?.families?.cold?.t2?.dmgDealtPenalty ?? 0;
      const capPen = WeaknessV3?.families?.cold?.t2?.dmgDealtPenaltyCap ?? 0.35;
      const pen = Math.min(basePen * I, capPen);
      const prevTotal = physical + elemental + necrotic;
      physical = Math.max(0, Math.floor(physical * (1 - pen)));
      elemental = Math.max(0, Math.floor(elemental * (1 - pen)));
      necrotic = Math.max(0, Math.floor(necrotic * (1 - pen)));
      try { _pushBreakdown?.({ label: 'Cold T2 damage-out', mult: (1 - pen), from: prevTotal, to: physical + elemental + necrotic }); } catch { }
    }
  }

  return { physical: Math.max(0, physical), elemental: Math.max(0, elemental), necrotic: Math.max(0, necrotic) };
}

// --------------------------------------------------
// Lightning jolts: a flat, non-crittable rider added to the elemental bucket
// AFTER the crit multiplier (see calculateDamage) — it bypasses PhysicalResist
// (elemental bucket) but is deliberately excluded from crit amplification,
// same as a rider like Curse of Needles rather than part of the base swing.
// Intensity currently only scales the CHANCE of extra jolts (T2); the size of
// each individual jolt (1..dieMax) stays flat/unscaled regardless of overflow.
// Signature: (target) → { joltTotal }
// Exported so CombatScene.js can call it as the true final step for
// typed-pipeline skills — AFTER applyGearConversionAndPercent — instead of
// inside applyTypedDamageModifiers, where gear conversion/gear% couldn't
// avoid touching it. Pure function of the TARGET's weakness state, no side
// effects, so WHEN it's called doesn't change what it rolls.
// --------------------------------------------------
export function applyLightningJolt(target) {
  const w = target?.weakness;
  if (!w) return { joltTotal: 0 };

  const key = famKey(w, 'lightning');
  const t = w.tiers?.[key] | 0;
  if (t < 1) return { joltTotal: 0 };

  const m = w.meters?.[key] | 0;
  const I = familyIntensityMult('lightning', m);
  const dieMax = WeaknessV3.families.lightning.t1.joltDieMax ?? 0;
  const flat = WeaknessV3.families.lightning.t1.joltFlat ?? 0;

  let repeats = 1;
  let joltTotal = 0;

  if (t >= 2) {
    const baseP = WeaknessV3.families.lightning.t2.multiJoltChance ?? 0;
    const capP = WeaknessV3.families.lightning.t2.multiJoltChanceCap ?? 0.9;
    const extraMax = WeaknessV3.families.lightning.t2.extraJoltsMax ?? 3;
    const p = Math.min(capP, baseP * I);
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

  try { if (joltTotal > 0) _pushBreakdown({ label: `Lightning Jolt x${repeats}`, flat: joltTotal }); } catch { }
  return { joltTotal };
}

// --------------------------------------------------
// Tier-1 "+X weapon damage" riders (e.g. Curse of Needles): baked directly
// into the base weapon roll, BEFORE anything else (skill%, combat buffs,
// gear, crit) — so they ride the entire multiplicative stack, same as any
// other point of weapon damage. Live on the TARGET's own statusEffects
// (se.onHit.weaponDamageFlat), fire on every hit taken while active, for any
// attacker/skill (legacy or typed) — this check lives in calculateDamage()
// itself so it's universal, not gated behind the typed pipeline.
// Signature: (target) → flat total to add to baseDamage
// --------------------------------------------------
function applyCurseWeaponRiders(target) {
  if (!Array.isArray(target?.statusEffects)) return 0;
  let total = 0;
  for (const se of target.statusEffects) {
    const flatBase = se?.onHit?.weaponDamageFlat;
    if (!(flatBase > 0)) continue;
    let flat = flatBase;
    if (se.onHit.curseScaled) {
      const curseTier = target?.weakness?.tiers?.curse | 0;
      if (curseTier >= 2) {
        const m = target?.weakness?.meters?.curse | 0;
        const baseAmp = WeaknessV3?.families?.curse?.t2?.curseAmpMult ?? 1;
        const I = weaknessIntensityMult(m);
        const mult = Math.max(1, baseAmp * (I > 0 ? I : 1));
        flat = Math.floor(flat * mult);
      }
    }
    total += flat;
    try { _pushBreakdown({ label: se.name || 'Weapon damage rider', flat }); } catch { }
  }
  return total;
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

  // Local weapon damage% scales the WEAPON's own dice roll — same "local"
  // modifier PoE uses on weapon prefixes, treated as part of the weapon's own
  // damage rather than a combat-stage buff. It was already applied to weapon
  // elemental flats below, but not to the physical die roll itself, so a
  // weapon with local% but no elemental flat got no benefit from it at all.
  const dieRoll = Phaser.Math.Between(min, max);
  const scaledDieRoll = Math.floor(dieRoll * localDamageMult);

  // STR scaling — a character-level bonus, not part of "the weapon's own"
  // damage, so it's added AFTER local% rather than being scaled by it.
  const strengthMod = Math.floor((attacker.totalStats?.STR || 0) / 5);
  let baseDamage = scaledDieRoll + strengthMod;
  try { _pushBreakdown({ label: 'base', value: baseDamage }); } catch { }

  // Tier-1 "+X weapon damage" riders (e.g. Curse of Needles) — baked in here,
  // before gear/skill%/buffs/crit, so they ride the whole multiplicative stack.
  baseDamage += applyCurseWeaponRiders(target);

  // Crit chance/mult resolved now (Expose T2 can boost both via applyExposeCritBonuses),
  // but the multiply itself is deferred to the very end of this function so it scales
  // the WHOLE hit (physical + elemental + necrotic) uniformly — a crit is "the swing
  // lands harder," not a physical-only effect. Previously it multiplied baseDamage here,
  // before the physical/elemental split, so a weapon's flat elemental/necrotic bonus
  // never benefited from a crit at all.
  // getEffectiveDerived (not attacker.derived directly) so status-effect mods —
  // e.g. Needle Feint's +15% CritChance buff on crossing an Expose tier — are
  // actually read. Using attacker.derived here would silently ignore them: the
  // buff would still get applied and expire on schedule, it just never affected
  // any crit roll.
  const weaponCrit = weaponData?._derivedMods?.CritChance || 0;
  const effDerived = getEffectiveDerived(attacker) || {};
  // Per-ability bonus crit chance vs a specific weakness tier (e.g. Silent
  // Order vs an Exposed/Raw target) — additive percentage points, distinct
  // from the global Expose T2 crit bonus below (applyExposeCritBonuses),
  // which applies to every attack regardless of ability. Reusable: any
  // ability can declare critChanceIfWeak (array of {family, tierAtLeast,
  // bonusPct}), same shape as rewardIfWeak, highest tier met wins.
  let abilityCritBonus = 0;
  if (Array.isArray(ability?.critChanceIfWeak)) {
    const tw = target?.weakness;
    const matched = ability.critChanceIfWeak
      .filter(r => (tw?.tiers?.[r.family] || 0) >= (r.tierAtLeast ?? 1))
      .sort((a, b) => (b.tierAtLeast ?? 1) - (a.tierAtLeast ?? 1))[0];
    if (matched) abilityCritBonus = matched.bonusPct || 0;
  }
  let baseCritChance = (effDerived.CritChance || 0) + weaponCrit + abilityCritBonus;
  // Excess Accuracy (beyond what's needed to guarantee the hit) converts at
  // half value into bonus Crit Chance instead of being wasted past the 100%
  // hit chance cap — half weight to match Evasion's half-weight crit effect
  // below, so neither side of the accuracy/evasion relationship dominates
  // the crit roll on its own — see getAccuracyOverflow.
  const accuracyOverflow = getAccuracyOverflow(attacker, target) * 0.5;
  if (accuracyOverflow > 0) {
    const prev = baseCritChance;
    baseCritChance += accuracyOverflow;
    try { _pushBreakdown({ label: 'accuracy overflow vs crit', from: prev, value: Math.round(baseCritChance) }); } catch { }
  }
  // Evasion double-duty: on a landed hit, target Evasion also partially
  // resists the crit itself (retired CritAvoid's job — that stat was computed
  // but never actually read by the crit roll, so this is Evasion's alone now).
  // Half weight: full Evasion already fully governs whether the hit lands at
  // all via computeHitChance, so only half again counts a second time here.
  const targetEvasionEff = applyColdEvasionPenalty(target, getEffectiveDerived(target).Evasion | 0);
  const critAvoidance = targetEvasionEff * 0.5;
  if (critAvoidance > 0) {
    const prev = baseCritChance;
    baseCritChance = Math.max(0, baseCritChance - critAvoidance);
    try { _pushBreakdown({ label: 'evasion vs crit', from: prev, value: Math.round(baseCritChance) }); } catch { }
  }
  const baseCritMult = effDerived.CritMult || 1.5;
  const critBundle = applyExposeCritBonuses(attacker, target, baseCritChance, baseCritMult);
  try { _pushBreakdown({ label: 'critChance', value: Math.round(critBundle.critChance) }); } catch { }

  const critRoll = Phaser?.Math?.Between ? Phaser.Math.Between(1, 100) : (Math.floor(Math.random() * 100) + 1);
  const isCrit = critRoll <= critBundle.critChance;

  // Typed-pipeline skills (ability.typedDamage) DEFER gear damage% to the very
  // end of the whole cast — see applyGearConversionAndPercent, called from
  // CombatScene.js AFTER ability.apply() (including the skill's own manual
  // type conversion, e.g. Boulder Toss's Ablaze phys→elem) has fully
  // resolved. Applying it here instead, before the skill has even run, would
  // mean gear's type-specific bonuses (and the Elseth conversion amulets
  // below) only ever see the weapon's ORIGINAL composition, never anything a
  // skill converts later — see project_damage_pipeline_reorder memory.
  // Legacy (non-typed) skills are unaffected — they keep this early
  // application exactly as before.
  const gearMult = ability?.typedDamage ? 1 : getAttackerDamageMultiplier(attacker);
  if (gearMult !== 1) {
    const prev = baseDamage;
    baseDamage = Math.max(0, Math.floor(baseDamage * gearMult));
    try { _pushBreakdown({ label: 'gear damage', from: prev, mult: gearMult, to: baseDamage }); } catch { }
  }

  // physical = weapon swing; elemental = weapon elemental flats; necrotic = from conversions
  let physical = baseDamage;
  let elemental = 0;
  let necrotic = 0;

  // Weapon elemental flat adds. Flay/Curse/AttackPower amps are NOT applied here —
  // they're applied once by the calling skill's own applyDamageModifiers() pass
  // over the full returned amount (physical+elemental+necrotic combined). Doing it
  // here too used to double-apply Flay T2 (and Curse T2/AttackPower) on top of the
  // elemental portion — it silently didn't matter while the Flay tier check was
  // reading a dead key, but became a real double-count once that key was fixed.
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

    const elementMult = ability?.typedDamage ? 1 : getAttackerDamageMultiplier(attacker, { element });
    if (elementMult !== 1) {
      scaled = Math.max(0, Math.floor(scaled * elementMult));
    }

    if (scaled > 0) {
      elemental += scaled;
      try { _pushBreakdown({ label: `${element} flat`, flat: scaled }); } catch { }
    }
  }

  // Jewelry damage conversions (from attacker's gearEffects — set by CharacterBuilder).
  // Logged to the breakdown so the tooltip actually shows the split happening
  // (e.g. "10 physical -> 7 physical / 3 necrotic"), not just the end result.
  // Uses `convert` (not `flat`) so the formula renderer in CombatScene.js shows
  // it as "(3 phys→ele)" instead of "+3 ..." — a `flat` entry reads as an
  // ADDITION to the total, but a conversion is a net-zero redistribution
  // between two typed buckets, not new damage.
  //
  // Typed-pipeline skills defer this to applyGearConversionAndPercent (see
  // comment above the early gear% block) — same reasoning: run it here and a
  // skill's own later conversion (Boulder Toss's Ablaze phys→elem) would
  // move damage into a bucket this step already finished checking, so the
  // amulet silently converts nothing. Legacy (non-typed) skills keep the
  // original early-conversion behavior unchanged.
  const ge = attacker?.gearEffects || {};
  if (!ability?.typedDamage) {
    if (ge.physToElemPercent) {
      const conv = Math.floor(physical * ge.physToElemPercent / 100);
      physical -= conv;
      elemental += conv;
      try { if (conv > 0) _pushBreakdown({ label: 'phys→ele', convert: conv }); } catch { }
    }
    if (ge.physToNecroPercent) {
      const conv = Math.floor(physical * ge.physToNecroPercent / 100);
      physical -= conv;
      necrotic += conv;
      try { if (conv > 0) _pushBreakdown({ label: 'phys→necro', convert: conv }); } catch { }
    }
    if (ge.elemToNecroPercent) {
      const conv = Math.floor(elemental * ge.elemToNecroPercent / 100);
      elemental -= conv;
      necrotic += conv;
      try { if (conv > 0) _pushBreakdown({ label: 'elem→necro', convert: conv }); } catch { }
    }
  }

  // Weakness pipeline: Cold T2 damage-dealt penalty (modifies physical, elemental & necrotic)
  const pipeResult = applyWeaknessDamagePipeline(physical, elemental, necrotic, attacker, target, ability);
  physical = pipeResult.physical;
  elemental = pipeResult.elemental;
  necrotic = pipeResult.necrotic;

  // Proficiency — own multiplicative step, uniform across all three typed
  // components (same "whole hit" treatment as crit below), applied to both
  // legacy and typed-pipeline skills since it happens here in the shared
  // calculateDamage() rather than in either path's own finalize step.
  const profMult = getProficiencyMultiplier(attacker);
  if (profMult !== 1) {
    const prevSum = physical + elemental + necrotic;
    physical = Math.floor(physical * profMult);
    elemental = Math.floor(elemental * profMult);
    necrotic = Math.floor(necrotic * profMult);
    try { _pushBreakdown({ label: 'proficiency', from: prevSum, mult: profMult, to: physical + elemental + necrotic }); } catch { }
  }

  // Only true when gear% was actually applied above (legacy/non-typed skills)
  // — typed-pipeline skills defer it, so this must NOT claim it happened.
  if (attacker) attacker.__gearAppliedForLastDamage = !ability?.typedDamage;

  // Typed-pipeline skills (ability.typedDamage === true) defer crit AND jolt to
  // applyTypedDamageModifiers(), which applies them AFTER the skill's own
  // weapon% and combat buffs — see that function for why. Legacy (scalar-path)
  // skills keep the original behavior unchanged below: crit and jolt applied
  // right here, since those skills have no later "finalize" step to defer to.
  if (ability?.typedDamage) {
    const amount = physical + elemental + necrotic;
    return { physical, elemental, necrotic, amount, isCrit, critMult: critBundle.critMult };
  }

  // Crit — last step before returning, whole hit, uniform across all three types.
  if (isCrit) {
    const prevSum = physical + elemental + necrotic;
    physical = Math.floor(physical * critBundle.critMult);
    elemental = Math.floor(elemental * critBundle.critMult);
    necrotic = Math.floor(necrotic * critBundle.critMult);
    try { _pushBreakdown({ label: 'crit', from: prevSum, mult: critBundle.critMult, to: physical + elemental + necrotic }); } catch { }
  }

  // Lightning jolts: added AFTER crit, deliberately non-crittable (a rider on
  // the hit, not part of the base swing that gets amplified).
  const { joltTotal } = applyLightningJolt(target);
  if (joltTotal > 0) elemental += joltTotal;

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
  const element = opts?.element ?? null;

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

  // AttackPower from status effect mods (e.g. war_cry_buff +15%) — always applies
  const atkPowerPct = _sumStatusEffectMods(attacker)?.AttackPower || 0;
  if (atkPowerPct !== 0) {
    const prev = out;
    const mult = 1 + atkPowerPct / 100;
    out = Math.max(0, Math.floor(out * mult));
    try { _pushBreakdown({ label: 'Generic increased damage', mult, from: prev, to: out }); } catch { }
  }

  // NOTE: there used to be a "Flay/Expose universal damage amp" here (+10%/+20%
  // flat damage vs an Exposed/Flayed target). Removed — per the actual weakness
  // design, Expose does NOT grant a flat damage bonus at either tier. T1 (Raw) is
  // a physical DR reduction (applyExposePreDamage) and increased physical-family
  // buildup taken; T2 (Flayed) is crit chance/damage only (applyExposeCritBonuses).
  // A skill can still reward hitting an Exposed/Flayed target on its own (that's a
  // Category A "this skill hits harder" bonus, not a universal weakness effect —
  // see applyTypedDamageModifiers below and Needle Venom for an example).

  // NOTE: Curse T2 (Afflicted) does NOT amplify a curse-tagged ability's own
  // damage roll — a "curse" tag just means the skill interacts with the Curse
  // weakness (e.g. applies a curse rider), not that it hits harder against an
  // Afflicted target. What Afflicted actually amplifies is the flat bonus
  // damage of active CURSE RIDER status effects (e.g. Curse of Needles) —
  // see the `onHit.curseScaled` handling in CombatScene.js, applied after
  // mitigation on the FINAL hit, not here on the skill's own base roll.

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
// Typed damage modifiers — physical/elemental/necrotic scale independently.
//
// Every "+X% damage" modifier in the game falls into one of two categories, and
// they must NOT be handled the same way:
//
//   Category A — "weapon/skill damage %": the skill's own damage-effectiveness
//   (e.g. a skill dealing 100%/115%/95% weapon damage) and any skill-specific
//   reward that means "this skill hits harder" (e.g. Needle Venom's own Flayed-
//   tier reward — a property of THAT SKILL, not of the weakness system itself).
//   These represent more of the weapon's total kit coming through, so they scale
//   physical + elemental + necrotic UNIFORMLY — a flat elemental/necrotic roll on
//   the weapon is part of "weapon damage" too. Universal gear/buff "+damage%"
//   (globalDamagePercent, AttackPower) are also Category A. Use scaleTypedDamage()
//   below for these.
//
//   Category B — "target vulnerability": a weakness-family-specific amp that
//   represents the DEFENDER's type-based weakness being exploited, scoped to only
//   the matching component — Curse (necrotic family) below is the current example.
//   Expose/Flay does NOT have one of these: per the actual design, Expose's T1
//   (Raw) effect is a physical DR reduction + increased physical-family buildup
//   taken (both handled elsewhere, see applyExposePreDamage / CombatScene buildup
//   application), and its T2 (Flayed) effect is crit chance/damage only (handled
//   in calculateDamage via applyExposeCritBonuses) — no flat damage% at either
//   tier. An earlier version of this file had a "Flay universal amp" here; it
//   didn't match the intended design and has been removed.
//
// applyDamageModifiers() above collapses everything into one scalar, which is
// exactly why Category B bonuses used to bleed into elemental/necrotic damage
// they had no business touching. This variant takes the same
// {physical, elemental, necrotic} breakdown calculateDamage() already returns
// and keeps Category B modifiers scoped — CombatScene's per-type DR step
// (physical/elemental/necrotic resist) then mitigates each component correctly
// downstream, using whatever split comes out the other end of this function.
//
// Not wired into the ~150 existing skills yet (they still use the scalar version
// above) — migrate a skill to this one deliberately, the same way Needle Venom was.
// --------------------------------------------------

// Category A helper — scales every damage type on the hit by the same multiplier.
// Use this for a skill's own damage-effectiveness and any "this skill hits harder"
// reward. Do NOT use this for target-vulnerability amps (see Category B above).
export function scaleTypedDamage(breakdown, mult) {
  const physical = Math.floor((breakdown?.physical | 0) * mult);
  const elemental = Math.floor((breakdown?.elemental | 0) * mult);
  const necrotic = Math.floor((breakdown?.necrotic | 0) * mult);
  return { physical, elemental, necrotic, amount: physical + elemental + necrotic };
}

// --------------------------------------------------
// rewardIfWeak helpers — shared by every skill using the "if target is at
// least tier X, grant this bonus" pattern (Needle Venom, Static Prick, and any
// future skill). Two small pieces, used together:
//
//   1. findRewardIfWeakRule(ability, currentTier) — picks the highest tier the
//      target currently qualifies for (matches the tooltip's own logic, so a
//      skill's damage math and its tooltip can never read different rules).
//
//   2. applyDamagePctBonus(amount, dmgPct, label) — applies a flat %-of-amount
//      bonus AND logs it to the breakdown in one call. Missing this second
//      step is exactly why Static Prick's +25% wasn't showing up: the bonus
//      was being applied correctly, just never pushed to _pushBreakdown, so
//      the log/tooltip had nothing to show even though the number was right.
//
// Only the scalar (legacy applyDamageModifiers) path is covered here — for a
// skill already migrated to the typed pipeline, scaleTypedDamage() + your own
// _pushBreakdown call (see Needle Venom) is still the right tool, since a
// typed skill needs to log a from/to on the combined {physical,elemental,
// necrotic} sum, not a single scalar.
// --------------------------------------------------
export function findRewardIfWeakRule(ability, currentTier) {
  const rules = Array.isArray(ability?.rewardIfWeak)
    ? ability.rewardIfWeak
    : (ability?.rewardIfWeak ? [ability.rewardIfWeak] : []);
  return rules
    .filter(r => currentTier >= (r.tierAtLeast ?? 1))
    .sort((a, b) => (b.tierAtLeast ?? 1) - (a.tierAtLeast ?? 1))[0];
}

export function applyDamagePctBonus(amount, dmgPct, label) {
  if (!dmgPct) return amount;
  const mult = 1 + dmgPct / 100;
  const next = Math.floor(amount * mult);
  try { _pushBreakdown({ label, mult, from: amount, to: next }); } catch { }
  return next;
}

// Shared conversion primitive — physical→elemental, then physical→necrotic,
// then elemental→necrotic, in that FIXED order, matching the canon
// conversion hierarchy (Physical → Elemental → Necrotic; Necrotic terminal;
// Elemental cannot revert to Physical). Used by BOTH a skill's own declared
// conversion (opts.skillConversion below) and gear's conversion
// (applyGearConversionAndPercent) so the two can never drift apart. `conv`
// shape: { physToElemPct, physToNecroPct, elemToNecroPct } (any subset).
function convertDamageType(physical, elemental, necrotic, conv, labelSuffix = '') {
  if (!conv) return { physical, elemental, necrotic };
  if (conv.physToElemPct) {
    const c = Math.floor(physical * conv.physToElemPct / 100);
    physical -= c; elemental += c;
    try { if (c > 0) _pushBreakdown({ label: `phys→ele${labelSuffix}`, convert: c }); } catch { }
  }
  if (conv.physToNecroPct) {
    const c = Math.floor(physical * conv.physToNecroPct / 100);
    physical -= c; necrotic += c;
    try { if (c > 0) _pushBreakdown({ label: `phys→necro${labelSuffix}`, convert: c }); } catch { }
  }
  if (conv.elemToNecroPct) {
    const c = Math.floor(elemental * conv.elemToNecroPct / 100);
    elemental -= c; necrotic += c;
    try { if (c > 0) _pushBreakdown({ label: `elem→necro${labelSuffix}`, convert: c }); } catch { }
  }
  return { physical, elemental, necrotic };
}

// --------------------------------------------------
// applyTypedDamageModifiers — the typed-pipeline "finalize" step. Order matters
// here and is deliberate (2026-07 pipeline reorder, see project_damage_pipeline_reorder
// memory for the full design discussion):
//
//   1. skill's own weapon% (opts.skillPct)      — Category A, e.g. Power Stab's 200%
//   1.5 skill's own conversion (opts.skillConversion) — e.g. Boulder Toss's
//       Ablaze phys→elem. Runs BEFORE Tier-2 riders/combat buffs/crit
//       specifically so a skill's own conversion only touches ITS OWN
//       weapon-swing-times-skillPct portion — a Tier-2 rider or combat buff
//       added afterward (by a DIFFERENT source) keeps whatever type IT
//       specifies, rather than being swept into the skill's conversion just
//       because it landed in a bucket the conversion later touches.
//   2. Tier-2 "+X [Type] damage" riders          — e.g. Blazing Fervor's fire rider
//   3. combat buffs (AttackPower, summed)         — Category A, e.g. Rhythm/War Cry
//   4. crit (opts.isCrit / opts.critMult)         — moved here from calculateDamage()
//   5. Lightning jolt                             — Tier-3 rider, non-crittable
//
// Gear% and gear conversion are NOT applied here — they're deferred even
// later, to applyGearConversionAndPercent, called from CombatScene.js AFTER
// this skill's apply() (including step 1.5 above) has fully resolved.
//
// This order is what makes a "Tier 2" rider possible: something that needs to
// be scaled by combat buffs and crit, but NOT by the skill's own weapon% (e.g.
// Blazing Fervor's onHit bonus), can simply be added to the breakdown AFTER
// step 1 resolves and BEFORE this function's steps 2-4 run — call this function
// once for the skill's own weapon%+rider math is threaded through, or add the
// rider between two calls if a skill needs that split. See CombatLogic.js
// header comment for the Tier 1/2/3 rider taxonomy this maps to.
// --------------------------------------------------
export function applyTypedDamageModifiers(breakdown, attacker, target, opts = {}) {
  // Carried as FLOATS through every multiplicative step below, floored only
  // ONCE at the very end. Flooring after each individual step (skill% → buffs
  // → crit) compounds rounding loss — e.g. base 4 through three separate
  // floor(x*mult) steps can lose a whole point versus computing the combined
  // multiplier once and flooring the final result, and it gets worse the more
  // steps are chained or the smaller the base number is. See
  // project_rounding_precision_fix memory note for a worked example.
  let physical = breakdown?.physical | 0;
  let elemental = breakdown?.elemental | 0;
  let necrotic = breakdown?.necrotic | 0;

  // Gear% already applied inside calculateDamage() for this hit — just clear
  // the marker so an unrelated later call for the same attacker doesn't
  // mistakenly skip ITS OWN gear application.
  if (attacker?.__gearAppliedForLastDamage) attacker.__gearAppliedForLastDamage = false;

  // 1) Skill's own weapon% (Category A)
  const skillMult = Number.isFinite(opts.skillPct) ? opts.skillPct / 100 : 1;
  if (skillMult !== 1) {
    const prev = physical + elemental + necrotic;
    physical *= skillMult;
    elemental *= skillMult;
    necrotic *= skillMult;
    try { _pushBreakdown({ label: opts.skillLabel || `${opts.ability?.name || 'Skill'} weapon damage (${opts.skillPct}%)`, mult: skillMult, from: Math.round(prev), to: Math.round(physical + elemental + necrotic) }); } catch { }
  }

  // 1.5) Skill's own declared conversion (opts.skillConversion) — e.g.
  // Boulder Toss's Ablaze phys→elem, Miasma Crush's forced necrotic. Runs
  // HERE, before Tier-2 riders/combat buffs/crit, so it only touches the
  // skill's own weapon-swing-times-skillPct portion — see the header comment
  // above for the worked example that established this exact placement.
  if (opts.skillConversion) {
    const converted = convertDamageType(physical, elemental, necrotic, opts.skillConversion, ' (skill)');
    physical = converted.physical;
    elemental = converted.elemental;
    necrotic = converted.necrotic;
  }

  // 2) Tier-2 "+X [Type] damage" riders (e.g. Blazing Fervor's fire rider):
  // added AFTER the skill's own weapon% (so a big skillPct doesn't touch them)
  // but BEFORE combat buffs/crit below (so both of those still apply). Live on
  // the ATTACKER's own statusEffects. Legacy (non-typed) skills still get these
  // via the flat/unmitigated fallback in CombatScene.js's onHit-proc block —
  // this is the typed-pipeline-only, properly-scaled version. Flat integer add,
  // no rounding concern of its own.
  for (const se of (attacker?.statusEffects || [])) {
    const proc = se?.onHit;
    if (!proc) continue;
    if (!se.permanent && (se.turns || 0) <= 0) continue;
    if (proc.fireDamage > 0) {
      elemental += proc.fireDamage;
      try { _pushBreakdown({ label: se.name || 'Fire rider', flat: proc.fireDamage }); } catch { }
    }
  }

  // 3) Combat buffs (Category A) — AttackPower status mods, summed across every
  // active buff into ONE multiplier (two +20% buffs = +40% total, not 1.2×1.2).
  const atkPowerPct = _sumStatusEffectMods(attacker)?.AttackPower || 0;
  if (atkPowerPct !== 0) {
    const mult = 1 + atkPowerPct / 100;
    const prev = physical + elemental + necrotic;
    physical *= mult;
    elemental *= mult;
    necrotic *= mult;
    try { _pushBreakdown({ label: 'Generic increased damage', mult, from: Math.round(prev), to: Math.round(physical + elemental + necrotic) }); } catch { }
  }

  // (No Expose/Flay entry here — see the Category B note above. Its T1/T2 effects
  // are handled elsewhere, not as a flat damage% on the hit.)

  // NOTE: no Curse T2 amp here either, for the same reason as the scalar path
  // above (applyDamageModifiers) — a curse-tagged ability's own damage roll
  // isn't what Afflicted amplifies. Curse riders are now a Tier-1 rider inside
  // calculateDamage() (applyCurseWeaponRiders), not handled here at all.

  // 4) Crit — moved here from calculateDamage() so it lands AFTER the skill's
  // own weapon% and combat buffs, not before them. Whatever is present in the
  // running total at this exact point gets swept up; anything a skill wants
  // to shield from crit must be added to the breakdown AFTER this call returns.
  if (opts.isCrit) {
    const mult = Number.isFinite(opts.critMult) ? opts.critMult : 1.5;
    const prev = physical + elemental + necrotic;
    physical *= mult;
    elemental *= mult;
    necrotic *= mult;
    try { _pushBreakdown({ label: 'crit', mult, from: Math.round(prev), to: Math.round(physical + elemental + necrotic) }); } catch { }
  }

  // Lightning Jolt is NOT added here anymore — it's a Tier-3 rider and needs
  // to be immune to gear conversion/gear% too, which don't run until AFTER
  // this function returns (applyGearConversionAndPercent, called later from
  // CombatScene.js). See applyLightningJolt's call site there.

  // Floor ONCE, here, after every multiplicative step above has run on the
  // full-precision float total.
  physical = Math.floor(physical);
  elemental = Math.floor(elemental);
  necrotic = Math.floor(necrotic);

  const amount = physical + elemental + necrotic;
  return { physical, elemental, necrotic, amount };
}

// --------------------------------------------------
// applyGearConversionAndPercent — the LATE gear step for typed-pipeline
// skills (2026-07 pipeline reorder, see project_damage_pipeline_reorder
// memory). Called from CombatScene.js AFTER ability.apply() has fully
// resolved — including the skill's OWN manual type conversion (e.g. Boulder
// Toss's Ablaze phys→elem, Miasma Crush's forced necrotic) — so gear
// conversion and gear damage% both react to the FINAL composition of the
// hit, not the weapon's original roll. This is the whole point of the
// reorder: previously both ran inside calculateDamage(), before the skill
// (or its own conversion) had even happened, so e.g. an Elemental→Necrotic
// amulet paired with a phys→elemental-converting skill silently converted
// nothing (checking an elemental bucket that was still empty at that point).
//
// Conversion order is fixed: phys→elem, then phys→necro, then elem→necro —
// matches the in-game hierarchy (Physical → Elemental → Necrotic, Necrotic
// terminal, Elemental cannot revert to Physical).
//
// Legacy (non-typed) skills don't call this — they keep the original early
// application inside calculateDamage()/applyDamageModifiers unchanged.
// --------------------------------------------------
export function applyGearConversionAndPercent(breakdown, attacker) {
  let physical = breakdown?.physical | 0;
  let elemental = breakdown?.elemental | 0;
  let necrotic = breakdown?.necrotic | 0;
  const ge = attacker?.gearEffects || {};

  const converted = convertDamageType(physical, elemental, necrotic, {
    physToElemPct: ge.physToElemPercent,
    physToNecroPct: ge.physToNecroPercent,
    elemToNecroPct: ge.elemToNecroPercent,
  }, ' (gear)');
  physical = converted.physical;
  elemental = converted.elemental;
  necrotic = converted.necrotic;

  // Gear damage% — global (+hidden) multiplies everything uniformly, same
  // compounding relationship as before (mult *= each in turn, not summed).
  // Elemental/necrotic-specific% now apply to the FINAL bucket regardless of
  // source (weapon's own roll, a skill's conversion, or gear's own
  // conversion above) — previously elementalDamagePercent only ever touched
  // the weapon's originally-rolled elemental flat.
  let globalMult = 1;
  if (ge.globalDamagePercent) globalMult *= 1 + ge.globalDamagePercent / 100;
  if (ge.hiddenDamagePercent) globalMult *= 1 + ge.hiddenDamagePercent / 100;
  if (globalMult !== 1) {
    const prev = physical + elemental + necrotic;
    physical *= globalMult; elemental *= globalMult; necrotic *= globalMult;
    try { _pushBreakdown({ label: 'gear damage', mult: globalMult, from: Math.round(prev), to: Math.round(physical + elemental + necrotic) }); } catch { }
  }
  if (ge.elementalDamagePercent && elemental > 0) {
    const mult = 1 + ge.elementalDamagePercent / 100;
    const prev = elemental;
    elemental *= mult;
    try { _pushBreakdown({ label: 'gear elemental damage', mult, from: Math.round(prev), to: Math.round(elemental) }); } catch { }
  }
  if (ge.necroticDamagePercent && necrotic > 0) {
    const mult = 1 + ge.necroticDamagePercent / 100;
    const prev = necrotic;
    necrotic *= mult;
    try { _pushBreakdown({ label: 'gear necrotic damage', mult, from: Math.round(prev), to: Math.round(necrotic) }); } catch { }
  }

  physical = Math.max(0, Math.floor(physical));
  elemental = Math.max(0, Math.floor(elemental));
  necrotic = Math.max(0, Math.floor(necrotic));
  return { physical, elemental, necrotic, amount: physical + elemental + necrotic };
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