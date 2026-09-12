// src/systems/seededRng.js
//
// A random stream you can hand to someone else and get the same numbers back.
//
// Co-op needs this because enemy gear is ROLLED, not scripted. Every client
// runs _placeEnemies locally to draw the board, so every client rolled its own
// random equipment for the same enemy -- one player's Gorrek wore different
// armour from another's, with different derived stats. The server's copy is the
// one that actually governs combat, so the divergence was in what each player
// was shown, which is worse than it sounds: an Identify tonic would truthfully
// report a local item that no one else had.
//
// The fix is for the server to send one seed and everyone to roll from it.
//
// Deliberately NOT the seeding that tools/headless/phaserStub.js does. That
// replaces the GLOBAL Math.random, which session.js already documents as wrong
// for a server: a second hunt starting would reset the randomness of every hunt
// already in progress. This hands out an explicit stream instead, passed as an
// `rng` option to the functions that need it, so nothing global is touched and
// concurrent fights cannot interfere with each other.
//
// Dependency-free and Phaser-free, so the client, the server and the headless
// harness all load it unchanged.

/**
 * mulberry32 -- small, fast, and identical across runs and machines for a
 * given seed. Returns a function yielding floats in [0, 1), the same shape as
 * Math.random, so it drops into any `rng` parameter.
 *
 * Chosen to match the generator the headless harness already uses, so a seed
 * means the same sequence everywhere in this project.
 */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;   // a zero seed degenerates; 1 is as good as any
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A fresh seed to hand out. Uses ambient randomness, which is correct here --
 * this is called once when a fight is created, not during it.
 */
export function randomSeed() {
  return (Math.random() * 0xFFFFFFFF) >>> 0;
}

/** True if `v` can be used as a seed. Keeps the callers' guards identical. */
export function isSeed(v) {
  return Number.isFinite(v);
}

export default { makeRng, randomSeed, isSeed };
