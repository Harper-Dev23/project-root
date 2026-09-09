// @ts-nocheck
// tools/headless/phaserStub.js
//
// A Phaser shim just complete enough that `src/scenes/CombatScene.js` and its
// dependencies can be IMPORTED and their methods CALLED with no canvas, no
// game loop, and no browser.
//
// WHY THIS SHAPE
// --------------
// CombatScene.js touches Phaser at module scope (class extends Phaser.Scene,
// plus a few Phaser.GameObjects references), so the shim has to exist BEFORE
// the import, not after. Everything drawn is replaced by `chain` — a Proxy that
// returns itself for any property access, call, or construction — so a render
// call like
//     this.add.text(...).setOrigin(0.5).setDepth(3).setInteractive()
// runs harmlessly to completion instead of throwing partway and aborting the
// rules that follow it.
//
// SEEDED RANDOMNESS
// -----------------
// A golden master is worthless if the same fight produces different numbers on
// each run. Combat draws randomness from two places — Phaser.Math.Between (13
// call sites) and bare Math.random() (29 call sites) — so BOTH are routed
// through one seeded generator here. `Math.random` is overwritten globally,
// which is acceptable precisely because this file only ever runs in a
// throwaway node process, never in the game.
//
// This file changes nothing in the game. It is a host, not a refactor.

/** mulberry32 — small, fast, and identical across runs for a given seed. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _rng = makeRng(1);

/** Reseed every randomness source. Call once per scripted fight. */
export function seed(n) {
  _rng = makeRng(n);
  Math.random = _rng;          // deliberate: node-only process, see header
}

/**
 * Hand randomness back to the platform, leaving `Math.random` untouched.
 *
 * A SERVER must use this. Seeding is exactly right for a snapshot and exactly
 * wrong for a long-running process, in two ways that are easy to miss:
 *
 *   1. `seed()` replaces the GLOBAL Math.random, so two concurrent hunts share
 *      one stream. Starting a second fight resets the first one's randomness
 *      mid-combat, and the two interfere.
 *   2. Seeding at startup means every restart replays the same sequence -
 *      the same crits, the same loot, forever.
 *
 * Determinism is still available per fight when it is wanted (a replay, a bug
 * report); it just cannot be the default for a process serving real players.
 */
export function useSystemRandom() {
  _rng = () => Math.random();
}

/** The current stream, for anything that wants to draw directly. */
export function rng() { return _rng(); }

/** Anything visual: accepts every call, returns itself, never throws. */
export const chain = new Proxy(function () { }, {
  get: (_t, prop) => (prop === Symbol.toPrimitive ? () => '' : chain),
  apply: () => chain,
  construct: () => chain,
  set: () => true,
  has: () => true,
});

class SceneShim {
  constructor(cfg) { this.sys = { settings: { key: typeof cfg === 'string' ? cfg : cfg?.key } }; }
}

/**
 * Install the shim on globalThis. MUST be called before importing any file
 * that reaches for Phaser at module scope.
 */
export function installPhaserStub(seedValue = 1, { deterministic = true } = {}) {
  // Deterministic by default, because every existing caller is a test or a
  // snapshot and silently losing reproducibility would be the worse failure.
  // A server passes { deterministic: false } - see useSystemRandom above.
  if (deterministic) seed(seedValue);
  else useSystemRandom();

  globalThis.localStorage = globalThis.localStorage || {
    _v: {},
    getItem(k) { return k in this._v ? this._v[k] : null; },
    setItem(k, v) { this._v[k] = String(v); },
    removeItem(k) { delete this._v[k]; },
  };

  globalThis.Phaser = {
    Scene: SceneShim,
    Math: {
      // Inclusive integer range, matching Phaser's own contract — the engine
      // relies on Between(1,100) being able to return both 1 and 100.
      Between: (min, max) => Math.floor(_rng() * (max - min + 1)) + min,
      FloatBetween: (min, max) => _rng() * (max - min) + min,
      Clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
      Linear: (a, b, t) => a + (b - a) * t,
      Distance: { Between: (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1) },
      RND: { pick: (arr) => arr[Math.floor(_rng() * arr.length)] },
    },
    Geom: {
      Rectangle: class {
        constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height }); }
        get right() { return this.x + this.width; }
        get bottom() { return this.y + this.height; }
        static Contains(r, x, y) { return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height; }
      },
      Polygon: class { constructor(pts) { this.points = pts || []; } },
      Circle: class { constructor(x, y, r) { Object.assign(this, { x, y, radius: r }); } },
    },
    Display: {
      Color: {
        GetColor: (r, g, b) => (r << 16) | (g << 8) | b,
        IntegerToColor: () => ({ r: 0, g: 0, b: 0 }),
        Interpolate: { ColorWithColor: () => ({ r: 0, g: 0, b: 0 }) },
      },
    },
    Utils: { Array: { Shuffle: (a) => a, GetRandom: (a) => a[Math.floor(_rng() * a.length)] } },
    Scenes: { Events: { SHUTDOWN: 'shutdown', CREATE: 'create', WAKE: 'wake', SLEEP: 'sleep' } },
    Input: { Keyboard: { KeyCodes: {} } },
    GameObjects: {
      Container: class { }, Sprite: class { }, Text: class { },
      Graphics: class { }, Zone: class { }, Rectangle: class { }, Image: class { },
    },
    BlendModes: { NORMAL: 0, ADD: 1 },
    Tweens: { Builders: {} },
  };

  return globalThis.Phaser;
}
