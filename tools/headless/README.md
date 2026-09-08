# Headless combat harness

Runs `src/scenes/CombatScene.js` — the real engine, unmodified — in Node, with
no browser, no canvas and no game loop.

**Nothing under `src/` or `data/` was changed to make this work, and nothing
should be.** If the harness needs something the engine does not expose, that is
a harness problem until a separate, deliberate decision says otherwise.

```
node tools/headless/smoke.mjs        does the whole chain still stand up?
node tools/combat_snapshot.js        the golden master built on top of it
```

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

`fight.js`'s `cast()` re-composes the sequence `_useAbility` →
`_enterTargetingMode` → click, because that path only resolves on a real
`pointerdown` and there is no pointer here. It calls the engine's own
predicates rather than reimplementing them, but the *sequence* is copied, so a
NEW gate added to `_useAbility` will not be enforced here until it is added to
`cast()` as well. That is the one place this harness can fall out of step with
the game.
