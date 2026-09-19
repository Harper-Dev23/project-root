# Headless combat harness

Runs `src/scenes/CombatScene.js` — the real engine, unmodified — in Node, with
no browser, no canvas and no game loop.

**Nothing under `src/` or `data/` was changed to make this work, and nothing
should be.** If the harness needs something the engine does not expose, that is
a harness problem until a separate, deliberate decision says otherwise.

```
node tools/headless/smoke.mjs        does the whole chain still stand up?
node tools/headless/verify.mjs       what the golden master structurally can't check
node tools/combat_snapshot.js        the golden master built on top of it
```

**Before and after any change to combat, run both of these.** They cover
different things and neither substitutes for the other:

```
node tools/combat_snapshot.js --diff tools/snapshots/combat-golden.json
node tools/headless/verify.mjs
```

The snapshot records damage numbers, meters and refusals across every skill.
`verify.mjs` covers the click path, identity, and the co-op ownership gate —
none of which the snapshot can see, because it calls `_resolveAction` directly
and records outcomes rather than permissions.

## Hunts

`hunt.mjs` is exploration's counterpart: a golden master of whole scripted
hunts (`tools/snapshots/hunt-golden.json`) plus the save proofs, run through the
real `createHunt`, `GameState.save` and `GameState.load`. It needs no
`CombatScene`. A change to hunt rules, zone tables or weather moves its golden on
purpose; regenerate with `--json` in the same commit. A combat change should
never move it, and a hunt change should never move the combat golden.

`tools/snapshots/save-v3-fixture.json` is a real save written by the v3 build,
before hunts were saved. Keep it: it is what proves old saves still migrate.

## How it works

`CombatScene.prototype` carries every method. So:

```js
const host = Object.create(CombatScene.prototype);
```

inherits the entire engine, and the harness only has to supply the state and
the presentation surface those methods reach for. There is no refactor, no
extraction and no second copy of the rules that could drift.

## The four files

| file | what it is |
|---|---|
| `phaserStub.js` | Just enough Phaser for the imports to resolve, plus one seeded RNG behind **both** `Phaser.Math.Between` and `Math.random`. |
| `combatHost.js` | The fake `this`: real state, real log, real EventBus and ReactionSystem, counted no-op drawing, and a virtual clock. |
| `fixtures.js` | Real party members through `buildCharacter`, real weapons from `Items`, real enemies through `_spawnEnemy`. |
| `fight.js` | The driver: `cast`, `endTurn`, `runFight`, `snapshotBoard`. |

## Three things that are easy to get wrong

**Load order.** `installPhaserStub()` must run *before* anything that imports
CombatScene, because CombatScene touches Phaser at module scope
(`class extends Phaser.Scene`). `combatHost.js` and `fixtures.js` both throw a
clear error if imported too early, so use a static import for the stub and
`await import(...)` for everything else — as `smoke.mjs` does.

**Timers are queued, not inline.** `this.time.delayedCall` puts the callback on
a virtual clock that `host.__drain()` runs oldest-first. Running callbacks
inline was the first attempt and was wrong twice over: in a browser a delayed
call always runs *after* the current stack unwinds, and the enemy turn loop is
built entirely out of delayed calls that end in `_advanceTurn`, so inline
execution recursed through the whole fight. Every scripted action ends with a
drain, so `cast()` and `endTurn()` return with the board settled.

**Slots are plain objects, not the `chain` Proxy.** The engine writes
`slot.occupied`, `slot.char` and `slot.slotId` and reads them back; a Proxy
would swallow those writes and `slots.find(s => s.slotId === id)` would never
match again.

## What is faked, and what is not

Real: damage, mitigation, hit rolls, crits, weakness meters and tiers, status
effects, reactions, the AI, the turn order, victory and defeat, the combat log
(including its colours), character construction, gear, and enemy spawning.

Faked: everything that draws. Every stub is counted in `host.__skipped`, so a
run can say what it never executed instead of quietly implying a VFX-driven
side effect happened.

One consequence worth knowing: winning a fight makes the engine autosave, which
is why `Saved → autosave` appears in the output. It writes into the throwaway
`localStorage` the stub installs, never to a real save slot.

## Adding a gate

This used to be the one place the harness could fall out of step with the
game: `cast()` re-composed the `_useAbility` → `_enterTargetingMode` → click
sequence by hand, so a new gate added to `_useAbility` would not be enforced
here until someone remembered to copy it.

That gap is closed. `CombatScene._resolveAction()` is now the single place the
sequence is written down, and the click path, `cast()` and any future network
message all go through it. **Add a new gate to `_resolveAction` and all three
callers get it.**

## Identity and ownership

`_unitRef(unit)` gives the reference a network message should carry: players
keep the `instanceId` their save already uses, enemies get a per-combat `uid`
assigned in spawn order (`e1`, `e2`, …). Spawn order rather than random, so a
seeded replay reproduces the same ids and a log line stays readable.

Enemy templates carry no id of their own and several enemies share a name, so
before this an enemy could only be named by object reference — fine in one
process, useless once an action arrives as data.

`_resolveAction(intent, { playerId })` enforces co-op ownership. It is opt-in
and fail-closed: single player passes no `playerId` and the gate is inert, but
once one is supplied the actor must carry a matching `ownerId`. An *unowned*
hunter is refused rather than allowed, so one missed stamp during lobby setup
cannot silently let anyone drive that character.
