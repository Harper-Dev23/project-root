// src/systems/HuntModifiers.js
// Shared modifier shape combined from Hunt Plan items, zone data, and
// rolled weather — summed into one flat object the Hunt loop reads from.
//
// All six fields are live: lootQualityPercent shifts Cultist fight drops
// toward rare and epic (a diminishing curve — see PartyStats.js rollHuntDropRarity()),
// xpPercent scales the hunt-fight XP reward (_calculateXPReward()), and the
// rest were already wired in earlier passes.
//
// Hunt Plans v2 (chunk 4) added more plan fields (data/planAffixes.js
// PLAN_FIELDS). They are deliberately NOT summed into the hunt's combined
// modifiers: only a plan writes them, and the ones that are live are read
// straight off the plan at departure (createHunt), so the saved hunt keeps its
// shape. They are DISPLAYED here, and a field whose reader is a later chunk is
// labelled "(no effect yet)" rather than silently doing nothing.

import { PLAN_FIELDS } from '../../data/planAffixes.js';

const FIELDS = [
  'encounterChancePercent',
  'beastChanceWeight',
  'supplyEfficiencyPercent',
  'huntPointsPercent',
  'xpPercent',
  'lootQualityPercent',
];

const PLAN_ONLY_FIELDS = Object.keys(PLAN_FIELDS).filter(f => !FIELDS.includes(f));

const INERT_FIELDS = new Set(Object.entries(PLAN_FIELDS).filter(([, d]) => !d.live).map(([f]) => f));

const FIELD_LABELS = {
  encounterChancePercent: 'Encounter Chance',
  beastChanceWeight: 'Beast Encounter Weight',
  supplyEfficiencyPercent: 'Travel Efficiency',
  huntPointsPercent: 'Hunt Points',
  xpPercent: 'Experience Gained',
  lootQualityPercent: 'Loot Quality',
  ...Object.fromEntries(PLAN_ONLY_FIELDS.map(f => [f, PLAN_FIELDS[f].label])),
};

const FIELD_UNITS = {
  beastChanceWeight: '',
  ...Object.fromEntries(PLAN_ONLY_FIELDS.map(f => [f, PLAN_FIELDS[f].unit])),
};

export function emptyModifiers() {
  return Object.fromEntries(FIELDS.map(f => [f, 0]));
}

/** Sums each field across any number of sources. Falsy/missing sources are skipped. */
export function combineModifiers(...sources) {
  const combined = emptyModifiers();
  for (const source of sources) {
    if (!source) continue;
    for (const field of FIELDS) {
      combined[field] += source[field] || 0;
    }
  }
  return combined;
}

/**
 * Human-readable lines for display, e.g. "+15% Encounter Chance". Plan-only
 * fields are listed when present; inert ones are flagged.
 */
export function describeModifiers(mods) {
  const lines = [];
  for (const field of [...FIELDS, ...PLAN_ONLY_FIELDS]) {
    const value = mods?.[field] || 0;
    if (!value) continue;
    const sign = value > 0 ? '+' : '';
    const unit = FIELD_UNITS[field] ?? '%';
    const note = INERT_FIELDS.has(field) ? ' (no effect yet)' : '';
    lines.push(`${sign}${value}${unit} ${FIELD_LABELS[field]}${note}`);
  }
  return lines;
}

/** The loadout preview: region + plan combined, then the plan's own fields. */
export function describeLoadout(zoneMods, planMods) {
  const shown = combineModifiers(zoneMods, planMods);
  for (const f of PLAN_ONLY_FIELDS) if (planMods?.[f]) shown[f] = planMods[f];
  return describeModifiers(shown);
}
