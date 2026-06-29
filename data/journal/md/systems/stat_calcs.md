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

Every character has six core stats: **STR, DEX, CON, INT, WIS, CHA** — set at creation, then shifted by race and class bonuses.

## Derived values

| Derived Stat       | Formula                          | Notes |
|---------------------|-----------------------------------|-------|
| Max HP              | `CON * 5`                        | |
| Max MP               | `2*INT + CHA + WIS`               | Deliberately generous. |
| Accuracy             | `DEX * 2`                         | |
| Initiative           | `CHA * 1`                         | Determines turn order. |
| Crit Chance          | scales with `STR + DEX + INT`     | All three contribute equally. |
| Elemental Resist     | `WIS*0.5 + CHA*0.5`                | |
| Physical Resist      | `CON * 0.5`                       | |
| Crit Avoidance       | `WIS * 0.5`                       | |

## Stat-gated weapon skills

Certain weapon skills unlock once a stat crosses a threshold — for example `DEX >= 10` unlocks Feinting Jab, `DEX >= 15` unlocks Barbed Arrow, `STR >= 10` unlocks Bonecrusher, and `INT >= 10` unlocks Scorching Ray.
