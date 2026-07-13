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
import { WeaknessTierNames } from '../systems/StatusEffects.js';

const COST_LABEL = {
  major: 'Major Action',
  bonus: 'Bonus Action',
  class: 'Class Action',
  reaction: 'Reaction',
};

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function tierLabel(family, tierAtLeast) {
  const idx = Math.max(1, tierAtLeast || 1) - 1;
  return WeaknessTierNames[family]?.[idx] || `${capitalize(family)} (Tier ${tierAtLeast || 1}+)`;
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
  // damageType is optional/descriptive: most damagePct rewards scale the
  // whole hit uniformly (e.g. Needle Venom), but a few add the bonus to one
  // specific typed component only (e.g. Vein Tap's necrotic-only drain) —
  // this makes that distinction visible instead of reading identically to
  // a whole-hit bonus.
  if (buff.damagePct)           parts.push(`+${buff.damagePct}% damage${buff.damageType ? ` (as ${buff.damageType})` : ''}`);
  if (buff.grantsRhythm)        parts.push('Builds Rhythm');
  if (buff.initiativePerRhythmStack) parts.push(`+${buff.initiativePerRhythmStack} Initiative per Rhythm stack${buff.consumesRhythm ? ' (consumes them)' : ''}`);
  if (buff.evasionPct)          parts.push(`+${buff.evasionPct}% Evasion`);
  if (buff.guardPct)            parts.push(`+${buff.guardPct}% Guard`);
  if (buff.chanceExtraHitPct)   parts.push(`${buff.chanceExtraHitPct}% extra hit`);
  if (buff.healMP)              parts.push(`+${buff.healMP} MP`);
  if (buff.healHP)              parts.push(`+${buff.healHP} HP`);
  if (buff.repeatStrikeOnce)    parts.push(`repeat strike (${buff.repeatPowerPct ?? 60}%)`);
  if (buff.extraRapidTicks)     parts.push(`+${buff.extraRapidTicks} tick`);
  if (buff.addBuildup) {
    const b = Object.entries(buff.addBuildup).map(([k, v]) => `+${v} bonus ${capitalize(k)} buildup`);
    parts.push(b.join(', '));
  }
  if (buff.physicalVulnPct)     parts.push(`-${buff.physicalVulnPct}% phys resist`);
  if (buff.bleedTakenPct)       parts.push(`+${buff.bleedTakenPct}% bleed taken`);
  if (buff.speedDownPct)        parts.push(`-${buff.speedDownPct}% speed`);
  if (buff.onNextDamageTaken) {
    const n = buff.onNextDamageTaken;
    const nParts = [];
    if (n.bonusDamagePercent) nParts.push(`next hit taken: damage added as Fire (+${n.bonusDamagePercent}%)`);
    if (n.buildup) {
      const b = Object.entries(n.buildup).map(([k, v]) => `+${v} ${capitalize(k)} buildup`);
      if (b.length) nParts.push(b.join(', '));
    }
    parts.push(nParts.join(', '));
  }
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

  // Buildup hints — directly under the description, above cost/damage.
  if (sk.buildupHint && typeof sk.buildupHint === 'object') {
    const buildupParts = Object.entries(sk.buildupHint).map(([fam, amt]) => `+${amt} ${capitalize(fam)} buildup`);
    if (buildupParts.length) lines.push(`Applies: ${buildupParts.join(', ')}`);
  }

  // Rhythm — shared mechanic across several one-handed sword skills (and
  // others). One line here instead of repeating the same explanation in
  // every skill's own description text.
  if (sk.grantsRhythm) {
    lines.push('Builds Rhythm: gain a stack (max 3) of +5% generic increased damage; gaining a stack refreshes ALL current stacks to 2 turns.');
  }

  // Reward if weak (target is currently at/above a weakness tier) — grouped with
  // Applies near the top since both describe what the skill DOES, before the
  // cost/cooldown/damage mechanics below. Supports either a single rule or a
  // list of rules (e.g. a weaker T1 case and a stronger T2 case for the same
  // family). Rules are shown lowest tier first; a higher tier only lists what's
  // NEW compared to the tier below it, so an unchanged buildup bonus isn't
  // repeated at every tier — see buffDelta().
  if (sk.rewardIfWeak) {
    const rules = (Array.isArray(sk.rewardIfWeak) ? sk.rewardIfWeak : [sk.rewardIfWeak])
      .filter(Boolean)
      .sort((a, b) => (a.tierAtLeast ?? 1) - (b.tierAtLeast ?? 1));
    let prevBuff = null;
    rules.forEach((rw, idx) => {
      const label = tierLabel(rw.family, rw.tierAtLeast);
      // "at least" because tierAtLeast is a floor, not an exact match — a T1
      // rule with no higher tier defined still applies at T2 and beyond, so
      // saying just "If target is Dazed" would wrongly imply it stops applying
      // once they're Concussed instead.
      if (idx === 0) {
        lines.push(`If target is at least ${label}: ${buffToText(rw.buff)}`);
      } else {
        const delta = buffDelta(prevBuff, rw.buff);
        if (delta && Object.keys(delta).length) {
          lines.push(`If target is at least ${label}, it also grants: ${buffToText(delta)}`);
        } else {
          lines.push(`If target is at least ${label}: ${buffToText(rw.buff)}`);
        }
      }
      prevBuff = rw.buff;
    });
  }

  // Bonus crit chance vs a weakness tier (e.g. Silent Order vs Exposed) — same
  // shape/grouping rationale as rewardIfWeak above, just a dedicated field
  // since it's not a post-hit "reward" but a modifier on this hit's own roll.
  if (Array.isArray(sk.critChanceIfWeak) && sk.critChanceIfWeak.length) {
    const rules = [...sk.critChanceIfWeak].sort((a, b) => (a.tierAtLeast ?? 1) - (b.tierAtLeast ?? 1));
    rules.forEach(r => {
      const label = tierLabel(r.family, r.tierAtLeast);
      lines.push(`If target is at least ${label}: +${r.bonusPct}% crit chance`);
    });
  }

  // Crit-triggered initiative gain scaled by a stat (e.g. Silent Order's CHA),
  // with an optional stronger multiplier vs a weakness tier.
  if (sk.critInitiative) {
    const ci = sk.critInitiative;
    const mult = Number.isFinite(ci.mult) ? ci.mult : 1;
    const multStr = mult === 1 ? '' : ` ×${mult}`;
    let line = `On crit: gain initiative equal to ${ci.stat}${multStr}`;
    const rules = Array.isArray(ci.weaknessBonus) ? ci.weaknessBonus : (ci.weaknessBonus ? [ci.weaknessBonus] : []);
    if (rules.length) {
      const bonusParts = rules
        .sort((a, b) => (a.tierAtLeast ?? 1) - (b.tierAtLeast ?? 1))
        .map(r => `×${r.mult} if target is at least ${tierLabel(r.family, r.tierAtLeast)}`);
      line += ` (${bonusParts.join(', ')})`;
    }
    lines.push(`${line}.`);
  }

  // Reward if tier cross — same grouping rationale as above. When consecutive
  // rules grant the exact same buff (e.g. "fires on crossing either Raw or
  // Flayed, same bonus either way"), merge them into one line instead of
  // repeating an identical line per tier.
  if (Array.isArray(sk.rewardIfTierCross) && sk.rewardIfTierCross.length) {
    const grouped = [];
    sk.rewardIfTierCross.forEach(rule => {
      const buffStr = buffToText(rule.buff ?? rule.debuff);
      const last = grouped[grouped.length - 1];
      if (last && last.buffStr === buffStr && last.family === rule.family) {
        last.labels.push(tierLabel(rule.family, rule.tier));
      } else {
        grouped.push({ family: rule.family, buffStr, labels: [tierLabel(rule.family, rule.tier)] });
      }
    });
    grouped.forEach(g => {
      lines.push(`On reaching ${g.labels.join(' or ')}: ${g.buffStr}`);
    });
  }

  // Rank-conditional rewards (e.g. Momentum Strike) — one line per rank that
  // has a variant defined, in a fixed front/middle/back reading order.
  if (sk.rankVariants) {
    const RANK_LABEL = { front: 'Front rank', middle: 'Middle rank', back: 'Back rank' };
    for (const rank of ['front', 'middle', 'back']) {
      const variant = sk.rankVariants[rank];
      if (variant) lines.push(`${RANK_LABEL[rank]}: ${buffToText(variant)}`);
    }
  }

  if (sk.buildupHint || sk.rewardIfWeak || sk.critChanceIfWeak || sk.critInitiative || sk.grantsRhythm
    || sk.rankVariants
    || (Array.isArray(sk.rewardIfTierCross) && sk.rewardIfTierCross.length)) {
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

  // Weakness consumption
  if (Array.isArray(sk.consumeWeakness) && sk.consumeWeakness.length) {
    lines.push(`Consumes: ${sk.consumeWeakness.join(', ')} weakness`);
  }

  // Weakness consumption for a scaling damage bonus (e.g. Power Stab) —
  // distinct from the flat consumeWeakness list above since this one has a
  // real rate/cap to show, not just "drains this family."
  if (sk.consumeWeaknessBonus) {
    const cfg = sk.consumeWeaknessBonus;
    const maxBonusPct = Math.floor(cfg.maxConsume / 100) * cfg.pctPer100;
    lines.push(`Consumes up to ${cfg.maxConsume} ${capitalize(cfg.family)}: +${cfg.pctPer100}% damage per 100 consumed (up to +${maxBonusPct}%).`);
  }

  // Transform weakness
  if (sk.transformWeakness) {
    const tw = sk.transformWeakness;
    lines.push(`Converts: ${tw.from} → ${tw.to} (×${tw.ratio ?? 1})`);
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
