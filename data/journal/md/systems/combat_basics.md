---
id: systems/combat_basics
title: "Combat Basics"
slug: "combat-basics"
category: "systems"
subtab: "Combat"
order: 5
tags: ["systems", "combat"]
status: "approved"
teaser: false
requires: []
sort: 5
version: 2
updatedAt: 2026-08-23
---
# Combat Basics

Battles are turn-based, fought between your party and a set of enemies. Each side fills three positional columns -- **front, mid and back** -- and some skills shift a unit between them.

## Your turn

Every Hunter starts a turn with four separate pools:

- **Major action** -- the turn's main event. Most real attacks cost one.
- **Bonus action** -- a smaller second act. Movement lives here.
- **Class action** -- reserved for your class skill, so using it never costs anything else.
- **Reaction** -- spent outside your own turn, when a prepared trigger fires.

A handful of abilities are **free**: they cost nothing from any pool and stack on top of a normal turn.

## Landing a hit

Attacks roll against the target's Evasion using the attacker's Accuracy. Accuracy beyond what the hit required is not wasted -- the overflow converts into bonus critical chance for that strike.

A critical hit deals **1.5x** damage before gear and effects.

## Damage

Damage resolves through one pipeline in a fixed order: the weapon roll, the skill's own percentage, attribute and gear bonuses, critical multiplication, and finally the target's mitigation. Damage is typed -- **physical**, **elemental** or **necrotic** -- and each type is reduced by its own resistance.

## Initiative

Turn order is set by an **Initiative Gauge** that fills each turn, primarily from Charisma. It is also a resource: some abilities spend accumulated Initiative for a stronger effect, and Cold buildup slows how fast it refills.

## Weaknesses

Alongside damage, attacks apply **weakness buildup** across nine families -- Lightning, Cold, Fire, Disorient, Lacerate, Expose, Disease, Curse and Toxic. Crossing a threshold inflicts that family's effects, and the strongest abilities consume the meter for a payoff. See the [[Weakness System Overview]].

For the exact order of operations, every multiplier, and what is deliberately *not* in the pipeline, see [[Damage Pipeline (In Depth)]].

## Hunt encounters

Fights triggered during a Hunt route into this same system and play out identically -- with no way to flee once engaged.
