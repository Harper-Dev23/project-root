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
version: 3
updatedAt: 2026-09-08
---
# Stat Calculations Overview

Every character has six core attributes -- **STR, DEX, CON, INT, WIS, CHA** -- chosen at creation, then adjusted by race and class. Everything below is derived from those six.

## Proficiency

**Proficiency** is what skill requirements are measured against, and it is deliberately *not* the number on your character sheet.

    Proficiency in a stat = half that stat's PERMANENT value, rounded down

Permanent means the points you allocated, plus your race bonus, plus your class bonus. **Gear does not count.** A ring that grants +4 STR raises your Strength and everything Strength derives, but it does not move your Strength Proficiency, and it will never unlock a skill.

That is the point. Access to a skill is something you build toward and keep; it does not appear and vanish as you swap equipment mid-hunt. It also means the requirements can be written against a curve that actually exists, rather than guessing how much a Hunter of a given level happens to be wearing.

Proficiency is shown in brackets beside each attribute, both at creation and on the character panel: `18  (9)`.

Resetting your allocated points -- as the vendor's draught does -- resets Proficiency with them. That is what makes it possible to abandon one weapon and train honestly into another.

## Mastery

**Mastery** is a percentage bonus to all outgoing damage *and* healing, driven by your single best Proficiency, whichever attribute that happens to be.

    Mastery = 2% per point of your highest Proficiency above 5

A Hunter with 20 permanent Dexterity has 10 Dexterity Proficiency, and so +10% Mastery. Because it keys off your best attribute rather than a specific one, no build is forced through Strength to hit respectably.

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
