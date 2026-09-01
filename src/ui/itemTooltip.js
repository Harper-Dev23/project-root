// src/ui/itemTooltip.js
// Shared item tooltip builder — single source of truth for InventoryOverlay,
// StashOverlay, and TownScene, which previously each maintained their own
// independent (and already slightly-drifted) copy of this logic.
//
// buildItemTooltipLines(itemRef, opts) -> { title, titleColor, lines }
//   itemRef — an item instance (has .id/.instanceMods) or a raw item id/base
//   opts.rarityColors — the RARITY_COLORS map (caller-supplied so this file
//     doesn't need to import ui/styles.js and risk a circular import)
//
// `lines` entries are either plain strings or { text, color } objects — both
// are natively supported by Tooltip.js's _renderBodyLines already.

import { isItemInstance, getItemComputedData } from '../systems/ItemFactory.js';
import { Items } from '../../data/items.js';
import { SKILLS } from '../../data/skills.js';

// Matches Tooltip.js's existing _pillColorFor palette where a family overlaps
// (fire/cold/lightning), so a skill's fire tag and a weapon's fire damage
// read as the same color everywhere in the UI.
const TYPE_COLORS = {
  physical: '#dddddd',
  fire: '#D24E35',
  cold: '#3BA3D9',
  lightning: '#E6C447',
  necrotic: '#9B6BD9',
};
const typeColor = (t) => TYPE_COLORS[t] || '#dddddd';
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function buildItemTooltipLines(itemRef, opts = {}) {
  const instance = isItemInstance(itemRef) ? itemRef : null;
  const computed = instance ? getItemComputedData(instance) : (typeof itemRef === 'string' ? getItemComputedData(itemRef) : null);
  const base = computed || Items[itemRef?.id] || Items[itemRef] || {};
  const rarityColors = opts.rarityColors || {};

  const name = instance?.displayName || computed?.name || base.name || instance?.id || itemRef?.id || 'Unknown';
  const rarity = instance?.rarity || instance?.quality || computed?.rarity || base.rarity || base.quality || 'common';
  const titleColor = rarityColors[rarity] || rarityColors.common || '#dddddd';

  const lines = [];
  if (base.type) lines.push(`Type: ${base.type}${base.slot ? ` (${base.slot})` : ''}`);
  if (base.type === 'weapon') {
    if (base.weaponType) lines.push(`Weapon Type: ${capitalize(base.weaponType)}`);
    if (typeof base.hands === 'number') lines.push(`Hands: ${base.hands}`);
  }

  // ===== Consolidated, color-coded "Weapon Damage" total =====
  // Every typed component the weapon deals, already fully scaled by local
  // weapon damage% (view.damage for physical, view.displayScaledElementalFlat
  // for elemental/necrotic — see ItemFactory.js for why these are kept
  // separate from the raw values combat reads). This is the number that
  // actually lands in combat, not the base/unscaled affix values.
  if (base.type === 'weapon' && computed?.damage) {
    lines.push('');
    lines.push('Weapon Damage:');
    lines.push({ text: `  Physical: ${computed.damage.min}–${computed.damage.max}`, color: typeColor('physical') });
    const scaledElem = computed.displayScaledElementalFlat || {};
    for (const [element, range] of Object.entries(scaledElem)) {
      if (!range || (!range.min && !range.max)) continue;
      lines.push({ text: `  ${capitalize(element)}: ${range.min}–${range.max}`, color: typeColor(element) });
    }
  }

  const statBonuses = computed?.bonuses || {};
  const statKeys = Object.keys(statBonuses);
  if (statKeys.length) {
    lines.push('');
    lines.push('Bonuses:');
    statKeys.forEach(k => lines.push(`  • ${k} +${statBonuses[k]}`));
  }

  const derivedMods = instance?.instanceMods?.derived || {};
  const derivedKeys = Object.keys(derivedMods);
  if (derivedKeys.length) {
    lines.push('');
    lines.push('Derived:');
    derivedKeys.forEach(k => lines.push(`  • ${k} +${derivedMods[k]}`));
  }

  // ===== Modifiers — the raw, unscaled affix values (what rolled on the
  // item), shown below the already-scaled total above. =====
  const dmgFlat = instance?.instanceMods?.damageFlat || {};
  const dmgPercent = instance?.instanceMods?.damagePercent?.weapon || 0;
  const elemFlat = instance?.instanceMods?.elementalFlat || {};
  const elemEntries = Object.entries(elemFlat).filter(([, v]) => (v?.min || 0) || (v?.max || 0));
  const misc = instance?.instanceMods?.misc || {};
  const buildup = misc.buildupPercent || {};

  const hasModifiers = (dmgFlat.min || 0) || (dmgFlat.max || 0) || dmgPercent || elemEntries.length
    || misc.mpPerTurn || misc.skillCostReductionPct || misc.globalDamagePercent || misc.elementalDamagePercent
    || misc.necroticDamagePercent || misc.healingPercent || misc.resilience || Object.keys(buildup).length
    || misc.physicalBuildupPercent || misc.elementalBuildupPercent || misc.necroticBuildupPercent
    || misc.physToElemPercent || misc.physToNecroPercent || misc.elemToNecroPercent
    || misc.initBonusOnBattleStart || misc.shieldPctOnBattleStart
    || Object.keys(misc.physBuildupOnPhysDmg || {}).length || Object.keys(misc.elemBuildupOnElemDmg || {}).length
    || misc.procDoubleDamage || misc.procHalfDamageTaken || misc.procHealOnHeal
    || misc.procPhysFlat || misc.procElemFlat || misc.procNecroFlat;

  if (hasModifiers) {
    lines.push('');
    lines.push('Modifiers:');
    if (dmgFlat.min) lines.push(`  • Min Damage +${dmgFlat.min}`);
    if (dmgFlat.max) lines.push(`  • Max Damage +${dmgFlat.max}`);
    if (dmgPercent) lines.push({ text: `  • Local Weapon Damage +${dmgPercent}%`, color: typeColor('physical') });
    elemEntries.forEach(([el, v]) => lines.push({ text: `  • ${capitalize(el)} +${v.min}–${v.max}`, color: typeColor(el) }));
    if (misc.mpPerTurn) lines.push(`  • MP per Turn: +${misc.mpPerTurn}`);
    if (misc.skillCostReductionPct) lines.push(`  • Skill Cost Reduction: -${misc.skillCostReductionPct}%`);
    if (misc.globalDamagePercent) lines.push(`  • Damage (all sources): +${misc.globalDamagePercent}%`);
    // Percent damage modifiers stay uncolored (white) — only FLAT bonuses get
    // the type color, per the user's call, kept consistent everywhere.
    if (misc.elementalDamagePercent) lines.push(`  • Elemental Damage: +${misc.elementalDamagePercent}%`);
    if (misc.necroticDamagePercent) lines.push(`  • Necrotic Damage: +${misc.necroticDamagePercent}%`);
    if (misc.healingPercent) lines.push(`  • Healing: +${misc.healingPercent}%`);
    if (misc.resilience) lines.push(`  • Resilience: +${misc.resilience}`);
    Object.entries(buildup).forEach(([k, v]) => { if (v) lines.push(`  • +${v}% ${capitalize(k)} Buildup`); });
    if (misc.physicalBuildupPercent) lines.push(`  • +${misc.physicalBuildupPercent}% Physical Buildup (Expose/Lacerate/Disorient)`);
    if (misc.elementalBuildupPercent) lines.push(`  • +${misc.elementalBuildupPercent}% Elemental Buildup (Fire/Cold/Lightning)`);
    if (misc.necroticBuildupPercent) lines.push(`  • +${misc.necroticBuildupPercent}% Necrotic Buildup (Toxic/Disease/Curse)`);

    // Jewelry
    if (misc.physToElemPercent) lines.push(`  • ${misc.physToElemPercent}% Physical → Elemental Conversion`);
    if (misc.physToNecroPercent) lines.push(`  • ${misc.physToNecroPercent}% Physical → Necrotic Conversion`);
    if (misc.elemToNecroPercent) lines.push(`  • ${misc.elemToNecroPercent}% Elemental → Necrotic Conversion`);
    if (misc.initBonusOnBattleStart) lines.push(`  • +${misc.initBonusOnBattleStart} Initiative at Battle Start`);
    if (misc.shieldPctOnBattleStart) lines.push(`  • +${misc.shieldPctOnBattleStart}% Shield at Battle Start`);
    Object.entries(misc.physBuildupOnPhysDmg || {}).forEach(([fam, pct]) => {
      if (pct) lines.push(`  • ${pct}% Phys Dmg → ${capitalize(fam)} Buildup`);
    });
    Object.entries(misc.elemBuildupOnElemDmg || {}).forEach(([fam, pct]) => {
      if (pct) lines.push(`  • ${pct}% Elem Dmg → ${capitalize(fam)} Buildup`);
    });
    if (misc.procDoubleDamage) lines.push(`  • ${misc.procDoubleDamage}% Chance: Double Damage`);
    if (misc.procHalfDamageTaken) lines.push(`  • ${misc.procHalfDamageTaken}% Chance: Halve Damage Taken`);
    if (misc.procHealOnHeal) lines.push(`  • ${misc.procHealOnHeal}% Chance: Double Heal`);
    if (misc.procPhysFlat) lines.push(`  • ${misc.procPhysFlat}% Chance: +10 Physical Damage`);
    if (misc.procElemFlat) lines.push(`  • ${misc.procElemFlat}% Chance: +10 Elemental Damage`);
    if (misc.procNecroFlat) lines.push(`  • ${misc.procNecroFlat}% Chance: +10 Necrotic Damage`);
  }

  // Falls back to base.grantsSkills (view already spreads it in) for items
  // that haven't been instanced yet, e.g. a pre-purchase vendor preview.
  const grantedSkillIds = instance?.grantsSkills?.length ? instance.grantsSkills : (base.grantsSkills || []);
  if (grantedSkillIds.length) {
    lines.push('');
    lines.push('Grants:');
    grantedSkillIds.forEach(id => {
      const sk = SKILLS?.[id];
      const skillName = sk?.name || id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      lines.push(`  • ${skillName}`);
      if (sk?.description) lines.push(`    ${sk.description}`);
    });
  }

  if (base.description && !instance?.fixedAffixValue && !grantedSkillIds.length) {
    lines.push('', base.description);
  }

  if (base.locked) lines.push('', '[ Locked — Cannot be transferred ]');

  if (instance?.historic) {
    if (base.lifeStealPct) lines.push(`✦ ${Math.round(base.lifeStealPct * 100)}% Lifesteal`);
    if (instance.soulbound) lines.push('✦ Soulbound — cannot be lost on party wipe');
    lines.push('', '[ ✦ HISTORIC ITEM — press [Inspect] to read its history ]');
  } else if (instance?.renownState === 'gaining') {
    const pct = Math.round(((instance.renown || 0) / (instance.renownMax || 1000)) * 100);
    lines.push('', `◆ Gaining Renown: ${instance.renown || 0} / ${instance.renownMax || 1000}  (${pct}%)`);
    lines.push('[ Use this item in combat to build Renown ]');
  }

  return { title: name, titleColor, lines, name, color: titleColor };
}
