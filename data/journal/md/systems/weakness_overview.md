---
id: systems/weakness_overview
title: "Weakness System Overview"
slug: "weakness-system"
category: "systems"
subtab: "Weakness System"
order: 10
tags: ["systems", "weakness", "combat"]
status: "approved"
teaser: false
requires: []
sort: 10
version: 3
updatedAt: 2026-08-23
---
# Weakness System Overview

Nine **weakness families** run alongside ordinary damage. Attacks apply *buildup* to a family; when enough accumulates, the target crosses a tier and begins suffering that family's effects.

## Thresholds

Every family uses the same scale:

- **Tier 1** at **100** buildup
- **Tier 2** at **200** buildup

Buildup **decays** each turn if it is not refreshed, at a rate set per family. Buildup above the Tier 2 threshold is not wasted -- overflow scales the *intensity* of that family's effects, so 380 Lacerate bites harder than 210.

**Resilience** (derived from WIS, plus gear) reduces incoming buildup across every family.

## The nine families

| Family | Tier 1 | Tier 2 | Core identity |
|---|---|---|---|
| Lightning | Zapped | Shocked | Flat damage jolts; tier 2 can trigger multiple hits |
| Cold | Chilled | Frostbitten | Slows the Initiative Gauge; reduces output |
| Fire | Singed | Ablaze | Fuels fire abilities; burn damage at turn end |
| Disorient | Dazed | Concussed | Raises ability costs; drains MP at turn start |
| Lacerate | Bleeding | Hemorrhaging | Percentage health loss over time |
| Expose | Raw | Flayed | Reduced physical defence; then critical vulnerability |
| Disease | Sickened | Plagued | Reduced healing received; then reduced maximum HP |
| Curse | Hexed | Afflicted | Spiritual debilitation and synergy hooks |
| Toxic | Poisoned | Envenomed | Stacking poison damage over time |

For the exact thresholds, the intensity curve, the Resilience formula and every per-family number, see [[Weakness Scaling (In Depth)]].

## Consuming buildup

Many of the strongest abilities do not merely *apply* buildup -- they **consume** it, spending an accumulated meter for a large one-off payoff, then leaving the target's meter reduced or emptied. A few require a specific tier before they can be used at all, and fizzle for free if that tier is not met.

## What actually reduces buildup

**Only Resilience.** Physical, Elemental and Necrotic Resist reduce incoming *damage* — they do nothing whatsoever to incoming buildup. A target in heavy armour still fills its meters at full speed.

That makes Resilience the single defensive stat against the whole weakness system, and it is why Wisdom carries more weight than its damage contribution suggests. Everything else in the buildup pipeline is a multiplier that makes buildup land *harder*: the attacker's gear buildup percentages, vulnerability riders, and Expose's amplification of physical-family buildup.

Damage typing still matters once a family's effects start dealing damage — a Toxic tick is necrotic and *is* reduced by Necrotic Resist, a Fire burn is elemental, a Lacerate bleed is physical. The resist applies to the damage those ticks deal, never to the meter that produced them.
