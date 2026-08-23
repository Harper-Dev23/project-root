---
id: systems/weakness_scaling
title: "Weakness Scaling (In Depth)"
slug: "weakness-scaling"
category: "systems"
subtab: "In Depth"
order: 20
tags: ["systems", "weakness", "combat", "reference", "in-depth"]
status: "approved"
teaser: false
requires: []
sort: 20
version: 6
updatedAt: 2026-08-23
---
# Weakness Scaling (In Depth)

The exact numbers behind the nine families. For what each one broadly does, see [[Weakness System Overview]].

## Thresholds

- **Tier 1** at **100** buildup
- **Tier 2** at **200** buildup

There is no Tier 3 threshold. Buildup beyond 200 is not wasted — it raises **intensity** instead.

## Intensity

Every effect that scales does so off the same curve:

```
intensity = 1 + (buildup - 200) / 300     capped at 2.5
```

So 200 buildup is intensity 1.0, 350 is 1.5, 500 is 2.0, and 950 or more sits at the 2.5 cap. Two families override this with their own linear ramp — **Cold** and **Disorient** both use `+0.007 per point` capped at 3.0, and **Fire** uses `+0.01 per point` capped at 8.0, by far the steepest in the game.

Nearly every effect below is written as `base x intensity, capped` — the cap matters, because most reach it well before intensity does.

## Resilience

Incoming buildup is reduced by a percentage curve, not a flat subtraction:

```
reduction = Resilience / (Resilience + 100)
```

So **100 Resilience is exactly 50% reduction**, 50 is 33%, 200 is 67%. It never reaches 100%. The percentage applies uniformly regardless of hit size — a small buildup hit is softened but never zeroed, and a large one takes the same proportional cut.

Resilience comes from Wisdom (`WIS x 0.5`), from gear, and from temporary status effects, all summed before the curve.

**Resilience is the only thing that reduces buildup.** Physical, Elemental and Necrotic Resist are damage stats and have no effect on a meter at all — verified directly: a target with 80 in all three resists takes exactly the same buildup as a target with none.

Those resists do still apply to the *damage* a family's tier effects deal — a Toxic tick is necrotic, a Fire burn elemental, a Lacerate bleed physical — but they never slow the meter that triggers them. Everything else in the buildup pipeline points the other way: the attacker's gear buildup percentages, vulnerability riders and Expose's physical-family amplification are all multipliers that make buildup land harder.

## Decay

Unrefreshed buildup decays each turn on a three-band curve, scaled by each family's own weight:

| Buildup | Decay per turn |
|---|---|
| Below 100 | 1–3 (light chip, so buildup can stick) |
| 100–200 | ramps 8 → 12 |
| 200+ | 28, plus 20 per 100 overflow, capped at 140 |

Only **Fire** carries a heavier weight than baseline (40 against the standard 35), so fire falls off faster than anything else.

---

## Per-family numbers

### Lightning — *Zapped / Shocked*
- **T1:** each jolt rolls **1–4** damage.
- **T2:** each extra jolt has a **40%** base chance (scaling with intensity, capped at **95%**), up to **4 extra jolts** — a maximum of 5 in one hit.
- Jolt damage is applied after crit and is never crit-amplified.

### Cold — *Chilled / Frostbitten*
- **T1:** Initiative penalty **15%**, capped at **50%**. Initiative Gauge regeneration reduced **35%**, capped at **75%**.
- **T2:** outgoing damage **−10%**, capped at **−35%**. Evasion **−25%**, capped at **−60%**. Flat gauge drain of **4** at turn start, capped at **35**.

### Fire — *Singed / Ablaze*
- **T1:** **10** buildup lost on acting. Incoming fire damage **+25%**, capped at **+100%**.
- **T2:** burn tick of **10**, plus **5 per 100** buildup, at turn start. Consumes **50** buildup per tick on a scaling curve, capped at **400**.

### Disorient — *Dazed / Concussed*
- **T1:** ability costs **+25%**, capped at **+75%**.
- **T2:** **6** MP drained at turn start, capped at **40**.

### Lacerate — *Bleeding / Hemorrhaging*
- **T1:** acting adds **10** more Lacerate to yourself — the only family that feeds itself.
- **T2:** an end-of-turn tick for **6% of the target's maximum HP x intensity**, reduced by Physical Resist. Its own ramp is `+0.0025 per point`, soft-capping at **22%** around meter 1270.

Lacerate is the only damage family that scales off the *target* rather than off the meter alone, which makes it the one damage-over-time effect that does not fall behind against high-health enemies.

### Expose — *Raw / Flayed*
- **T1:** target's physical damage reduction cut by **10%**, capped at **20%**. Incoming physical-family buildup **+15%**.
- **T2:** attacker crit chance **+15%**, capped at **+25%**. Crit damage **+25%**, capped at **+35%**.

### Disease — *Sickened / Plagued*
- **T1:** healing received **−25%**, capped at **−60%**.
- **T2:** maximum HP reduced **10%** (scaling with intensity, hard-capped at 40%).

### Toxic — *Poisoned / Envenomed*
- **T1:** each turn there is a **30%** chance the meter skips its decay entirely, scaling with intensity to a **75%** cap. Toxic is the stickiest family in the game.
- **T2:** an end-of-turn tick of **10 x intensity**, dealt as **necrotic** damage and reduced by the target's Necrotic Resist.
- **Decay 30** — the lowest of any family, so what is applied stays applied.

Toxic runs its own linear ramp (`+0.0075 per point`, capped at **8.0**) — the same shape as Fire at roughly half the strength.

### Curse — *Hexed / Afflicted*
- **T1:** the meter's own decay is reduced **25%**, capped at **60%**.
- **T2:** decay reduced **50%**, capped at **85%**, and a **1.25x** curse amplification available to riders that read it.

Curse deals no damage of its own. It is a persistence family — it makes itself and its riders hard to shake, and the payoff lives in the skills that consume it.

---

## The three damage-over-time families

Fire, Toxic and Lacerate all deal damage at end of turn, and all three are shaped to do it differently.

| Meter | Lacerate | Toxic | Fire |
|---|---|---|---|
| 200 | 6% max HP | 10 | 20 |
| 300 | 7% max HP | 17 | 35 |
| 500 | 10% max HP | 32 | 65 |
| 800 | 15% max HP | 55 | 110 |
| 1000 | 18% max HP | 70 | 130 |
| 1270 | 22% *(soft cap)* | 80 *(capped)* | 143 |
| 2000 | 22% max HP | 80 | 180 |

**Fire — the spike.** Scales at `+0.01 per point` **and** adds a flat 5 per 100 meter, so it climbs faster than anything else. It pays for that: it consumes **50 of its own meter every tick** (up to 400) and decays fastest at **40**. Fire burns hot and burns out.

**Toxic — the grind.** Scales at `+0.0075 per point` — deliberately half of Fire — with no second term. It consumes nothing, decays slowest at **30**, and at Tier 1 has up to a **75%** chance to skip decay entirely. Half the damage, indefinitely.

**Lacerate — the equaliser.** The only one that scales off the *target's maximum HP* rather than off its own meter, so it is the only damage-over-time effect whose value does not shrink as enemies get bigger. Against a 100 HP target its 22% ceiling is worth 22 a turn, well under Toxic; against a 900 HP boss that same 22% is nearly 200 a turn, more than Fire at any meter. It also feeds itself — anything the target does adds another 10 to the stack.

Put simply: **Fire scales with investment, Toxic scales with patience, and Lacerate scales with the enemy.**

## Consuming buildup

Many strong abilities **consume** a meter rather than adding to it. Two conventions are worth knowing:

- Most consumers spend in **whole 100-point increments** — a target sitting on 350 has 300 drained and keeps the leftover 50, rather than losing the lot.
- Some abilities **require** a tier before they will fire at all, and fizzle for free (no cost, no cooldown) if the tier is not met.
