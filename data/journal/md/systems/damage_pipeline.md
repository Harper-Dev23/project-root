---
id: systems/damage_pipeline
title: "Damage Pipeline (In Depth)"
slug: "damage-pipeline"
category: "systems"
subtab: "In Depth"
order: 10
tags: ["systems", "combat", "damage", "reference", "in-depth"]
status: "approved"
teaser: false
requires: []
sort: 10
version: 1
updatedAt: 2026-08-23
---
# Damage Pipeline (In Depth)

Exactly how a hit is calculated, in order. For the short version see [[Combat Basics]].

The single most important rule: **bonuses of the same category are summed first, then applied once.** Two +20% damage bonuses give ×1.40, never ×1.20 × ×1.20 = ×1.44. Where a step *is* genuinely multiplicative, it says so below.

The second: **damage is carried as a floating-point number through every step and floored exactly once, at the very end.** Rounding after each step used to shave a point or two off long chains.

---

## Stage 1 — The swing

**1. Weapon roll.** The weapon's damage die is rolled.

*Dual wielding:* both weapons roll, each contributing at reduced weight, and the two are combined into one swing **before** anything below runs. Crit, gear and procs therefore apply once to the combined figure rather than twice.

**2. Flat weapon riders.** Status effects granting flat weapon damage are added here.

**3. Hit roll.** Attacker Accuracy against target Evasion.

**4. Accuracy overflow → crit.** Accuracy in excess of what the hit needed converts into bonus crit chance (at half weight).

**5. Evasion → crit.** The target's Evasion reduces the attacker's crit chance (at half weight), on a hit that already landed.

**6. Gear damage %.** All Category A gear percentages — global damage, the hidden balance dial, and the matching elemental or necrotic percentage — are **summed into one figure** and applied as a single multiplier.

**7. Flat elemental adds.** Flat fire/cold/lightning/necrotic from gear.

**8. Gear conversions.** In fixed order: physical → elemental, then physical → necrotic, then elemental → necrotic.

**9. Proficiency.** A multiplier derived from the character's highest core attribute.

---

## Stage 2 — The skill

Typed skills continue through a second pass. Damage is split into **physical / elemental / necrotic** components and every step below operates on all three.

**1. Skill percentage.** The skill's own weapon-damage percentage (a 160% skill multiplies by 1.6).

> Where a skill has conditional bonuses of this kind — "160%, plus 30% more against a Lacerated target" — they are **added together first** (160 + 30 = 190%) and applied once. They do not chain.

**1.5. Skill conversion.** Any conversion the skill itself declares, applied here so it only touches the skill's own damage and not the riders below.

**2. Tier-2 type riders.** Flat "+X fire damage"-style riders from weakness tiers, plus flat ring procs. These are **flat additions**, deliberately placed after the skill percentage so a 160% skill does not also inflate a flat +20.

**3. Combat buffs.** All AttackPower status modifiers are **summed into one pool**, and Cold Tier 2's outgoing-damage penalty is subtracted from that same pool before it is applied once. A +30% buff and a −10% Cold penalty is ×1.20, not two separate multiplications.

**4. Critical hit.** ×1.5 by default, applied **after** the skill percentage and combat buffs — so a crit multiplies the fully-built number.

Damage is floored here, once.

---

## Stage 3 — After the hit

**1. Lightning Jolt.** Tier-3 lightning riders are added *after* crit, deliberately, so jolt damage can never be crit-amplified.

**2. Mitigation.** The target's resistance is applied per damage component: Physical Resist against physical, Elemental Resist against elemental, Necrotic Resist against necrotic. Each resist point is **1% reduction**, capped at 95% and floored at −95%.

Expose Tier 1 reduces the target's physical damage reduction before this step, so Expose makes physical hits land harder by shrinking the mitigation rather than inflating the hit.

**3. Ring procs.** A defensive ring proc may halve the incoming total after mitigation.

**4. Splash and repeats.** Area and repeat instances are built from the resolved core hit and run through mitigation on their own targets, at their own reduced weight.

---

## What is *not* in the pipeline

- **Expose does not grant flat bonus damage.** Tier 1 is a physical-mitigation reduction; Tier 2 is crit chance and crit damage. Neither adds a damage percentage.
- **Curse Tier 2 does not amplify curse-tagged abilities.** A "curse" tag means the skill interacts with the Curse family, not that it hits harder.
- A skill carrying an element **tag** does not gain damage from that element's buildup unless the skill itself says so.
