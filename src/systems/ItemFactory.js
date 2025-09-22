// src/systems/ItemFactory.js
import { Items } from '../../data/items.js';

/** ---------- Quality Rules (counts) ----------
 * uncommon: 1–2 total affixes (prefix+suffix combined)
 * rare: 3 total affixes
 * epic: 2 prefixes + 2 suffixes (fixed)
 * common: 0
 */
export const QUALITY_RULES = {
  common:   { min: 0, max: 0, force: null },          // 0 total
  uncommon: { min: 1, max: 2, force: null },          // 1–2 total
  rare:     { min: 3, max: 3, force: null },          // exactly 3 total
  epic:     { min: 4, max: 4, force: { prefixes: 2, suffixes: 2 } }, // 2+2
};

/** ---------- Affix Pools ----------
 * Keep it small and obvious to verify in UI/combat.
 * You can expand at will; effects are additive unless noted.
 */
const PREFIX_POOL = [
  // flat stats
  { key: 'Mighty',   type: 'stat',   path: 'STR', amount: 2 },
  { key: 'Agile',    type: 'stat',   path: 'DEX', amount: 2 },
  { key: 'Hearty',   type: 'stat',   path: 'CON', amount: 2 },
  { key: 'Sage',     type: 'stat',   path: 'INT', amount: 2 },
  { key: 'Aware',    type: 'stat',   path: 'WIS', amount: 2 },

  // derived
  { key: 'Keen',     type: 'derived','path': 'CritChance', amount: 5 }, // +5% crit
  { key: 'Swift',    type: 'derived','path': 'Evasion', amount: 5 },    // +5 evasion (if you track it)
];

const SUFFIX_POOL = [
  // weapon damage adjustments (flat min/max)
  { key: 'of Cutting',    type: 'damageFlat', min: 1, max: 1 },
  { key: 'of Wounding',   type: 'damageFlat', min: 2, max: 0 },
  { key: 'of Brutality',  type: 'damageFlat', min: 0, max: 2 },

  // defensive/utility
  { key: 'of Guarding',   type: 'stat', path: 'PhysicalRes', amount: 5 },   // if tracked
  { key: 'of Warding',    type: 'stat', path: 'ElementalRes', amount: 5 },  // if tracked
  { key: 'of Precision',  type: 'derived','path': 'Accuracy', amount: 5 },
];

/** Utility: pick N unique elements from an array */
function pickUnique(arr, n, rng) {
  const pool = [...arr];
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor((rng() ?? Math.random()) * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/** Decide how many prefixes/suffixes for a given quality. */
function rollAffixCounts(quality, rng) {
  const rule = QUALITY_RULES[quality] || QUALITY_RULES.common;
  if (rule.force) return { prefixes: rule.force.prefixes, suffixes: rule.force.suffixes };

  const total = rule.min === rule.max
    ? rule.min
    : rule.min + Math.floor((rng() ?? Math.random()) * (rule.max - rule.min + 1));

  // heuristic split: prefer 1 prefix first, then alternate
  let prefixes = 0, suffixes = 0;
  for (let i = 0; i < total; i++) {
    if (prefixes <= suffixes) prefixes++; else suffixes++;
  }
  return { prefixes, suffixes };
}

/**
 * Apply affixes to produce a merged "instanceMods" object we can read later.
 * We avoid mutating the base item; all affix effects live on the instance.
 */
function buildInstanceModifiers(prefixes, suffixes) {
  const mods = {
    // stats: STR/DEX/… or resistances
    stats: {},             // e.g., { STR:+2, DEX:+1, PhysicalRes:+5 }
    // derived bonuses: crit, accuracy, evasion, etc.
    derived: {},           // e.g., { CritChance:+5 }
    // weapon damage adjustments
    damageFlat: { min: 0, max: 0 }, // additive
  };

  const apply = (affix) => {
    switch (affix.type) {
      case 'stat': {
        const k = affix.path;
        mods.stats[k] = (mods.stats[k] || 0) + affix.amount;
        break;
      }
      case 'derived': {
        const k = affix.path;
        mods.derived[k] = (mods.derived[k] || 0) + affix.amount;
        break;
      }
      case 'damageFlat': {
        mods.damageFlat.min += affix.min || 0;
        mods.damageFlat.max += affix.max || 0;
        break;
      }
    }
  };

  prefixes.forEach(apply);
  suffixes.forEach(apply);
  return mods;
}

/**
 * Create a new item instance from a base ID with optional quality+affixes.
 * @param {string} id
 * @param {object} opts
 *   - quality: 'common'|'uncommon'|'rare'|'epic' (default: base item quality or 'common')
 *   - rollAffixes: boolean (default true if quality != 'common')
 *   - rng: optional function returning 0..1 for deterministic tests
 */
export function createItemInstance(id, opts = {}) {
  const base = Items[id];
  if (!base) {
    console.warn(`Item ID "${id}" not found in items.js`);
    return null;
  }

  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const quality = opts.quality || base.quality || 'common';

  // decide affixes
  const { prefixes: nPre, suffixes: nSuf } = rollAffixCounts(quality, rng);
  const doRoll = opts.rollAffixes ?? (quality !== 'common');
  const prefixes = doRoll ? pickUnique(PREFIX_POOL, nPre, rng) : [];
  const suffixes = doRoll ? pickUnique(SUFFIX_POOL, nSuf, rng) : [];

  const instance = {
    id,
    instanceId: 'itm_' + Math.random().toString(36).slice(2, 10),
    quality,
    prefixes: prefixes.map(a => a.key),
    suffixes: suffixes.map(a => a.key),
    // mods are used by combat/stat merge routines
    instanceMods: buildInstanceModifiers(prefixes, suffixes),
    // optional display override for convenience
    displayName: buildAffixedName(base.name, prefixes, suffixes),
  };

  return instance;
}

function buildAffixedName(baseName, prefixes, suffixes) {
  const pre = prefixes.map(a => a.key).join(' ');
  const suf = suffixes.map(a => a.key).join(' ');
  if (pre && suf)  return `${pre} ${baseName} ${suf}`;
  if (pre)         return `${pre} ${baseName}`;
  if (suf)         return `${baseName} ${suf}`;
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
  // Normalize to { base, instanceMods }
  let base, instanceMods = null, displayName = null, quality = null;
  if (isItemInstance(itemRef)) {
    base = Items[itemRef.id];
    instanceMods = itemRef.instanceMods || null;
    displayName = itemRef.displayName || null;
    quality = itemRef.quality || base?.quality || 'common';
  } else {
    base = Items[itemRef];
  }
  if (!base) return null;

  // Start with base and layer on computed changes
  const view = {
    ...base,
    name: displayName || base.name,
    quality: quality || base.quality || 'common',
  };

  if (instanceMods) {
    // merge stats/bonuses
    if (Object.keys(instanceMods.stats).length > 0) {
      // put them into a familiar place for your pipeline:
      view.bonuses = { ...(base.bonuses || {}) };
      for (const [k, v] of Object.entries(instanceMods.stats)) {
        view.bonuses[k] = (view.bonuses[k] || 0) + v;
      }
    }

    // derived (non-persistent stat map—read in combat calc)
    view._derivedMods = { ...(instanceMods.derived || {}) };

    // weapon damage adjustments
    if (base.damage) {
      const flat = instanceMods.damageFlat || { min: 0, max: 0 };
      view.damage = {
        min: (base.damage.min || 0) + (flat.min || 0),
        max: (base.damage.max || 0) + (flat.max || 0),
      };
    }
  }

  return view;
}
