// ReactionSystem.js — Prep-based, scalable reactions
// Supports:
// - Prepare up to `capacity` reactions on your turn (default 2)
// - Between your turns, at most `triggersPerRound` will actually fire (default 1)
// - When one fires, remaining prepared reactions disarm until your next turn
// - Cooldowns start on TRIGGER (not on prep), unless you choose otherwise
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
    st.prepared.length = 0; // disarm old prep
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

    // 2) Only react to WEAPON-origin hits by default (prevents Hide/other buffs)
    const isWeaponSource = ability?.type === 'weapon' || (intent?.tags || []).includes('attack');
    if (!isWeaponSource) return;

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
        !this.scene?._isSkillOnCooldown?.(owner, x.s.id)
      )
      .sort((a, b) => (b.trig.priority || 0) - (a.trig.priority || 0));

    if (!candidates.length && this.defaults?.allowUnpreparedFallback) {
      const legacy = this._getAvailableReactionSkills(owner);
      candidates = legacy
        .map(s => ({ s, trig: getTriggerForEvent(s, evt) }))
        .filter(x =>
          x.trig &&
          this._meetsReqs(owner, x.s) &&
          !this.scene?._isSkillOnCooldown?.(owner, x.s.id)
        )
        .sort((a, b) => (b.trig.priority || 0) - (a.trig.priority || 0));
    }

    if (!candidates.length) return;

    const chosen = candidates[0].s;

    if (typeof chosen?.reaction?.canTrigger === 'function') {
      const ok = chosen.reaction.canTrigger({
        owner, attacker, target, scene: this.scene,
        incoming: incomingMutable, event: evt
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

    // Spend budget & disarm leftovers
    st.triggersRemaining = Math.max(0, (st.triggersRemaining | 0) - 1);
    st.prepared.length = 0;
  }

  _fireReaction({ owner, attacker, reactSkill, evt, incomingMutable, sourceAbility, sourceIntent }) {
    const cooldownOn = reactSkill?.reaction?.cooldownOn || 'trigger';

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
    // stat
    if (s.requiredStat && ((u.totalStats?.[s.requiredStat] || 0) < (s.requiredValue || 0))) return false;

    // weapon
    if (Array.isArray(s.requiredWeapon) && s.requiredWeapon.length) {
      const wType = u.weaponType || u.equipment?.weaponMain?.type || u.equipment?.weaponMain?.weaponType;
      if (!wType || !s.requiredWeapon.includes(wType)) return false;
    }

    // position
    if (Array.isArray(s.positionRequirement) && s.positionRequirement.length) {
      const col = this.scene._getUnitColumn?.(u) || u.position;
      if (!s.positionRequirement.includes(col)) return false;
    }

    return true;
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
