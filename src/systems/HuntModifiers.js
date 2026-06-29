// src/systems/HuntModifiers.js
// Shared modifier shape combined from Hunt Plan items, zone data, and
// rolled weather — summed into one flat object the Hunt loop reads from.
//
// All six fields are live: lootQualityPercent shifts Cultist fight drops
// toward rare (capped there for now — see CombatScene.js rollHuntDropRarity()),
// xpPercent scales the hunt-fight XP reward (_calculateXPReward()), and the
// rest were already wired in earlier passes.

const FIELDS = [
  'encounterChancePercent',
  'beastChanceWeight',
  'supplyEfficiencyPercent',
  'huntPointsPercent',
  'xpPercent',
  'lootQualityPercent',
];

const INERT_FIELDS = new Set();

const FIELD_LABELS = {
  encounterChancePercent: 'Encounter Chance',
  beastChanceWeight: 'Beast Encounter Weight',
  supplyEfficiencyPercent: 'Travel Efficiency',
  huntPointsPercent: 'Hunt Points',
  xpPercent: 'Experience Gained',
  lootQualityPercent: 'Loot Quality',
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

/** Human-readable lines for display, e.g. "+15% Encounter Chance". Inert fields are flagged. */
export function describeModifiers(mods) {
  const lines = [];
  for (const field of FIELDS) {
    const value = mods?.[field] || 0;
    if (!value) continue;
    const sign = value > 0 ? '+' : '';
    const unit = field === 'beastChanceWeight' ? '' : '%';
    const note = INERT_FIELDS.has(field) ? ' (no effect yet)' : '';
    lines.push(`${sign}${value}${unit} ${FIELD_LABELS[field]}${note}`);
  }
  return lines;
}
