---
id: systems/weapon_types
title: "Weapon Types and Handedness"
slug: "weapon-types"
category: "systems"
subtab: "Weapon Types"
order: 10
tags: ["systems", "weapons", "equipment"]
status: "approved"
teaser: false
requires: []
sort: 10
version: 2
updatedAt: 2026-08-23
---
# Weapon Types and Handedness

Thirteen weapon types exist. Each has its own skill list, and a skill will not appear unless the matching weapon is equipped.

## One-handed

`dagger`, `sword_1h`, `spear_1h`, `whip`, `sling`, `wand`, `shield`

One-handed weapons leave the off hand free. Two can be carried at once, and a shield occupies an off hand like any other one-handed item.

## Two-handed

`sword_2h`, `axe_2h`, `mace_2h`, `bow`, `gun`, `staff`

Two-handed weapons occupy both hand slots. Nothing can be equipped alongside them.

## Dual wielding

A Hunter carrying two one-handed weapons swings both. Each contributes its own damage roll at reduced weight, combined before the rest of the damage pipeline runs -- so critical hits, gear bonuses and jewellery procs apply once to the combined swing rather than twice.

## Affixes and handedness

A two-handed weapon rolls larger base damage than a one-hander, so affix ranges are scaled by handedness to keep the two competitive:

- Affixes that apply **per swing** (flat and percentage weapon damage) roll at roughly two-thirds strength on a one-hander.
- Affixes that are **globally additive** (buildup percentage, elemental damage percentage) roll at roughly half.

Shields are exempt from that reduction -- they are not carrying a damage budget to balance against.
