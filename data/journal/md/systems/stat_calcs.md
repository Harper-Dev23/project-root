---
id: systems/stat_calcs
category: systems
title: Stat Calculations & Turn Basics
excerpt: Derived stats and per-turn action pools used by the combat engine.
tags: [stats, mechanics]
requires: []
sort: 20
icon: icon-stats
version: 1
updatedAt: 2025-10-04
---
# Stat Calculations & Turn Basics

### Key Derived Stats
- **Accuracy** = `round(DEX * 2)`
- **Initiative** = `round(CHA)`
- **Max HP** = `CON * 5`
- **Max MP** — driven primarily by INT/CHA (see master combat doc).

### Action Economy (per turn)
- The active character’s pool resets each turn: `{ major: 1, bonus: 1, class: 1, reaction: 1 }`.

See the Combat System master document for full formulas and edge cases.
