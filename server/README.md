# Co-op hunt server

The GAME is still static ES modules with no build step and no runtime
dependencies — the browser loads nothing from npm. The repo root now has a
`package.json` because this server does, and because Railway needs one thing to
install and one thing to start.

```
npm install          # one package (ws), zero transitive dependencies
npm start            # listens on :8787, or $PORT
```

```
npm run verify       golden master + the checks it cannot make
npm test             every co-op suite, including two real sockets
```

**The server cannot be deployed from this directory alone.** `index.js` imports
`../tools/headless/` and `../src/scenes/CombatScene.js` — running the real
engine is the entire point — so a host must take the whole repository and run
`node server/index.js`. That is what `railway.json` at the root declares.

## Layers

| file | what it decides |
|---|---|
| `session.js` | one hunt: the shared party of six, ownership, turn flow, the broadcast payload |
| `protocol.js` | lobbies, the message vocabulary, who may send what |
| `index.js` | nothing — it moves bytes and manages connections |

That ordering is deliberate. Everything that makes a decision is testable in a
plain Node process with fake connections, so the socket layer stays thin enough
to read in one sitting.

`session.js` imports the harness's `createCombatHost` rather than copying it,
so the fight a server runs is the exact object the golden master exercises
across 276 skills, 13 reactions and 160 enemy skills.

## Three things that will bite you

**Load order.** `installPhaserStub()` must run before anything that imports
`CombatScene`, which reaches for Phaser at module scope. Both `session.js` and
`protocol.js` throw a clear error if imported too early.

**A server must not seed the RNG.** `index.js` passes
`{ deterministic: false }`, and sessions are created with `seed: null`. Seeding
replaces the *global* `Math.random`, so a server that seeded each session would
have every new hunt reset the randomness of every hunt already in progress —
and seeding at startup would make every restart replay the same crits and the
same loot. Determinism stays available per fight for replays and bug reports.

**Characters lose their skills on the wire.** A character JSON round-trips
without error and silently drops every skill's `apply()` function — 15 of 19 on
a level-5 hunter. Skills therefore cross as ids and are rehydrated from
`SKILLS`; an unknown id throws rather than vanishing.

## Protocol

Client → server: `create`, `join`, `setHunters`, `ready`, `start`, `act`,
`endTurn`, `sync`.
Server → client: `joined`, `lobby`, `started`, `state`, `over`, `error`.

**Every `state` carries a `version`.** Read it. Several broadcasts can be in
flight at once — an action and the end of turn that follows it — so "the next
state message" is not necessarily the one your action caused. A client that
takes it anyway will act twice on a stale board and then be told it is not its
turn. Wait for a state whose `version` is greater than the one you acted on.

A refusal (`error`) goes only to the player who caused it, so the broadcast
stays a pure record of what actually happened.

## Not done yet

Reward *distribution*. The `over` message reports the outcome, the survivors
and who was present; each client is expected to apply its own rewards through
the save system it already has. Nothing here writes to anyone's save.
