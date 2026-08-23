---
id: systems/stat_calcs
title: "Stat Calculations Overview"
slug: "stat-calculations"
category: "systems"
subtab: "Stat Calcs"
order: 10
tags: ["systems", "stats"]
status: "approved"
teaser: false
requires: []
sort: 10
version: 2
updatedAt: 2026-08-23
---
# Stat Calculations Overview

Every character has six core attributes -- **STR, DEX, CON, INT, WIS, CHA** -- chosen at creation, then adjusted by race and class. Everything below is derived from those six.

## Derived values

| Derived stat | Formula | Notes |
|---|---|---|
| Max HP | `16 + CON x 2` | The flat 16 is a universal floor for Hunters. |
| Max MP | `2 x INT + CHA + WIS` | Deliberately generous. |
| Accuracy | `DEX x 1` | Accuracy beyond what a hit needs rolls over into bonus crit chance. |
| Evasion | `0` | Nothing derives Evasion. It comes only from gear, buffs and weaknesses. |
| Initiative | `CHA x 1` | Fills the Initiative Gauge each turn. |
| Crit Chance | `2 + 0.30 x (STR + DEX + INT)` | All three contribute equally. Capped at 100. |
| Crit Damage | `x1.5` | Flat for everyone; raised only by gear and effects. |
| Physical Resist | `CON x 0.5` | |
| Elemental Resist | `WIS x 0.5 + CHA x 0.5` | The only resist drawing on two attributes. |
| Necrotic Resist | `CHA x 0.5` | |
| Resilience | `WIS x 0.5` | Reduces incoming weakness buildup. |
| MP per turn | `floor(INT / 5)` | Stacks with MP regen from gear. |

## What each attribute actually does

- **STR** -- adds to weapon damage, and feeds Crit Chance.
- **DEX** -- Accuracy (and through Accuracy overflow, extra crit), and feeds Crit Chance.
- **CON** -- Max HP and Physical Resist.
- **INT** -- Max MP, MP regen, and feeds Crit Chance.
- **WIS** -- Elemental Resist, Resilience, and healing done (`floor(WIS / 5)` added to a heal roll).
- **CHA** -- Initiative, Max MP, Elemental Resist and Necrotic Resist.

## Actions per turn

Every Hunter begins each turn with one **Major** action, one **Bonus** action, one **Reaction**, and one **Class** action. These are separate pools -- spending a Major never costs a Bonus. Some abilities are **Free** and cost nothing from any pool.

## Stat-gated weapon skills

A few weapon skills unlock once an attribute crosses a threshold: `DEX 10` for Feinting Jab, `DEX 15` for Barbed Arrow, `STR 10` for Bonecrusher, and `INT 10` for Scorching Ray.
