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
    // Friendly-side trigger (e.g. Volley) — a teammate USED a projectile
    // skill, as opposed to self_hit/ally_hit's "someone got HIT". Kept as
    // its own handler rather than folded into _onEvent since that one's
    // hostile-teams check (`!!attacker?.isEnemy === !!owner?.isEnemy`
    // returning early) is specifically wrong here: attacker and reactor are
    // on the SAME side by construction for this event.
    this.bus?.on?.('ally_projectile_used', payload => this._onAllyProjectileUsed(payload));
    // A unit (either side) just crossed INTO a T2 weakness tier, from
    // whatever cause — see _onWeaknessTierCross below for why this can't
    // reuse _onEvent's self_hit/ally_hit shape.
    this.bus?.on?.('weakness_tier_cross', payload => this._onWeaknessTierCross(payload));
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

  // Friendly counterpart to _onEvent — reactor (`ally`) and the skill's
  // user are teammates by construction (see the emission-side gate in
  // CombatScene.js), so there's no hostile-teams check here at all, unlike
  // _onEvent's very first real check.
  _onAllyProjectileUsed({ user, target, ability, ally }) {
    if (!ally || ally.status === 'incapacitated') return;
    if (Array.isArray(ally.statusEffects) && ally.statusEffects.some(se => se?.blocksAction)) return;

    const st = this._state(ally);
    if (!st || (st.triggersRemaining | 0) <= 0) return;

    const pool = this._resolvePrepared(ally);
    const candidates = pool
      .map(id => SKILLS[id])
      .filter(Boolean)
      .map(s => ({ s, trig: getTriggerForEvent(s, 'ally_projectile_used') }))
      .filter(x =>
        x.trig &&
        this._meetsReqs(ally, x.s) &&
        (DevFlags.isNoCooldownEnabled() || !this.scene?._isSkillOnCooldown?.(ally, x.s.id))
      )
      .sort((a, b) => (b.trig.priority || 0) - (a.trig.priority || 0));

    if (!candidates.length) return;
    const chosen = candidates[0].s;

    if (typeof chosen?.reaction?.canTrigger === 'function') {
      const ok = chosen.reaction.canTrigger({
        owner: ally, attacker: user, target, scene: this.scene,
        event: 'ally_projectile_used', sourceAbility: ability,
      });
      if (!ok) return;
    }

    this._fireReaction({
      owner: ally,
      attacker: user,
      target,
      reactSkill: chosen,
      evt: 'ally_projectile_used',
      incomingMutable: null,
      sourceAbility: ability,
      sourceIntent: null,
    });

    st.triggersRemaining = Math.max(0, (st.triggersRemaining | 0) - 1);
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
    if (!st || (st.triggersRemaining | 0) <= 0) return;

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

    if (!candidates.length) return;

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
      if (!ok) return;
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

  _fireReaction({ owner, attacker, target, reactSkill, evt, incomingMutable, sourceAbility, sourceIntent }) {
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
          target,
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

  // ---------- pre-hit reactions (redirect / scoped attacker debuffs) ------
  // A SEPARATE resolution path from self_hit/ally_hit above, on purpose —
  // those fire off `this.bus.emit(...)` AFTER a hit's damage is already
  // computed, mutating a result object; there's no synchronous return value
  // to the caller. Redirect and "weaken this specific hit before it rolls"
  // both need an answer BEFORE calculateDamage() ever runs, so this is a
  // direct method call (from CombatScene._applyAbilityToTarget, right before
  // ability.apply()) that returns a real value instead. Deliberately kept
  // separate from _fireReaction rather than merged into it — that function
  // also carries self_hit-only concerns (legacy apply()-based reactions,
  // counterattacks, DR/parry) that don't apply here, and forcing a shared
  // path would make BOTH harder to follow for no real gain.
  //
  // Returns whatever the winning reaction's exec() returns (e.g.
  // { redirectTo: unit } or { scopedDebuffId: 'some_status_id' }), or null
  // if nothing fired. Only ever called for a REAL primary target — splash/
  // AoE instances don't route through _applyAbilityToTarget again, so they
  // never reach this check at all (redirect/pre-hit debuffs are scoped to
  // primary single-target hits by construction, not by an extra flag).
  checkPreHit(target, { attacker, ability, scene }) {
    if (!target || target.status === 'incapacitated') return null;
    if (!!attacker?.isEnemy === !!target?.isEnemy) return null; // hostile only
    if (!isReactableAttackSource(ability, null)) return null;

    const sideSlots = target?.isEnemy ? scene?.enemySlots : scene?.allySlots;
    const teammates = (sideSlots || [])
      .map(s => s?.char)
      .filter(a => a && a.status !== 'incapacitated');

    for (const owner of teammates) {
      const st = this._state(owner);
      if (!st || (st.triggersRemaining | 0) <= 0) continue;
      if (Array.isArray(owner.statusEffects) && owner.statusEffects.some(se => se?.blocksAction)) continue;

      const pool = this._resolvePrepared(owner);
      const candidates = pool
        .map(id => SKILLS[id])
        .filter(s => s && getTriggerForEvent(s, 'pre_hit'))
        .filter(s => this._meetsReqs(owner, s) && (DevFlags.isNoCooldownEnabled() || !scene?._isSkillOnCooldown?.(owner, s.id)))
        .sort((a, b) => (b.reaction?.priority || 0) - (a.reaction?.priority || 0));

      if (!candidates.length) continue;
      const chosen = candidates[0];

      const ok = typeof chosen.reaction?.canTrigger === 'function'
        ? chosen.reaction.canTrigger({ owner, attacker, target, scene, event: 'pre_hit', sourceAbility: ability })
        : true;
      if (!ok) continue;

      // Same cost/action/cooldown bookkeeping _fireReaction does for the
      // event-bus path, minus the parts that don't apply here.
      owner.actionsLeft = owner.actionsLeft || {};
      owner.actionsLeft.reaction = Math.max(0, (owner.actionsLeft.reaction || 0) - 1);
      const mpCost = Number.isFinite(chosen.mpCost) ? chosen.mpCost : 0;
      if (mpCost > 0) {
        owner.currentMP = Math.max(0, (owner.currentMP || 0) - mpCost);
        scene?._log?.(`${owner.name} spends ${mpCost} MP on ${chosen.name}.`);
      }

      let outcome = null;
      try {
        outcome = chosen.reaction.exec?.({ owner, attacker, target, scene }) || null;
      } catch (e) {
        console.error('[Reaction Error: pre_hit exec()]', chosen.id, e);
      }

      if ((chosen.reaction.cooldownOn || 'trigger') === 'trigger') this._startCD(owner, chosen);
      st.triggersRemaining = Math.max(0, (st.triggersRemaining | 0) - 1);

      return outcome;
    }

    return null;
  }

  // Fires when ANY unit (either side) crosses INTO a T2 weakness tier,
  // regardless of what caused it — a hit, a zone tick, decay recompute, a
  // start-of-turn proc all funnel through the single emission point in
  // _onWeaknessTierChanged (CombatScene.js), so this reaction category
  // reacts to "target became Ablaze/Frostbitten/etc.", not to "I got hit".
  // There's no well-defined attacker (a zone tick has none), so candidates
  // are scoped to the side OPPOSING the unit that crossed, mirroring
  // checkPreHit's multi-teammate priority-sorted scan rather than _onEvent's
  // single-target shape. A reaction can optionally restrict itself to one
  // family via reaction.weaknessFamily (e.g. 'cold') — checked here, before
  // canTrigger, since it's a static property of the skill, not a runtime rule.
  _onWeaknessTierCross({ unit, family, newTier, oldTier }) {
    if (!unit || unit.status === 'incapacitated') return;

    const sideSlots = unit.isEnemy ? this.scene?.allySlots : this.scene?.enemySlots;
    const reactors = (sideSlots || [])
      .map(s => s?.char)
      .filter(a => a && a.status !== 'incapacitated');

    for (const owner of reactors) {
      const st = this._state(owner);
      if (!st || (st.triggersRemaining | 0) <= 0) continue;
      if (Array.isArray(owner.statusEffects) && owner.statusEffects.some(se => se?.blocksAction)) continue;

      const pool = this._resolvePrepared(owner);
      const candidates = pool
        .map(id => SKILLS[id])
        .filter(Boolean)
        .map(s => ({ s, trig: getTriggerForEvent(s, 'weakness_tier_cross') }))
        .filter(x =>
          x.trig &&
          (!x.s.reaction?.weaknessFamily || x.s.reaction.weaknessFamily === family) &&
          this._meetsReqs(owner, x.s) &&
          (DevFlags.isNoCooldownEnabled() || !this.scene?._isSkillOnCooldown?.(owner, x.s.id))
        )
        .sort((a, b) => (b.trig.priority || 0) - (a.trig.priority || 0));

      if (!candidates.length) continue;
      const chosen = candidates[0].s;

      if (typeof chosen?.reaction?.canTrigger === 'function') {
        const ok = chosen.reaction.canTrigger({
          owner, attacker: null, target: unit, scene: this.scene,
          event: 'weakness_tier_cross', family, newTier, oldTier,
        });
        if (!ok) continue;
      }

      this._fireReaction({
        owner,
        attacker: null,
        target: unit,
        reactSkill: chosen,
        evt: 'weakness_tier_cross',
        incomingMutable: null,
        sourceAbility: null,
        sourceIntent: null,
      });

      st.triggersRemaining = Math.max(0, (st.triggersRemaining | 0) - 1);
      return; // one reactor fires per crossing, same stop-at-first-success shape as checkPreHit
    }
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
