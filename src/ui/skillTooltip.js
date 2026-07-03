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

import { getItemComputedData } from '../systems/ItemFactory.js';

const COST_LABEL = {
  major: 'Major Action',
  bonus: 'Bonus Action',
  class: 'Class Action',
  reaction: 'Reaction',
};

// T1/T2 flavor names — keep in sync with CombatScene._onWeaknessTierChanged's `names` map.
const TIER_NAMES = {
  lightning: ['Zapped', 'Shocked'],
  cold: ['Chilled', 'Frostbitten'],
  fire: ['Singed', 'Ablaze'],
  disorient: ['Dazed', 'Concussed'],
  lacerate: ['Bleeding', 'Hemorrhaging'],
  expose: ['Raw', 'Flayed'],
  disease: ['Sickened', 'Plagued'],
  curse: ['Hexed', 'Afflicted'],
  toxic: ['Poisoned', 'Envenomed'],
};
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function tierLabel(family, tierAtLeast) {
  const idx = Math.max(1, tierAtLeast || 1) - 1;
  return TIER_NAMES[family]?.[idx] || `${capitalize(family)} (Tier ${tierAtLeast || 1}+)`;
}

// For a list of per-tier rewardIfWeak rules, higher tiers often just add one
// new thing on top of what the lower tier already grants (e.g. Flayed adds a
// damage% bonus but keeps the same buildup bonus Raw already gives). Repeating
// the unchanged parts at every tier reads as confusing/redundant, so this
// returns only the keys that are new or changed vs. the previous tier's buff.
function buffDelta(prevBuff, buff) {
  if (!prevBuff) return buff;
  const delta = {};
  for (const key of Object.keys(buff || {})) {
    if (key === 'addBuildup') {
      const prevAB = prevBuff.addBuildup || {};
      const ab = buff.addBuildup || {};
      const changed = {};
      for (const k of Object.keys(ab)) {
        if (ab[k] !== prevAB[k]) changed[k] = ab[k];
      }
      if (Object.keys(changed).length) delta.addBuildup = changed;
      continue;
    }
    if (buff[key] !== prevBuff[key]) delta[key] = buff[key];
  }
  return delta;
}

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
    const b = Object.entries(buff.addBuildup).map(([k, v]) => `+${v} bonus ${capitalize(k)} buildup`);
    parts.push(b.join(', '));
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
      // Live mode: real numbers for this character, including rolled weapon
      // affixes (flat/% weapon damage) and gear-wide % damage bonuses — both are
      // attacker-only, so they're safe to bake into the headline number.
      // Target-dependent bonuses (e.g. vs an Exposed foe) can't be known yet
      // since no target is selected at tooltip time — those show below instead.
      const weaponInst = actor.equipment?.weaponMain;
      const weaponView = weaponInst ? getItemComputedData(weaponInst) : null;
      const wMin = weaponView?.damage?.min ?? 1;
      const wMax = weaponView?.damage?.max ?? 2;
      const str = actor.totalStats?.STR ?? 0;
      const strMod = Math.floor(str / 5);
      const weapName = weaponView?.name ?? 'Unarmed';

      const preGearMin = wMin + strMod;
      const preGearMax = wMax + strMod;
      const gearPct = actor.gearEffects?.globalDamagePercent || 0;
      const gearMult = 1 + gearPct / 100;
      const finalMin = Math.max(1, Math.floor(preGearMin * gearMult));
      const finalMax = Math.max(1, Math.floor(preGearMax * gearMult));

      lines.push(`Damage: ${finalMin}–${finalMax}`);
      lines.push(`  ${weapName} (${wMin}–${wMax}) + STR/5 (+${strMod}) = ${preGearMin}–${preGearMax}`);
      if (gearPct) lines.push(`  × Gear Damage +${gearPct}% = ${finalMin}–${finalMax}`);
      if (sk.hitCount > 1) {
        lines.push(`  × ${sk.hitCount} hits = ${finalMin * sk.hitCount}–${finalMax * sk.hitCount} total`);
      }

      const critChance = Math.round((actor.derived?.CritChance || 0) + (weaponView?._derivedMods?.CritChance || 0));
      const critMult = actor.derived?.CritMult ?? 1.5;
      if (critChance > 0) lines.push(`  Crit: ${critChance}% chance for ×${critMult}`);
    } else {
      // Generic mode: formula only, no numbers (no character context to compute from)
      lines.push('Damage: weapon damage + STR/5 (+ gear % bonuses)');
      if (sk.hitCount > 1) lines.push(`  × ${sk.hitCount} hits`);
    }
    if (sk.damageType) lines.push(`  Type: ${sk.damageType}`);
  } else if (sk.damageType) {
    lines.push('');
    lines.push(`Damage type: ${sk.damageType}`);
  }

  // Buildup hints
  if (sk.buildupHint && typeof sk.buildupHint === 'object') {
    const parts = Object.entries(sk.buildupHint).map(([fam, amt]) => `+${amt} ${capitalize(fam)} buildup`);
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

  // Reward if weak (target is currently at/above a weakness tier).
  // Supports either a single rule or a list of rules (e.g. a weaker T1 case and
  // a stronger T2 case for the same family). Rules are shown lowest tier first;
  // a higher tier only lists what's NEW compared to the tier below it, so an
  // unchanged buildup bonus isn't repeated at every tier — see buffDelta().
  if (sk.rewardIfWeak) {
    const rules = (Array.isArray(sk.rewardIfWeak) ? sk.rewardIfWeak : [sk.rewardIfWeak])
      .filter(Boolean)
      .sort((a, b) => (a.tierAtLeast ?? 1) - (b.tierAtLeast ?? 1));
    let prevBuff = null;
    rules.forEach((rw, idx) => {
      const label = tierLabel(rw.family, rw.tierAtLeast);
      if (idx === 0) {
        lines.push(`If target is ${label}: ${buffToText(rw.buff)}`);
      } else {
        const delta = buffDelta(prevBuff, rw.buff);
        if (delta && Object.keys(delta).length) {
          lines.push(`If target is ${label}, it also grants: ${buffToText(delta)}`);
        } else {
          lines.push(`If target is ${label}: ${buffToText(rw.buff)}`);
        }
      }
      prevBuff = rw.buff;
    });
  }

  // Reward if tier cross
  if (Array.isArray(sk.rewardIfTierCross) && sk.rewardIfTierCross.length) {
    lines.push('');
    sk.rewardIfTierCross.forEach(rule => {
      lines.push(`On reaching ${tierLabel(rule.family, rule.tier)}: ${buffToText(rule.buff ?? rule.debuff)}`);
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
