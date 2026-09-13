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
version: 8
updatedAt: 2026-09-13
---
# Weakness Scaling (In Depth)

How the nine families grow, decay and hurt, with the numbers behind each. For what each family broadly does, see [[Weakness System Overview]].

Every table on this page is generated straight from the game's own combat rules, so the numbers always match what happens in a fight.

## Thresholds

- **Tier 1** at **100** buildup
- **Tier 2** at **200** buildup

There is no Tier 3. Buildup beyond 200 is not wasted — it raises **intensity** instead.

## Intensity

Most effects grow with intensity, which is worked out from how far a meter has climbed past Tier 2:

```
intensity = 1 + (overflow / S) ^ exp          overflow = buildup - 200
```

Intensity is exactly **1.0 at 200** in every family. That makes an effect's starting value simply what it does the moment a target reaches Tier 2.

**Intensity has no ceiling.** Instead, each *effect* has its own cap. That split is deliberate: a chance should never reach certainty, but a damage tick can keep climbing for as long as you keep investing.

The curve is **sublinear**, so doubling a meter never doubles its effect. For most families, going from 1200 to 2400 buildup raises intensity by only about 1.6×. That matters, because several hunters can stack the same family at once, and some abilities multiply buildup outright.

Three families have their own shape:

- **Fire** and **Toxic** climb faster than the rest.
- **Lacerate** climbs a little faster than the default early on, then flattens out at high meters.

The other six share the default curve.

One subtlety: an effect doesn't always use its own family's curve. Toxic's chance to skip decay grows at the *default* rate, not Toxic's faster one. The same goes for Expose's critical bonuses and for Disease and Curse. The tables below already account for this.

## Resilience

Incoming buildup is reduced by a percentage curve, not a flat subtraction:

```
reduction = Resilience / (Resilience + 100)
```

So **100 Resilience is exactly a 50% reduction**, 50 gives 33%, and 200 gives 67%. It never reaches 100%. The same percentage applies to every hit, so a small hit is softened but never cancelled, and a large one takes the same proportional cut.

Resilience comes from Wisdom (`WIS × 1`), from gear, and from temporary effects, all added together before the curve.

**Resilience is the only thing that reduces buildup.** Physical, Elemental and Necrotic Resist reduce *damage*, and do nothing to a meter. A target in heavy armour fills its meters at full speed.

Those resists still apply to the damage a family deals once it is active: a Fire burn is elemental, a Toxic tick is necrotic, and a Lacerate bleed is physical.

## Decay

Buildup that is not refreshed is lost at the end of each turn, in three bands:

- **Below 100:** only a light chip, so early buildup has time to stick.
- **100 to 200:** the loss ramps up steadily.
- **Past 200:** it climbs with every hundred points of overflow, up to a per-turn maximum.

A few families break from that pattern:

- **Fire** sheds buildup far faster than anything else once it passes Tier 2, and also loses buildup each time a Singed target acts. It burns hot and burns out.
- **Toxic** decays more slowly than the rest, and at Tier 1 has a chance to skip decay entirely.
- **Curse** reduces its own decay, which makes it hard to shake once it takes hold.

## The three damage-over-time families

Fire, Toxic and Lacerate all deal damage at the end of a turn, but each is built to do it differently.

**Fire — the spike.** Its tick starts gentle and accelerates hard, climbing faster than any other damage in the system. It pays for that with the steepest decay in the game. It rewards investment.

**Toxic — the grind.** Its tick follows the same accelerating shape as Fire's, but weaker. In exchange it lasts: it decays slowest of the three, and it can skip decay outright. It rewards patience.

**Lacerate — the equaliser.** It deals a share of the target's **maximum HP** rather than a fixed amount, so it is the only damage-over-time effect that grows with the size of the enemy. Against a high-health target it outpaces Fire at moderate meters, though Fire's accelerating tick overtakes it deep into the meter, where Lacerate has hit its cap. It also feeds itself: each time a Bleeding target acts, more Lacerate is added.

Put simply: **Fire scales with investment, Toxic with patience, and Lacerate with the enemy.**

## Consuming buildup

Many strong abilities **consume** a meter rather than adding to it. Two conventions are worth knowing:

- Most consumers spend in **whole 100-point increments**. A target on 350 has 300 drained and keeps the leftover 50, rather than losing the lot.
- Some abilities **require** a tier before they will fire at all, and fizzle for free (no cost, no cooldown) if the tier is not met.

<!-- GEN:START - regenerated by tools/gen_weakness_journal.js, do not hand-edit below -->

## Intensity by family

Intensity is **1.0 at 200** buildup in every family, and grows from there with no ceiling. Each effect below carries its own cap instead.

| Family | Curve | At 300 | At 400 | At 600 | At 800 | At 1200 | At 2400 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Lightning** | S 250, exp 0.78 | 1.49 | 1.84 | 2.44 | 2.98 | 3.95 | 6.45 |
| **Cold** | S 250, exp 0.78 | 1.49 | 1.84 | 2.44 | 2.98 | 3.95 | 6.45 |
| **Fire** | S 149, exp 0.78 | 1.73 | 2.26 | 3.16 | 3.96 | 5.41 | 9.17 |
| **Disorient** | S 250, exp 0.78 | 1.49 | 1.84 | 2.44 | 2.98 | 3.95 | 6.45 |
| **Lacerate** | S 250, exp 0.6 | 1.58 | 1.87 | 2.33 | 2.69 | 3.3 | 4.69 |
| **Expose** | S 250, exp 0.78 | 1.49 | 1.84 | 2.44 | 2.98 | 3.95 | 6.45 |
| **Disease** | S 250, exp 0.78 | 1.49 | 1.84 | 2.44 | 2.98 | 3.95 | 6.45 |
| **Toxic** | S 151, exp 0.78 | 1.73 | 2.25 | 3.14 | 3.93 | 5.37 | 9.08 |
| **Curse** | S 250, exp 0.78 | 1.49 | 1.84 | 2.44 | 2.98 | 3.95 | 6.45 |

## Decay per turn

Buildup that is not refreshed is lost at the end of each turn. These are the amounts lost at each meter.

| Family | At 50 | At 150 | At 200 | At 300 | At 400 | At 600 | At 800 | Most per turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Lightning** | 2 | 15 | 28 | 68 | 108 | 180 | 180 | 180 |
| **Cold** | 2 | 15 | 28 | 68 | 108 | 180 | 180 | 180 |
| **Fire** | 2 | 18 | 60 | 110 | 160 | 260 | 340 | 340 |
| **Disorient** | 2 | 15 | 28 | 68 | 108 | 180 | 180 | 180 |
| **Lacerate** | 2 | 15 | 28 | 68 | 108 | 180 | 180 | 180 |
| **Expose** | 2 | 15 | 28 | 68 | 108 | 180 | 180 | 180 |
| **Disease** | 2 | 15 | 28 | 68 | 108 | 180 | 180 | 180 |
| **Toxic** | 2 | 13 | 24 | 58 | 93 | 161 | 180 | 180 |
| **Curse** | 2 | 15 | 28 | 68 | 108 | 180 | 180 | 180 |

## Damage over time

Damage each family deals at the end of the target's turn, before resistances. Fire and Toxic deal a fixed amount set by the meter. Lacerate deals a share of the target's maximum HP.

| Meter | Fire (elemental) | Toxic (necrotic) | Lacerate (physical) |
| --- | --- | --- | --- |
| 200 | 10 | 8 | 5% max HP |
| 300 | 14 | 10 | 8% max HP |
| 400 | 23 | 14 | 9% max HP |
| 600 | 54 | 30 | 11% max HP |
| 800 | 100 | 53 | 13% max HP |
| 1000 | 159 | 82 | 15% max HP |
| 1200 | 229 | 117 | 16% max HP |
| 1600 | 404 | 205 | 19% max HP |
| 2400 | 876 | 441 | 20% max HP *(cap)* |

## Every effect, by family

Values at four meters, the cap each effect stops at, and the meter where it first gets there.

### Lightning — *Zapped / Shocked*

**Zapped:** each jolt deals **1–4** damage. A jolt is added after every other part of the hit, so it is never scaled by skill bonuses, buffs or critical hits.

**Shocked:** each hit rolls some number of extra jolts, each landing independently. A hit always deals its first jolt, plus however many of the extra rolls land.

| Meter | Extra jolt rolls | Chance each lands | Average jolts per hit |
| --- | --- | --- | --- |
| 200 | 4 | 32% | 2.3 |
| 300 | 5 | 43% | 3.2 |
| 400 | 5 | 51% | 3.5 |
| 600 | 6 | 63% | 4.8 |
| 800 | 7 | 73% | 6.1 |
| 1200 | 9 | 90% | 9.1 |
| 1600 | 10 | 90% | 10.0 |
| 2400 | 12 | 90% | 11.8 |

### Cold — *Chilled / Frostbitten*

| Tier | Effect | At 200 | At 400 | At 800 | At 1600 | Cap | Cap reached |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Chilled | Initiative reduced | 15% | 28% | 45% | 73% | 90% | meter 2150 |
| Chilled | Initiative Gauge regeneration reduced | 25% | 46% | 75% | 90% | 90% | meter 1050 |
| Frostbitten | Outgoing damage reduced | 10% | 19% | 30% | 49% | 90% | meter 3760 |
| Frostbitten | Evasion reduced | 20% | 37% | 60% | 90% | 90% | meter 1440 |
| Frostbitten | Initiative Gauge drained at turn start | 4 | 7 | 12 | 19 | 35 | meter 3620 |

### Fire — *Singed / Ablaze*

| Tier | Effect | At 200 | At 400 | At 800 | At 1600 | Cap | Cap reached |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Singed | Fire buildup lost each time the target acts | 23 | 53 | 93 | 158 | none | — |
| Singed | Incoming Fire buildup increased | 34% | 76% | 133% | 200% | 200% | meter 1370 |

Ablaze deals burn damage at the end of each turn; see **Damage over time** above.

### Disorient — *Dazed / Concussed*

| Tier | Effect | At 200 | At 400 | At 800 | At 1600 | Cap | Cap reached |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Dazed | Ability costs increased | 25% | 46% | 75% | 90% | 90% | meter 1050 |
| Concussed | MP drained at turn start | 6 | 11 | 18 | 29 | 40 | meter 2490 |

### Lacerate — *Bleeding / Hemorrhaging*

| Tier | Effect | At 200 | At 400 | At 800 | At 1600 | Cap | Cap reached |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bleeding | Lacerate added to itself each time the target acts | 8 | 15 | 22 | 31 | none | — |

Hemorrhaging deals bleed damage at the end of each turn; see **Damage over time** above.

### Expose — *Raw / Flayed*

| Tier | Effect | At 200 | At 400 | At 800 | At 1600 | Cap | Cap reached |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Raw | Physical damage reduction lowered | 7 pts | 12 pts | 20 pts | 32 pts | 90 pts | beyond 5000 |
| Raw | Incoming Disorient and Lacerate buildup increased | 13% | 23% | 38% | 61% | none | — |
| Flayed | Attacker crit chance increased | 8% | 15% | 25% | 41% | 90% | meter 4820 |
| Flayed | Attacker crit damage increased | 12% | 22% | 35% | 57% | 90% | meter 3050 |

### Disease — *Sickened / Plagued*

| Tier | Effect | At 200 | At 400 | At 800 | At 1600 | Cap | Cap reached |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sickened | Healing received reduced | 20% | 37% | 60% | 90% | 90% | meter 1440 |
| Plagued | Maximum HP reduced | 8% | 15% | 25% | 40% | 40% | meter 1570 |

### Toxic — *Poisoned / Envenomed*

| Tier | Effect | At 200 | At 400 | At 800 | At 1600 | Cap | Cap reached |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Poisoned | Chance each turn that Toxic does not decay | 20% | 37% | 60% | 60% | 60% | meter 810 |

Envenomed deals poison damage at the end of each turn; see **Damage over time** above.

### Curse — *Hexed / Afflicted*

| Tier | Effect | At 200 | At 400 | At 800 | At 1600 | Cap | Cap reached |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hexed | Curse's own decay reduced | 20% | 37% | 60% | 70% | 70% | meter 1010 |
| Afflicted | Curse's own decay reduced | 20% | 37% | 60% | 70% | 70% | meter 1010 |
| Afflicted | Amplification for curse-scaled on-hit effects | ×1.05 | ×1.93 | ×3.12 | ×5.07 | none | — |

<!-- GEN:END -->
