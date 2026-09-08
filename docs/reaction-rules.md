# Reaction Rules

The contract every reaction in the game follows. Written down because the
rules were previously implicit in the code, which made it impossible to tell
whether a new reaction was consistent or just happened to work.

Read this before adding or changing anything with `mechanic: "reaction"`.

---

## Rule 1 — Every reaction resolves in a WINDOW

The window, not the trigger name, is what ordering is written against. Several
triggers share a window because they happen at the same point in the hit.

| window | when | what belongs here |
|---|---|---|
| `pre_hit` | before the attack is computed, before the hit roll | redirects, attacker debuffs, cancels |
| `on_hit` | after the hit roll, **before damage commits** | counterattacks, damage negation, shot buffs |
| `post_damage` | after damage has landed | revenge effects, death triggers |

Trigger → window mapping lives in `ReactionSystem.WINDOW_OF`, read via
`ReactionSystem.windowFor(evt)`:

```
pre_hit               -> pre_hit
self_hit              -> on_hit
ally_hit              -> on_hit
ally_projectile_used  -> on_hit
weakness_tier_cross   -> post_damage
post_damage           -> post_damage
```

Where the windows sit inside `CombatScene._applyAbilityToTarget`:

```
checkPreHit()          pre_hit      can redirect / debuff the attacker
ability.apply()                     the skill computes its result
rollToHit()                         miss resolved here
emit self_hit          on_hit       can modify or zero the result
emit ally_hit          on_hit
result = resultMutable              damage frozen, then applied
emit post_damage       post_damage  the hit is real and on screen
```

## Rule 2 — A reaction may only affect its own window or later

Never reach backwards. A reaction cannot un-resolve something already settled.

This is the anti-spaghetti rule, and it is what lets reactions be reasoned
about locally. It is also why Sidestep slips a counterattack but does not undo
an ally's intercept: intercepts are `pre_hit`, counterattacks are `on_hit`, and
by the time a counter exists the redirect is already history.

**Practical consequence:** `post_damage` handlers receive no `incomingMutable`.
There is deliberately nothing for them to reshape.

## Rule 3 — One trigger per unit per round

`defaults.triggersPerRound = 1`. Firing any reaction — including a responder —
spends its owner's budget until their next turn.

This is the **termination guarantee**. Chain depth is bounded by the number of
living units, with no cycle detection anywhere. `_respondDepth` (cap 2) exists
only as belt-and-braces if that budget is ever raised.

Do not add loop guards to individual reactions. If something seems to need
one, the budget is being bypassed and that is the bug.

## Rule 4 — Within a window: by `priority`, then first-armed, one per unit

Candidates are sorted by `reaction.priority` (default 0) and the first eligible
one fires. Other prepared reactions stay armed but cannot fire until the
budget refreshes.

**Eligibility falls through.** If the highest-priority candidate's
`canTrigger` returns false, the next one is tried, and so on. This is not
cosmetic: the old code tested only `candidates[0]` and returned outright if it
declined, which made preparing a second reaction *strictly worse* than
preparing one — a conditional reaction whose condition was unmet silently
blocked a general one that would have fired. Skipping a declined candidate
costs nothing, because the trigger budget is only spent once something
actually fires.

### Convention: the more CONDITIONAL reaction takes the higher priority

It gets first refusal; the general one catches whatever it declines. Two
reactions sharing a trigger should therefore be authored as a pair, not left
on the default 0 where prepare order silently decides.

The sword kit is the reference case. Both answer `self_hit`:

| skill | priority | condition | effect |
|---|---|---|---|
| Practiced Eye | 5 | attacker carries any weakness | -35% damage, +3 MP |
| Riposte | 0 | any melee hit | 70% counter, +1 Rhythm |

Arming both reads as one plan: *if they're weakened, read the flaw; otherwise,
hit back.* Note the balance constraint this implies — a reaction that is both
the better defensive AND the better offensive option makes the priority order
meaningless. Riposte deliberately carries no mitigation for that reason.

**Reaction capacity is 2 and `triggersPerRound` is 1**, so at most two are
armed and at most one resolves per round. There is no stacking case to guard
against, and no need for tag-based mutual exclusion.

## Rule 5 — A reaction may be ANSWERED by another, in the same window

Handled by `ReactionSystem._checkReactionResponders()`, which runs inside
`_fireReaction` **before the parent's `exec`**.

A responder declares:

```js
reaction: {
  trigger: "reaction_fired",
  respondsToWindow: "on_hit",   // rule 2: which parents it may answer
  exec: ({ owner, attacker, parentSkill, parentWindow, scene }) => { ... }
}
```

**Responders run before the parent, not after.** This is the single most
important implementation detail. A counterattack applies its damage inside its
own `exec`; once that has run there is nothing to unwind. Answering beforehand
requires no cooperation from the counterattack skill itself.

### Responders answer the OPPOSING side by default

`reaction.respondsTo` is `'enemy'` unless stated (`'ally'` or `'any'`). Without
this, an ally's reaction is a valid parent — which is how Sidestep once fired
on a friendly Ignite and logged a dodge of something that was never an attack.

A responder may return `{ prevent: true }` to stop the parent's `exec` running
at all. **The parent still spends its trigger** — it committed.

### Prefer weakening over preventing

`prevent` exists for a true "counterspell", but it should be rare. Cancelling a
reaction also suppresses its own `reaction_fired` emission, so anything else
watching for "a reaction happened this sequence" silently never sees it.

Sidestep is the reference implementation: it lets the counterattack fire and
resolve normally, and simply makes it whiff by buffing the dodger's Evasion.

---

## Accuracy vs Evasion — not interchangeable

For the hit roll they are symmetric:

```js
computeHitChance = clamp(100 - evasion + accuracy, 5, 100)
```

For crit they are **not**:

- accuracy overflow adds `overflow * 0.5` to the attacker's crit chance
- target evasion subtracts `evasion * 0.5` from it

So buffing the defender's Evasion is strictly stronger than cutting the
attacker's Accuracy by the same amount. Prefer whichever is *thematically*
correct, but know the difference.

Note the **floor of 5**: no amount of evasion guarantees a miss.

---

## Checklist for a new reaction

- [ ] Which window does it belong in? Does its trigger already map there?
- [ ] Does it only affect its own window or later (rule 2)?
- [ ] If it answers another reaction, is `respondsToWindow` set?
- [ ] If it prevents, is preventing genuinely right, or would weakening do?
- [ ] Does it carry `melee` or `ranged` if it deals damage? (see the tag scheme)
- [ ] Is `cooldownOn` correct — `trigger` (on fire) or `cast` (on arm)?

## Known gaps

- `post_damage` fires only for the unit that took the damage. An
  "ally was wounded" variant would need its own event, as `ally_hit` is to
  `self_hit`.
- There is no window between `apply()` and the hit roll. Nothing has needed
  one; if something does, it is a fourth window, not a special case inside an
  existing one.
