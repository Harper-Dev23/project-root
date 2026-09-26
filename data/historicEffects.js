// data/historicEffects.js
//
// The numbers behind the Reeds' Historic items' unique mechanics (chunk 14b;
// vault IMPLEMENTATION_PLAN, "The Reeds' three Historic items — final
// sheet", owner-approved 2026-09-26). An item turns one on through its base
// `effects` block (data/items.js), which ItemFactory.mergeHistoricEffects
// merges into gearEffects.historic for hunters (CharacterBuilder) and enemies
// (CombatScene._equipEnemyItem) alike, so a Ghost Captain's amulet works on
// him exactly as on a hunter.
//
// Readers (every field here has one):
//   GRIEF          CombatScene._applyGrief (the status; its AttackPower mod is
//                  read by applyTypedDamageModifiers like any buff/debuff);
//                  Heavy Heart (onHitGrief) and Sorrowfall lay it; the
//                  Mourning Beast will too (14b-3)
//   SORROWFALL     data/skills.js sorrowfall.apply
//   CURSE_ON_HIT   (values are on the items) CombatScene._applyAbilityToTarget,
//                  after the hit lands: curseOnHitTarget / curseOnHitSelf
//   UNSHRIVEN      CombatLogic.unshrivenPct -> applyGearConversionAndPercent
//                  (after gear conversion, so the amulet's own converted
//                  necrotic counts: the Le'sse lesson)
//   ROOTED         CombatScene._rootedTurnEnd / _moveUnitToSlot /
//                  _addStatusEffects (Immobilize immunity)

/** Grief: -8% damage dealt per stack, 3 stacks at most, 3 of its own turns. */
export const GRIEF = { perStackPct: -8, maxStacks: 3, turns: 3 };

/** Sorrowfall (granted by Burden of Dreams): 180% weapon damage, +25% per
 *  Grief stack on the target. With STR Proficiency 17 it is Flashing Grief:
 *  it lays GRIEF.maxStacks stacks before the blow. */
export const SORROWFALL = { basePct: 180, perGriefPct: 25, flashing: { stat: 'STR', value: 17 } };

/** Curse of the Unshriven (The Unconfessed): while its wearer carries Curse
 *  (tier 1+), +basePct% necrotic dealt AND taken, scaled by the wearer's own
 *  curse meter on the family curve other curse effects use, capped. */
export const UNSHRIVEN = { cap: 60 };

/** Rooted (Sunken Nave): a stack per turn ended without moving, up to 3; each
 *  stack +5 Physical Resist and +15 Resilience. Moving, or being moved,
 *  clears it. While Rooted (1+), Immobilize does not take. */
export const ROOTED = { maxStacks: 3, perStack: { PhysicalResist: 5, Resilience: 15 } };

/** Grief stacks on a unit now. */
export function griefStacks(unit) {
  return (unit?.statusEffects || []).find(se => se?.id === 'grief' && (se.turns || 0) > 0)?.stacks || 0;
}

/** Rooted stacks on a unit now. */
export function rootedStacks(unit) {
  return (unit?.statusEffects || []).find(se => se?.id === 'rooted')?.stacks || 0;
}
