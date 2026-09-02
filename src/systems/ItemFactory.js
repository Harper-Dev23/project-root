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
    range: range,
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
    range: range,
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
    range: r,
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
    range: r,
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
    range: r,
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
    range: r,
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
/**
 * Armour stat suffix ("of the Bear" = +STR).
 *
 * `key` is the INTERNAL identity and must be unique -- it is what an instance
 * persists and what getAffixIndex is keyed by. `label` is what the player
 * sees, and is deliberately SHARED across every tier of one animal: the
 * player reads the tier off the value (+1 vs +8), not off a different name.
 *
 * The bare key ("of the Bear") is kept for tier 5 at its original flat +1, so
 * every item saved before these were tiered still resolves in the index and
 * still means exactly what it meant then.
 *
 * `family` is per-STAT so pickUnique cannot roll two tiers of the same animal
 * onto one item. Two DIFFERENT animals are still fine ("of the Bear and the
 * Serpent"), which is how it behaved when these were untiered.
 */
function makeStatSuffix({ key, label, stat, tier = null, family = null, range = null }) {
  return {
    key,
    label: label || key,
    range,
    tier,
    family,
    roll(rng) {
      // Low tiers are a fixed point, high tiers roll a spread -- a big suffix
      // should be worth inspecting, a +1 should not.
      const amount = range ? rollInt(range, rng) : 1;
      return {
        key,
        label: label || key,
        tier,
        family,
        mods: { stats: { [stat]: amount } }
      };
    }
  };
}

/**
 * Hybrid buildup suffix — one rolled value applied to TWO families in the
 * same category.
 *
 * `family` is the pair itself ("fire+cold"), not either member. That single
 * choice is what makes this need no dedupe changes: pickUnique already
 * refuses two entries sharing a family, so two tiers of the same pair can
 * never co-roll, while "fire" and "fire+cold" read as different families and
 * are free to appear together — deliberate, since stacking a broad roll with
 * a narrow one is a real build decision rather than an accident.
 */
function makeHybridBuildupSuffix({ key, tier, families, range }, scale = 1) {
  const r = scaleRange(range, scale);
  const famKey = families.join('+');
  return {
    key,
    range: r,
    tier,
    family: famKey,
    families: [...families],
    roll(rng) {
      // ONE roll shared by both families rather than two independent ones:
      // an item that read "+31% fire / +12% cold" from a single affix would
      // look like a bug, and the pair is meant to be a single decision.
      const amount = rollInt(r, rng);
      const buildupPercent = {};
      for (const f of families) buildupPercent[f] = amount;
      return { key, tier, family: famKey, mods: { misc: { buildupPercent } } };
    }
  };
}

function makeBuildupSuffix({ key, tier, family, range }, scale = 1) {
  const r = scaleRange(range, scale);
  return {
    key,
    range: r,
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
  makeDerivedArmorPrefix({ key: 'Sanctified', tier: 3, derivedKey: 'maxHP', range: [6, 9] }),
    makeDerivedArmorPrefix({ key: 'Mended', tier: 4, derivedKey: 'maxHP', range: [3, 5] }),
    makeDerivedArmorPrefix({ key: 'Patched', tier: 5, derivedKey: 'maxHP', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Covenant', tier: 2, derivedKey: 'maxHP', range: [10, 14] }),
  makeDerivedArmorPrefix({ key: 'Elijah\u2019s', tier: 1, derivedKey: 'maxHP', range: [15, 20] }),

  // Max MP
  makeDerivedArmorPrefix({ key: 'Anointed', tier: 3, derivedKey: 'maxMP', range: [6, 9] }),
    makeDerivedArmorPrefix({ key: 'Quiet', tier: 4, derivedKey: 'maxMP', range: [3, 5] }),
    makeDerivedArmorPrefix({ key: 'Hollow', tier: 5, derivedKey: 'maxMP', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Sanctuary', tier: 2, derivedKey: 'maxMP', range: [10, 14] }),
  makeDerivedArmorPrefix({ key: 'Isaiah\u2019s', tier: 1, derivedKey: 'maxMP', range: [15, 20] }),

  // Physical Resist
  makeDerivedArmorPrefix({ key: 'Blessed', tier: 3, derivedKey: 'PhysicalResist', range: [6, 9] }),
    makeDerivedArmorPrefix({ key: 'Braced', tier: 4, derivedKey: 'PhysicalResist', range: [3, 5] }),
    makeDerivedArmorPrefix({ key: 'Layered', tier: 5, derivedKey: 'PhysicalResist', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Exalted', tier: 2, derivedKey: 'PhysicalResist', range: [10, 14] }),
  makeDerivedArmorPrefix({ key: 'David\u2019s', tier: 1, derivedKey: 'PhysicalResist', range: [15, 20] }),

  // Elemental Resist
  makeDerivedArmorPrefix({ key: 'Hallowed', tier: 3, derivedKey: 'ElementalResist', range: [6, 9] }),
    makeDerivedArmorPrefix({ key: 'Insulated', tier: 4, derivedKey: 'ElementalResist', range: [3, 5] }),
    makeDerivedArmorPrefix({ key: 'Lined', tier: 5, derivedKey: 'ElementalResist', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Redeemed', tier: 2, derivedKey: 'ElementalResist', range: [10, 14] }),
  makeDerivedArmorPrefix({ key: 'Samuel\u2019s', tier: 1, derivedKey: 'ElementalResist', range: [15, 20] }),

  // Necrotic Resist
  makeDerivedArmorPrefix({ key: 'Warded', tier: 3, derivedKey: 'NecroticResist', range: [6, 9] }),
    makeDerivedArmorPrefix({ key: 'Salted', tier: 4, derivedKey: 'NecroticResist', range: [3, 5] }),
    makeDerivedArmorPrefix({ key: 'Bound', tier: 5, derivedKey: 'NecroticResist', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Sealed', tier: 2, derivedKey: 'NecroticResist', range: [10, 14] }),
  makeDerivedArmorPrefix({ key: 'Ezekiel\u2019s', tier: 1, derivedKey: 'NecroticResist', range: [15, 20] }),

  // Accuracy
  makeDerivedArmorPrefix({ key: 'Ordained', tier: 3, derivedKey: 'Accuracy', range: [6, 9] }),
    makeDerivedArmorPrefix({ key: 'Steady', tier: 4, derivedKey: 'Accuracy', range: [3, 5] }),
    makeDerivedArmorPrefix({ key: 'Level', tier: 5, derivedKey: 'Accuracy', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Zealous', tier: 2, derivedKey: 'Accuracy', range: [10, 14] }),
  makeDerivedArmorPrefix({ key: 'Zechariah\u2019s', tier: 1, derivedKey: 'Accuracy', range: [15, 20] }),

  // Evasion
  makeDerivedArmorPrefix({ key: 'Fleet', tier: 3, derivedKey: 'Evasion', range: [6, 9] }),
    makeDerivedArmorPrefix({ key: 'Nimble', tier: 4, derivedKey: 'Evasion', range: [3, 5] }),
    makeDerivedArmorPrefix({ key: 'Loose', tier: 5, derivedKey: 'Evasion', range: [1, 2] }),
  makeDerivedArmorPrefix({ key: 'Swift', tier: 2, derivedKey: 'Evasion', range: [10, 14] }),
  makeDerivedArmorPrefix({ key: 'Nahum\u2019s', tier: 1, derivedKey: 'Evasion', range: [15, 20] }),

  // MP Regen (per turn)
  makeMiscArmorPrefix({ key: 'Meditative', tier: 3, prop: 'mpPerTurn', range: [2, 3] }),
    makeMiscArmorPrefix({ key: 'Thoughtful', tier: 4, prop: 'mpPerTurn', range: [1, 2] }),
    makeMiscArmorPrefix({ key: 'Idle', tier: 5, prop: 'mpPerTurn', range: [1, 1] }),
  makeMiscArmorPrefix({ key: 'Devout', tier: 2, prop: 'mpPerTurn', range: [3, 5] }),
  makeMiscArmorPrefix({ key: 'Elisha\u2019s', tier: 1, prop: 'mpPerTurn', range: [5, 7] }),

  // Skill Cost Reduction (% of MP/HP costs)
  makeMiscArmorPrefix({ key: 'Frugal', tier: 3, prop: 'skillCostReductionPct', range: [5, 7] }),
    makeMiscArmorPrefix({ key: 'Sparing', tier: 4, prop: 'skillCostReductionPct', range: [3, 4] }),
    makeMiscArmorPrefix({ key: 'Thrifty', tier: 5, prop: 'skillCostReductionPct', range: [1, 2] }),
  makeMiscArmorPrefix({ key: 'Temperate', tier: 2, prop: 'skillCostReductionPct', range: [8, 10] }),
  makeMiscArmorPrefix({ key: 'Solomon\u2019s', tier: 1, prop: 'skillCostReductionPct', range: [12, 15] }),

  // Crit Chance (%)
  makeDerivedArmorPrefix({ key: 'Keen', tier: 3, derivedKey: 'CritChance', range: [4, 5] }),
    makeDerivedArmorPrefix({ key: 'Pointed', tier: 4, derivedKey: 'CritChance', range: [2, 3] }),
    makeDerivedArmorPrefix({ key: 'Filed', tier: 5, derivedKey: 'CritChance', range: [1, 1] }),
  makeDerivedArmorPrefix({ key: 'Sharp', tier: 2, derivedKey: 'CritChance', range: [7, 8] }),
  makeDerivedArmorPrefix({ key: 'Micah\u2019s', tier: 1, derivedKey: 'CritChance', range: [11, 12] }),

  // Damage % (all sources)
  makeMiscArmorPrefix({ key: 'Strong', tier: 3, prop: 'globalDamagePercent', range: [5, 7] }),
    makeMiscArmorPrefix({ key: 'Hardy', tier: 4, prop: 'globalDamagePercent', range: [3, 4] }),
    makeMiscArmorPrefix({ key: 'Able', tier: 5, prop: 'globalDamagePercent', range: [1, 2] }),
  makeMiscArmorPrefix({ key: 'Mighty', tier: 2, prop: 'globalDamagePercent', range: [8, 10] }),
  makeMiscArmorPrefix({ key: 'Amos\u2019', tier: 1, prop: 'globalDamagePercent', range: [12, 15] }),

  // Healing % (all sources) \u2014 armor-side counterpart, same ranges as
  // globalDamagePercent above. Consumed by applyHealModifiers (CombatLogic.js).
  makeMiscArmorPrefix({ key: 'Nurturing', tier: 3, prop: 'healingPercent', range: [5, 7] }),
    makeMiscArmorPrefix({ key: 'Tending', tier: 4, prop: 'healingPercent', range: [3, 4] }),
    makeMiscArmorPrefix({ key: 'Kindly', tier: 5, prop: 'healingPercent', range: [1, 2] }),
  makeMiscArmorPrefix({ key: 'Restoring', tier: 2, prop: 'healingPercent', range: [8, 10] }),
  makeMiscArmorPrefix({ key: 'Miriam\u2019s', tier: 1, prop: 'healingPercent', range: [12, 15] }),

  // Resilience (Buildup resistance)
  // v3.3: buffed alongside the weakness decay rebalance \u2014 decay got weaker, so
  // resilience (flat reduction to incoming buildup, CombatScene.js _applyWeakness)
  // needs to carry more of the "resisting weakness" weight than before.
  makeMiscArmorPrefix({ key: 'Stalwart', tier: 3, prop: 'resilience', range: [18, 25] }),
    makeMiscArmorPrefix({ key: 'Rooted', tier: 4, prop: 'resilience', range: [8, 14] }),
    makeMiscArmorPrefix({ key: 'Settled', tier: 5, prop: 'resilience', range: [3, 6] }),
  makeMiscArmorPrefix({ key: 'Unyielding', tier: 2, prop: 'resilience', range: [33, 40] }),
  makeMiscArmorPrefix({ key: 'Job\u2019s', tier: 1, prop: 'resilience', range: [53, 60] }),

  // Buildup % by damage-type CATEGORY (physical/elemental/necrotic) \u2014 the
  // armor-side counterpart to the weapon suffixes' per-FAMILY buildup% above.
  // Broader (any family in that category) but smaller (3-11%, vs. weapons'
  // 9-50%) \u2014 same category split calculateDerivedStats/mitigation already use
  // (physical: expose/lacerate/disorient, elemental: fire/cold/lightning,
  // necrotic: toxic/disease/curse). Consumed by _applyWeaknessBuildup
  // (CombatScene.js), combined ADDITIVELY with the weapon per-family bonus
  // into one multiplier \u2014 same-stage gear bonuses, not sequential stages.
  makeMiscArmorPrefix({ key: 'Forceful', tier: 3, prop: 'physicalBuildupPercent', range: [9, 11] }),
    makeMiscArmorPrefix({ key: 'Firm', tier: 4, prop: 'physicalBuildupPercent', range: [6, 8] }),
    makeMiscArmorPrefix({ key: 'Nudging', tier: 5, prop: 'physicalBuildupPercent', range: [3, 5] }),
  makeMiscArmorPrefix({ key: 'Battering', tier: 2, prop: 'physicalBuildupPercent', range: [12, 14] }),
  makeMiscArmorPrefix({ key: 'Titan\u2019s', tier: 1, prop: 'physicalBuildupPercent', range: [15, 17] }),

  makeMiscArmorPrefix({ key: 'Charged', tier: 3, prop: 'elementalBuildupPercent', range: [9, 11] }),
    makeMiscArmorPrefix({ key: 'Restless', tier: 4, prop: 'elementalBuildupPercent', range: [6, 8] }),
    makeMiscArmorPrefix({ key: 'Stirring', tier: 5, prop: 'elementalBuildupPercent', range: [3, 5] }),
  makeMiscArmorPrefix({ key: 'Volatile', tier: 2, prop: 'elementalBuildupPercent', range: [12, 14] }),
  makeMiscArmorPrefix({ key: 'Zephyr\u2019s', tier: 1, prop: 'elementalBuildupPercent', range: [15, 17] }),

  makeMiscArmorPrefix({ key: 'Festering', tier: 3, prop: 'necroticBuildupPercent', range: [9, 11] }),
    makeMiscArmorPrefix({ key: 'Souring', tier: 4, prop: 'necroticBuildupPercent', range: [6, 8] }),
    makeMiscArmorPrefix({ key: 'Tainted', tier: 5, prop: 'necroticBuildupPercent', range: [3, 5] }),
  makeMiscArmorPrefix({ key: 'Defiling', tier: 2, prop: 'necroticBuildupPercent', range: [12, 14] }),
  makeMiscArmorPrefix({ key: 'Mordecai\u2019s', tier: 1, prop: 'necroticBuildupPercent', range: [15, 17] })
];

const ARMOR_SUFFIX_POOL = [
  // One entry per animal PER TIER. The display label repeats on purpose; only
  // the internal key and the rolled value differ. Tier 5 keeps the original
  // bare key and the original flat +1, so nothing already in a save changes.
  makeStatSuffix({ key: 'of the Bear', label: 'of the Bear', stat: 'STR', tier: 5, family: 'stat_STR', range: [1, 1] }),
  makeStatSuffix({ key: 'of the Bear [T4]', label: 'of the Bear', stat: 'STR', tier: 4, family: 'stat_STR', range: [2, 2] }),
  makeStatSuffix({ key: 'of the Bear [T3]', label: 'of the Bear', stat: 'STR', tier: 3, family: 'stat_STR', range: [3, 4] }),
  makeStatSuffix({ key: 'of the Bear [T2]', label: 'of the Bear', stat: 'STR', tier: 2, family: 'stat_STR', range: [5, 6] }),
  makeStatSuffix({ key: 'of the Bear [T1]', label: 'of the Bear', stat: 'STR', tier: 1, family: 'stat_STR', range: [7, 9] }),

  makeStatSuffix({ key: 'of the Wolf', label: 'of the Wolf', stat: 'DEX', tier: 5, family: 'stat_DEX', range: [1, 1] }),
  makeStatSuffix({ key: 'of the Wolf [T4]', label: 'of the Wolf', stat: 'DEX', tier: 4, family: 'stat_DEX', range: [2, 2] }),
  makeStatSuffix({ key: 'of the Wolf [T3]', label: 'of the Wolf', stat: 'DEX', tier: 3, family: 'stat_DEX', range: [3, 4] }),
  makeStatSuffix({ key: 'of the Wolf [T2]', label: 'of the Wolf', stat: 'DEX', tier: 2, family: 'stat_DEX', range: [5, 6] }),
  makeStatSuffix({ key: 'of the Wolf [T1]', label: 'of the Wolf', stat: 'DEX', tier: 1, family: 'stat_DEX', range: [7, 9] }),

  makeStatSuffix({ key: 'of the Boar', label: 'of the Boar', stat: 'CON', tier: 5, family: 'stat_CON', range: [1, 1] }),
  makeStatSuffix({ key: 'of the Boar [T4]', label: 'of the Boar', stat: 'CON', tier: 4, family: 'stat_CON', range: [2, 2] }),
  makeStatSuffix({ key: 'of the Boar [T3]', label: 'of the Boar', stat: 'CON', tier: 3, family: 'stat_CON', range: [3, 4] }),
  makeStatSuffix({ key: 'of the Boar [T2]', label: 'of the Boar', stat: 'CON', tier: 2, family: 'stat_CON', range: [5, 6] }),
  makeStatSuffix({ key: 'of the Boar [T1]', label: 'of the Boar', stat: 'CON', tier: 1, family: 'stat_CON', range: [7, 9] }),

  makeStatSuffix({ key: 'of the Serpent', label: 'of the Serpent', stat: 'INT', tier: 5, family: 'stat_INT', range: [1, 1] }),
  makeStatSuffix({ key: 'of the Serpent [T4]', label: 'of the Serpent', stat: 'INT', tier: 4, family: 'stat_INT', range: [2, 2] }),
  makeStatSuffix({ key: 'of the Serpent [T3]', label: 'of the Serpent', stat: 'INT', tier: 3, family: 'stat_INT', range: [3, 4] }),
  makeStatSuffix({ key: 'of the Serpent [T2]', label: 'of the Serpent', stat: 'INT', tier: 2, family: 'stat_INT', range: [5, 6] }),
  makeStatSuffix({ key: 'of the Serpent [T1]', label: 'of the Serpent', stat: 'INT', tier: 1, family: 'stat_INT', range: [7, 9] }),

  makeStatSuffix({ key: 'of the Stag', label: 'of the Stag', stat: 'WIS', tier: 5, family: 'stat_WIS', range: [1, 1] }),
  makeStatSuffix({ key: 'of the Stag [T4]', label: 'of the Stag', stat: 'WIS', tier: 4, family: 'stat_WIS', range: [2, 2] }),
  makeStatSuffix({ key: 'of the Stag [T3]', label: 'of the Stag', stat: 'WIS', tier: 3, family: 'stat_WIS', range: [3, 4] }),
  makeStatSuffix({ key: 'of the Stag [T2]', label: 'of the Stag', stat: 'WIS', tier: 2, family: 'stat_WIS', range: [5, 6] }),
  makeStatSuffix({ key: 'of the Stag [T1]', label: 'of the Stag', stat: 'WIS', tier: 1, family: 'stat_WIS', range: [7, 9] }),

  makeStatSuffix({ key: 'of the Lion', label: 'of the Lion', stat: 'CHA', tier: 5, family: 'stat_CHA', range: [1, 1] }),
  makeStatSuffix({ key: 'of the Lion [T4]', label: 'of the Lion', stat: 'CHA', tier: 4, family: 'stat_CHA', range: [2, 2] }),
  makeStatSuffix({ key: 'of the Lion [T3]', label: 'of the Lion', stat: 'CHA', tier: 3, family: 'stat_CHA', range: [3, 4] }),
  makeStatSuffix({ key: 'of the Lion [T2]', label: 'of the Lion', stat: 'CHA', tier: 2, family: 'stat_CHA', range: [5, 6] }),
  makeStatSuffix({ key: 'of the Lion [T1]', label: 'of the Lion', stat: 'CHA', tier: 1, family: 'stat_CHA', range: [7, 9] }),
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
    makeWeaponFlatPrefix({ key: 'Honed', tier: 3, field: 'min', range: [4, 5] }, local),
    makeWeaponFlatPrefix({ key: 'Whetted', tier: 4, field: 'min', range: [2, 3] }, local),
    makeWeaponFlatPrefix({ key: 'Trued', tier: 5, field: 'min', range: [1, 2] }, local),
    makeWeaponFlatPrefix({ key: 'Sharpened', tier: 2, field: 'min', range: [7, 8] }, local),
    makeWeaponFlatPrefix({ key: 'Razor-edged', tier: 1, field: 'min', range: [11, 12] }, local),

    // Flat max damage
    makeWeaponFlatPrefix({ key: 'Weighted', tier: 3, field: 'max', range: [4, 5] }, local),
    makeWeaponFlatPrefix({ key: 'Heavy', tier: 4, field: 'max', range: [2, 3] }, local),
    makeWeaponFlatPrefix({ key: 'Solid', tier: 5, field: 'max', range: [1, 2] }, local),
    makeWeaponFlatPrefix({ key: 'Tempered', tier: 2, field: 'max', range: [7, 8] }, local),
    makeWeaponFlatPrefix({ key: 'Crushing', tier: 1, field: 'max', range: [11, 12] }, local),

    // % weapon damage (local) — was topping out at 7-10%, vastly outcomputed by
    // flat damage adds; new top tier reaches up to 40% so this stat has room to
    // actually matter on the item once flat numbers scale up too. Gapless: each
    // tier's max is exactly one less than the next tier's min.
    // Renumbered off the old 0-3 scheme onto the same 1 = best convention every
    // other family uses. This family is the only one that ever had a tier 0,
    // and once item level gates on tier NUMBER a stray 0 would read as an
    // unusually weak affix rather than the strongest one. Ranges unchanged.
    makeWeaponPercentPrefix({ key: 'Rugged', tier: 4, range: [7, 15] }, local),
    makeWeaponPercentPrefix({ key: 'Blunt', tier: 5, range: [2, 6] }, local),
    makeWeaponPercentPrefix({ key: 'Vicious', tier: 3, range: [16, 27] }, local),
    makeWeaponPercentPrefix({ key: 'Brutal', tier: 2, range: [28, 40] }, local),
    makeWeaponPercentPrefix({ key: 'Merciless', tier: 1, range: [43, 55] }, local),

    // Flat elemental damage
    makeWeaponElementFlatPrefix({ key: 'Smoldering', tier: 3, element: 'fire', range: [3, 4] }, local),
    makeWeaponElementFlatPrefix({ key: 'Warming', tier: 4, element: 'fire', range: [2, 3] }, local),
    makeWeaponElementFlatPrefix({ key: 'Sooty', tier: 5, element: 'fire', range: [1, 2] }, local),
    makeWeaponElementFlatPrefix({ key: 'Burning', tier: 2, element: 'fire', range: [5, 6] }, local),
    makeWeaponElementFlatPrefix({ key: 'Infernal', tier: 1, element: 'fire', range: [7, 8] }, local),

    makeWeaponElementFlatPrefix({ key: 'Chilling', tier: 3, element: 'cold', range: [3, 4] }, local),
    makeWeaponElementFlatPrefix({ key: 'Cooling', tier: 4, element: 'cold', range: [2, 3] }, local),
    makeWeaponElementFlatPrefix({ key: 'Dewed', tier: 5, element: 'cold', range: [1, 2] }, local),
    makeWeaponElementFlatPrefix({ key: 'Freezing', tier: 2, element: 'cold', range: [5, 6] }, local),
    makeWeaponElementFlatPrefix({ key: 'Glacial', tier: 1, element: 'cold', range: [7, 8] }, local),

    makeWeaponElementFlatPrefix({ key: 'Sparking', tier: 3, element: 'lightning', range: [3, 4] }, local),
    makeWeaponElementFlatPrefix({ key: 'Buzzing', tier: 4, element: 'lightning', range: [2, 3] }, local),
    makeWeaponElementFlatPrefix({ key: 'Humming', tier: 5, element: 'lightning', range: [1, 2] }, local),
    makeWeaponElementFlatPrefix({ key: 'Crackling', tier: 2, element: 'lightning', range: [5, 6] }, local),
    makeWeaponElementFlatPrefix({ key: 'Thunderous', tier: 1, element: 'lightning', range: [7, 8] }, local),

    makeWeaponElementFlatPrefix({ key: 'Withering', tier: 3, element: 'necrotic', range: [3, 4] }, local),
    makeWeaponElementFlatPrefix({ key: 'Wilting', tier: 4, element: 'necrotic', range: [2, 3] }, local),
    makeWeaponElementFlatPrefix({ key: 'Musty', tier: 5, element: 'necrotic', range: [1, 2] }, local),
    makeWeaponElementFlatPrefix({ key: 'Blighted', tier: 2, element: 'necrotic', range: [5, 6] }, local),
    makeWeaponElementFlatPrefix({ key: 'Corrupting', tier: 1, element: 'necrotic', range: [7, 8] }, local),

    // % Elemental / Necrotic (global)
    makeWeaponElementPercentPrefix({ key: 'Flaring', tier: 3, prop: 'elementalDamagePercent', range: [10, 14] }, global),
    makeWeaponElementPercentPrefix({ key: 'Kindled', tier: 4, prop: 'elementalDamagePercent', range: [6, 8] }, global),
    makeWeaponElementPercentPrefix({ key: 'Glowing', tier: 5, prop: 'elementalDamagePercent', range: [2, 4] }, global),
    makeWeaponElementPercentPrefix({ key: 'Shocking', tier: 2, prop: 'elementalDamagePercent', range: [16, 20] }, global),
    makeWeaponElementPercentPrefix({ key: 'Cataclysmic', tier: 1, prop: 'elementalDamagePercent', range: [24, 30] }, global),

    makeWeaponElementPercentPrefix({ key: 'Foul', tier: 3, prop: 'necroticDamagePercent', range: [10, 14] }, global),
    makeWeaponElementPercentPrefix({ key: 'Tainting', tier: 4, prop: 'necroticDamagePercent', range: [6, 8] }, global),
    makeWeaponElementPercentPrefix({ key: 'Grubby', tier: 5, prop: 'necroticDamagePercent', range: [2, 4] }, global),
    makeWeaponElementPercentPrefix({ key: 'Profane', tier: 2, prop: 'necroticDamagePercent', range: [16, 20] }, global),
    makeWeaponElementPercentPrefix({ key: 'Unholy', tier: 1, prop: 'necroticDamagePercent', range: [24, 30] }, global),

    // % Healing — weapon-side counterpart, same ranges as the elemental/
    // necrotic % affixes above. Consumed by applyHealModifiers (CombatLogic.js).
    makeWeaponElementPercentPrefix({ key: 'Soothing', tier: 3, prop: 'healingPercent', range: [10, 14] }, global),
    makeWeaponElementPercentPrefix({ key: 'Salving', tier: 4, prop: 'healingPercent', range: [6, 8] }, global),
    makeWeaponElementPercentPrefix({ key: 'Balmy', tier: 5, prop: 'healingPercent', range: [2, 4] }, global),
    makeWeaponElementPercentPrefix({ key: 'Restorative', tier: 2, prop: 'healingPercent', range: [16, 20] }, global),
    makeWeaponElementPercentPrefix({ key: 'Consecrated', tier: 1, prop: 'healingPercent', range: [24, 30] }, global),
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
    makeBuildupSuffix({ key: 'of Sparks', tier: 3, family: 'fire', range: [37, 50] }, global),
    makeBuildupSuffix({ key: 'of Smoulder', tier: 4, family: 'fire', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Ash', tier: 5, family: 'fire', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Flames', tier: 2, family: 'fire', range: [51, 64] }, global),
    makeBuildupSuffix({ key: 'of Inferno', tier: 1, family: 'fire', range: [65, 78] }, global),

    // Cold buildup
    makeBuildupSuffix({ key: 'of Chill', tier: 3, family: 'cold', range: [37, 50] }, global),
    makeBuildupSuffix({ key: 'of Shivers', tier: 4, family: 'cold', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Draft', tier: 5, family: 'cold', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Frost', tier: 2, family: 'cold', range: [51, 64] }, global),
    makeBuildupSuffix({ key: 'of Blizzard', tier: 1, family: 'cold', range: [65, 78] }, global),

    // Lightning buildup
    makeBuildupSuffix({ key: 'of Static', tier: 3, family: 'lightning', range: [37, 50] }, global),
    makeBuildupSuffix({ key: 'of Prickle', tier: 4, family: 'lightning', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Tingle', tier: 5, family: 'lightning', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Storms', tier: 2, family: 'lightning', range: [51, 64] }, global),
    makeBuildupSuffix({ key: 'of Tempest', tier: 1, family: 'lightning', range: [65, 78] }, global),

    // Lacerate buildup
    makeBuildupSuffix({ key: 'of Scratches', tier: 3, family: 'lacerate', range: [37, 50] }, global),
    makeBuildupSuffix({ key: 'of Nicks', tier: 4, family: 'lacerate', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Grazes', tier: 5, family: 'lacerate', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Wounds', tier: 2, family: 'lacerate', range: [51, 64] }, global),
    makeBuildupSuffix({ key: 'of Hemorrhage', tier: 1, family: 'lacerate', range: [65, 78] }, global),

    // Expose buildup
    makeBuildupSuffix({ key: 'of Bruises', tier: 3, family: 'expose', range: [37, 50] }, global),
    makeBuildupSuffix({ key: 'of Welts', tier: 4, family: 'expose', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Smudges', tier: 5, family: 'expose', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Flaying', tier: 2, family: 'expose', range: [51, 64] }, global),
    makeBuildupSuffix({ key: 'of Ruin', tier: 1, family: 'expose', range: [65, 78] }, global),

    // Disorient buildup
    makeBuildupSuffix({ key: 'of Echoes', tier: 3, family: 'disorient', range: [37, 50] }, global),
    makeBuildupSuffix({ key: 'of Murmurs', tier: 4, family: 'disorient', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Haze', tier: 5, family: 'disorient', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Daze', tier: 2, family: 'disorient', range: [51, 64] }, global),
    makeBuildupSuffix({ key: 'of Concussion', tier: 1, family: 'disorient', range: [65, 78] }, global),

    // Disease buildup
    makeBuildupSuffix({ key: 'of Rot', tier: 3, family: 'disease', range: [37, 50] }, global),
    makeBuildupSuffix({ key: 'of Blight', tier: 4, family: 'disease', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Mildew', tier: 5, family: 'disease', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Plague', tier: 2, family: 'disease', range: [51, 64] }, global),
    makeBuildupSuffix({ key: 'of Pestilence', tier: 1, family: 'disease', range: [65, 78] }, global),

    // Curse buildup
    makeBuildupSuffix({ key: 'of Whispers', tier: 3, family: 'curse', range: [37, 50] }, global),
    makeBuildupSuffix({ key: 'of Mutters', tier: 4, family: 'curse', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Doubt', tier: 5, family: 'curse', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Hexes', tier: 2, family: 'curse', range: [51, 64] }, global),
    makeBuildupSuffix({ key: 'of Affliction', tier: 1, family: 'curse', range: [65, 78] }, global),

    // Toxic buildup
    makeBuildupSuffix({ key: 'of Venom', tier: 3, family: 'toxic', range: [37, 50] }, global),
    makeBuildupSuffix({ key: 'of Bile', tier: 4, family: 'toxic', range: [23, 36] }, global),
    makeBuildupSuffix({ key: 'of Souring', tier: 5, family: 'toxic', range: [9, 22] }, global),
    makeBuildupSuffix({ key: 'of Toxins', tier: 2, family: 'toxic', range: [51, 64] }, global),
    makeBuildupSuffix({ key: 'of Envenoming', tier: 1, family: 'toxic', range: [65, 78] }, global),

    // === Hybrid buildup (two families, ~62% each) ======================
    // Breadth costs magnitude: 62+62 across two families against 100
    // concentrated in one, so a hybrid is never a strict upgrade.

    // Elemental pairs
    makeHybridBuildupSuffix({ key: 'of Blistering', tier: 1, families: ['fire', 'cold'], range: [40, 48] }, global),
    makeHybridBuildupSuffix({ key: 'of Scalding', tier: 2, families: ['fire', 'cold'], range: [32, 40] }, global),
    makeHybridBuildupSuffix({ key: 'of Steam', tier: 3, families: ['fire', 'cold'], range: [23, 31] }, global),
    makeHybridBuildupSuffix({ key: 'of Vapour', tier: 4, families: ['fire', 'cold'], range: [14, 22] }, global),
    makeHybridBuildupSuffix({ key: 'of Mist', tier: 5, families: ['fire', 'cold'], range: [6, 14] }, global),
    makeHybridBuildupSuffix({ key: 'of Firestorm', tier: 1, families: ['fire', 'lightning'], range: [40, 48] }, global),
    makeHybridBuildupSuffix({ key: 'of Cinderfall', tier: 2, families: ['fire', 'lightning'], range: [32, 40] }, global),
    makeHybridBuildupSuffix({ key: 'of Emberflash', tier: 3, families: ['fire', 'lightning'], range: [23, 31] }, global),
    makeHybridBuildupSuffix({ key: 'of Crackle', tier: 4, families: ['fire', 'lightning'], range: [14, 22] }, global),
    makeHybridBuildupSuffix({ key: 'of Fizzle', tier: 5, families: ['fire', 'lightning'], range: [6, 14] }, global),
    makeHybridBuildupSuffix({ key: 'of Hailstorm', tier: 1, families: ['cold', 'lightning'], range: [40, 48] }, global),
    makeHybridBuildupSuffix({ key: 'of Sleet', tier: 2, families: ['cold', 'lightning'], range: [32, 40] }, global),
    makeHybridBuildupSuffix({ key: 'of Glaze', tier: 3, families: ['cold', 'lightning'], range: [23, 31] }, global),
    makeHybridBuildupSuffix({ key: 'of Flurry', tier: 4, families: ['cold', 'lightning'], range: [14, 22] }, global),
    makeHybridBuildupSuffix({ key: 'of Drizzle', tier: 5, families: ['cold', 'lightning'], range: [6, 14] }, global),

    // Necrotic pairs
    makeHybridBuildupSuffix({ key: 'of Contagion', tier: 1, families: ['toxic', 'disease'], range: [40, 48] }, global),
    makeHybridBuildupSuffix({ key: 'of Putrescence', tier: 2, families: ['toxic', 'disease'], range: [32, 40] }, global),
    makeHybridBuildupSuffix({ key: 'of Rankness', tier: 3, families: ['toxic', 'disease'], range: [23, 31] }, global),
    makeHybridBuildupSuffix({ key: 'of Fever', tier: 4, families: ['toxic', 'disease'], range: [14, 22] }, global),
    makeHybridBuildupSuffix({ key: 'of Aches', tier: 5, families: ['toxic', 'disease'], range: [6, 14] }, global),
    makeHybridBuildupSuffix({ key: 'of Malediction', tier: 1, families: ['toxic', 'curse'], range: [40, 48] }, global),
    makeHybridBuildupSuffix({ key: 'of Blackblood', tier: 2, families: ['toxic', 'curse'], range: [32, 40] }, global),
    makeHybridBuildupSuffix({ key: 'of Illwill', tier: 3, families: ['toxic', 'curse'], range: [23, 31] }, global),
    makeHybridBuildupSuffix({ key: 'of Spite', tier: 4, families: ['toxic', 'curse'], range: [14, 22] }, global),
    makeHybridBuildupSuffix({ key: 'of Grudges', tier: 5, families: ['toxic', 'curse'], range: [6, 14] }, global),
    makeHybridBuildupSuffix({ key: 'of Wasting', tier: 1, families: ['disease', 'curse'], range: [40, 48] }, global),
    makeHybridBuildupSuffix({ key: 'of Withering', tier: 2, families: ['disease', 'curse'], range: [32, 40] }, global),
    makeHybridBuildupSuffix({ key: 'of Sickening', tier: 3, families: ['disease', 'curse'], range: [23, 31] }, global),
    makeHybridBuildupSuffix({ key: 'of Waning', tier: 4, families: ['disease', 'curse'], range: [14, 22] }, global),
    makeHybridBuildupSuffix({ key: 'of Fading', tier: 5, families: ['disease', 'curse'], range: [6, 14] }, global),

    // Physical pairs
    makeHybridBuildupSuffix({ key: 'of Flensing', tier: 1, families: ['expose', 'lacerate'], range: [40, 48] }, global),
    makeHybridBuildupSuffix({ key: 'of Rending', tier: 2, families: ['expose', 'lacerate'], range: [32, 40] }, global),
    makeHybridBuildupSuffix({ key: 'of Scoring', tier: 3, families: ['expose', 'lacerate'], range: [23, 31] }, global),
    makeHybridBuildupSuffix({ key: 'of Chafing', tier: 4, families: ['expose', 'lacerate'], range: [14, 22] }, global),
    makeHybridBuildupSuffix({ key: 'of Scuffs', tier: 5, families: ['expose', 'lacerate'], range: [6, 14] }, global),
    makeHybridBuildupSuffix({ key: 'of Reeling', tier: 1, families: ['lacerate', 'disorient'], range: [40, 48] }, global),
    makeHybridBuildupSuffix({ key: 'of Staggering', tier: 2, families: ['lacerate', 'disorient'], range: [32, 40] }, global),
    makeHybridBuildupSuffix({ key: 'of Wooziness', tier: 3, families: ['lacerate', 'disorient'], range: [23, 31] }, global),
    makeHybridBuildupSuffix({ key: 'of Stumble', tier: 4, families: ['lacerate', 'disorient'], range: [14, 22] }, global),
    makeHybridBuildupSuffix({ key: 'of Wobble', tier: 5, families: ['lacerate', 'disorient'], range: [6, 14] }, global),
    makeHybridBuildupSuffix({ key: 'of Rattling', tier: 1, families: ['expose', 'disorient'], range: [40, 48] }, global),
    makeHybridBuildupSuffix({ key: 'of Jarring', tier: 2, families: ['expose', 'disorient'], range: [32, 40] }, global),
    makeHybridBuildupSuffix({ key: 'of Shaking', tier: 3, families: ['expose', 'disorient'], range: [23, 31] }, global),
    makeHybridBuildupSuffix({ key: 'of Tremors', tier: 4, families: ['expose', 'disorient'], range: [14, 22] }, global),
    makeHybridBuildupSuffix({ key: 'of Jitters', tier: 5, families: ['expose', 'disorient'], range: [6, 14] }, global),
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


/**
 * Item level -> which affix tiers may roll, and how often.
 *
 * Tier 1 is the strongest, matching the convention every affix family uses.
 * A tier stays in the pool once unlocked, so a high-level item can still roll
 * a weak affix - `weight` is what makes the top tiers a chase rather than a
 * switch that flips on at a level.
 *
 * This is deliberately a TABLE and not a set of conditionals. Re-pitching the
 * curve (for the five-tier expansion, or for a 30-level game later) should be
 * editing these numbers and nothing else. Tiers 4 and 5 are declared now even
 * though only `weaponPercent` currently reaches tier 4, so the table does not
 * need reshaping when the remaining families gain their lower tiers.
 */
/**
 * Which BASE TYPES an item level may roll, and how often.
 *
 * The same shape as AFFIX_TIER_RULES, and deliberately a separate table: base
 * tier and affix tier answer different questions ("what was it made from" vs
 * "how well did it roll") and want to be re-pitched independently.
 *
 * Bases carry `baseTier` in data/items.js. Anything WITHOUT one -- uniques,
 * jewelry, consumables, hunt plans -- is never filtered by this, so the table
 * only ever governs the Crude/Wrought/Ancestral and Simple/Fitted ladders.
 *
 * Bone is NOT on this ladder. It stays a parallel base at its own 1-in-100
 * rate and carries baseTier 1, so a Bone drop is possible from the first roll.
 */
export const BASE_TIER_RULES = {
  1: { minItemLevel: 1, weight: 100, perLevel: 0 },
  2: { minItemLevel: 2, weight: 25,  perLevel: 8 },
  // Ancestral sits on the SAME threshold as tier-1 affixes (AFFIX_TIER_RULES
  // above), so "endgame gear" is one coherent line rather than two staggered
  // ones. It was 5, which meant raising the player cap to 5 would have started
  // dropping Ancestral at ~4% from a one-Hunt-Ticket roll — the cheapest
  // currency in the game — long before it was meant to exist.
  3: { minItemLevel: 8, weight: 6,   perLevel: 4 },
};

export const AFFIX_TIER_RULES = {
  // T2/T1 stay deliberately out of reach: the level cap is 3, so nothing in
  // the game can currently roll them. That is intended, not an oversight.
  1: { minItemLevel: 8, weight: 10,  perLevel: 9 },
  2: { minItemLevel: 5, weight: 18,  perLevel: 8 },
  // Pitched for a 1-10 player-level range, one unlock roughly every other
  // level: 2 tiers at iLvl 1, 3 at 3, 4 at 5, all 5 at 8, with the weights
  // still climbing past that. Gating is FLOOR-ONLY everywhere — affixAllowedAt
  // has no upper bound, so a low tier is never removed from the pool, it only
  // dilutes (T5 is still the commonest single tier at iLvl 10). That is the
  // PoE shape and it is deliberate.
  //
  // T2 lands exactly on iLvl 5 so that raising the player cap to 5 opens the
  // second-highest tier as its reward. T1 stays at 8 — the top tier is meant
  // to be rare (~7.6% at iLvl 10, nudged up from 5.6%) and chased through a
  // crafting system later rather than handed out by levelling.
  3: { minItemLevel: 3, weight: 28,  perLevel: 9 },
  4: { minItemLevel: 1, weight: 90,  perLevel: 0 },
  5: { minItemLevel: 1, weight: 100, perLevel: 0 },
};

/**
 * Effective weight = base weight + perLevel * (itemLevel - minItemLevel).
 *
 * Unlocking a tier is not the same as it becoming common. Without the
 * per-level term a tier-1 affix was exactly as likely the moment it unlocked
 * as it was ten levels later, which makes levelling past the unlock pointless
 * for that affix. Growing the weight instead means the top of the ladder keeps
 * getting more reachable, so the chase continues after the gate opens.
 */
function tierWeightAt(tier, itemLevel) {
  const rule = tier != null ? AFFIX_TIER_RULES[tier] : null;
  if (!rule) return 100;
  if (itemLevel == null) return rule.weight;
  const over = Math.max(0, itemLevel - rule.minItemLevel);
  return rule.weight + (rule.perLevel || 0) * over;
}

/** Weight for an affix def at a given item level. Untiered affixes (the stat
 *  suffixes) are always eligible and take the commonest weight. */
function affixWeight(def, itemLevel) {
  if (def?.tier == null) return 100;
  return tierWeightAt(def.tier, itemLevel);
}

/** Is this affix allowed to roll on an item of this level? */
function affixAllowedAt(def, itemLevel) {
  if (itemLevel == null) return true;          // un-levelled caller: no gating
  if (def?.tier == null) return true;          // untiered: always eligible
  const rule = AFFIX_TIER_RULES[def.tier];
  return !rule || itemLevel >= rule.minItemLevel;
}

/**
 * Pick one base id from `ids`, weighted by base tier and gated by item level.
 *
 * Callers pass a plain id list (the existing gamble pools are built by
 * FILTERING Items, never by id prefix, so nothing here needs to know what a
 * "Crude" is). An id whose base has no `baseTier` is always eligible at the
 * commonest weight, which is what keeps uniques and jewelry working unchanged.
 *
 * `maxBaseTier` / `minBaseTier` are HARD bounds applied before weighting, and
 * are deliberately a separate axis from item level: an encounter can want
 * "rolls as though the player were level 3, but the gear is still Crude", and
 * a currency can want "always exactly tier 2". Item level alone expresses
 * neither, because base tier 2 unlocks at item level 2 and is never
 * guaranteed.
 *
 * itemLevel == null means un-levelled, and restricts the draw to base TIER 1.
 * Note this is the opposite of affixAllowedAt(), where null skips gating
 * entirely -- and deliberately so. An ungated affix draw can only hand out a
 * better roll of something that already existed; an ungated BASE draw would
 * hand out an Ancestral weapon (~45% more base damage) to any call site that
 * simply forgot to pass a level. Tier 1 is what every such caller got before
 * this ladder existed, so it is the safe default.
 */
export function pickBaseId(ids, itemLevel = null,
    { maxBaseTier = null, minBaseTier = null, rng = Math.random } = {}) {
  if (!Array.isArray(ids) || !ids.length) return null;
  // minBaseTier is what makes a currency meaningful rather than merely
  // permissive: capping a Reckoning-Mark roll at tier 2 changed nothing while
  // the level cap already locked tier 3, so a Mark bought the same 75/25 base
  // split as a Hunt Ticket. A FLOOR guarantees the thing being paid for.
  const capped = ids.filter(id => {
    const t = Items[id]?.baseTier ?? 1;
    if (maxBaseTier != null && t > maxBaseTier) return false;
    if (minBaseTier != null && t < minBaseTier) return false;
    return true;
  });
  const usable = capped.length ? capped : ids;

  if (itemLevel == null) {
    const t1 = usable.filter(id => (Items[id]?.baseTier ?? 1) === 1);
    const from = t1.length ? t1 : usable;
    return from[(rng() * from.length) | 0];
  }

  const scored = [];
  let total = 0;
  for (const id of usable) {
    const tier = Items[id]?.baseTier;
    const rule = tier != null ? BASE_TIER_RULES[tier] : null;
    if (rule && itemLevel < rule.minItemLevel) continue;      // locked
    const w = rule
      ? rule.weight + (rule.perLevel || 0) * Math.max(0, itemLevel - rule.minItemLevel)
      : 100;
    if (w <= 0) continue;
    total += w;
    scored.push([id, w]);
  }
  // Every base was gated out (an item level below every tier's floor should be
  // impossible, but a bad level must not hand back undefined).
  if (!scored.length) return usable[(rng() * usable.length) | 0];

  let r = rng() * total;
  for (const [id, w] of scored) {
    r -= w;
    if (r <= 0) return id;
  }
  return scored[scored.length - 1][0];
}

/** Base-tier id prefixes for the weapon ladder. Armour is NOT here: its tiers
 *  use unrelated names per piece ("Padded Tunic" -> "Banded Hauberk"), so it
 *  is upgraded by re-rolling from the pool rather than by id rewriting. */
const BASE_TIER_PREFIX = { 1: 'crude', 2: 'hardened', 3: 'ancestral' };

/**
 * Raise an explicitly-named weapon base to the highest tier allowed.
 *
 * Scenarios name their weapons outright (`crude_bow`) rather than rolling
 * them, so the random path in pickBaseId never sees them. This is how a
 * Reckoning tier gets a Hardened weapon without duplicating every loadout.
 *
 * Anything that is not on the crude/wrought/ancestral ladder is returned
 * untouched -- which is what protects the scripted historic gear
 * (bloodthirster) and the tribe amulets/rings that scenarios also name. Bone
 * is excluded for the same reason: it is a PARALLEL base, not a rung.
 */
export function upgradeWeaponBase(id, maxBaseTier) {
  if (!id || !maxBaseTier) return id;
  const m = /^(crude|wrought|ancestral)_(.+)$/.exec(id);
  if (!m) return id;
  const current = Items[id]?.baseTier ?? 1;
  if (current >= maxBaseTier) return id;
  const want = `${BASE_TIER_PREFIX[maxBaseTier]}_${m[2]}`;
  // Only seven weapon types have tiered variants; the rest stay as they are.
  return Items[want] ? want : id;
}

/**
 * key -> { tier, family, range } for every affix definition in every pool.
 *
 * Built once, lazily, by walking the pools that already exist. Deliberately a
 * LOOKUP rather than data stored on the item: instances only ever persisted
 * affix KEYS, so an index keyed the same way works on items that were saved
 * long before item levels existed, with no migration.
 *
 * Used by the detailed (Alt-held) item tooltip to show which tier a roll came
 * from and what the possible range was.
 */
let _affixIndexCache = {};
export function getAffixIndex(hands) {
  // Weapon affix ranges are SCALED by hand count (the 1H/2H rebalance halves
  // or two-thirds them), so one flat index would report a two-hander's
  // "Merciless" as its one-handed 19-27 instead of 28-40. Cache one index per
  // variant and let the caller pass the item's hand count.
  const variant = hands === 1 ? '1h' : hands === 2 ? '2h' : 'other';
  if (_affixIndexCache[variant]) return _affixIndexCache[variant];
  const index = {};
  const add = (defs) => {
    for (const d of (defs || [])) {
      if (!d?.key || index[d.key]) continue;
      index[d.key] = {
        tier: d.tier ?? null,
        family: d.family ?? null,
        range: Array.isArray(d.range) ? [d.range[0], d.range[1]] : null,
        // Only differs from the key where several tiers share a player-facing
        // name (the stat suffixes). The Alt view shows this, not the key.
        label: d.label || d.key,
      };
    }
  };
  // Only the pools an item of this kind can actually roll from. Mixing armour
  // pools into a weapon index shadowed three keys that exist in BOTH with
  // different meanings — "Sanctified" is armour Max HP and weapon healing%,
  // "Brutal" is armour physical buildup% and weapon damage%, "Corrupting" is
  // armour necrotic buildup% and a weapon necrotic flat. A weapon can never
  // roll an armour affix, so keeping them apart resolves each correctly.
  if (variant === '1h') { add(WEAPON_PREFIX_POOL_1H); add(WEAPON_SUFFIX_POOL_1H); }
  else if (variant === '2h') { add(WEAPON_PREFIX_POOL_2H); add(WEAPON_SUFFIX_POOL_2H); }
  else { add(ARMOR_PREFIX_POOL); add(ARMOR_SUFFIX_POOL);
         add(HUNTPLAN_PREFIX_POOL); add(HUNTPLAN_SUFFIX_POOL); }
  _affixIndexCache[variant] = index;
  return index;
}

/** Utility: pick N unique elements from an array */
function pickUnique(arr, n, rng, itemLevel = null) {
  // Item-level gate. Applied ONCE up front rather than per draw, so a pool
  // that filters down to fewer entries than requested simply yields fewer
  // affixes instead of looping. Passing no item level leaves the pool whole,
  // which is what every un-migrated caller still does.
  const pool = arr.filter(d => affixAllowedAt(d, itemLevel));
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    // WEIGHTED draw, not uniform. Tier used to be decorative here: a tier-1
    // affix was exactly as likely as a tier-3, so unlocking a tier would have
    // made it instantly common. Weights make the top of the ladder rare.
    const total = pool.reduce((a, d) => a + affixWeight(d, itemLevel), 0);
    let roll = (asRng(rng)() ?? Math.random()) * total;
    let idx = pool.length - 1;
    for (let k = 0; k < pool.length; k++) {
      roll -= affixWeight(pool[k], itemLevel);
      if (roll <= 0) { idx = k; break; }
    }
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
  // Item level: stamped once at creation and never changed. It does not alter
  // the item's stats directly - it decides which affix TIERS were eligible to
  // roll (see AFFIX_TIER_RULES). Deliberately an ARGUMENT rather than a lookup:
  // the bone pile passes the party's highest level, a drop passes the encounter
  // level, and a future zone passes its own, without this function ever knowing
  // which. `null` means "un-levelled" and skips gating entirely, which is what
  // every existing call site does until it is migrated.
  const itemLevel = Number.isFinite(opts.itemLevel) ? opts.itemLevel : null;
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
    prefixes = pickUnique(pools.prefixes, nPre, rng, itemLevel);
    suffixes = pickUnique(pools.suffixes, nSuf, rng, itemLevel);
  }

  const instance = {
    id,
    instanceId: 'itm_' + Math.random().toString(36).slice(2, 10),
    rarity,
    itemLevel,
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
  // `opts.renownOrigin` lets a drop source stamp an origin onto an ORDINARY
  // base -- this is how a Bone roll works now that Bone is an overlay rather
  // than its own 13 base items, and it is what allows Bone to appear on any
  // base TIER. `base.renownOrigin` still covers the legacy bases so nothing
  // already in a save changes.
  const originToApply = opts.renownOrigin || base.renownOrigin;
  if (originToApply) {
    applyRenownOrigin(instance, originToApply, {
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
    preKeys = [title, kept.label || kept.key, ...others.map(a => a.label || a.key)];
  } else {
    // Zero or one prophet — prophet leads, then other prefixes
    preKeys = [...prophets.map(a => a.label || a.key), ...others.map(a => a.label || a.key)];
  }

  const pre = preKeys.join(' ');

  // ── Suffixes: join multiple "of X" entries as "of X and Y" ───────────────
  // Strip the leading "of " from every entry except the first, then join.
  let suf = '';
  if (suffixes.length === 0) {
    suf = '';
  } else if (suffixes.length === 1) {
    suf = suffixes[0].label || suffixes[0].key;
  } else {
    // All suffix keys start with "of " — first keeps it, rest lose the "of ".
    // Uses `label` so a tiered stat suffix reads "of the Bear", never its
    // internal "of the Bear [T2]".
    const first = suffixes[0].label || suffixes[0].key;    // e.g. "of Sparks"
    const rest  = suffixes.slice(1).map(a => {
      const k = a.label || a.key;
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
      // Renown-origin overlay (Bone's +20%). FIRST, so flat adds on top of it
      // and weapon-damage% multiplies the whole thing -- putting it after the
      // percent step is what made the earlier attempt feel like nothing.
      // Skipped when the BASE itself declares the origin: the legacy `bone_*`
      // items already have the bonus baked in and would compound to +44%.
      const originId = isItemInstance(itemRef) ? itemRef.renownOrigin : null;
      const originMult = (originId && originId !== base.renownOrigin)
        ? (RENOWN_ORIGINS[originId]?.baseDamageMult || 1)
        : 1;
      const baseMin = Math.floor((base.damage?.min || 0) * originMult);
      const baseMax = Math.floor((base.damage?.max || 0) * originMult);
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
  bone: {
    id: 'bone',
    label: 'Bone',
    // Applied to base.damage BEFORE flat and percent (see getItemComputedData)
    // so a weapon-damage% affix multiplies the bone bonus too. Only applies
    // when bone is stamped as an OVERLAY onto an ordinary base -- the legacy
    // `bone_*` bases already carry their +20% in their own damage numbers and
    // are excluded, so old saves are untouched.
    baseDamageMult: 1.20,
    // Every tier reads simply "Bone <noun>": the descriptor is replaced, so a
    // Bone Crude and a Bone Ancestral dagger are both "Bone Dagger". That is
    // deliberate -- the tooltip's Base Tier line carries the distinction (and
    // is shown on EVERY item, tier 1 included, precisely so this stays
    // unambiguous). Same rule as `severed` below.
    renameBase: (baseName) => {
      const parts = String(baseName || '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return 'Bone';
      return parts.length > 1 ? ['Bone', ...parts.slice(1)].join(' ') : `Bone ${parts[0]}`;
    },
  },
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
    // Second arg (base) is unused here; bone's rename needs it for baseTier.
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
      instance.displayName = instance.displayName.replace(baseName, originDef.renameBase(baseName, Items[instance.id]));
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
