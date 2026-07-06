// ReactionSystem.js — Prep-based, scalable reactions
// Supports:
// - Prepare up to `capacity` reactions; prep persists until it fires or the
//   player changes their selection (does NOT auto-clear each turn)
// - Between your turns, at most `triggersPerRound` will actually fire (default
//   1) — firing one does NOT disarm the others, they just can't fire until
//   triggersRemaining refreshes on your next turn (scales naturally once a
//   character has more than 1 reaction point)
// - Cooldowns (and MP) are paid on TRIGGER, not on prep
//
// Backward-compat:
// - Works with skills that have mechanic: 'reaction' and triggers[],
//   OR with `reaction: { trigger, canTrigger, exec, counterSkillId, cooldownOn }`.
//
// Scene expects:
// - this.bus emits 'self_hit' with { attacker, target, ability, intent, incomingMutable }
// - this._isSkillOnCooldown(user, skillId), this._startSkillCooldown(user, skillId, cd)
// - this._applyAbilityToTarget(user, target, skill [, intent])
// - this._log(str) (optional)
// - this.time.delayedCall(ms, fn) (optional)

import { SKILLS } from '../../data/skills.js';
import { DevFlags } from './DevFlags.js';

/**
 * isReactableAttackSource(ability) — the ONE place that decides whether a
 * hit is eligible to trigger a reaction at all (before any specific
 * reaction's own canTrigger/weakness/position checks even run). Used in
 * exactly two places, both of which must agree: CombatScene.js's self_hit
 * emission gate (`allowSelfHit`), and _onEvent's internal check below. If
 * you ever need to touch this logic, change it HERE and both call sites
 * pick it up — don't re-derive it inline anywhere else.
 *
 * DEV NOTE — why 'enemy' is in here, and how to retire it later:
 * Every player weapon skill is `type: 'weapon'` and/or tagged 'attack', so
 * either check alone would work for the player side. Every enemy-authored
 * skill (Berserker, etc.) instead uses `type: 'enemy'` and — as of this
 * writing — NONE of them have a `tags` array at all, not even 'attack'.
 * Without explicitly allowing `type === 'enemy'` here, NO enemy attack could
 * ever trigger ANY player reaction (Riposte, Cover Strike, Read and React —
 * all of them), which is exactly the bug this fixed. This is a blanket
 * allowance because enemy skill data just isn't granular enough yet to be
 * pickier — every enemy skill is currently treated as a valid attack source
 * for reaction purposes (a separate isDamaging check elsewhere already
 * excludes non-damaging enemy actions from ever reaching this point).
 *
 * If enemy skills eventually get real tags (melee/ranged/attack/support/
 * etc.) or a `dealsDamage` flag like player skills already have, tighten
 * THIS function to check those instead of blanket-allowing `type ===
 * 'enemy'` — every reaction in the game inherits the fix automatically,
 * with no per-skill changes needed anywhere else.
 */
export function isReactableAttackSource(ability, intent) {
  const hasAttackTag = (intent?.tags || []).includes('attack') || (ability?.tags || []).includes('attack');
  return ability?.type === 'weapon' || ability?.type === 'enemy' || hasAttackTag;
}

export default class ReactionSystem {
  constructor(scene, bus, opts = {}) {
    this.scene = scene;
    this.bus = bus;

    this.defaults = {
      capacity: 2,            // how many unique reactions can be prepared
      triggersPerRound: 1,    // how many can actually fire between owner's turns
      allowUnpreparedFallback: false, // legacy fallback if nothing prepared
    };

    Object.assign(this.defaults, opts);

  }

  install() {
    this.bus?.on?.('self_hit', payload => this._onEvent('self_hit', payload));
    this.bus?.on?.('ally_hit', payload => this._onEvent('ally_hit', payload));
  }


  // Called at the start of the unit's OWN turn
  onTurnStart(unit) {
    const st = this._state(unit);
    st.triggersRemaining = unit.reactionTriggers ?? this.defaults.triggersPerRound;
    // Prepared reactions now PERSIST across turns/rounds — they only clear
    // when one actually fires (disarms the whole set, see _onEvent) or the
    // player explicitly changes their selection via the reaction menu. This
    // used to wipe prep every turn regardless of whether anything triggered.
  }

  // Arm a reaction (from a "prep" skill apply() returning { armReaction:true })
  arm(unit, ability, options = {}) {
    if (!unit || !ability) return;
    const st = this._state(unit);

    const a = normalizeSkill(ability);
    if (a.mechanic !== 'reaction') return;

    // de-dupe and enforce capacity (FIFO)
    st.prepared = st.prepared.filter(x => x.id !== a.id);
    while (st.prepared.length >= (unit.reactionCapacity ?? st.capacity)) st.prepared.shift();

    st.prepared.push({
      id: a.id,
      trigger: getPrimaryTrigger(a),
      cooldownOn: a?.reaction?.cooldownOn || 'trigger',
      ...(options || {})
    });

    this.scene._log?.(`${unit.name} readies ${a.name}.`);
  }

  disarm(unit) {
    const st = this._state(unit);
    st.prepared.length = 0;
  }

  // ---------- internals ----------

  _state(u) {
    if (!u) return null;
    if (!u.reaction) {
      u.reaction = {
        prepared: [],
        capacity: u.reactionCapacity ?? this.defaults.capacity,
        triggersRemaining: u.reactionTriggers ?? this.defaults.triggersPerRound,
      };
    } else {
      if (u.reaction.capacity == null) u.reaction.capacity = u.reactionCapacity ?? this.defaults.capacity;
      if (u.reaction.triggersRemaining == null) u.reaction.triggersRemaining = u.reactionTriggers ?? this.defaults.triggersPerRound;
      if (!Array.isArray(u.reaction.prepared)) u.reaction.prepared = [];
    }
    return u.reaction;
  }

  listPrepared(unit) {
    const st = this._state(unit);
    return (st?.prepared || [])
      .map(x => ({ id: x.id, ...(SKILLS[x.id] || {}) }))
      .filter(Boolean);
  }
  capacity(unit) {
    return this._state(unit)?.capacity ?? this.defaults.capacity;
  }
  remainingTriggers(unit) {
    return this._state(unit)?.triggersRemaining ?? this.defaults.triggersPerRound;
  }



  _onSelfHit(payload) {
    this._onEvent('self_hit', payload);
  }


  _onEvent(evt, payload) {
    const { attacker, target, ability, intent, incomingMutable, ally } = payload || {};

    // Who is the reactor?
    let owner = null;
    if (evt === 'self_hit') owner = target;
    else if (evt === 'ally_hit') owner = ally;
    else return;

    if (!owner || owner.status === 'incapacitated') return;

    // 1) Only react to *hostile* actions (different teams)
    if (!!attacker?.isEnemy === !!owner?.isEnemy) return;

    // 2) Only react to valid attack sources (see isReactableAttackSource's
    // dev notes above — this is the ONE shared definition, also used by
    // CombatScene's emission-side gate). Redundant with that gate in
    // practice (it already filters before the event is even emitted) but
    // kept here too so this function stays correct if ever called another way.
    if (!isReactableAttackSource(ability, intent)) return;

    // (optional) block while stunned
    if (Array.isArray(owner.statusEffects)) {
      if (owner.statusEffects.some(se => se?.blocksAction)) return;
    }

    const st = this._state(owner);
    if (!st || (st.triggersRemaining | 0) <= 0) {
      // Diagnostic: only worth logging if they actually have something
      // prepared (otherwise this fires on every single hit taken, which
      // would be pure noise for a character with no reactions armed at all).
      if (st?.prepared?.length) {
        this.scene?._log?.(`${owner.name} has no reaction points left this round (refreshes on their next turn).`);
      }
      return;
    }

    // prepared pool → candidates (same as before)
    let pool = this._resolvePrepared(owner);
    let candidates = pool
      .map(id => SKILLS[id])
      .filter(Boolean)
      .map(s => ({ s, trig: getTriggerForEvent(s, evt) }))
      .filter(x =>
        x.trig &&
        this._meetsReqs(owner, x.s) &&
        (DevFlags.isNoCooldownEnabled() || !this.scene?._isSkillOnCooldown?.(owner, x.s.id))
      )
      .sort((a, b) => (b.trig.priority || 0) - (a.trig.priority || 0));

    if (!candidates.length && this.defaults?.allowUnpreparedFallback) {
      const legacy = this._getAvailableReactionSkills(owner);
      candidates = legacy
        .map(s => ({ s, trig: getTriggerForEvent(s, evt) }))
        .filter(x =>
          x.trig &&
          this._meetsReqs(owner, x.s) &&
          (DevFlags.isNoCooldownEnabled() || !this.scene?._isSkillOnCooldown?.(owner, x.s.id))
        )
        .sort((a, b) => (b.trig.priority || 0) - (a.trig.priority || 0));
    }

    // Diagnostic: if something was actually prepared and its trigger matches
    // this event, but it still didn't qualify, say exactly why instead of
    // silently doing nothing. This is the one gap that made "why isn't my
    // reaction firing" impossible to debug from outside — every other bail-
    // out above this point is either irrelevant (wrong event/team) or
    // already visible another way, but a prepared-and-ready-looking reaction
    // failing silently here was the confusing case.
    if (!candidates.length) {
      for (const id of pool) {
        const s = SKILLS[id];
        const trig = s && getTriggerForEvent(s, evt);
        if (!trig) continue;
        if (!DevFlags.isNoCooldownEnabled() && this.scene?._isSkillOnCooldown?.(owner, id)) {
          this.scene?._log?.(`${owner.name}'s ${s.name} is on cooldown and can't trigger yet.`);
        } else if (!this._meetsReqs(owner, s)) {
          this.scene?._log?.(`${owner.name}'s ${s.name} can't trigger — ${this._reqFailureReason(owner, s)}.`);
        }
      }
      return;
    }

    const chosen = candidates[0].s;

    if (typeof chosen?.reaction?.canTrigger === 'function') {
      const ok = chosen.reaction.canTrigger({
        owner, attacker, target, scene: this.scene,
        incoming: incomingMutable, event: evt,
        // sourceAbility/sourceIntent weren't passed here before (only exec()
        // got them) — added so a canTrigger can gate on the hit's own tags
        // (e.g. Read and React needing to confirm the hit was melee).
        sourceAbility: ability, sourceIntent: intent,
      });
      if (!ok) {
        this.scene?._log?.(`${owner.name}'s ${chosen.name} didn't trigger — its condition wasn't met.`);
        return;
      }
    }

    // Execute
    this._fireReaction({
      owner,
      attacker,
      reactSkill: chosen,
      evt,
      incomingMutable,
      sourceAbility: ability,
      sourceIntent: intent,
    });

    // Spend one trigger budget. Other prepared reactions stay ARMED (not
    // disarmed) — they just can't fire until triggersRemaining refreshes on
    // the owner's next turn, since that's already the gate checked above
    // (`if (!st || (st.triggersRemaining|0) <= 0) return;`). This lets a
    // player with more reaction points eventually fire more than one of
    // their prepared reactions before needing to re-prepare anything.
    st.triggersRemaining = Math.max(0, (st.triggersRemaining | 0) - 1);
  }

  _fireReaction({ owner, attacker, reactSkill, evt, incomingMutable, sourceAbility, sourceIntent }) {
    const cooldownOn = reactSkill?.reaction?.cooldownOn || 'trigger';

    // Reaction action point + MP cost are both paid HERE, at trigger time —
    // preparing is free; only an actual trigger spends anything. The action
    // point deduction is purely a UI-light mirror of st.triggersRemaining
    // (already the real gate in _onEvent, checked before we ever get here);
    // this keeps the on-screen reaction light in sync without it being a
    // second independent gate that could drift out of sync with the real one.
    if (owner) {
      owner.actionsLeft = owner.actionsLeft || {};
      owner.actionsLeft.reaction = Math.max(0, (owner.actionsLeft.reaction || 0) - 1);
      const mpCost = Number.isFinite(reactSkill?.mpCost) ? reactSkill.mpCost : 0;
      if (mpCost > 0) {
        owner.currentMP = Math.max(0, (owner.currentMP || 0) - mpCost);
        this.scene?._log?.(`${owner.name} spends ${mpCost} MP on ${reactSkill.name}.`);
      }
    }

    // explicit executor hook
    if (reactSkill?.reaction?.exec) {
      try {
        reactSkill.reaction.exec({
          owner,
          attacker,
          scene: this.scene,
          incoming: incomingMutable,
          event: evt,
          sourceAbility,
          sourceIntent,
        });
      } catch (e) {
        console.error('[Reaction Error: exec()]', reactSkill.id, e);
      }
      if (cooldownOn === 'trigger') this._startCD(owner, reactSkill);
      return;
    }

    // legacy: use apply() at trigger time
    let rxRes = {};
    try {
      rxRes = reactSkill.apply ? (reactSkill.apply(owner, attacker, {
        trigger: evt, incoming: incomingMutable, intent: sourceIntent
      }) || {}) : {};
    } catch (e) {
      console.error('[Reaction Error: apply()]', reactSkill.id, e);
    }

    // DR / parry
    if (rxRes?.parry && typeof rxRes.damageReduction === 'number' && incomingMutable) {
      const cur = incomingMutable.damageReduction || 0;
      incomingMutable.damageReduction = Math.max(cur, Math.min(0.95, rxRes.damageReduction));
      this.scene._log?.(`${owner.name} parries!`);
    }

    // counterattack
    const counterId = reactSkill?.reaction?.counterSkillId || reactSkill?.counterSkillId || 'basic_attack';
    const counterSkill = SKILLS[counterId];
    if (counterSkill) {
      this.scene.time?.delayedCall?.(50, () => {
        this.scene._applyAbilityToTarget(owner, attacker, counterSkill, { isReaction: true, tags: counterSkill.tags || [] });
      });
    }

    if (cooldownOn === 'trigger') this._startCD(owner, reactSkill);
  }

  _startCD(owner, skill) {
    const cd = Number.isFinite(skill.cooldown) ? skill.cooldown : 0;
    if (cd > 0) this.scene._startSkillCooldown?.(owner, skill.id, cd);
  }

  _resolvePrepared(owner) {
    const st = this._state(owner);
    return (st.prepared || []).map(x => x.id);
  }

  _getAvailableReactionSkills(unit) {
    const learned = (unit.skills || [])
      .map(e => typeof e === 'string' ? (SKILLS[e] || null) : (SKILLS[e.id] || e))
      .filter(Boolean);
    return learned.filter(s => s && s.mechanic === 'reaction');
  }

  _meetsReqs(u, s) {
    // stat — was checked here with NO DevFlags.isBreakthroughEnabled()
    // exemption, even though getReactionSkillsFor() (which builds the prep
    // menu) already respects it. That mismatch let a character prepare a
    // reaction under Breakthrough that could then never actually fire,
    // silently, since this real gate didn't know about the cheat at all.
    if (s.requiredStat && !DevFlags.isBreakthroughEnabled()
      && ((u.totalStats?.[s.requiredStat] || 0) < (s.requiredValue || 0))) return false;

    // weapon
    if (Array.isArray(s.requiredWeapon) && s.requiredWeapon.length) {
      const wType = u.weaponType || u.equipment?.weaponMain?.type || u.equipment?.weaponMain?.weaponType;
      if (!wType || !s.requiredWeapon.includes(wType)) return false;
    }

    // position — same gap as stat above, now respects the no-range cheat
    // (positionRequirement/targetColumns bypass) like every other position
    // check in the codebase does.
    if (!DevFlags.isNoRangeEnabled()
      && Array.isArray(s.positionRequirement) && s.positionRequirement.length) {
      const col = this.scene._getUnitColumn?.(u) || u.position;
      if (!s.positionRequirement.includes(col)) return false;
    }

    return true;
  }

  // Diagnostic-only twin of _meetsReqs — same three checks, same DevFlags
  // exemptions, but returns WHICH one failed instead of a bare boolean.
  // Only used for the log message above; the real gate stays _meetsReqs.
  _reqFailureReason(u, s) {
    if (s.requiredStat && !DevFlags.isBreakthroughEnabled()
      && ((u.totalStats?.[s.requiredStat] || 0) < (s.requiredValue || 0))) {
      return `needs ${s.requiredStat} ${s.requiredValue} (has ${u.totalStats?.[s.requiredStat] || 0})`;
    }
    if (Array.isArray(s.requiredWeapon) && s.requiredWeapon.length) {
      const wType = u.weaponType || u.equipment?.weaponMain?.type || u.equipment?.weaponMain?.weaponType;
      if (!wType || !s.requiredWeapon.includes(wType)) {
        return `needs weapon [${s.requiredWeapon.join(', ')}] (has ${wType || 'none'})`;
      }
    }
    if (!DevFlags.isNoRangeEnabled()
      && Array.isArray(s.positionRequirement) && s.positionRequirement.length) {
      const col = this.scene._getUnitColumn?.(u) || u.position;
      if (!s.positionRequirement.includes(col)) {
        return `needs position [${s.positionRequirement.join(', ')}] (in ${col || 'unknown'})`;
      }
    }
    return 'requirements not met';
  }
}

// ---------- helpers ----------

function normalizeSkill(s) {
  if (!s) return s;
  return SKILLS[s.id] || s;
}

function getPrimaryTrigger(s) {
  if (s?.reaction?.trigger) return s.reaction.trigger;
  const t = Array.isArray(s?.triggers) ? s.triggers.find(x => !!x?.event) : null;
  return t?.event || null;
}

function getTriggerForEvent(s, evt) {
  if (s?.reaction?.trigger === evt) return { event: evt, priority: s?.reaction?.priority ?? 0 };
  const arr = Array.isArray(s?.triggers) ? s.triggers : [];
  return arr.find(t => t.event === evt) || null;
}
