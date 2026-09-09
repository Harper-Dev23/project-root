# Co-op hunt server

The game stays a dependency-free static site on GitHub Pages. This directory is
its own npm project so that stays true — nothing here is loaded by the browser,
and `npm install` never touches the game.

```
cd server
npm install          # one package (ws), zero transitive dependencies
npm start            # listens on :8787, or $PORT
```

```
node server/session_test.mjs     a co-op fight, no network at all
node server/protocol_test.mjs    a whole hunt through protocol messages
node server/e2e_test.mjs         the real server, real sockets, two clients
```

The first two need no `npm install`. Only the socket layer does.

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
