// @ts-nocheck
// tools/headless/fight.js
//
// The driver: what a player's hands do, done in code.
//
// CombatScene's own player entry point, `_useAbility`, is a button handler. It
// checks its gates, then calls `_enterTargetingMode`, which attaches a
// `pointerdown` listener to every valid slot and returns - the ability only
// resolves when a click arrives. There is no click here, so `cast()` below
// walks the same sequence and supplies the target directly.
//
// It is a RE-COMPOSITION, not a reimplementation: every gate calls the engine's
// own predicate (`_canUseActionType`, `_abilityActorGateReason`,
// `_validTargetsFor`, ...) so a rule change lands here automatically. The
// sequence mirrors _useAbility (CombatScene.js:4758) and _enterTargetingMode
// (:4970). If those grow a new gate, add the matching call here - and the
// gate-parity check in verify.mjs exists to make that omission visible.

import { DevFlags } from '../../src/systems/DevFlags.js';
import GameState from '../../src/systems/GameState.js';

/**
 * Starts combat exactly as create() does (CombatScene.js:451-459): index to -1
 * so the bootstrap _advanceTurn lands on 0, then snapshot the round the fight
 * really began on, because that bootstrap counts as a round wrap and leaves
 * combatRound at 2 during the party's first turn.
 */
export function startCombat(host) {
  host.currentTurnIndex = -1;
  host._advanceTurn();
  host._combatStartRound = host.combatRound;
  host.__drain();
  return host;
}

/** Puts `actor` under the turn index so `_currentChar()` resolves to them. */
export function setActor(host, actor) {
  const i = host.turnOrder.indexOf(actor);
  if (i < 0) throw new Error(actor?.name + ' is not in the turn order');
  host.currentTurnIndex = i;
  return i;
}

/**
 * The scripted equivalent of clicking an ability and then clicking a target.
 *
 * Returns a result object rather than throwing on a refusal: "the engine
 * refused this and said why" is a legitimate, interesting outcome for a
 * harness to record, and a golden master that captured only successes would
 * miss every gating regression.
 */
export function cast(host, actor, ability, target = null) {
  const before = host.combatEntries.length;
  const tail = () => host.__logLines().slice(before);

  if (!ability) return { ok: false, reason: 'no such ability', log: tail() };

  setActor(host, actor);

  // A slotId is a convenience this harness accepts and the engine does not,
  // since a bare number is ambiguous across the two sides. Resolve it here.
  let ref = target;
  if (typeof target === 'number') {
    ref = (host.enemySlots.find(s => s.slotId === target && s.char)
      || host.allySlots.find(s => s.slotId === target && s.char))?.char ?? target;
  }

  const verdict = host._resolveAction({ actor, skill: ability, target: ref });
  host.__drain();
  return { ...verdict, log: tail() };
}

/** Ends the current actor's turn the way the End Turn button does. */
export function endTurn(host) {
  host._advanceTurn({ playerEndedTurn: true });
  host.__drain();
  return host._currentChar();
}

/**
 * Runs a whole fight.
 *
 * `plan(host, actor)` is called on each ALLY turn and returns either a list of
 * {ability, target} actions or null to pass. Enemy turns need no plan: the
 * engine's own AI takes them, because _advanceTurn schedules
 * _takeEnemyTurn_viaLogic on the clock, and the driver's drain runs it.
 *
 * `maxTurns` is a runaway guard. Hitting it is a finding - a fight that cannot
 * end - not a number to raise.
 */
export function runFight(host, plan, { maxTurns = 400 } = {}) {
  startCombat(host);

  let turns = 0;
  while (!host.combatEnded && turns < maxTurns) {
    const actor = host._currentChar();
    if (!actor) break;

    // An enemy under the index means the AI's scheduled turn has already run
    // and advanced past it, or is about to; either way the drain owns it.
    if (actor.isEnemy) {
      const before = host.currentTurnIndex;
      host.__drain();
      if (host.currentTurnIndex === before && !host.combatEnded) {
        // Nothing was queued for them - take the turn explicitly.
        host._takeEnemyTurn_viaLogic(actor);
        host.__drain();
      }
      turns++;
      continue;
    }

    const actions = plan(host, actor) || [];
    for (const step of actions) {
      if (host.combatEnded) break;
      cast(host, actor, step.ability, step.target ?? null);
    }
    if (host.combatEnded) break;
    endTurn(host);
    turns++;
  }

  return {
    ended: host.combatEnded,
    turns,
    round: host.combatRound,
    hitTurnCap: turns >= maxTurns,
  };
}

/**
 * A compact, comparable picture of the board - the unit of a golden master.
 *
 * Rosters come from GameState.party and host.enemies rather than from the
 * slots, because _removeUnit clears slot.char when a unit goes down: reading
 * the slots would make a wipe look like an empty board, which is the one
 * outcome a snapshot most needs to record.
 */
export function snapshotBoard(host) {
  const unit = (u) => ({
    name: u.name,
    slot: u._slot?.slotId ?? u.slotId ?? null,
    hp: u.currentHP,
    maxHP: u.maxHP,
    mp: u.currentMP,
    gauge: u.initiativeGauge ?? 0,
    shield: u.shieldHP || 0,
    status: u.status,
    meters: { ...(u.weakness?.meters || {}) },
    tiers: { ...(u.weakness?.tiers || {}) },
    effects: (u.statusEffects || [])
      .map(e => e?.id + (e?.turns != null ? ':' + e.turns : ''))
      .sort(),
    cooldowns: Object.fromEntries(
      Object.entries(u.cooldowns || {}).filter(([, v]) => v > 0).sort()
    ),
  });

  return {
    round: host.combatRound,
    ended: host.combatEnded,
    turn: host._currentChar()?.name ?? null,
    allies: (GameState.party || []).map(unit),
    enemies: (host.enemies || []).map(unit),
    zones: Object.fromEntries(
      Object.entries(host.slotEffects || {})
        .filter(([, v]) => Array.isArray(v) && v.length)
        .map(([k, v]) => [k, v.map(e => e.id + ':' + e.turns).sort()])
    ),
  };
}
