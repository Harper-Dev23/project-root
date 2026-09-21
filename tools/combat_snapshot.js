// tools/combat_snapshot.js
//
// Golden-master snapshot of the combat engine, taken by running the REAL
// engine headless. Sibling to tools/weakness_snapshot.js, same workflow.
//
// WHY THIS EXISTS
// ---------------
// Every balance change so far has been checked by reading code and by playing
// the game. Both miss the same thing: a change to one skill quietly moving a
// number in an unrelated one. The Shattering Cut / Overhead Hew question - does
// a skill's own hit benefit from the armour shred it applies? - took a
// stack-order argument to settle, and the answer was the opposite of what had
// been asserted. A recorded fingerprint per skill turns that whole class of
// question into a diff.
//
// It runs `src/scenes/CombatScene.js` itself against a fake `this`
// (tools/headless/). No production file is modified, imported differently, or
// re-implemented here.
//
// WHAT IS RECORDED
//   skills       one fingerprint per castable player weapon skill on the six
//                current weapon types, cast twice: once at a CLEAN target and
//                once at a LOADED one (every weakness family at 250, i.e. Tier
//                2 with overflow) so consumers actually have something to eat.
//   reactions    each weapon reaction armed on a defender and then genuinely
//                provoked. Reactions cannot be cast - they define `exec`, not
//                `apply`, and ReactionSystem dispatches them - so each one is
//                set off through its own declared trigger. See measureReaction.
//   enemySkills  the same treatment for every enemy skill in the six scripted
//                encounters, cast by an enemy who actually carries it.
//   fights       each encounter run start to finish by the engine's own turn
//                loop and its own AI, recorded as final board state.
//
// THE BAG IS DELIBERATELY ARTIFICIAL. Targets are given a fixed, declared
// maxHP (see BAG_HP) so nothing dies mid-measurement and every number stays
// comparable run to run. Percent-of-max-HP effects are therefore measured
// against that declared number, not against a real enemy's. This snapshot
// answers "did this change?", not "is this balanced?".
//
// A refusal is RECORDED, not skipped. "The engine refuses this, and here is
// what it said" is exactly the kind of thing that regresses silently, and a
// snapshot of only the successes would never notice a gate breaking.
//
// USAGE
//   node tools/combat_snapshot.js                    print the report
//   node tools/combat_snapshot.js --json out.json    write a diffable snapshot
//   node tools/combat_snapshot.js --diff old.json    compare against one
//   node tools/combat_snapshot.js --skill power_stab print one skill's detail
//
// The stray "Saved -> autosave" lines are real: winning a fight makes the
// engine autosave, into the throwaway localStorage the stub installs. Engine
// output is deliberately not muted, since muting it would also hide warnings.
//
// The intended workflow for any combat change:
//   1. --json before.json      (no code changes yet)
//   2. make the change
//   3. --diff before.json      every delta must be intentional
//
// The committed baseline lives at tools/snapshots/combat-golden.json.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { installPhaserStub, seed } from './headless/phaserStub.js';
installPhaserStub(20260908);

const { createCombatHost } = await import('./headless/combatHost.js');
const { makeParty, slotMapFor, HUNTERS, BASE_WEAPON } = await import('./headless/fixtures.js');
const { cast, runFight, snapshotBoard, setActor } = await import('./headless/fight.js');
const { SKILLS } = await import('../data/skills.js');
const { COMBAT_SCENARIOS } = await import('../data/combatScenarios.js');
const { ENEMY_TYPES } = await import('../data/enemyTypes.js');
const { rollLoadout, fightScenario } = await import('../src/systems/HuntBeasts.js');
const CombatSceneMod = await import('../src/scenes/CombatScene.js');
const CombatScene = CombatSceneMod.default
  || Object.values(CombatSceneMod).find(v => typeof v === 'function');

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants of the rig. Changing any of these invalidates the whole baseline,
// which is why they are named and gathered here rather than inlined.
// ---------------------------------------------------------------------------
const SEED = 20260908;
const BAG_HP = 5000;        // survives any single skill, so nothing dies mid-measure
const LOADED_METER = 250;   // Tier 2 plus overflow: consumers have something to eat
const GAUGE = 100;          // full Initiative Gauge, so gauge spenders can spend
const RIG_SCENARIO = 'training_encounter_1';  // six targets, slots 2-7

// Only these six are current. Every other weapon's skills are outdated and are
// deliberately NOT measured - recording them would imply they are maintained.
const CURRENT_WEAPONS = ['sword_1h', 'dagger', 'staff', 'mace_2h', 'bow', 'axe_2h'];

const FIGHTS = [
  'training_encounter_1', 'training_encounter_2', 'training_encounter_3',
  'training_encounter_4', 'training_encounter_5', 'training_encounter_6',
];

const COLUMN_SLOTS = { front: [1, 2, 3], mid: [4, 5], back: [6, 7, 8] };

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/** A fresh board: real party, real enemies, targets inflated into punching bags. */
function buildRig() {
  seed(SEED);
  const host = createCombatHost(CombatScene);
  const party = makeParty();
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId: RIG_SCENARIO });

  for (const foe of host.enemies) {
    foe.maxHP = BAG_HP;
    foe.currentHP = BAG_HP;
  }
  for (const ally of party) {
    ally.initiativeGauge = GAUGE;
    ally.currentMP = ally.maxMP;
    ally.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
  }
  return { host, party };
}

/** Loads every weakness family on a unit to LOADED_METER, tiers included. */
function loadWeaknesses(unit) {
  const meters = unit.weakness?.meters;
  if (!meters) return;
  for (const fam of Object.keys(meters)) {
    meters[fam] = LOADED_METER;
    if (unit.weakness.tiers) unit.weakness.tiers[fam] = 2;
  }
}

/**
 * Puts a character in a slot of the given column, swapping with whoever is
 * there. Setup only - it writes the same three fields _assignCharToSlot does
 * and nothing else, so no movement rules, zones or reactions fire. Needed
 * because a positionRequirement would otherwise refuse most of a weapon's kit
 * purely because of where its fixture hunter happens to start.
 */
function placeInColumn(host, char, column) {
  if (host._getUnitColumn(char) === column) return true;
  const wanted = COLUMN_SLOTS[column];
  if (!wanted) return false;

  const target = host.allySlots.find(s => wanted.includes(s.slotId) && !s.occupied)
    || host.allySlots.find(s => wanted.includes(s.slotId));
  if (!target) return false;

  const from = char._slot;
  const other = target.char;

  target.char = char; target.occupied = true; char._slot = target;
  if (from) {
    from.char = other || null;
    from.occupied = !!other;
    if (other) other._slot = from;
  }
  return true;
}

/** The hunter who can actually wield this skill, or null if none of the six can. */
function casterFor(party, skill) {
  const req = skill.requiredWeapon;
  if (!req || !req.length) return party[0];
  const type = req.find(t => CURRENT_WEAPONS.includes(t));
  if (!type) return null;
  const spec = HUNTERS.find(h => h.weaponType === type);
  return party.find(c => c.name === spec?.name) || null;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const meterDelta = (before, after) => {
  const out = [];
  for (const fam of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = Math.round((after[fam] || 0) - (before[fam] || 0));
    if (d !== 0) out.push(fam + (d > 0 ? '+' : '') + d);
  }
  return out.sort();
};

/**
 * Casts one skill once and returns a flat, diffable fingerprint string.
 *
 * A refusal is recorded, not skipped: "the engine refuses this and says why"
 * is exactly the kind of thing that regresses silently, and a snapshot of only
 * the successes would never notice a gate breaking.
 */
function measureSkill(skillId, { loaded }) {
  const skill = SKILLS[skillId];
  const { host, party } = buildRig();
  const caster = casterFor(party, skill);
  if (!caster) return 'SKIPPED no current weapon wields it';

  if (skill.positionRequirement?.length) {
    placeInColumn(host, caster, skill.positionRequirement[0]);
  }

  const foes = host.enemies;
  if (loaded) foes.forEach(loadWeaknesses);

  // Resolve the target the same way cast() will, so the meter reading below is
  // taken on the unit that actually gets hit. Preferring slot 2 keeps the
  // measurement stable, but a skill whose shape excludes slot 2 (Crescent
  // Cleave's arc, the column skills) must still be measured somewhere real
  // rather than recorded as a refusal that says nothing about the skill.
  setActor(host, caster);
  const valid = host._validTargetsFor(caster, skill) || [];
  const bag = valid.find(s => s.slotId === 2)?.char || valid[0]?.char
    || foes.find(f => f._slot?.slotId === 2) || foes[0];

  const hpBefore = foes.map(f => f.currentHP);
  const allyHpBefore = party.map(a => a.currentHP);
  const metersBefore = { ...(bag.weakness?.meters || {}) };
  const mpBefore = caster.currentMP;
  const gaugeBefore = caster.initiativeGauge || 0;
  const logBefore = host.combatEntries.length;

  let res;
  try {
    res = cast(host, caster, skill, bag);
  } catch (e) {
    return 'THREW ' + e.constructor.name + ': ' + String(e.message).split('\n')[0].slice(0, 90);
  }

  if (!res.ok) return 'refused: ' + res.reason;

  const dmg = hpBefore.reduce((s, hp, i) => s + (hp - foes[i].currentHP), 0);
  const hits = hpBefore.filter((hp, i) => hp !== foes[i].currentHP).length;
  const selfDmg = allyHpBefore.reduce((s, hp, i) => s + (hp - party[i].currentHP), 0);
  const metersAfter = { ...(bag.weakness?.meters || {}) };
  const effects = (bag.statusEffects || []).map(e => e.id).sort();
  const selfEffects = (caster.statusEffects || []).map(e => e.id).sort();
  const cd = caster.cooldowns?.[skillId] || 0;

  const parts = [
    'dmg=' + dmg,
    'targets=' + hits,
    'mp=' + (caster.currentMP - mpBefore),
    'gauge=' + ((caster.initiativeGauge || 0) - gaugeBefore),
    'cd=' + cd,
  ];
  if (selfDmg) parts.push('selfHP=' + -selfDmg);
  const dm = meterDelta(metersBefore, metersAfter);
  if (dm.length) parts.push('meters[' + dm.join(' ') + ']');
  if (effects.length) parts.push('onTarget[' + effects.join(' ') + ']');
  if (selfEffects.length) parts.push('onSelf[' + selfEffects.join(' ') + ']');
  parts.push('log=' + (host.combatEntries.length - logBefore));

  return parts.join(' ');
}

/** Is this a current-weapon player skill at all? */
function isCurrentWeaponSkill(s) {
  return !!s && s.type === 'weapon' && !s.enemyOnly && !s.disabled && !s.hidden &&
    (!s.requiredWeapon?.length || s.requiredWeapon.some(w => CURRENT_WEAPONS.includes(w)));
}

/**
 * Every current-weapon player skill that can be CAST, in a stable order.
 *
 * Reactions are excluded here and measured separately below. They are not
 * castable at all: a reaction defines `exec` and is dispatched by
 * ReactionSystem when its trigger fires, so pushing one through
 * _applyAbilityToTarget only produces "ability.apply is not a function" -
 * an artefact of the harness, not a fact about the skill.
 */
function currentWeaponSkillIds() {
  return Object.entries(SKILLS)
    .filter(([, s]) => isCurrentWeaponSkill(s) && s.mechanic !== 'reaction')
    .map(([id]) => id)
    .sort();
}

/** The reaction half of the same set. */
function reactionSkillIds() {
  return Object.entries(SKILLS)
    .filter(([, s]) => isCurrentWeaponSkill(s) && s.mechanic === 'reaction')
    .map(([id]) => id)
    .sort();
}

function collectSkills() {
  const out = {};
  for (const id of currentWeaponSkillIds()) {
    out[id + ' @clean'] = measureSkill(id, { loaded: false });
    out[id + ' @loaded'] = measureSkill(id, { loaded: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reactions
//
// A reaction cannot be cast, so it is measured the way it actually happens:
// arm it on a defender, refresh their trigger budget, then have a real enemy
// hit them with a real enemy skill and record what came back. This exercises
// the whole path - the bus, isReactableAttackSource, the prepared pool, each
// reaction's own canTrigger - which is the half of the reaction system that
// has produced real bugs (the fall-through fix, the missing `target` argument).
// ---------------------------------------------------------------------------

// Unlike a cast, a reaction's stat gate is enforced at DISPATCH time, inside
// ReactionSystem._meetsReqs. The fixture hunters are built around their own
// weapon's primary stat, so most of them fail their weapon's reaction gate on
// the off-stat it asks for - Riposte wants DEX proficiency 8 and the sword
// hunter has 4. That is the gate working correctly, but it would leave this
// whole section recording nothing but "did not fire".
//
// So the measurement runs with the game's own Breakthrough dev flag, which
// _meetsReqs already honours by design (it was fixed specifically so a
// reaction prepared under Breakthrough could actually fire). It is recorded in
// meta, because it means this section measures BEHAVIOUR, not availability.
const REACTION_SCENARIO = 'training_encounter_3';  // fully modernized attackers
const PROVOKER_SKILL = 'fighter_heavy_slash';
const REACTIONS_USE_BREAKTHROUGH = true;

/**
 * Sets up a reaction on a defender and then provokes it the way the game does.
 *
 * The provocation is chosen from the reaction's OWN declared trigger, because
 * the triggers in use reach ReactionSystem by six different routes:
 *
 *   self_hit               an enemy attacks the defender
 *   pre_hit                the same attack, caught earlier via checkPreHit
 *   ally_hit               an enemy attacks one of the defender's teammates
 *   ally_projectile_used   a teammate uses a projectile skill
 *   weakness_tier_cross    something the defender does pushes a foe over T1
 *   reaction_fired         another of the defender's reactions just fired
 *
 * Even within one trigger the conditions differ sharply - Bone Notch wants a
 * RANGED hit, Covering Arc a PROJECTILE one, Bedrock Guard a SPLASH one,
 * Aftershock a quake zone already under the attacker, Practiced Eye an
 * attacker who is already weakened. Rather than hand-pick a provocation per
 * skill - which would go stale the moment one of those conditions changed -
 * this searches the real skills present on the board and records WHICH one
 * worked, as `via=`. A reaction that fires for no provocation at all is then
 * a genuine finding rather than an artefact of a thin rig.
 */

/** Every enemy skill actually on the board, as candidate provocations. */
function enemyProvocations(host) {
  const out = [];
  for (const enemy of host.enemies) {
    for (const id of (enemy.skills || [])) {
      const s = SKILLS[id];
      if (!s || typeof s.apply !== 'function') continue;
      out.push({ id, skill: s, attacker: enemy });
    }
  }
  return out;
}

function measureReaction(skillId) {
  const skill = SKILLS[skillId];
  const trigger = skill?.reaction?.trigger
    || (Array.isArray(skill?.triggers) ? skill.triggers[0]?.event : null);

  /**
   * A fresh board with the reaction armed.
   *
   * The provoking side is deliberately pre-weakened to LOADED_METER: several
   * reactions gate on the ATTACKER carrying a weakness (Practiced Eye answers
   * only an already-weakened foe), and against a clean attacker that condition
   * can never be met, so those entries would record silence and mean nothing.
   */
  const setup = () => {
    seed(SEED);
    const host = createCombatHost(CombatScene);
    const party = makeParty();
    host.__begin({ party, partySlots: slotMapFor(party), scenarioId: REACTION_SCENARIO });

    const defender = casterFor(party, skill);
    if (!defender) return null;

    for (const ally of party) {
      ally.maxHP = BAG_HP;
      ally.currentHP = BAG_HP;
      ally.currentMP = ally.maxMP;
      ally.initiativeGauge = GAUGE;
      ally.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
    }
    for (const foe of host.enemies) {
      foe.maxHP = BAG_HP;
      foe.currentHP = BAG_HP;
      loadWeaknesses(foe);
    }

    host.reactions.arm(defender, skill);
    host.reactions.onTurnStart(defender);
    return { host, party, defender };
  };

  /**
   * Fires `provoke` and reports what the armed reaction did.
   *
   * "Did it fire?" is read from the TRIGGER BUDGET, not from the log text.
   * Matching on the skill's name looked obvious and was wrong: Sidestep's own
   * line is "Sable slips aside - Doug Longshot's Covering Shot is thrown
   * wide", which never says "Sidestep", so a working reaction was recorded as
   * dead. Every firing path - _onEvent and _checkReactionResponders alike -
   * spends one trigger, so that is the one signal every reaction shares.
   */
  const observe = (rig, provoke, via) => {
    const { host, defender } = rig;
    const foeHpBefore = host.enemies.map(e => e.currentHP);
    const defHpBefore = defender.currentHP;
    const mpBefore = defender.currentMP;
    const logBefore = host.combatEntries.length;
    const triggersBefore = defender.reaction?.triggersRemaining ?? 0;

    try {
      provoke();
      host.__drain();
    } catch (e) {
      return {
        fired: false,
        text: 'THREW ' + e.constructor.name + ': ' + String(e.message).split('\n')[0].slice(0, 90),
      };
    }

    const lines = host.__logLines().slice(logBefore);
    const triggersAfter = defender.reaction?.triggersRemaining ?? 0;
    const fired = triggersAfter < triggersBefore
      || (defender.cooldowns?.[skillId] || 0) > 0
      || lines.some(l => l.includes(skill.name));
    const toFoes = foeHpBefore.reduce((sum, hp, i) => sum + (hp - host.enemies[i].currentHP), 0);

    const parts = [fired ? 'FIRED' : 'did not fire', 'trigger=' + trigger];
    if (via) parts.push('via=' + via);
    parts.push(
      'toFoes=' + toFoes,
      'took=' + (defHpBefore - defender.currentHP),
      'mp=' + (defender.currentMP - mpBefore),
      'cd=' + (defender.cooldowns?.[skillId] || 0),
      'log=' + lines.length
    );
    return { fired, text: parts.join(' ') };
  };

  /** Runs an enemy skill at whoever pickVictim names. */
  const hitWith = (rig, prov, pickVictim) => () => {
    rig.host.currentTurnIndex = rig.host.turnOrder.indexOf(prov.attacker);
    rig.host._applyAbilityToTarget(prov.attacker, pickVictim(rig), prov.skill);
  };

  // --- the three hit-driven triggers ---------------------------------------
  if (trigger === 'self_hit' || trigger === 'pre_hit' || trigger === 'ally_hit') {
    const pickVictim = trigger === 'ally_hit'
      ? (rig) => rig.party.find(c => c !== rig.defender)
      : (rig) => rig.defender;

    const probe = setup();
    if (!probe) return 'SKIPPED no current weapon wields it';
    const provs = enemyProvocations(probe.host);
    if (!provs.length) return 'SKIPPED no provoking attacker on the board';

    let lastText = null;
    // Pass 1: each enemy skill on its own, aimed at the defender.
    for (const prov of provs) {
      const rig = setup();
      const out = observe(rig, hitWith(rig, prov, pickVictim), prov.id);
      if (out.fired) return out.text;
      if (out.text.startsWith('did not fire')) lastText = out.text;
    }

    // Pass 1b: aimed at a TEAMMATE, so the defender is caught in the splash
    // rather than being the chosen target. Bedrock Guard needs exactly this -
    // it gates on `sourceIntent.isSplash`, and that flag is only set by the
    // splash emit path (CombatScene.js:7751). A defender who is the primary
    // target is hit through _applyAbilityToTarget instead, where isSplash is
    // never true, so no directly-aimed attack of any kind can provoke it.
    if (trigger === 'self_hit' || trigger === 'pre_hit') {
      for (const prov of provs) {
        for (let i = 0; i < 3; i++) {
          const rig = setup();
          const mates = rig.party.filter(c => c !== rig.defender);
          const mate = mates[i];
          if (!mate) break;
          const out = observe(rig, hitWith(rig, prov, () => mate), prov.id + ' splashing off ' + mate.name);
          if (out.fired) return out.text;
        }
      }
    }

    // Pass 2: the defender first sets something up with their own kit, then
    // takes the hit. This is what Aftershock needs - it answers a hit only
    // when a quake zone is already under the attacker, so no bare enemy swing
    // could ever provoke it.
    const kit = (probe.defender.skills || [])
      .filter(s => s.type === 'weapon' && !s.hidden && typeof s.apply === 'function')
      .map(s => s.id);
    for (const setupId of kit) {
      for (const prov of provs.slice(0, 4)) {
        const rig = setup();
        const setupSkill = (rig.defender.skills || []).find(s => s.id === setupId);
        const pre = cast(rig.host, rig.defender, setupSkill, prov.attacker.name);
        if (!pre.ok) break;   // this setup skill cannot be used at all
        rig.defender.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
        const out = observe(rig, hitWith(rig, prov, pickVictim), setupId + ' + ' + prov.id);
        if (out.fired) return out.text;
      }
    }
    return lastText || ('did not fire trigger=' + trigger);
  }

  // --- ally_projectile_used: a teammate throws something --------------------
  if (trigger === 'ally_projectile_used') {
    const probe = setup();
    if (!probe) return 'SKIPPED no current weapon wields it';
    let lastText = null;
    for (const mate of probe.party) {
      if (mate === probe.defender) continue;
      const shots = (mate.skills || []).filter(s =>
        (s.tags || []).includes('projectile') && s.requiresTarget && !s.hidden);
      for (const shot of shots) {
        const rig = setup();
        const freshMate = rig.party.find(c => c.name === mate.name);
        const out = observe(rig, () => {
          cast(rig.host, freshMate, shot, rig.host.enemies[0]);
        }, shot.id);
        if (out.fired) return out.text;
        if (out.text.startsWith('did not fire')) lastText = out.text;
      }
    }
    return lastText || ('did not fire trigger=' + trigger + ' (no projectile skill in the party)');
  }

  // --- weakness_tier_cross: the defender pushes a foe over a tier line ------
  // Each of these reactions watches a specific family, so every meter is
  // parked one point under T1 and the defender's own kit is tried until one of
  // its skills crosses the line this reaction is waiting on.
  if (trigger === 'weakness_tier_cross') {
    const probe = setup();
    if (!probe) return 'SKIPPED no current weapon wields it';
    const kit = (probe.defender.skills || [])
      .filter(s => s.type === 'weapon' && s.requiresTarget && !s.hidden && s.buildupHint)
      .map(s => s.id);

    let lastText = null;
    let resolved = 0;
    for (const id of kit) {
      const rig = setup();
      const skillObj = (rig.defender.skills || []).find(s => s.id === id);
      const foe = rig.host.enemies[0];
      // One point under T2, not T1. _onWeaknessTierChanged only emits
      // weakness_tier_cross on `newTier === 2 && oldTier < 2`, so a crossing
      // into T1 raises no event at all - parking the meters at 99 made this
      // whole branch measure nothing, and the one reaction that did fire only
      // did so because its provoking skill happened to add enough buildup to
      // clear both tiers in a single hit.
      for (const fam of Object.keys(foe.weakness?.meters || {})) {
        foe.weakness.meters[fam] = 199;
        if (foe.weakness.tiers) foe.weakness.tiers[fam] = 1;
      }
      // Refusals are not evidence about the reaction - a consumer skill the
      // caster cannot afford or is not weakened enough to use never reaches
      // the tier line at all - so only casts that actually resolved count as
      // an attempt, and only they are eligible to be the recorded result.
      let ok = false;
      const out = observe(rig, () => { ok = cast(rig.host, rig.defender, skillObj, foe).ok; }, id);
      if (out.fired) return out.text;
      if (ok) { resolved++; lastText = out.text; }
    }
    return lastText
      ? lastText + ' (tried ' + resolved + ' of the kit)'
      : ('did not fire trigger=' + trigger + ' (nothing in the kit could be cast: ' + kit.length + ' tried)');
  }

  // --- reaction_fired: chained off an ENEMY's reaction ----------------------
  //
  // The obvious reading - "my other reaction went off" - is wrong, and the rig
  // measured nothing until that was checked against the code. _onReactionFired
  // skips the parent's own owner outright (`responder === parentOwner`) and
  // then gates on `respondsTo`, which defaults to 'enemy'. So Sidestep answers
  // an OPPOSING unit's reaction: the rig has to arm a reaction on an enemy,
  // set THAT off, and watch the defender chain off it.
  if (trigger === 'reaction_fired') {
    const probe = setup();
    if (!probe) return 'SKIPPED no current weapon wields it';

    // Enemies carry their reactions in their skill list but only ARM them
    // through their AI profile, which never runs here - so arm them directly.
    const enemyReactors = [];
    for (const enemy of probe.host.enemies) {
      for (const id of (enemy.skills || [])) {
        if (SKILLS[id]?.mechanic === 'reaction') enemyReactors.push({ enemyName: enemy.name, id });
      }
    }
    if (!enemyReactors.length) return 'SKIPPED no enemy on this board carries a reaction';

    const kit = (probe.defender.skills || [])
      .filter(s => s.type === 'weapon' && s.requiresTarget && !s.hidden && typeof s.apply === 'function')
      .map(s => s.id);

    let lastText = null;
    for (const reactor of enemyReactors) {
      for (const attackId of kit) {
        const rig = setup();
        const enemy = rig.host.enemies.find(e => e.name === reactor.enemyName);
        const parent = SKILLS[reactor.id];
        enemy.reactionTriggers = 2;
        rig.host.reactions.arm(enemy, parent);
        rig.host.reactions.onTurnStart(enemy);

        const attack = (rig.defender.skills || []).find(s => s.id === attackId);
        let ok = false;
        const out = observe(rig, () => { ok = cast(rig.host, rig.defender, attack, enemy).ok; },
          reactor.id + ' + ' + attackId);
        if (out.fired) return out.text;
        if (ok) lastText = out.text;
      }
    }
    return lastText || ('did not fire trigger=' + trigger + ' (nothing could be cast at a reactor)');
  }

  // --- unreachable: kept only so an unhandled trigger is loud ---------------
  if (trigger === '__never__') {
    const probe = setup();
    if (!probe) return 'SKIPPED no current weapon wields it';
    // The primary must be a reaction the SAME defender can actually wield -
    // arming one their weapon forbids would be provoking nothing. Its own
    // trigger then decides how to set it off, which is why both provocation
    // styles are tried: the dagger's only other reaction is Carrion Strike,
    // and that answers a tier crossing, not a hit.
    const primaries = reactionSkillIds().filter(id =>
      id !== skillId && casterFor(probe.party, SKILLS[id])?.name === probe.defender.name);
    const provs = enemyProvocations(probe.host);

    const armBoth = (rig, primaryId) => {
      rig.defender.reactionCapacity = 2;
      rig.defender.reactionTriggers = 2;
      rig.host.reactions.arm(rig.defender, SKILLS[primaryId]);
      rig.host.reactions.onTurnStart(rig.defender);
    };

    let lastText = null;
    for (const primaryId of primaries) {
      const primaryTrigger = SKILLS[primaryId]?.reaction?.trigger;

      if (primaryTrigger === 'weakness_tier_cross') {
        const kit = (probe.defender.skills || [])
          .filter(s => s.type === 'weapon' && s.requiresTarget && !s.hidden && s.buildupHint)
          .map(s => s.id);
        for (const id of kit) {
          const rig = setup();
          armBoth(rig, primaryId);
          const skillObj = (rig.defender.skills || []).find(s => s.id === id);
          const foe = rig.host.enemies[0];
          for (const fam of Object.keys(foe.weakness?.meters || {})) {
            foe.weakness.meters[fam] = 199;   // one under T2; see the note above
            if (foe.weakness.tiers) foe.weakness.tiers[fam] = 1;
          }
          let ok = false;
          const out = observe(rig, () => { ok = cast(rig.host, rig.defender, skillObj, foe).ok; },
            primaryId + ' + ' + id);
          if (out.fired) return out.text;
          if (ok) lastText = out.text;
        }
        continue;
      }

      for (const prov of provs.slice(0, 6)) {
        const rig = setup();
        armBoth(rig, primaryId);
        const out = observe(rig, hitWith(rig, prov, r => r.defender), primaryId + ' + ' + prov.id);
        if (out.fired) return out.text;
        if (out.text.startsWith('did not fire')) lastText = out.text;
      }
    }
    return lastText || ('did not fire trigger=' + trigger +
      ' (no other reaction this defender can wield: ' + primaries.length + ')');
  }

  return 'SKIPPED unhandled trigger: ' + trigger;
}

function collectReactions() {
  const out = {};
  const restore = localStorage.getItem('dev_breakthrough');
  if (REACTIONS_USE_BREAKTHROUGH) localStorage.setItem('dev_breakthrough', 'true');
  try {
    for (const id of reactionSkillIds()) out[id] = measureReaction(id);
  } finally {
    if (restore == null) localStorage.removeItem('dev_breakthrough');
    else localStorage.setItem('dev_breakthrough', restore);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Enemy skills
//
// The player matrix alone leaves a real hole. Perturbing an enemy skill's
// damage by 15 percentage points while testing this tool produced NO diff at
// all: nothing measured it. Enemy kits are where a lot of recent work has gone
// (encounters 3 through 6 were each modernized onto the typed pipeline), so
// they get the same treatment - each enemy skill cast by an enemy who actually
// carries it, at a party member turned into a punching bag.
//
// Every roster is walked, not just one, because an enemy skill only exists in
// the scenarios that place its owner.
// ---------------------------------------------------------------------------

const ENEMY_ROSTERS = FIGHTS;

/** Every (scenario, enemy, skill) triple in the scripted encounters. */
function enemySkillIndex() {
  const seen = new Map();   // skillId -> { scenarioId, enemyName }
  for (const scenarioId of ENEMY_ROSTERS) {
    const scenario = COMBAT_SCENARIOS[scenarioId];
    for (const cfg of (scenario?.enemies || [])) {
      const template = ENEMY_TYPES[cfg.type];
      for (const id of (template?.skills || [])) {
        if (!SKILLS[id] || seen.has(id)) continue;
        seen.set(id, { scenarioId, enemyName: cfg.name || template.name || cfg.type });
      }
    }
  }
  return seen;
}

function measureEnemySkill(skillId, where, { loaded }) {
  const skill = SKILLS[skillId];
  if (skill.mechanic === 'reaction') return 'SKIPPED reaction - dispatched, not cast';

  seed(SEED);
  const host = createCombatHost(CombatScene);
  const party = makeParty();
  host.__begin({ party, partySlots: slotMapFor(party), scenarioId: where.scenarioId });

  const caster = host.enemies.find(e => e.name === where.enemyName);
  if (!caster) return 'SKIPPED its owner is not on the board';
  caster.currentMP = caster.maxMP;
  caster.actionsLeft = { major: 1, bonus: 1, class: 1, reaction: 1 };
  // A full gauge, as player skills get. Without it every enemy gauge spender
  // (Coordinated Volley, Molt, Huntmaster's Mark) was recorded as a fizzle, so
  // the snapshot could not see anything they do.
  caster.initiativeGauge = GAUGE;

  for (const ally of party) {
    ally.maxHP = BAG_HP;
    ally.currentHP = BAG_HP;
    ally.currentMP = ally.maxMP;
    if (loaded) loadWeaknesses(ally);
  }
  // A healer's kit only shows its numbers on someone who is actually hurt.
  for (const foe of host.enemies) {
    foe.maxHP = BAG_HP;
    foe.currentHP = Math.floor(BAG_HP / 2);
    if (loaded) loadWeaknesses(foe);
  }
  caster.currentHP = Math.floor(BAG_HP / 2);

  const bag = party.find(c => c._slot?.slotId === 1) || party[0];
  const allyHpBefore = party.map(a => a.currentHP);
  const foeHpBefore = host.enemies.map(e => e.currentHP);
  const metersBefore = { ...(bag.weakness?.meters || {}) };
  const mpBefore = caster.currentMP;
  const gaugeBefore = caster.initiativeGauge || 0;
  const logBefore = host.combatEntries.length;

  try {
    host.currentTurnIndex = host.turnOrder.indexOf(caster);
    host._applyAbilityToTarget(caster, bag, skill);
    host.__drain();
  } catch (e) {
    return 'THREW ' + e.constructor.name + ': ' + String(e.message).split('\n')[0].slice(0, 90);
  }

  const dmg = allyHpBefore.reduce((s, hp, i) => s + (hp - party[i].currentHP), 0);
  const hits = allyHpBefore.filter((hp, i) => hp !== party[i].currentHP).length;
  const healed = host.enemies.reduce((s, e, i) => s + (e.currentHP - foeHpBefore[i]), 0);

  const parts = [
    'dmg=' + dmg,
    'targets=' + hits,
    'mp=' + (caster.currentMP - mpBefore),
    'cd=' + (caster.cooldowns?.[skillId] || 0),
  ];
  if (healed) parts.push('healedOwnSide=' + healed);
  const gaugeSpent = (caster.initiativeGauge || 0) - gaugeBefore;
  if (gaugeSpent) parts.push('gauge=' + gaugeSpent);
  const dm = meterDelta(metersBefore, { ...(bag.weakness?.meters || {}) });
  if (dm.length) parts.push('meters[' + dm.join(' ') + ']');
  const onBag = (bag.statusEffects || []).map(e => e.id).sort();
  if (onBag.length) parts.push('onTarget[' + onBag.join(' ') + ']');
  const onSelf = (caster.statusEffects || []).map(e => e.id).sort();
  if (onSelf.length) parts.push('onSelf[' + onSelf.join(' ') + ']');
  parts.push('log=' + (host.combatEntries.length - logBefore));
  return parts.join(' ');
}

function collectEnemySkills() {
  const out = {};
  const index = enemySkillIndex();
  for (const id of [...index.keys()].sort()) {
    const where = index.get(id);
    out[id + ' @clean'] = measureEnemySkill(id, where, { loaded: false });
    out[id + ' @loaded'] = measureEnemySkill(id, where, { loaded: true });
  }
  return out;
}

/**
 * A whole fight, driven by the engine's own turn loop and its own AI, with the
 * party on the simplest possible policy: Basic Attack the first standing foe.
 * A fixed policy is the point - it is a control, so a change in the result is a
 * change in the ENGINE, not in the tactics.
 */
function collectFights() {
  const out = {};
  for (const scenarioId of FIGHTS) {
    seed(SEED);
    const host = createCombatHost(CombatScene);
    const party = makeParty();
    try {
      host.__begin({ party, partySlots: slotMapFor(party), scenarioId });
      const r = runFight(host, (h, actor) => {
        const atk = (actor.skills || []).find(s => s.id === 'basic_attack');
        const foe = h.enemies.find(e => e.status !== 'incapacitated' && e.currentHP > 0);
        return (atk && foe) ? [{ ability: atk, target: foe }] : [];
      }, { maxTurns: 600 });

      const snap = snapshotBoard(host);
      const alliesUp = snap.allies.filter(a => a.hp > 0).length;
      const foesUp = snap.enemies.filter(e => e.hp > 0).length;
      out[scenarioId] = [
        (foesUp === 0 ? 'WIN' : alliesUp === 0 ? 'LOSS' : 'UNRESOLVED'),
        'turns=' + r.turns,
        'round=' + r.round,
        'allies=' + alliesUp + '/' + snap.allies.length,
        'foes=' + foesUp + '/' + snap.enemies.length,
        'allyHP=' + snap.allies.map(a => a.hp).join('/'),
        'foeHP=' + snap.enemies.map(e => e.hp).join('/'),
        'log=' + host.combatEntries.length,
      ].join(' ');
    } catch (e) {
      out[scenarioId] = 'THREW ' + String(e.message).split('\n')[0].slice(0, 120);
    }
  }
  return out;
}

function collect() {
  return {
    meta: {
      seed: SEED,
      bagHP: BAG_HP,
      loadedMeter: LOADED_METER,
      gauge: GAUGE,
      rigScenario: RIG_SCENARIO,
      reactionScenario: REACTION_SCENARIO,
      reactionProvoker: PROVOKER_SKILL,
      reactionsUseBreakthrough: REACTIONS_USE_BREAKTHROUGH,
      weapons: CURRENT_WEAPONS,
      party: HUNTERS.map(h => h.name + '/' + h.weaponType + '/' + BASE_WEAPON[h.weaponType]),
    },
    skills: collectSkills(),
    reactions: collectReactions(),
    enemySkills: collectEnemySkills(),
    fights: collectFights(),
    huntFights: collectHuntFights(),
  };
}

/**
 * Map-hunt fights (Exploration v2, chunk 9b): occupants built by hand, their
 * loadouts rolled from a fixed seed (HuntBeasts.rollLoadout), turned into
 * fights by the same HuntBeasts.fightScenario the hunt uses, and run start to
 * finish by the engine's own turn loop with the same Basic Attack control
 * policy as the scripted fights. The hunt is a recorder: what the fight hands
 * back to it (winEncounter's loot, a wipe) is part of the entry. Everything
 * it exercises is gated on huntFight, so no entry above can move with it.
 */
const HUNT_FIGHTS = {
  'stalker pack, party first': { occ: { id: 'o1', kind: 'beast', family: 'marsh_stalker', grades: ['grown', 'grown', 'grown', 'grown'] }, first: 'party' },
  'stalker pack, ambushed':    { occ: { id: 'o1', kind: 'beast', family: 'marsh_stalker', grades: ['grown', 'grown', 'grown', 'grown'] }, first: 'enemy' },
  'great-led pack with parts': { occ: { id: 'o2', kind: 'beast', family: 'tide_crab', grades: ['grown', 'great', 'grown', 'yearling', 'grown'] }, first: 'party' },
  'cultist band':              { occ: { id: 'o3', kind: 'cultist', grades: [null, null, null] }, first: 'party' },
  // Chunk 9c: a fight fed by a "next fight" meal, and a fight fled at once.
  'stalker pack, fed for the fight': { occ: { id: 'o1', kind: 'beast', family: 'marsh_stalker', grades: ['grown', 'grown', 'grown', 'grown'] }, first: 'party',
    foodBuff: { field: 'AttackPower', amount: 10, source: 'ember_pepper', name: 'Ember Pepper' } },
  'stalker pack, fled on the first turn': { occ: { id: 'o1', kind: 'beast', family: 'marsh_stalker', grades: ['grown', 'grown', 'grown', 'grown'] }, first: 'party', flee: true },
};

/** Play a flee's free round out, the way runFight drives enemy turns. */
function playFreeRound(host) {
  for (let i = 0; i < 60 && !host.combatEnded; i++) {
    const before = host.currentTurnIndex;
    host.__drain();
    const c = host._currentChar();
    if (!host.combatEnded && host.currentTurnIndex === before && c?.isEnemy) {
      host._takeEnemyTurn_viaLogic(c);
      host.__drain();
    }
  }
}

function collectHuntFights() {
  const out = {};
  for (const [label, def] of Object.entries(HUNT_FIGHTS)) {
    seed(SEED);
    const host = createCombatHost(CombatScene);
    const party = makeParty();
    const o = def.occ;
    const occ = {
      id: o.id, kind: o.kind, family: o.family || null,
      roster: o.grades.map(g => ({ type: o.kind === 'cultist' ? 'cultist' : o.family, grade: g })),
    };
    occ.loadout = rollLoadout(occ, { itemLevel: 1, itemRarity: 0, seed: 4242 });
    const calls = [];
    const hunt = {
      winEncounter: ({ loot = [] } = {}) => { calls.push('win:' + loot.map(i => i.id + '/' + i.rarity).join(',')); return { ok: true, huntPoints: 0 }; },
      wipe: () => { calls.push('wipe'); return { ok: true }; },
      flee: ({ knockedOut = 0 } = {}) => { calls.push('flee:ko=' + knockedOut); return { ok: true }; },
    };
    const huntFight = {
      hunt, kind: o.kind, first: def.first, itemLevel: 1, xpPool: 20, deathRule: 'sheltered',
      scenario: fightScenario(occ, { itemLevel: 1 }),
      ...(def.foodBuff ? { foodBuff: def.foodBuff } : {}),
    };
    let fled = false;
    try {
      host.__begin({ party, partySlots: slotMapFor(party), huntFight });
      const firstSide = host.turnOrder[0]?.isEnemy ? 'enemy' : 'party';
      const r = runFight(host, (h, actor) => {
        // The flee entry breaks away on the party's first turn and plays the
        // free round out here, so runFight's own endTurn never cuts into it.
        if (def.flee && !fled) { fled = true; h._startFlee(); playFreeRound(h); return []; }
        const atk = (actor.skills || []).find(s => s.id === 'basic_attack');
        const foe = h.enemies.find(e => e.status !== 'incapacitated' && e.currentHP > 0);
        return (atk && foe) ? [{ ability: atk, target: foe }] : [];
      }, { maxTurns: 600 });
      const snap = snapshotBoard(host);
      const alliesUp = snap.allies.filter(a => a.hp > 0).length;
      const foesUp = snap.enemies.filter(e => e.hp > 0).length;
      out[label] = [
        (foesUp === 0 ? 'WIN' : alliesUp === 0 ? 'LOSS' : calls.some(c => c.startsWith('flee')) ? 'FLED' : 'UNRESOLVED'),
        'first=' + firstSide,
        'turns=' + r.turns,
        'round=' + r.round,
        'allies=' + alliesUp + '/' + snap.allies.length,
        'foes=' + foesUp + '/' + snap.enemies.length,
        'foeMaxHP=' + host.enemies.map(e => e.maxHP).join('/'),
        'allyHP=' + snap.allies.map(a => a.hp).join('/'),
        'foeHP=' + snap.enemies.map(e => e.hp).join('/'),
        'hunt=' + (calls.join(';') || 'none'),
        'log=' + host.combatEntries.length,
      ].join(' ');
    } catch (e) {
      out[label] = 'THREW ' + String(e.message).split('\n')[0].slice(0, 120);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const diffIdx = args.indexOf('--diff');
const skillIdx = args.indexOf('--skill');

if (skillIdx !== -1) {
  const id = args[skillIdx + 1];
  if (!SKILLS[id]) {
    console.log('No such skill: ' + id + ' (commented out in skills.js?)');
    process.exit(1);
  }
  for (const loaded of [false, true]) {
    const { host, party } = buildRig();
    const skill = SKILLS[id];
    const caster = casterFor(party, skill);
    console.log('\n=== ' + id + (loaded ? '  @loaded' : '  @clean') + ' ===');
    if (!caster) { console.log('  no current weapon wields it'); continue; }
    if (skill.positionRequirement?.length) placeInColumn(host, caster, skill.positionRequirement[0]);
    const bag = host.enemies.find(f => f._slot?.slotId === 2) || host.enemies[0];
    if (loaded) host.enemies.forEach(loadWeaknesses);
    console.log('  caster: ' + caster.name + ' (' + caster.weaponType + ', ' +
      host._getUnitColumn(caster) + ' row)  MP ' + caster.currentMP + '/' + caster.maxMP);
    console.log('  ' + measureSkill(id, { loaded }));
    const at = host.combatEntries.length;
    cast(host, caster, skill, bag);
    host.__logLines().slice(at).forEach(l => console.log('    | ' + l));
  }
} else if (diffIdx !== -1) {
  const before = JSON.parse(fs.readFileSync(args[diffIdx + 1], 'utf8'));
  const after = collect();
  let n = 0;
  for (const section of ['skills', 'reactions', 'enemySkills', 'fights', 'huntFights']) {
    const keys = new Set([...Object.keys(before[section] || {}), ...Object.keys(after[section] || {})]);
    for (const k of [...keys].sort()) {
      const a = before[section]?.[k], b = after[section]?.[k];
      if (a !== b) {
        console.log('  ' + section + '  ' + k);
        console.log('      was: ' + (a ?? '(absent)'));
        console.log('      now: ' + (b ?? '(absent)'));
        n++;
      }
    }
  }
  for (const k of Object.keys(after.meta)) {
    if (JSON.stringify(before.meta?.[k]) !== JSON.stringify(after.meta[k])) {
      console.log('  meta    ' + k + ': ' + JSON.stringify(before.meta?.[k]) +
        ' -> ' + JSON.stringify(after.meta[k]) + '   (baseline is not comparable)');
      n++;
    }
  }
  console.log(n ? '\n' + n + ' entr(ies) changed. Every one must be intentional.'
    : '\nIDENTICAL - behaviour-neutral.');
  // A change FAILS the run, so npm run verify (which chains on this) stops.
  // Before chunk 9b it only printed: a moved golden passed verify unless
  // someone read this line.
  if (n) process.exit(1);
} else if (jsonIdx !== -1) {
  const out = args[jsonIdx + 1] || path.join(HERE, 'snapshots', 'combat-golden.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(collect(), null, 1));
  console.log('snapshot written to ' + out);
} else {
  const data = collect();
  console.log('COMBAT GOLDEN MASTER   seed ' + data.meta.seed +
    '   bag ' + data.meta.bagHP + ' HP   loaded meters ' + data.meta.loadedMeter + '\n');

  const skills = Object.entries(data.skills);
  const refused = skills.filter(([, v]) => v.startsWith('refused'));
  const threw = skills.filter(([, v]) => v.startsWith('THREW'));
  const skippedSkills = skills.filter(([, v]) => v.startsWith('SKIPPED'));

  console.log('SKILLS  ' + skills.length + ' measurements  (' +
    (skills.length - refused.length - threw.length - skippedSkills.length) + ' resolved, ' +
    refused.length + ' refused, ' + threw.length + ' threw, ' + skippedSkills.length + ' skipped)\n');
  for (const [k, v] of skills) console.log('  ' + k.padEnd(34) + v);

  if (threw.length) {
    console.log('\nTHREW - these are real errors, not measurements:');
    for (const [k, v] of threw) console.log('  ' + k.padEnd(34) + v);
  }

  const es = Object.entries(data.enemySkills);
  const esThrew = es.filter(([, v]) => v.startsWith('THREW'));
  console.log('\n\nENEMY SKILLS  ' + es.length + ' measurements  (' +
    esThrew.length + ' threw)\n');
  for (const [k, v] of es) console.log('  ' + k.padEnd(38) + v);
  if (esThrew.length) {
    console.log('\nTHREW - these are real errors, not measurements:');
    for (const [k, v] of esThrew) console.log('  ' + k.padEnd(38) + v);
  }

  const reactions = Object.entries(data.reactions);
  const firedCount = reactions.filter(([, v]) => v.startsWith('FIRED')).length;
  console.log('\n\nREACTIONS  ' + reactions.length + ' armed and provoked  (' +
    firedCount + ' fired)\n');
  for (const [k, v] of reactions) console.log('  ' + k.padEnd(34) + v);

  console.log('\n\nFIGHTS\n');
  for (const [k, v] of Object.entries(data.fights)) console.log('  ' + k.padEnd(24) + v);
}
