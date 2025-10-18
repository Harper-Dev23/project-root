---
id: systems/stat_calcs
title: "Stat Calculations Overview"
slug: "stat-calcs"
category: "systems"
subtab: "Stat Calcs"
order: 10
tags: ["systems", "stats"]
status: "approved"
teaser: false
requires: []
sort: 30
icon: icon-stats
version: 1
updatedAt: 2025-10-04
---
# Stat Calculations Overview

This page outlines how core player stats are derived at runtime.

## Primary attributes

- **Strength** drives melee damage scaling and contributes to carry weight.
- **Finesse** affects ranged weapon accuracy and critical chance.
- **Resilience** governs maximum health and reduces incoming physical damage.
- **Resolve** sets maximum spirit and increases resistance to spiritual effects.
- **Focus** improves cooldown recovery and boosts technique damage.

## Derived values

| Derived Stat | Formula (base)                                  | Notes |
|--------------|-------------------------------------------------|-------|
| Max Health   | `100 + (Resilience * 12)`                       | Modified by gear traits and camp bonuses. |
| Max Spirit   | `80 + (Resolve * 10)`                           | Capped by shrine favors and equipped relics. |
| Attack Power | `Weapon Base + (Strength * Weapon Scaling)`     | Scaling varies per weapon archetype. |
| Spell Power  | `Technique Base + (Focus * Technique Scaling)`  | Techniques list their multiplier explicitly. |
| Guard Value  | `Resilience * 0.6`                              | Applies before weakness multipliers. |

## Balancing hooks

- Camp upgrades and tribe favors apply percentage modifiers that stack additively.
- Weakness tiers modify Attack Power and Guard Value multiplicatively after additive bonuses.
- Temporary buffs (skills, items) apply last, so they are easy to sunset when the effect ends.

> Use this sheet for quick reference; the full combat spreadsheet holds granular numbers.
