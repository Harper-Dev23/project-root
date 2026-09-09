// @ts-nocheck
// tools/headless/combatHost.js
//
// The fake `this` that CombatScene's own methods run against.
//
// The key idea: we do NOT move combat logic anywhere. `CombatScene.prototype`
// carries every method, so an object made with
// `Object.create(CombatScene.prototype)` inherits the real engine, and we only
// supply the state and the presentation surface it reaches for. Nothing under
// src/ changes, which is what makes this safe to run against a live codebase.
//
// LOAD ORDER MATTERS. This module statically imports production modules that
// touch Phaser at module scope, so `installPhaserStub()` must have run first.
// The guard below turns a confusing deep import error into a clear one.
//
// FIDELITY RULE
// -------------
// Where the engine has a real method or a real system, the host uses it rather
// than reimplementing it. The real EventBus, the real ReactionSystem, the real
// _log, and the real _placePartyMembers / _prepareCharForBattle /
// _assignCharToSlot / _spawnEnemy / _equipEnemyItem / _resetAllCooldowns all
// run. Only the leaves that DRAW are stubbed. A change to enemy construction or
// to reaction dispatch then shows up in the harness automatically instead of
// quietly drifting away from it.
//
// Every stub is counted (`host.__skipped`), so a run can report what it never
// executed rather than silently pretending a visual side effect happened.

if (!globalThis.Phaser) {
  throw new Error(
    'combatHost.js imported before installPhaserStub(). Call installPhaserStub() ' +
    'and THEN `await import("./combatHost.js")`.'
  );
}

import { chain } from './phaserStub.js';
import GameState from '../../src/systems/GameState.js';
import EventBus from '../../src/systems/EventBus.js';
import ReactionSystem from '../../src/systems/ReactionSystem.js';
import { COMBAT_SCENARIOS } from '../../data/combatScenarios.js';
import { computeEffectiveInitiative } from '../../src/systems/CombatLogic.js';

// Mirrored from _createBattleSlots (CombatScene.js:1271-1297). The authored
// order of the position arrays is meaningful - it is what pairs a screen
// position with a slot id - so it is copied rather than regenerated.
const SLOT_IDS = [8, 7, 6, 4, 5, 3, 2, 1];
const ALLY_POS = [
  { x: 200, y: 100 }, { x: 200, y: 180 }, { x: 200, y: 260 },
  { x: 380, y: 160 }, { x: 380, y: 240 },
  { x: 560, y: 120 }, { x: 560, y: 200 }, { x: 560, y: 280 },
];
const ENEMY_POS = [
  { x: 1080, y: 100 }, { x: 1080, y: 180 }, { x: 1080, y: 260 },
  { x: 900, y: 160 }, { x: 900, y: 240 },
  { x: 720, y: 120 }, { x: 720, y: 200 }, { x: 720, y: 280 },
];

/**
 * A stand-in for the Phaser Container a battle slot really is. Deliberately a
 * plain object and NOT the `chain` Proxy: the engine writes `slot.occupied`,
 * `slot.char` and `slot.slotId` and reads them back, and a Proxy would swallow
 * those writes and return itself, so `slots.find(s => s.slotId === id)` would
 * never match. Data fields are real; only the drawing methods are inert.
 */
function makeSlot(side, slotId, pos) {
  return {
    x: pos.x, y: pos.y,
    slotId,
    uniqueKey: side + '_' + slotId,
    occupied: false,
    char: null,
    rect: chain,
    list: [],
    add() { return this; },
    remove() { return this; },
    removeAll() { return this; },
    removeAllListeners() { return this; },
    setInteractive() { return this; },
    disableInteractive() { return this; },
    setSize() { return this; },
    setDepth() { return this; },
    setAlpha() { return this; },
    setVisible() { return this; },
    setScale() { return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },

    // Listeners are REAL, not no-ops. The engine's targeting mode works by
    // attaching a `pointerdown` to every valid slot and waiting; without
    // somewhere for that handler to live, the harness can exercise the rules
    // but never the path a player's click actually takes. Storing them lets
    // __click() drive the genuine UI flow - _useAbility, _enterTargetingMode,
    // then the click - which is the only way to prove the single-player path
    // still works without opening a browser.
    _handlers: Object.create(null),
    on(evt, fn) { (this._handlers[evt] || (this._handlers[evt] = [])).push({ fn, once: false }); return this; },
    once(evt, fn) { (this._handlers[evt] || (this._handlers[evt] = [])).push({ fn, once: true }); return this; },
    off(evt, fn) {
      if (this._handlers[evt]) this._handlers[evt] = this._handlers[evt].filter(h => h.fn !== fn);
      return this;
    },
    removeAllListeners() { this._handlers = Object.create(null); return this; },
    emit(evt, ...args) {
      const list = (this._handlers[evt] || []).slice();
      this._handlers[evt] = list.filter(h => !h.once);
      for (const h of list) h.fn(...args);
      return this;
    },
    /** Simulate a player clicking this slot. */
    __click() { return this.emit('pointerdown'); },
    __listenerCount(evt) { return (this._handlers[evt] || []).length; },

    getBounds() { return { x: this.x - 32, y: this.y - 32, width: 64, height: 64 }; },
    destroy() { },
  };
}

/**
 * A virtual clock for `this.time`.
 *
 * Inline execution was the obvious first choice and is WRONG. In the browser a
 * delayedCall always runs after the current call stack unwinds; running it
 * inline reorders the rules relative to the caller that scheduled it. It also
 * recurses without bound here, because the enemy turn loop is built entirely
 * out of delayed calls that end in _advanceTurn, which schedules the next
 * unit's turn, and so on for the whole fight.
 *
 * So callbacks are queued with a virtual timestamp and drained oldest-first in
 * a flat loop. Ties break on insertion order, which is what Phaser does. The
 * clock never sleeps: draining a 400ms wait costs nothing but advances `now`,
 * so a full fight resolves instantly and still in the game's own order.
 */
function makeClock() {
  const queue = [];
  let seq = 0;
  let now = 0;

  const schedule = (ms, fn, ctx, args) => {
    const evt = {
      at: now + Math.max(0, Number(ms) || 0),
      seq: seq++,
      fn,
      ctx,
      args: args || [],
      cancelled: false,
      remove() { this.cancelled = true; },
      destroy() { this.cancelled = true; },
    };
    queue.push(evt);
    return evt;
  };

  return {
    get now() { return now; },
    pending() { return queue.filter(e => !e.cancelled).length; },
    schedule,
    /**
     * Runs queued callbacks until the queue empties. `limit` is a runaway
     * guard, not a tuning knob: hitting it means something is scheduling
     * itself forever, which is a finding, not a value to raise.
     */
    drain(limit = 20000) {
      let fired = 0;
      while (fired < limit) {
        let bestIdx = -1;
        for (let i = 0; i < queue.length; i++) {
          const e = queue[i];
          if (e.cancelled) continue;
          if (bestIdx === -1) { bestIdx = i; continue; }
          const b = queue[bestIdx];
          if (e.at < b.at || (e.at === b.at && e.seq < b.seq)) bestIdx = i;
        }
        if (bestIdx === -1) break;
        const evt = queue.splice(bestIdx, 1)[0];
        now = Math.max(now, evt.at);
        fired++;
        if (typeof evt.fn === 'function') evt.fn.apply(evt.ctx, evt.args);
      }
      if (fired >= limit) {
        throw new Error(
          'clock.drain hit its ' + limit + '-callback guard: something is ' +
          'rescheduling itself forever. This is a bug to look at, not a limit to raise.'
        );
      }
      // Cancelled leftovers accumulate otherwise.
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].cancelled) queue.splice(i, 1);
      return fired;
    },
  };
}

/**
 * Presentation calls worth RECORDING rather than merely dropping.
 *
 * A co-op client cannot produce these for itself: it never runs
 * _applyAbilityToTarget, so it never learns that a hit was a crit, or that a
 * status flared, or how much damage to float over whose head. But the server
 * runs the real engine, and the real engine calls exactly these methods, in
 * exactly the right order, with exactly the right arguments — and this host
 * was already intercepting every one of them in order to throw them away.
 *
 * So they are captured instead, each stamped with the virtual clock's time.
 * That timestamp is what restores PACING: the engine staggers a chain of
 * enemy turns across hundreds of milliseconds, and replaying the recording on
 * those same offsets gives the client the game's own rhythm rather than a
 * board that jumps from before to after.
 *
 * Deliberately a small allowlist. These three carry the visual meaning; the
 * rest are bars and panels the client redraws from state anyway.
 */
const RECORDED_METHODS = new Set([
  '_playAttackVFX',        // (attacker, target, { missed, ability, isCrit })
  '_showFloatingNumber',   // (amount, target, isHeal, isCrit)
  '_playStatusVFX',        // (target, { kind, scale, duration, sound })
]);

/** Presentation methods replaced with counted no-ops returning `chain`. */
const VISUAL_METHODS = [
  // combat VFX / SFX
  '_playAttackVFX', '_playStatusVFX', '_playProjectileVFX', '_playMeleeImpactVFX',
  '_playSword2hVFX', '_playBowVFX', '_playDaggerVFX', '_playMaceVFX', '_playStaffVFX',
  '_showFloatingNumber', '_showFloatingText', '_flashPortrait', '_shakePortrait',
  '_hopPortrait', '_animateMove',
  // bars, icons, portraits
  '_refreshUI', '_updateHealthBars', '_updateHPMPBars', '_updateInitiativeBars',
  '_refreshStatusEffectIcons', '_updateWeaknessOverlays', '_wireSlotInfoClick',
  '_clearPortrait', '_clearSlotHighlights', '_clearAllPortraitHighlights',
  '_refreshRunicZoneSprite', '_refreshLodgeSprites', '_refreshGroundSprites',
  '_resetSlotStroke', '_paintSlotFrame', '_highlightCurrentTurn',
  // menus, panels, screens
  '_renderCharacterInfoBody', '_buildActionMenuRoot', '_rebuildActionMenu',
  '_exitTargetingMode', '_exitPositionTargeting', '_enterPositionTargeting',
  '_showVictoryScreen', '_showDefeatScreen', '_updateTurnOrderUI',
  // log rendering (the log CONTENT is real; only drawing it is skipped)
  '_renderCombatLog', '_scrollCombatLogToBottom',
];

/** Presentation methods whose RETURN VALUE the engine actually consumes. */
const VISUAL_METHODS_RETURNING_ARRAY = ['_makeStatusBars'];

export function createCombatHost(CombatScene, { installReactions = true } = {}) {
  const host = Object.create(CombatScene.prototype);
  const skipped = Object.create(null);
  const count = (name) => { skipped[name] = (skipped[name] || 0) + 1; };
  const clock = makeClock();
  const events = [];

  const allySlots = ALLY_POS.map((pos, i) => makeSlot('ally', SLOT_IDS[i], pos));
  const enemySlots = ENEMY_POS.map((pos, i) => makeSlot('enemy', SLOT_IDS[i], pos));

  Object.assign(host, {
    // ---- state the engine reads and writes ---------------------------------
    combatEnded: false,
    combatRound: 1,
    currentTurnIndex: 0,
    turnOrder: [],
    enemies: [],
    allySlots,
    enemySlots,
    unitSlots: [...allySlots, ...enemySlots],
    allSlots: [...allySlots, ...enemySlots],
    slotEffects: {},
    groundSprites: {},
    lodgeSprites: {},
    koArea: [],
    menuLevel: 'root',
    targetingAbility: null,
    targetingAbilityBtn: null,
    scenarioId: null,
    scenarioData: null,
    _rxSelection: null,
    _respondDepth: 0,
    currentActorMovedThisTurn: false,
    lodgesDislodgedThisTurn: 0,

    // The real log buckets. _log / _logLocal are NOT stubbed - they run for
    // real and push normalized {segments:[{text,color}]} entries here, so the
    // harness reads exactly what a player would see, colours included.
    combatEntries: [],
    localEntries: [],
    combatLogMaxEntries: 0,   // 0 = never trim, so a snapshot keeps everything
    isHoveringCombatLog: false,
    localChatScript: null,

    // ---- presentation: accepted, counted, discarded -------------------------
    add: chain, tweens: chain, cameras: chain, sound: chain, input: chain,
    anims: chain, textures: chain, make: chain, load: chain,
    scale: { width: 1280, height: 720 },
    children: { list: [] },
    sys: { game: { canvas: { width: 1280, height: 720 } }, settings: { key: 'CombatScene' } },
    scene: {
      key: 'CombatScene',
      sleep() { }, wake() { }, start() { }, stop() { }, launch() { },
      get() { return null; }, isActive() { return true; },
    },
    events: {
      on() { return this; }, once() { return this; },
      off() { return this; }, emit() { return this; },
    },

    // ---- timing: a virtual clock, drained in a flat loop --------------------
    time: {
      delayedCall: (ms, fn, args, ctx) => clock.schedule(ms, fn, ctx || host, args),
      addEvent: (cfg) => clock.schedule(
        cfg?.delay, cfg?.callback, cfg?.callbackScope || host, cfg?.args
      ),
      get now() { return clock.now; },
      removeAllEvents() { },
    },

    // ---- harness bookkeeping -------------------------------------------------
    __skipped: skipped,
    __clock: clock,
    __events: events,
  });

  for (const name of VISUAL_METHODS) {
    if (RECORDED_METHODS.has(name)) {
      host[name] = function (...args) {
        count(name);
        events.push({ at: clock.now, fn: name, args: args.map(a => wireArg(a, host)) });
        return chain;
      };
    } else {
      host[name] = function () { count(name); return chain; };
    }
  }
  for (const name of VISUAL_METHODS_RETURNING_ARRAY) {
    host[name] = function () { count(name); return []; };
  }

  // The result of _createWeaknessOverlays is passed to slot.add(), so an inert
  // object is enough - but it must not be an array, since the engine spreads
  // the status bars and not this.
  host._createWeaknessOverlays = function () { count('_createWeaknessOverlays'); return chain; };

  // The real systems, wired the way create() wires them (CombatScene.js:444-446).
  host.bus = new EventBus();
  host.reactions = new ReactionSystem(host, host.bus);
  if (installReactions) host.reactions.install();

  /** Drains the virtual clock. Every scripted action ends with one of these. */
  host.__drain = function (limit) { return clock.drain(limit); };

  /**
   * Hand over everything recorded since the last call, and start fresh.
   *
   * Taken rather than copied: each broadcast should carry the visuals for its
   * OWN action. Leaving them to accumulate would make every message replay the
   * whole fight from the beginning.
   */
  host.__takeEvents = function () { return events.splice(0, events.length); };

  /**
   * A log entry made safe to send, WITH its tooltip payload intact.
   *
   * Flattening entries to plain text was fine until the detailed damage
   * breakdown mattered: that lives on a segment as `tooltipData`, so a
   * co-op client shown only text has nothing to hover. Entries cannot be sent
   * raw either — a segment carries `actor` (a live unit, and therefore
   * circular through _slot.char) and `ability` (a skill, whose apply()
   * would be silently dropped). Both become references, exactly as the visual
   * event stream does.
   *
   * The depth allowance is raised because a tooltip is entry -> segments ->
   * segment -> tooltipData -> lines -> line, which is deeper than an event's
   * arguments ever go. At the default depth the breakdown lines came back null.
   */
  host.__wireLogEntry = function (entry) { return wireArg(entry, host, 0, 8); };

  /** The combat log as plain comparable text. */
  host.__logLines = function () {
    return host.combatEntries.map(e => (
      e?.separator ? '---' : (e?.segments || []).map(s => s?.text ?? '').join('')
    ));
  };

  /**
   * Runs the same setup create() does, minus the drawing - see CombatScene.js
   * lines 347-406. Kept in that order deliberately: party first, then enemies
   * (so scenarioData is live for enemyScale and loot gating), then turn order,
   * then the per-combat wipe that clears gauges and stale statuses.
   *
   * Note it does NOT call _advanceTurn. Starting the first turn is the
   * driver's job (see fight.js), so a caller can also just poke at a
   * fully-built board without a turn loop running.
   */
  host.__begin = function ({ party, partySlots = {}, scenarioId = 'training_encounter_1' }) {
    const scenario = COMBAT_SCENARIOS[scenarioId];
    if (!scenario) throw new Error('unknown scenario: ' + scenarioId);

    GameState.party = party;
    GameState.partySlots = partySlots;
    this.scenarioId = scenarioId;
    this.scenarioData = scenario;
    this.enemies = [];

    this._placePartyMembers();
    this._placeEnemies(scenarioId);

    const byInitiativeDesc = (a, b) => computeEffectiveInitiative(b) - computeEffectiveInitiative(a);
    this.turnOrder = [
      ...[...GameState.party].sort(byInitiativeDesc),
      ...[...(this.enemies || [])].sort(byInitiativeDesc),
    ];

    this._resetAllCooldowns();

    for (const u of this.turnOrder) {
      u.statusEffects = [];
      u.statuses = {};
      u.initiativeGaugeMax = u.initiativeGaugeMax ?? 100;
      u.initiativeGauge = 0;
      if (u._weaknessDerived) {
        u._weaknessDerived.maxHPDown = 0;
        u._weaknessDerived.evasionDown = 0;
        u._weaknessDerived.initiativeSlow = 0;
      }
      const initBonus = u?.gearEffects?.initBonusOnBattleStart || 0;
      if (initBonus > 0) {
        u.initiativeGauge = Math.min(u.initiativeGaugeMax, u.initiativeGauge + initBonus);
      }
      const shieldPct = u?.gearEffects?.shieldPctOnBattleStart || 0;
      u.shieldHP = shieldPct > 0 ? Math.floor((u.maxHP || 0) * shieldPct / 100) : 0;
      if (u.shieldHP > 0) u.statusEffects.push({ id: 'ward_shield_timer', turns: 2 });
    }

    this.__drain();
    return this;
  };

  return host;
}

/**
 * Make one argument safe to send.
 *
 * Units and skills cross as REFERENCES, never as copies: the client already
 * has both, and shipping a whole character to say "this one got hit" would be
 * absurd — and would give the client a second, divergent copy of a unit it is
 * already tracking.
 *
 * Anything not recognised is passed through only if it is JSON-safe, so an
 * unexpected argument can never make a broadcast unserializable.
 */
function wireArg(value, host, depth = 0, maxDepth = 2) {
  if (value == null || typeof value !== 'object') {
    return typeof value === 'function' ? null : value;
  }
  if (depth > maxDepth) return null;

  // A combatant: has a name and a health pool.
  if (typeof value.name === 'string' && value.currentHP !== undefined) {
    return { __unit: host._unitRef(value) };
  }
  // A skill: has an id and something to run.
  if (typeof value.id === 'string' && typeof value.apply === 'function') {
    return { __skill: value.id };
  }
  if (Array.isArray(value)) return value.map(v => wireArg(v, host, depth + 1, maxDepth));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const w = wireArg(v, host, depth + 1, maxDepth);
    if (w !== undefined) out[k] = w;
  }
  return out;
}
