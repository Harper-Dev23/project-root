---
id: systems/damage_conversion
title: "Damage Conversion"
slug: "damage-conversion"
category: "systems"
subtab: "Combat"
order: 45
tags: ["systems", "combat", "damage", "conversion", "gear", "elemental", "necrotic"]
status: "approved"
teaser: false
requires: []
sort: 45
version: 1
updatedAt: 2026-08-25
---
# Damage Conversion

Every point of damage in the game is one of three types — **Physical**, **Elemental**, or **Necrotic** — and each is mitigated by its own resistance. Conversion is the act of changing a hit's type after it has been rolled but before it lands.

## The hierarchy

There are two kinds of conversion, and they follow different rules.

**Partial conversion** moves a percentage of one type into another, and runs one way only:

**Physical → Elemental → Necrotic**

Along that chain, Necrotic is terminal and Elemental does not revert to Physical. When several partial conversions apply at once they resolve in fixed order — physical to elemental first, then physical to necrotic, then elemental to necrotic.

**Whole-hit overrides ignore the chain entirely.** They are not percentages; they collapse everything you dealt into a single type, in any direction. Raw Force pulls elemental and necrotic back into Physical, which no partial conversion can do.

## Conversion never changes how much damage you deal

Only what kind. Every conversion is a transfer: what leaves one type arrives in another, and the total is identical before and after.

This holds no matter how the conversions stack. Each partial conversion takes its percentage of **what is left** at that moment, not of the original roll — so a 60% physical-to-elemental followed by a 60% physical-to-necrotic converts 60 and then 24 of a 100-point swing, leaving 16 physical. Never 120 points out of 100.

Overrides can't compound either. Only one applies to a hit, and it is a single reassignment rather than an accumulating effect. Conversion cannot loop, cannot double-count, and cannot manufacture damage out of a chain of steps.

## Three sources

**Skill conversion.** Built into an ability, sometimes conditionally. Boulder Toss converts its physical component entirely to elemental, but only against a target already Ablaze. This kind of conversion touches only the ability's *own* damage — a rider or buff added afterward by some other source keeps whatever type it brought with it.

**Gear conversion.** The three Elseth pendants — of Conversion, of Corruption, of the Void — each convert a percentage of one type into the next. Unlike skill conversion, gear conversion applies to the **finished hit**, after the ability, its riders, your buffs and any critical strike have all resolved. It converts whatever you actually ended up dealing.

**Whole-hit override.** The Le'sse bands grant abilities that collapse an entire hit into a single type for a turn — Elemental Overload makes everything elemental, Raw Force everything physical, Sever Spirit everything necrotic. These are absolute, not percentages.

## Why the ordering matters

The two conversion stages sit at deliberately different points.

A skill's own conversion happens early, right after the ability's damage percentage is applied. This keeps it honest: an ability that says it converts *its* damage converts its damage, and does not quietly sweep up a fire rider from your weapon or a buff cast by an ally.

Gear conversion happens late, after everything else. This is what makes conversion chains work at all. An Elemental-to-Necrotic pendant paired with an ability that converts physical to elemental produces necrotic damage — because by the time the pendant looks at the hit, the ability's conversion has already happened and there is elemental damage there to find.

## What conversion carries with it

**Resistance follows the final type.** This is the whole point. Converted damage is mitigated by the resistance matching what it became, not what it started as. A physical swing converted to elemental is reduced by Elemental Resist and completely ignores Physical Resist.

**Gear damage bonuses follow the final type.** A bonus to elemental damage applies to converted elemental damage, because the bonus is calculated after conversion in the same step.

**Buildup follows the final type.** The tribal buildup pendants read the hit's *actual* composition, so converted damage feeds them normally. A Le'sse pendant grants buildup in **its own declared family** regardless of what the ability was thematically — converted damage carries no element of its own, and the pendant supplies one. This is additive: the ability's own buildup is untouched, and the pendant's contribution is added on top. Pairing a Storms pendant with a fire build is therefore a real choice rather than a mistake — you trade depth in one family for reach into two.

## Two things conversion does not touch

**Lightning jolts** are appended after everything, including conversion. A jolt is a consequence of being struck rather than part of the strike, so it is never converted, never scaled by your abilities, and never critical.

**Buffs scoped to a specific damage type** — the kind granted by a status effect, such as a channelled rite that makes your elemental damage burn hotter — resolve *before* gear conversion. They therefore apply only to damage that was **already** that type when the buff was checked. Damage converted afterward by gear does not receive them.

This is a genuine distinction and worth holding onto: a *gear* bonus to elemental damage reaches converted damage, while a *status-effect* bonus to elemental damage does not. Read the former as "you deal elemental damage well" and the latter as "the magic you are channelling burns hotter" — the rite empowers what you cast, not what your jewellery rewrites afterward.

## Related

- [[Weakness System Overview]] — what the buildup families do once filled
- [[Combat Basics]] — where damage rolls come from in the first place
