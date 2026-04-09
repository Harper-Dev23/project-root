/**
 * skillTooltip.js
 * Shared skill tooltip builder used by SkillsOverlay and CombatScene.
 *
 * buildSkillTooltipLines(sk, actor, opts)
 *   sk     — normalized skill object (from SKILLS registry)
 *   actor  — character object with equipment/totalStats, or null
 *             null → generic mode: shows formula text, no live numbers
 *             char → live mode: shows real weapon range + stat modifier
 *   opts   — optional overrides
 *     cdRemaining  number  — turns remaining on cooldown (CombatScene knows this)
 *
 * Returns { lines: string[], tags: string[] }
 */

import { Items } from '../../data/items.js';
import { isItemInstance } from '../systems/ItemFactory.js';

const COST_LABEL = {
  major: 'Major Action',
  bonus: 'Bonus Action',
  class: 'Class Action',
  reaction: 'Reaction',
};

function buffToText(buff) {
  if (!buff) return '—';
  const parts = [];
  if (buff.critChanceBonusPct)  parts.push(`+${buff.critChanceBonusPct}% Crit Chance`);
  if (buff.critMultBonus)       parts.push(`+${buff.critMultBonus} Crit Mult`);
  if (buff.nextSkillDamagePct)  parts.push(`+${buff.nextSkillDamagePct}% next skill dmg`);
  if (buff.damagePct)           parts.push(`+${buff.damagePct}% damage`);
  if (buff.evasionPct)          parts.push(`+${buff.evasionPct}% Evasion`);
  if (buff.guardPct)            parts.push(`+${buff.guardPct}% Guard`);
  if (buff.chanceExtraHitPct)   parts.push(`${buff.chanceExtraHitPct}% extra hit`);
  if (buff.repeatStrikeOnce)    parts.push(`repeat strike (${buff.repeatPowerPct ?? 60}%)`);
  if (buff.extraRapidTicks)     parts.push(`+${buff.extraRapidTicks} tick`);
  if (buff.addBuildup) {
    const b = Object.entries(buff.addBuildup).map(([k, v]) => `${k} +${v}`);
    parts.push(`add ${b.join(', ')}`);
  }
  if (buff.physicalVulnPct)     parts.push(`-${buff.physicalVulnPct}% phys resist`);
  if (buff.bleedTakenPct)       parts.push(`+${buff.bleedTakenPct}% bleed taken`);
  if (buff.speedDownPct)        parts.push(`-${buff.speedDownPct}% speed`);
  if (buff.turns)               parts.push(`(${buff.turns}t)`);
  return parts.length ? parts.join(', ') : JSON.stringify(buff);
}

export function buildSkillTooltipLines(sk, actor = null, opts = {}) {
  if (!sk) return { lines: ['No skill data.'], tags: [] };

  const lines = [];
  const tags = Array.isArray(sk.tags) ? [...sk.tags] : [];

  // Description
  if (sk.description || sk.desc) {
    lines.push(sk.description || sk.desc);
    lines.push('');
  }

  // Action cost
  if (sk.actionCost) lines.push(`Cost: ${COST_LABEL[sk.actionCost] || sk.actionCost}`);

  // MP / HP cost
  const resourceParts = [];
  if (sk.mpCost > 0) resourceParts.push(`MP: ${sk.mpCost}`);
  if (sk.hpCost > 0) resourceParts.push(`HP: ${sk.hpCost}`);
  if (resourceParts.length) lines.push(resourceParts.join('   '));

  // Cooldown (base)
  if (sk.cooldown > 0) lines.push(`Cooldown: ${sk.cooldown} turn${sk.cooldown === 1 ? '' : 's'}`);

  // Remaining cooldown (live, CombatScene only)
  if (opts.cdRemaining > 0) lines.push(`  ⏳ ${opts.cdRemaining} turn${opts.cdRemaining === 1 ? '' : 's'} remaining`);

  // Position requirement (only show if restricted)
  const posReq = sk.positionRequirement;
  if (Array.isArray(posReq) && posReq.length > 0 && posReq.length < 3) {
    lines.push(`Position: ${posReq.join(' / ')}`);
  }

  // Targeting (only show non-default)
  const tReq = sk.targetRequirement;
  if (tReq && tReq !== 'enemy') {
    const tLabel = { ally: 'Target: Ally', self: 'Target: Self', position: 'Target: Position' };
    lines.push(tLabel[tReq] || `Target: ${tReq}`);
  }
  const targetCols = sk.targetColumns;
  if (Array.isArray(targetCols) && targetCols.length > 0 && targetCols.length < 3) {
    lines.push(`Target columns: ${targetCols.join(' / ')}`);
  }

  // AoE hint
  if (tags.includes('aoe') && sk.aoe) {
    const shape = sk.aoe.shape || 'column';
    const scale = sk.aoe.scale != null ? Math.round(sk.aoe.scale * 100) : 50;
    lines.push(`AoE: ${shape} splash (${scale}%)`);
  }

  // ---- Damage section ----
  const hasWeaponReq = Array.isArray(sk.requiredWeapon)
    ? sk.requiredWeapon.length > 0
    : !!sk.requiredWeapon;

  if (hasWeaponReq) {
    lines.push('');
    if (actor) {
      // Live mode: show actual numbers for this character
      const weaponInst = actor.equipment?.weaponMain;
      const weaponBase = weaponInst
        ? (isItemInstance(weaponInst) ? Items[weaponInst.id] : Items[weaponInst])
        : null;
      const wMin = weaponBase?.damage?.min ?? 1;
      const wMax = weaponBase?.damage?.max ?? 2;
      const str = actor.totalStats?.STR ?? 0;
      const strMod = Math.floor(str / 5);
      const weapName = weaponBase?.name ?? 'Unarmed';

      lines.push(`Damage: ${wMin + strMod}–${wMax + strMod}`);
      lines.push(`  ${weapName} (${wMin}–${wMax}) + STR/5 (+${strMod})`);
      if (sk.hitCount > 1) {
        lines.push(`  × ${sk.hitCount} hits = ${(wMin + strMod) * sk.hitCount}–${(wMax + strMod) * sk.hitCount} total`);
      }
    } else {
      // Generic mode: formula only, no numbers
      lines.push('Damage: weapon damage + STR/5');
      if (sk.hitCount > 1) lines.push(`  × ${sk.hitCount} hits`);
    }
    if (sk.damageType) lines.push(`  Type: ${sk.damageType}`);
  } else if (sk.damageType) {
    lines.push('');
    lines.push(`Damage type: ${sk.damageType}`);
  }

  // Buildup hints
  if (sk.buildupHint && typeof sk.buildupHint === 'object') {
    const parts = Object.entries(sk.buildupHint).map(([fam, amt]) => `${fam} +${amt}`);
    if (parts.length) { lines.push(''); lines.push(`Applies: ${parts.join(', ')}`); }
  }

  // Weakness consumption
  if (Array.isArray(sk.consumeWeakness) && sk.consumeWeakness.length) {
    lines.push(`Consumes: ${sk.consumeWeakness.join(', ')} weakness`);
  }

  // Transform weakness
  if (sk.transformWeakness) {
    const tw = sk.transformWeakness;
    lines.push(`Converts: ${tw.from} → ${tw.to} (×${tw.ratio ?? 1})`);
  }

  // Reward if weak
  if (sk.rewardIfWeak) {
    const rw = sk.rewardIfWeak;
    const buffStr = buffToText(rw.buff);
    lines.push(`If ${rw.family} tier ≥${rw.tierAtLeast}: ${buffStr}`);
  }

  // Reward if tier cross
  if (Array.isArray(sk.rewardIfTierCross) && sk.rewardIfTierCross.length) {
    lines.push('');
    sk.rewardIfTierCross.forEach(rule => {
      lines.push(`On ${rule.family} tier ${rule.tier}: ${buffToText(rule.buff ?? rule.debuff)}`);
    });
  }

  // Requirements
  const reqParts = [];
  const reqStat = sk.requiredStat;
  const reqVal  = sk.requiredValue;
  if (reqStat && Number.isFinite(reqVal) && reqVal > 0) reqParts.push(`${reqStat} ${reqVal}`);
  const weaponList = Array.isArray(sk.requiredWeapon)
    ? sk.requiredWeapon
    : (sk.requiredWeapon ? [sk.requiredWeapon] : []);
  if (weaponList.length) reqParts.push(`Weapon: ${weaponList.join(', ')}`);
  if (reqParts.length) { lines.push(''); lines.push(`Requires: ${reqParts.join(' • ')}`); }

  // Title color hint (returned separately so callers can use it)
  const titleColor = (tags.includes('fire') && '#ffb37a')
    || (tags.includes('cold') && '#88cff2')
    || (tags.includes('lightning') && '#f0d35c')
    || (tags.includes('heal') && '#8fe0b0')
    || '#ffddaa';

  // Trim leading/trailing blank lines
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  if (lines.length === 0) lines.push('No additional details.');
  return { lines, tags, titleColor };
}
