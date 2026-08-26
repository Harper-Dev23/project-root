// src/systems/ItemFactory.js
import { Items } from '../../data/items.js';

/** ---------- Rarity Rules (affix counts) ----------
 * uncommon: 1–2 total affixes (prefix+suffix combined)
 * rare: 3 total affixes
 * epic: 2 prefixes + 2 suffixes (fixed)
 * common: 0
 */
export const RARITY_RULES = {
  common: { min: 0, max: 0, force: null },          // 0 total
  uncommon: { min: 1, max: 2, force: null },          // 1–2 total
  rare: { min: 3, max: 3, force: null },          // exactly 3 total
  epic: { min: 4, max: 4, force: { prefixes: 2, suffixes: 2 } }, // 2+2
};

function asRng(fn) {
  return typeof fn === 'function' ? fn : Math.random;
}

function rollInt(range, rng) {
  if (!range) return 0;
  const [min, max] = range;
  if (min === max) return min;
  const next = asRng(rng);
  return min + Math.floor((next() ?? Math.random()) * (max - min + 1));
}

function cloneRange(range) {
  if (!range) return { min: 0, max: 0 };
  const { min = 0, max = 0 } = range;
  return { min, max };
}

// --- Armor prefix helpers ---------------------------------------------------
function makeDerivedArmorPrefix({ key, tier, derivedKey, range }) {
  return {
    key,
    tier,
    family: derivedKey,
    roll(rng) {
      const amount = rollInt(range, rng);
      return {
        key,
        tier,
        family: derivedKey,
        mods: { derived: { [derivedKey]: amount } }
      };
    }
  };
}

function makeMiscArmorPrefix({ key, tier, prop, range, clamp = null }) {
  return {
    key,
    tier,
    family: prop,
    roll(rng) {
      let amount = rollInt(range, rng);
      if (clamp) amount = Math.max(clamp.min ?? -Infinity, Math.min(clamp.max ?? Infinity, amount));
      return {
        key,
        tier,
        family: prop,
        mods: { misc: { [prop]: amount } }
      };
    }
  };
}

// --- Weapon prefix helpers --------------------------------------------------
//
// 1H vs 2H weapon affix scaling: dual-wielding combines two weapons' worth of
// affixes into one attack, so using identical ranges for 1H and 2H weapons
// let a dual-wielder out-roll a 2H user on the same tier. Two different
// stacking shapes need two different discounts:
//
//   - "Local" per-weapon-swing stats (flat physical damageFlat, flat
//     elementalFlat, local damagePercent.weapon) are combined by
//     calculateDamage() at 75%/75% per hand (see rollWeaponSwing in
//     CombatLogic.js) — two rolls sum to 1.5x one unscaled roll, so each 1H
//     roll is cut to 2/3 of the 2H range (1.5 * 2/3 = 1.0).
//   - "Global" additive stats (buildupPercent per family, the weapon-wide
//     elementalDamagePercent/necroticDamagePercent/healingPercent prefixes)
//     aren't touched by that 75%/75% combine at all — they're summed
//     straight into gearEffects from every equipped item. Two 1H items give
//     TWO full uncapped rolls vs a 2H's one, so each 1H roll is halved.
//
// Same key/tier/family naming either way (matches Path of Exile's own
// convention of one affix name spanning multiple item classes) — only the
// numeric range differs. Shields are hands:1 but can't dual-wield-combine or
// swing on their own, so they keep the canonical (2H, unscaled) ranges.
const LOCAL_1H_SCALE = 2 / 3;
const GLOBAL_1H_SCALE = 0.5;

function scaleRange(range, scale) {
  if (scale === 1) return range;
  const min = Math.max(1, Math.round(range[0] * scale));
  const max = Math.max(min, Math.round(range[1] * scale));
  return [min, max];
}

function isOneHandedBase(base) {
  return base?.hands === 1 && base?.weaponType !== 'shield';
}

function makeWeaponFlatPrefix({ key, tier, field, range }, scale = 1) {
  const r = scaleRange(range, scale);
  return {
    key,
    tier,
    family: field,
    roll(rng) {
      const amount = rollInt(r, rng);
      return {
        key,
        tier,
        family: field,
        mods: { damageFlat: { [field]: amount } }
      };
    }
  };
}

function makeWeaponPercentPrefix({ key, tier, range }, scale = 1) {
  const r = scaleRange(range, scale);
  return {
    key,
    tier,
    family: 'weaponPercent',
    roll(rng) {
      const amount = rollInt(r, rng);
      return {
        key,
        tier,
        family: 'weaponPercent',
        mods: { damagePercent: { weapon: amount } }
      };
    }
  };
}

function makeWeaponElementFlatPrefix({ key, tier, element, range }, scale = 1) {
  const r = scaleRange(range, scale);
  return {
    key,
    tier,
    family: `${element}Flat`,
    roll() {
      return {
        key,
        tier,
        family: `${element}Flat`,
        mods: { elementalFlat: { [element]: { min: r[0], max: r[1] } } }
      };
    }
  };
}

function makeWeaponElementPercentPrefix({ key, tier, prop, range }, scale = 1) {
  const r = scaleRange(range, scale);
  return {
    key,
    tier,
    family: prop,
    roll(rng) {
      const amount = rollInt(r, rng);
      return {
        key,
        tier,
        family: prop,
        mods: { misc: { [prop]: amount } }
      };
    }
  };
}

// --- Suffix helpers ---------------------------------------------------------
function makeStatSuffix({ key, stat }) {
  return {
    key,
    roll() {
      return {
        key,
        mods: { stats: { [stat]: 1 } }
      };
    }
  };
}

function makeBuildupSuffix({ key, tier, family, range }, scale = 1) {
  const r = scaleRange(range, scale);
  return {
    key,
    tier,
    family,
    roll(rng) {
      const amount = rollInt(r, rng);
      return {
        key,
        tier,
        family,
        mods: { misc: { buildupPercent: { [family]: amount } } }
      };
    }
  };
}

// --- Armor pools ------------------------------------------------------------
const ARMOR_PREFIX_POOL = [
  // Max HP
  makeDerivedArmorPrefix({ key: 'Sanctified', tier: 3, derivedKey: 'maxHP', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Covenant', tier: 2, derivedKey: 'maxHP', range: [3, 5] }),
  makeDerivedArmorPrefix({ key: 'Elijah\u2019s', tier: 1, derivedKey: 'maxHP', range: [6, 9] }),

  // Max MP
  makeDerivedArmorPrefix({ key: 'Anointed', tier: 3, derivedKey: 'maxMP', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Sanctuary', tier: 2, derivedKey: 'maxMP', range: [3, 5] }),
  makeDerivedArmorPrefix({ key: 'Isaiah\u2019s', tier: 1, derivedKey: 'maxMP', range: [6, 9] }),

  // Physical Resist
  makeDerivedArmorPrefix({ key: 'Blessed', tier: 3, derivedKey: 'PhysicalResist', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Exalted', tier: 2, derivedKey: 'PhysicalResist', range: [3, 5] }),
  makeDerivedArmorPrefix({ key: 'David\u2019s', tier: 1, derivedKey: 'PhysicalResist', range: [6, 9] }),

  // Elemental Resist
  makeDerivedArmorPrefix({ key: 'Hallowed', tier: 3, derivedKey: 'ElementalResist', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Redeemed', tier: 2, derivedKey: 'ElementalResist', range: [3, 5] }),
  makeDerivedArmorPrefix({ key: 'Samuel\u2019s', tier: 1, derivedKey: 'ElementalResist', range: [6, 9] }),

  // Necrotic Resist
  makeDerivedArmorPrefix({ key: 'Warded', tier: 3, derivedKey: 'NecroticResist', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Sealed', tier: 2, derivedKey: 'NecroticResist', range: [3, 5] }),
  makeDerivedArmorPrefix({ key: 'Ezekiel\u2019s', tier: 1, derivedKey: 'NecroticResist', range: [6, 9] }),

  // Accuracy
  makeDerivedArmorPrefix({ key: 'Ordained', tier: 3, derivedKey: 'Accuracy', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Zealous', tier: 2, derivedKey: 'Accuracy', range: [3, 5] }),
  makeDerivedArmorPrefix({ key: 'Zechariah\u2019s', tier: 1, derivedKey: 'Accuracy', range: [6, 9] }),

  // Evasion
  makeDerivedArmorPrefix({ key: 'Fleet', tier: 3, derivedKey: 'Evasion', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Swift', tier: 2, derivedKey: 'Evasion', range: [3, 5] }),
  makeDerivedArmorPrefix({ key: 'Nahum\u2019s', tier: 1, derivedKey: 'Evasion', range: [6, 9] }),

  // MP Regen (per turn)
  makeMiscArmorPrefix({ key: 'Meditative', tier: 3, prop: 'mpPerTurn', range: [1, 1] }),
  makeMiscArmorPrefix({ key: 'Devout', tier: 2, prop: 'mpPerTurn', range: [2, 2] }),
  makeMiscArmorPrefix({ key: 'Elisha\u2019s', tier: 1, prop: 'mpPerTurn', range: [3, 3] }),

  // Skill Cost Reduction (% of MP/HP costs)
  makeMiscArmorPrefix({ key: 'Frugal', tier: 3, prop: 'skillCostReductionPct', range: [1, 1] }),
  makeMiscArmorPrefix({ key: 'Temperate', tier: 2, prop: 'skillCostReductionPct', range: [2, 3] }),
  makeMiscArmorPrefix({ key: 'Solomon\u2019s', tier: 1, prop: 'skillCostReductionPct', range: [4, 5] }),

  // Crit Chance (%)
  makeDerivedArmorPrefix({ key: 'Keen', tier: 3, derivedKey: 'CritChance', range: [1, 1] }),
  makeDerivedArmorPrefix({ key: 'Sharp', tier: 2, derivedKey: 'CritChance', range: [2, 3] }),
  makeDerivedArmorPrefix({ key: 'Micah\u2019s', tier: 1, derivedKey: 'CritChance', range: [4, 5] }),

  // Damage % (all sources)
  makeMiscArmorPrefix({ key: 'Strong', tier: 3, prop: 'globalDamagePercent', range: [1, 1] }),
  makeMiscArmorPrefix({ key: 'Mighty', tier: 2, prop: 'globalDamagePercent', range: [2, 3] }),
  makeMiscArmorPrefix({ key: 'Amos\u2019', tier: 1, prop: 'globalDamagePercent', range: [4, 5] }),

  // Healing % (all sources) \u2014 armor-side counterpart, same ranges as
  // globalDamagePercent above. Consumed by applyHealModifiers (CombatLogic.js).
  makeMiscArmorPrefix({ key: 'Nurturing', tier: 3, prop: 'healingPercent', range: [1, 1] }),
  makeMiscArmorPrefix({ key: 'Restoring', tier: 2, prop: 'healingPercent', range: [2, 3] }),
  makeMiscArmorPrefix({ key: 'Miriam\u2019s', tier: 1, prop: 'healingPercent', range: [4, 5] }),

  // Resilience (Buildup resistance)
  // v3.3: buffed alongside the weakness decay rebalance \u2014 decay got weaker, so
  // resilience (flat reduction to incoming buildup, CombatScene.js _applyWeakness)
  // needs to carry more of the "resisting weakness" weight than before.
  makeMiscArmorPrefix({ key: 'Stalwart', tier: 3, prop: 'resilience', range: [3, 6] }),
  makeMiscArmorPrefix({ key: 'Unyielding', tier: 2, prop: 'resilience', range: [8, 14] }),
  makeMiscArmorPrefix({ key: 'Job\u2019s', tier: 1, prop: 'resilience', range: [18, 25] }),

  // Buildup % by damage-type CATEGORY (physical/elemental/necrotic) \u2014 the
  // armor-side counterpart to the weapon suffixes' per-FAMILY buildup% above.
  // Broader (any family in that category) but smaller (3-11%, vs. weapons'
  // 9-50%) \u2014 same category split calculateDerivedStats/mitigation already use
  // (physical: expose/lacerate/disorient, elemental: fire/cold/lightning,
  // necrotic: toxic/disease/curse). Consumed by _applyWeaknessBuildup
  // (CombatScene.js), combined ADDITIVELY with the weapon per-family bonus
  // into one multiplier \u2014 same-stage gear bonuses, not sequential stages.
  makeMiscArmorPrefix({ key: 'Forceful', tier: 3, prop: 'physicalBuildupPercent', range: [3, 5] }),
  makeMiscArmorPrefix({ key: 'Brutal', tier: 2, prop: 'physicalBuildupPercent', range: [6, 8] }),
  makeMiscArmorPrefix({ key: 'Titan\u2019s', tier: 1, prop: 'physicalBuildupPercent', range: [9, 11] }),

  makeMiscArmorPrefix({ key: 'Charged', tier: 3, prop: 'elementalBuildupPercent', range: [3, 5] }),
  makeMiscArmorPrefix({ key: 'Volatile', tier: 2, prop: 'elementalBuildupPercent', range: [6, 8] }),
  makeMiscArmorPrefix({ key: 'Zephyr\u2019s', tier: 1, prop: 'elementalBuildupPercent', range: [9, 11] }),

  makeMiscArmorPrefix({ key: 'Festering', tier: 3, prop: 'necroticBuildupPercent', range: [3, 5] }),
  makeMiscArmorPrefix({ key: 'Corrupting', tier: 2, prop: 'necroticBuildupPercent', range: [6, 8] }),
  makeMiscArmorPrefix({ key: 'Mordecai\u2019s', tier: 1, prop: 'necroticBuildupPercent', range: [9, 11] })
];

const ARMOR_SUFFIX_POOL = [
  makeStatSuffix({ key: 'of the Bear', stat: 'STR' }),
  makeStatSuffix({ key: 'of the Wolf', stat: 'DEX' }),
  makeStatSuffix({ key: 'of the Boar', stat: 'CON' }),
  makeStatSuffix({ key: 'of the Serpent', stat: 'INT' }),
  makeStatSuffix({ key: 'of the Stag', stat: 'WIS' }),
  makeStatSuffix({ key: 'of the Lion', stat: 'CHA' })
];

// --- Hunt Plan pools ---------------------------------------------------------
// makeMiscArmorPrefix is generic over any `misc` field name despite the name —
// reused here rather than writing a near-duplicate factory. lootQualityPercent
// shifts Cultist fight drop rarity toward rare — see CombatScene.js's
// rollHuntDropRarity().
const HUNTPLAN_PREFIX_POOL = [
  makeMiscArmorPrefix({ key: 'Keen-Eyed', tier: 2, prop: 'beastChanceWeight', range: [1, 3] }),
  makeMiscArmorPrefix({ key: 'Bold', tier: 2, prop: 'encounterChancePercent', range: [5, 15] }),
  makeMiscArmorPrefix({ key: 'Studious', tier: 3, prop: 'xpPercent', range: [10, 25] }),
];

const HUNTPLAN_SUFFIX_POOL = [
  makeMiscArmorPrefix({ key: 'of Swift Travel', tier: 2, prop: 'supplyEfficiencyPercent', range: [5, 20] }),
  makeMiscArmorPrefix({ key: 'of the Hunt', tier: 1, prop: 'huntPointsPercent', range: [5, 20] }),
  makeMiscArmorPrefix({ key: 'of Plenty', tier: 3, prop: 'lootQualityPercent', range: [10, 25] }),
];

// --- Weapon pools -----------------------------------------------------------
// Built once per hand-count (2H = canonical/unscaled, 1H = discounted — see
// the big comment above the weapon prefix helpers for why). Same key/tier/
// family for both variants; only the numeric range passed to each maker
// differs, via `local`/`global` picking LOCAL_1H_SCALE/GLOBAL_1H_SCALE on the
// 1H pass and 1 (unscaled) on the 2H pass.
function buildWeaponPrefixPool(hands) {
  const local = hands === 1 ? LOCAL_1H_SCALE : 1;
  const global = hands === 1 ? GLOBAL_1H_SCALE : 1;
  return [
    // Flat min damage
    makeWeaponFlatPrefix({ key: 'Honed', tier: 3, field: 'min', range: [1, 2] }, local),
    makeWeaponFlatPrefix({ key: 'Sharpened', tier: 2, field: 'min', range: [2, 3] }, local),
    makeWeaponFlatPrefix({ key: 'Razor-edged', tier: 1, field: 'min', range: [4, 5] }, local),

    // Flat max damage
    makeWeaponFlatPrefix({ key: 'Weighted', tier: 3, field: 'max', range: [1, 2] }, local),
    makeWeaponFlatPrefix({ key: 'Tempered', tier: 2, field: 'max', range: [2, 3] }, local),
    makeWeaponFlatPrefix({ key: 'Crushing', tier: 1, field: 'max', range: [4, 5] }, local),

    // % weapon damage (local) — was topping out at 7-10%, vastly outcomputed by
    // flat damage adds; new top tier reaches up to 40% so this stat has room to
    // actually matter on the item once flat numbers scale up too. Gapless: each
    // tier's max is exactly one less than the next tier's min.
    makeWeaponPercentPrefix({ key: 'Rugged', tier: 3, range: [2, 6] }, local),
    makeWeaponPercentPrefix({ key: 'Vicious', tier: 2, range: [7, 15] }, local),
    makeWeaponPercentPrefix({ key: 'Brutal', tier: 1, range: [16, 27] }, local),
    makeWeaponPercentPrefix({ key: 'Merciless', tier: 0, range: [28, 40] }, local),

    // Flat elemental damage
    makeWeaponElementFlatPrefix({ key: 'Smoldering', tier: 3, element: 'fire', range: [1, 2] }, local),
    makeWeaponElementFlatPrefix({ key: 'Burning', tier: 2, element: 'fire', range: [2, 3] }, local),
    makeWeaponElementFlatPrefix({ key: 'Infernal', tier: 1, element: 'fire', range: [3, 4] }, local),

    makeWeaponElementFlatPrefix({ key: 'Chilling', tier: 3, element: 'cold', range: [1, 2] }, local),
    makeWeaponElementFlatPrefix({ key: 'Freezing', tier: 2, element: 'cold', range: [2, 3] }, local),
    makeWeaponElementFlatPrefix({ key: 'Glacial', tier: 1, element: 'cold', range: [3, 4] }, local),

    makeWeaponElementFlatPrefix({ key: 'Sparking', tier: 3, element: 'lightning', range: [1, 2] }, local),
    makeWeaponElementFlatPrefix({ key: 'Crackling', tier: 2, element: 'lightning', range: [2, 3] }, local),
    makeWeaponElementFlatPrefix({ key: 'Thunderous', tier: 1, element: 'lightning', range: [3, 4] }, local),

    makeWeaponElementFlatPrefix({ key: 'Withering', tier: 3, element: 'necrotic', range: [1, 2] }, local),
    makeWeaponElementFlatPrefix({ key: 'Blighted', tier: 2, element: 'necrotic', range: [2, 3] }, local),
    makeWeaponElementFlatPrefix({ key: 'Corrupting', tier: 1, element: 'necrotic', range: [3, 4] }, local),

    // % Elemental / Necrotic (global)
    makeWeaponElementPercentPrefix({ key: 'Flaring', tier: 3, prop: 'elementalDamagePercent', range: [2, 3] }, global),
    makeWeaponElementPercentPrefix({ key: 'Shocking', tier: 2, prop: 'elementalDamagePercent', range: [4, 6] }, global),
    makeWeaponElementPercentPrefix({ key: 'Cataclysmic', tier: 1, prop: 'elementalDamagePercent', range: [7, 10] }, global),

    makeWeaponElementPercentPrefix({ key: 'Foul', tier: 3, prop: 'necroticDamagePercent', range: [2, 3] }, global),
    makeWeaponElementPercentPrefix({ key: 'Profane', tier: 2, prop: 'necroticDamagePercent', range: [4, 6] }, global),
    makeWeaponElementPercentPrefix({ key: 'Unholy', tier: 1, prop: 'necroticDamagePercent', range: [7, 10] }, global),

    // % Healing — weapon-side counterpart, same ranges as the elemental/
    // necrotic % affixes above. Consumed by applyHealModifiers (CombatLogic.js).
    makeWeaponElementPercentPrefix({ key: 'Soothing', tier: 3, prop: 'healingPercent', range: [2, 3] }, global),
    makeWeaponElementPercentPrefix({ key: 'Restorative', tier: 2, prop: 'healingPercent', range: [4, 6] }, global),
    makeWeaponElementPercentPrefix({ key: 'Sanctified', tier: 1, prop: 'healingPercent', range: [7, 10] }, global),
  ];
}

// Three evenly-spaced tiers spanning the full 9%-50% range (was 5-15%,
// bumped per explicit request for "more powerful access to buildup on
// weapons") — tier 3 (common) 9-22%, tier 2 (mid) 23-36%, tier 1 (best)
// 37-50%, for 2H. Buildup% is a global-additive stat (see comment above the
// weapon prefix helpers), so 1H gets these halved.
function buildWeaponSuffixPool(hands) {
  const global = hands === 1 ? GLOBAL_1H_SCALE : 1;
  return [
    // Fire buildup
    makeBuildupSuffix({ key: 'of Sparks', tier: 3, family: 'fire', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Flames', tier: 2, family: 'fire', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Inferno', tier: 1, family: 'fire', range: [37, 50] }, global),

    // Cold buildup
    makeBuildupSuffix({ key: 'of Chill', tier: 3, family: 'cold', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Frost', tier: 2, family: 'cold', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Blizzard', tier: 1, family: 'cold', range: [37, 50] }, global),

    // Lightning buildup
    makeBuildupSuffix({ key: 'of Static', tier: 3, family: 'lightning', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Storms', tier: 2, family: 'lightning', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Tempest', tier: 1, family: 'lightning', range: [37, 50] }, global),

    // Lacerate buildup
    makeBuildupSuffix({ key: 'of Scratches', tier: 3, family: 'lacerate', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Wounds', tier: 2, family: 'lacerate', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Hemorrhage', tier: 1, family: 'lacerate', range: [37, 50] }, global),

    // Expose buildup
    makeBuildupSuffix({ key: 'of Bruises', tier: 3, family: 'expose', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Flaying', tier: 2, family: 'expose', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Ruin', tier: 1, family: 'expose', range: [37, 50] }, global),

    // Disorient buildup
    makeBuildupSuffix({ key: 'of Echoes', tier: 3, family: 'disorient', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Daze', tier: 2, family: 'disorient', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Concussion', tier: 1, family: 'disorient', range: [37, 50] }, global),

    // Disease buildup
    makeBuildupSuffix({ key: 'of Rot', tier: 3, family: 'disease', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Plague', tier: 2, family: 'disease', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Pestilence', tier: 1, family: 'disease', range: [37, 50] }, global),

    // Curse buildup
    makeBuildupSuffix({ key: 'of Whispers', tier: 3, family: 'curse', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Hexes', tier: 2, family: 'curse', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Affliction', tier: 1, family: 'curse', range: [37, 50] }, global),

    // Toxic buildup
    makeBuildupSuffix({ key: 'of Venom', tier: 3, family: 'toxic', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Toxins', tier: 2, family: 'toxic', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Envenoming', tier: 1, family: 'toxic', range: [37, 50] }, global),
  ];
}

const WEAPON_PREFIX_POOL_2H = buildWeaponPrefixPool(2);
const WEAPON_PREFIX_POOL_1H = buildWeaponPrefixPool(1);
const WEAPON_SUFFIX_POOL_2H = buildWeaponSuffixPool(2);
const WEAPON_SUFFIX_POOL_1H = buildWeaponSuffixPool(1);

function getAffixPoolsFor(base) {
  if (!base) return null;
  // Unique items with a fixedAffix skip the random pool entirely
  if (base.unique && base.fixedAffix) return null;
  if (base.type === 'armor') {
    return { prefixes: ARMOR_PREFIX_POOL, suffixes: ARMOR_SUFFIX_POOL };
  }
  if (base.type === 'weapon') {
    return isOneHandedBase(base)
      ? { prefixes: WEAPON_PREFIX_POOL_1H, suffixes: WEAPON_SUFFIX_POOL_1H }
      : { prefixes: WEAPON_PREFIX_POOL_2H, suffixes: WEAPON_SUFFIX_POOL_2H };
  }
  if (base.type === 'huntPlan') {
    return { prefixes: HUNTPLAN_PREFIX_POOL, suffixes: HUNTPLAN_SUFFIX_POOL };
  }
  return null;
}

/**
 * Roll the single fixed affix defined on a unique item's base definition.
 * Returns a rolled affix object in the same shape as pool affixes.
 */
function rollFixedAffix(fixedAffix, rng) {
  // Naming-only affixes have no range/family — they exist solely to append
  // a suffix to the display name (e.g. grantsSkills rings).
  const amount = fixedAffix.range ? rollInt(fixedAffix.range, rng) : null;
  return {
    key: fixedAffix.key,
    family: fixedAffix.family || null,
    buildupTarget: fixedAffix.buildupTarget || null,
    rolledValue: amount,
    mods: fixedAffix.family
      ? {
          misc: {
            [fixedAffix.family]: fixedAffix.buildupTarget
              ? { [fixedAffix.buildupTarget]: amount }
              : amount
          }
        }
      : { misc: {} }
  };
}


/** Utility: pick N unique elements from an array */
function pickUnique(arr, n, rng) {
  const pool = [...arr];
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor((asRng(rng)() ?? Math.random()) * pool.length);
    const def = pool.splice(idx, 1)[0];
    if (!def) continue;
    out.push(def.roll(rng));
    // Every affix def carries a `family` — the underlying stat it modifies
    // (e.g. 'weaponPercent', 'maxHP', 'PhysicalResist') — shared across its
    // 3 tiers (Sanctified/Covenant/Elijah's all family:'maxHP'). Splicing
    // out only the exact def picked above still left the OTHER tiers of the
    // same family in the pool, so a single item could roll e.g. both a T3
    // and a T2 weapon damage% affix together. Strip every remaining pool
    // entry that shares this family so each one can only appear once total.
    if (def.family) {
      for (let j = pool.length - 1; j >= 0; j--) {
        if (pool[j].family === def.family) pool.splice(j, 1);
      }
    }
  }
  return out;
}

/** Decide how many prefixes/suffixes for a given rarity. */
function rollAffixCounts(rarity, rng) {
  const rule = RARITY_RULES[rarity] || RARITY_RULES.common;
  if (rule.force) return { prefixes: rule.force.prefixes, suffixes: rule.force.suffixes };

  const total = rule.min === rule.max
    ? rule.min
    : rule.min + Math.floor((asRng(rng)() ?? Math.random()) * (rule.max - rule.min + 1));


  let prefixes = 0, suffixes = 0;
  for (let i = 0; i < total; i++) {
    if (prefixes <= suffixes) prefixes++; else suffixes++;
  }
  return { prefixes, suffixes };
}

function ensureObj(obj) {
  return obj && typeof obj === 'object' ? obj : {};
}


/**
 * Apply affixes to produce a merged "instanceMods" object we can read later.
 * We avoid mutating the base item; all affix effects live on the instance.
 */
function buildInstanceModifiers(prefixes, suffixes) {
  const mods = {
    stats: {},
    derived: {},
    damageFlat: { min: 0, max: 0 },
    damagePercent: { weapon: 0 },
    elementalFlat: {},
    misc: {
      // Existing
      mpPerTurn: 0,
      skillCostReductionPct: 0,
      globalDamagePercent: 0,
      elementalDamagePercent: 0,
      necroticDamagePercent: 0,
      // Healing-side counterpart to globalDamagePercent/elementalDamagePercent
      // — consumed by applyHealModifiers (CombatLogic.js), the new heal
      // pipeline. One shared stat regardless of source (armor or weapon
      // affix), same pattern globalDamagePercent/elementalDamagePercent use.
      healingPercent: 0,
      resilience: 0,
      buildupPercent: {},
      physicalBuildupPercent: 0,
      elementalBuildupPercent: 0,
      necroticBuildupPercent: 0,
      // Jewelry: damage conversion (%)
      physToElemPercent: 0,
      physToNecroPercent: 0,
      elemToNecroPercent: 0,
      // Jewelry: battle-start passives
      initBonusOnBattleStart: 0,
      shieldPctOnBattleStart: 0,
      // Jewelry: buildup-on-hit (keyed by buildup family, value = % of damage)
      physBuildupOnPhysDmg: {},
      elemBuildupOnElemDmg: {},
      // Jewelry: proc chances (%)
      procDoubleDamage: 0,
      procHalfDamageTaken: 0,
      procHealOnHeal: 0,
      procElemFlat: 0,
      procNecroFlat: 0,
      procPhysFlat: 0
    }
  };

  const apply = (affix) => {
    if (!affix?.mods) return;
    const data = affix.mods;

    if (data.stats) {
      for (const [k, v] of Object.entries(data.stats)) {
        mods.stats[k] = (mods.stats[k] || 0) + v;
      }
    }

    if (data.derived) {
      for (const [k, v] of Object.entries(data.derived)) {
        mods.derived[k] = (mods.derived[k] || 0) + v;
      }
    }

    if (data.damageFlat) {
      const flat = ensureObj(data.damageFlat);
      mods.damageFlat.min += flat.min || 0;
      mods.damageFlat.max += flat.max || 0;
    }

    if (data.damagePercent) {
      const percent = ensureObj(data.damagePercent);
      mods.damagePercent.weapon += percent.weapon || 0;
    }

    if (data.elementalFlat) {
      for (const [element, range] of Object.entries(data.elementalFlat)) {
        if (!range) continue;
        const existing = mods.elementalFlat[element] || { min: 0, max: 0 };
        existing.min += range.min || 0;
        existing.max += range.max || 0;
        mods.elementalFlat[element] = existing;
      }
    }

    if (data.misc) {
      const misc = data.misc;
      if (misc.mpPerTurn) mods.misc.mpPerTurn += misc.mpPerTurn;
      if (misc.skillCostReductionPct) mods.misc.skillCostReductionPct += misc.skillCostReductionPct;
      if (misc.globalDamagePercent) mods.misc.globalDamagePercent += misc.globalDamagePercent;
      if (misc.elementalDamagePercent) mods.misc.elementalDamagePercent += misc.elementalDamagePercent;
      if (misc.necroticDamagePercent) mods.misc.necroticDamagePercent += misc.necroticDamagePercent;
      if (misc.healingPercent) mods.misc.healingPercent += misc.healingPercent;
      if (misc.resilience) mods.misc.resilience += misc.resilience;
      if (misc.physicalBuildupPercent) mods.misc.physicalBuildupPercent += misc.physicalBuildupPercent;
      if (misc.elementalBuildupPercent) mods.misc.elementalBuildupPercent += misc.elementalBuildupPercent;
      if (misc.necroticBuildupPercent) mods.misc.necroticBuildupPercent += misc.necroticBuildupPercent;
      if (misc.buildupPercent) {
        for (const [fam, v] of Object.entries(misc.buildupPercent)) {
          mods.misc.buildupPercent[fam] = (mods.misc.buildupPercent[fam] || 0) + v;
        }
      }
      // Jewelry misc mods — scalar
      if (misc.physToElemPercent) mods.misc.physToElemPercent += misc.physToElemPercent;
      if (misc.physToNecroPercent) mods.misc.physToNecroPercent += misc.physToNecroPercent;
      if (misc.elemToNecroPercent) mods.misc.elemToNecroPercent += misc.elemToNecroPercent;
      if (misc.initBonusOnBattleStart) mods.misc.initBonusOnBattleStart += misc.initBonusOnBattleStart;
      if (misc.shieldPctOnBattleStart) mods.misc.shieldPctOnBattleStart += misc.shieldPctOnBattleStart;
      if (misc.procDoubleDamage) mods.misc.procDoubleDamage += misc.procDoubleDamage;
      if (misc.procHalfDamageTaken) mods.misc.procHalfDamageTaken += misc.procHalfDamageTaken;
      if (misc.procHealOnHeal) mods.misc.procHealOnHeal += misc.procHealOnHeal;
      if (misc.procElemFlat) mods.misc.procElemFlat += misc.procElemFlat;
      if (misc.procNecroFlat) mods.misc.procNecroFlat += misc.procNecroFlat;
      if (misc.procPhysFlat) mods.misc.procPhysFlat += misc.procPhysFlat;
      // Hunt Plan mods (src/systems/HuntModifiers.js shared schema)
      if (misc.encounterChancePercent) mods.misc.encounterChancePercent = (mods.misc.encounterChancePercent || 0) + misc.encounterChancePercent;
      if (misc.beastChanceWeight) mods.misc.beastChanceWeight = (mods.misc.beastChanceWeight || 0) + misc.beastChanceWeight;
      if (misc.supplyEfficiencyPercent) mods.misc.supplyEfficiencyPercent = (mods.misc.supplyEfficiencyPercent || 0) + misc.supplyEfficiencyPercent;
      if (misc.huntPointsPercent) mods.misc.huntPointsPercent = (mods.misc.huntPointsPercent || 0) + misc.huntPointsPercent;
      if (misc.xpPercent) mods.misc.xpPercent = (mods.misc.xpPercent || 0) + misc.xpPercent;
      if (misc.lootQualityPercent) mods.misc.lootQualityPercent = (mods.misc.lootQualityPercent || 0) + misc.lootQualityPercent;
      // Jewelry misc mods — keyed-by-family objects
      if (misc.physBuildupOnPhysDmg) {
        for (const [fam, v] of Object.entries(misc.physBuildupOnPhysDmg)) {
          mods.misc.physBuildupOnPhysDmg[fam] = (mods.misc.physBuildupOnPhysDmg[fam] || 0) + v;
        }
      }
      if (misc.elemBuildupOnElemDmg) {
        for (const [fam, v] of Object.entries(misc.elemBuildupOnElemDmg)) {
          mods.misc.elemBuildupOnElemDmg[fam] = (mods.misc.elemBuildupOnElemDmg[fam] || 0) + v;
        }
      }
    }
  };

  prefixes.forEach(apply);
  suffixes.forEach(apply);
  return mods;
}

/**
 * Create a new item instance from a base ID with optional rarity+affixes.
 * @param {string} id
 * @param {object} opts
 *   - rarity: 'common'|'uncommon'|'rare'|'epic' (default: base item rarity or 'common')
 *   - quality: legacy alias for rarity (old saves/callers), prefer rarity
 *   - rollAffixes: boolean (default true if rarity != 'common')
 *   - rng: optional function returning 0..1 for deterministic tests
 */
export function createItemInstance(id, opts = {}) {
  const base = Items[id];
  if (!base) {
    console.warn(`Item ID "${id}" not found in items.js`);
    return null;
  }

  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  // Accept legacy `quality` opt so old call sites don't silently break
  const rarity = opts.rarity || opts.quality || base.rarity || base.quality || 'common';
  const pools = getAffixPoolsFor(base);

  let prefixes = [];
  let suffixes = [];

  // Unique items with a fixedAffix: roll the single defined affix, skip the pool
  if (base.unique && base.fixedAffix) {
    const rolled = rollFixedAffix(base.fixedAffix, rng);
    // Treat it as a suffix so buildInstanceModifiers processes it
    suffixes = [rolled];
  } else if (pools && (opts.rollAffixes ?? (rarity !== 'common'))) {
    const { prefixes: nPre, suffixes: nSuf } = rollAffixCounts(rarity, rng);
    prefixes = pickUnique(pools.prefixes, nPre, rng);
    suffixes = pickUnique(pools.suffixes, nSuf, rng);
  }

  const instance = {
    id,
    instanceId: 'itm_' + Math.random().toString(36).slice(2, 10),
    rarity,
    prefixes: prefixes.map(a => a.key),
    suffixes: suffixes.map(a => a.key),

    instanceMods: buildInstanceModifiers(prefixes, suffixes),

    displayName: buildAffixedName(base.name, prefixes, suffixes, rng),
  };

  // Carry through unique-item metadata so equipped-item logic can read it
  if (base.unique) instance.unique = true;
  if (base.tribe) instance.tribe = base.tribe;
  if (base.grantsSkills) instance.grantsSkills = [...base.grantsSkills];

  // Carry through historic item flags
  if (base.historic) {
    instance.historic = true;
    instance.soulbound = !!base.soulbound;
    instance.renownState = 'historic';
    instance.history = { droppedFrom: null, droppedScenario: null, kills: 0, damageDealt: 0, battlesCarried: 0 };
    instance.questProgress = { lacerateBuildupDealt: 0, innocentBloodDrunk: 0, huntsCompleted: 0 };
  }

  // Base items that declare a renownOrigin (e.g. every Bone weapon) are
  // renown-capable the moment they exist — a drop source only has to pick
  // the right base id, and can pass droppedFrom via opts for the history log.
  if (base.renownOrigin) {
    applyRenownOrigin(instance, base.renownOrigin, {
      droppedFrom: opts.droppedFrom || null,
      droppedScenario: opts.droppedScenario || null,
    });
  }

  // For fixed-affix items, also record the rolled value for tooltip display
  if (base.fixedAffix && suffixes.length) {
    instance.fixedAffixKey = base.fixedAffix.key;
    instance.fixedAffixFamily = base.fixedAffix.family;
    instance.fixedAffixBuildupTarget = base.fixedAffix.buildupTarget || null;
    instance.fixedAffixValue = suffixes[0].rolledValue;
  }

  return instance;
}

// Honorific titles prepended to a prophet name when two tier-1 prefixes collide.
// Placed BEFORE the name ("Grand Solomon's") so the possessive reads naturally.
const GRAND_TITLES = [
  'Great', 'Grand', 'High', 'Elder', 'Mighty',
  'Noble', 'Venerable', 'Illustrious', 'Supreme', 'Hallowed'
];

/**
 * Determine whether a prefix key is a tier-1 "prophet" name.
 * Prophet names are possessives ending in \u2019s or \u2019 (curly apostrophe).
 * We detect them by checking the rolled affix's tier field.
 */
function isProphetPrefix(affix) {
  return affix?.tier === 1 && /\u2019/.test(affix?.key || '');
}

function buildAffixedName(baseName, prefixes, suffixes, rng = Math.random) {
  // ── Prefixes: prophet names always sort first ────────────────────────────
  const prophets = prefixes.filter(isProphetPrefix);
  const others   = prefixes.filter(a => !isProphetPrefix(a));

  let preKeys;
  if (prophets.length >= 2) {
    // Two prophet names — keep one, prefix it with an honorific title.
    // "Grand Solomon's Wraps" reads far better than "Solomon's Divine Wraps"
    // because the title modifies the person, not the item.
    const kept  = prophets[Math.floor(rng() * prophets.length)];
    const title = GRAND_TITLES[Math.floor(rng() * GRAND_TITLES.length)];
    preKeys = [title, kept.key, ...others.map(a => a.key)];
  } else {
    // Zero or one prophet — prophet leads, then other prefixes
    preKeys = [...prophets.map(a => a.key), ...others.map(a => a.key)];
  }

  const pre = preKeys.join(' ');

  // ── Suffixes: join multiple "of X" entries as "of X and Y" ───────────────
  // Strip the leading "of " from every entry except the first, then join.
  let suf = '';
  if (suffixes.length === 0) {
    suf = '';
  } else if (suffixes.length === 1) {
    suf = suffixes[0].key;
  } else {
    // All suffix keys start with "of " — first keeps it, rest lose the "of "
    const first = suffixes[0].key;                         // e.g. "of Sparks"
    const rest  = suffixes.slice(1).map(a => {
      const k = a.key;
      return k.startsWith('of ') ? k.slice(3) : k;        // "Thorns", "the Bear"
    });
    suf = `${first} and ${rest.join(', ')}`;               // "of Sparks and Thorns"
  }

  if (pre && suf) return `${pre} ${baseName} ${suf}`;
  if (pre)        return `${pre} ${baseName}`;
  if (suf)        return `${baseName} ${suf}`;
  return baseName;
}

/** Item instance type guard (unchanged behavior) */
export function isItemInstance(obj) {
  return obj && typeof obj === 'object' && 'id' in obj && 'instanceId' in obj;
}

/**
 * Read helper: get base item data merged with instance mods.
 * Works if you pass an instance or a raw base ID.
 * Returns a *computed view* object; does not mutate the base or instance.
 */
export function getItemComputedData(itemRef) {

  let base, instanceMods = null, displayName = null, rarity = null;
  if (isItemInstance(itemRef)) {
    base = Items[itemRef.id];
    instanceMods = itemRef.instanceMods || null;
    displayName = itemRef.displayName || null;
    // Support both new field (rarity) and legacy field (quality) from old saves
    rarity = itemRef.rarity || itemRef.quality || base?.rarity || base?.quality || 'common';
  } else {
    base = Items[itemRef];
  }
  if (!base) return null;


  const view = {
    ...base,
    name: displayName || base.name,
    rarity: rarity || base.rarity || base.quality || 'common',
  };

  if (instanceMods) {

    if (Object.keys(instanceMods.stats).length > 0) {

      view.bonuses = { ...(base.bonuses || {}) };
      for (const [k, v] of Object.entries(instanceMods.stats)) {
        view.bonuses[k] = (view.bonuses[k] || 0) + v;
      }
    }

    if (Object.keys(instanceMods.derived).length > 0) {
      view._derivedMods = { ...(instanceMods.derived || {}) };
    } else {
      view._derivedMods = {};
    }

    if (base.damage) {
      const flat = instanceMods.damageFlat || { min: 0, max: 0 };
      const percent = instanceMods.damagePercent?.weapon || 0;
      const baseMin = base.damage?.min || 0;
      const baseMax = base.damage?.max || 0;
      const totalMin = baseMin + (flat.min || 0);
      const totalMax = baseMax + (flat.max || 0);
      const mult = 1 + (percent / 100);
      view.damage = {
        min: Math.max(0, Math.floor(totalMin * mult)),
        max: Math.max(0, Math.floor(totalMax * mult)),
      };
    }

    const misc = instanceMods.misc || {};
    const elementalFlat = {};
    for (const [element, range] of Object.entries(instanceMods.elementalFlat || {})) {
      elementalFlat[element] = cloneRange(range);
    }

    // Display-only: elemental/necrotic flat damage scaled by local weapon
    // damage% for the TOOLTIP total. Deliberately a SEPARATE field from the
    // raw elementalFlat above — combat's calculateDamage() reads _weaponMods
    // .elementalFlat directly and applies its own localDamageMult to it, so
    // pre-scaling that same object here would double-apply local% in real
    // combat the moment the two ever got merged. This one is tooltip-only.
    {
      const localMult = 1 + ((instanceMods.damagePercent?.weapon || 0) / 100);
      view.displayScaledElementalFlat = {};
      for (const [element, range] of Object.entries(elementalFlat)) {
        view.displayScaledElementalFlat[element] = {
          min: Math.max(0, Math.floor((range.min || 0) * localMult)),
          max: Math.max(0, Math.floor((range.max || 0) * localMult)),
        };
      }
    }

    view._weaponMods = {
      damageFlat: { ...(instanceMods.damageFlat || { min: 0, max: 0 }) },
      localDamagePercent: instanceMods.damagePercent?.weapon || 0,
      elementalFlat,
      buildupPercent: { ...(misc.buildupPercent || {}) }
    };

    view._miscMods = {
      mpPerTurn: misc.mpPerTurn || 0,
      skillCostReductionPct: misc.skillCostReductionPct || 0,
      globalDamagePercent: misc.globalDamagePercent || 0,
      elementalDamagePercent: misc.elementalDamagePercent || 0,
      necroticDamagePercent: misc.necroticDamagePercent || 0,
      healingPercent: misc.healingPercent || 0,
      resilience: misc.resilience || 0,
      physicalBuildupPercent: misc.physicalBuildupPercent || 0,
      elementalBuildupPercent: misc.elementalBuildupPercent || 0,
      necroticBuildupPercent: misc.necroticBuildupPercent || 0,
      // Jewelry
      physToElemPercent: misc.physToElemPercent || 0,
      physToNecroPercent: misc.physToNecroPercent || 0,
      elemToNecroPercent: misc.elemToNecroPercent || 0,
      initBonusOnBattleStart: misc.initBonusOnBattleStart || 0,
      shieldPctOnBattleStart: misc.shieldPctOnBattleStart || 0,
      physBuildupOnPhysDmg: { ...(misc.physBuildupOnPhysDmg || {}) },
      elemBuildupOnElemDmg: { ...(misc.elemBuildupOnElemDmg || {}) },
      procDoubleDamage: misc.procDoubleDamage || 0,
      procHalfDamageTaken: misc.procHalfDamageTaken || 0,
      procHealOnHeal: misc.procHealOnHeal || 0,
      procElemFlat: misc.procElemFlat || 0,
      procNecroFlat: misc.procNecroFlat || 0,
      procPhysFlat: misc.procPhysFlat || 0,
      // Hunt Plan mods (src/systems/HuntModifiers.js shared schema)
      encounterChancePercent: misc.encounterChancePercent || 0,
      beastChanceWeight: misc.beastChanceWeight || 0,
      supplyEfficiencyPercent: misc.supplyEfficiencyPercent || 0,
      huntPointsPercent: misc.huntPointsPercent || 0,
      xpPercent: misc.xpPercent || 0,
      lootQualityPercent: misc.lootQualityPercent || 0,
    };
  }

  // Pass through unique-item fields from instance
  if (isItemInstance(itemRef)) {
    if (itemRef.unique) view.unique = true;
    if (itemRef.tribe) view.tribe = itemRef.tribe;
    if (itemRef.grantsSkills) view.grantsSkills = itemRef.grantsSkills;
    if (itemRef.fixedAffixKey) {
      view.fixedAffixKey = itemRef.fixedAffixKey;
      view.fixedAffixFamily = itemRef.fixedAffixFamily;
      view.fixedAffixBuildupTarget = itemRef.fixedAffixBuildupTarget;
      view.fixedAffixValue = itemRef.fixedAffixValue;
    }
  } else if (base.grantsSkills) {
    view.grantsSkills = base.grantsSkills;
  }

  return view;
}


// ============================================================================
// Renown origins
// ============================================================================
// An item is renown-capable because of WHERE IT CAME FROM, not its rarity.
// (This replaced an earlier placeholder that granted renown to any epic-rarity
// bone pile gamble.)
//
// The origin is declared on the BASE item definition, not bolted onto an
// instance after the fact. A Bone Dagger is its own base type sitting beside
// Crude Dagger with its own damage range -- it is not a Crude Dagger wearing a
// bonus, so its higher damage is ordinary base damage and is scaled by
// "% weapon damage" affixes exactly like any other weapon's.
//
// The origin matters because the renown tree keys off it: each origin unlocks
// its own arm of the shared web, and those arms are one-way.
export const RENOWN_ORIGINS = {
  bone: { id: 'bone', label: 'Bone' },
  // Earned rather than dropped: severing the soul-bond on an item that
  // was never meant to be lootable. Applied by the Severing Chant
  // consumables in combat, not by any drop table.
  //
  // Unlike bone (which is its own base type), severing REBRANDS the item it
  // acts on: the base name's leading descriptor is replaced with "Severed", so
  // "Light Cap" -> "Severed Cap" and "Crude War Mace" -> "Severed War Mace".
  // Every base name in the game is "<descriptor> <type noun(s)>", so dropping
  // the first word leaves exactly the type. Single-word names (Bloodthirster)
  // get it prepended instead.
  severed: {
    id: 'severed',
    label: 'Severed',
    renameBase: (baseName) => {
      const parts = String(baseName || '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return 'Severed';
      return parts.length > 1
        ? ['Severed', ...parts.slice(1)].join(' ')
        : `Severed ${parts[0]}`;
    },
  },
};

// Default renown needed to fully traverse. Placeholder until the tree exists.
export const DEFAULT_RENOWN_MAX = 1000;

/**
 * Stamps the renown fields onto a freshly created instance whose base item
 * declares a renownOrigin. Called automatically by createItemInstance, so a
 * drop source only has to pick the right base id -- nothing has to remember to
 * mark it afterwards.
 *
 * Field names are the pre-existing ones so the inventory panel's renown bar,
 * the Inspect button gate and itemTooltip all keep working untouched;
 * renownOrigin is the only addition.
 */
export function applyRenownOrigin(instance, originId, opts = {}) {
  if (!isItemInstance(instance)) return instance;
  if (instance.renownOrigin) return instance;
  if (!RENOWN_ORIGINS[originId]) {
    console.warn(`[ItemFactory] unknown renown origin '${originId}'`);
    return instance;
  }
  instance.renownOrigin = originId;

  // Rebrand the base-name portion in place, leaving rolled affixes alone:
  // "Swift Light Cap of the Lion" -> "Swift Severed Cap of the Lion".
  // Replacing the exact base-name substring is safer than counting words in
  // the affixed name, since prefixes and suffixes are variable length.
  const originDef = RENOWN_ORIGINS[originId];
  if (originDef.renameBase && instance.displayName) {
    const baseName = Items[instance.id]?.name;
    if (baseName && instance.displayName.includes(baseName)) {
      instance.displayName = instance.displayName.replace(baseName, originDef.renameBase(baseName));
    }
  }

  instance.renownState = 'gaining';
  instance.renown = 0;
  instance.renownMax = opts.renownMax ?? DEFAULT_RENOWN_MAX;
  instance.history = {
    droppedFrom: opts.droppedFrom || null,
    droppedScenario: opts.droppedScenario || null,
    kills: 0, damageDealt: 0, battlesCarried: 0,
  };
  return instance;
}

/** Every base item id carrying the given renown origin. */
export function getRenownItemIds(originId, { type = null } = {}) {
  return Object.entries(Items)
    .filter(([, it]) => it?.renownOrigin === originId && (!type || it.type === type))
    .map(([id]) => id);
}
