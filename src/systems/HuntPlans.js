// src/systems/HuntPlans.js
// Hunt Plans v2 (Exploration System v2, chunk 4): what the screens need to
// show a plan, the basic plan, and how the camp vendor stocks and prices
// plans. The rolling itself is ItemFactory's (createItemInstance); the data is
// data/planAffixes.js.

import { createItemInstance, huntPlanView } from './ItemFactory.js';
import { describeModifiers } from './HuntModifiers.js';

const OBJECTIVE_NAMES = { scout: 'Scout', apex: 'Apex', cull: 'Cull', retrieve: 'Retrieve', commune: 'Commune' };
const SIZE_NAMES = { small: 'Small map', medium: 'Medium map', large: 'Large map' };

/** The free basic plan. Made on demand; it never sits in a bag. */
export function makeBasicPlan() {
  return createItemInstance('basic_hunt_plan', { itemLevel: 1 });
}

/** True for the basic plan, which departing does not use up. */
export function isBasicPlan(inst) {
  return huntPlanView(inst).basic;
}

/**
 * A plan as display lines: level and tier (with its implicit), primary
 * objective and size where the base has them, bonus objectives, modifiers.
 */
export function describePlan(inst) {
  const v = huntPlanView(inst);
  const mods = describeModifiers(v.mods);
  return [...describePlanHeader(inst), ...(mods.length ? mods : [v.basic ? 'No modifiers.' : 'No modifiers rolled.'])];
}

/** describePlan without the modifier lines. */
export function describePlanHeader(inst) {
  const v = huntPlanView(inst);
  const lines = [];
  let head = `Item Level ${v.itemLevel}, ${v.tierName}`;
  if (v.implicitCompletionRewardPercent) head += `: +${v.implicitCompletionRewardPercent}% Completion Reward (no effect yet)`;
  lines.push(head);
  if (v.objective) lines.push(`${OBJECTIVE_NAMES[v.objective] || v.objective}, ${SIZE_NAMES[v.size] || v.size} (no effect yet)`);
  for (const o of v.bonusObjectives) {
    const tag = o.from === 'implicit' ? 'Tier III bonus' : 'Bonus';
    lines.push(`${tag}: ${o.def ? `${o.def.name}. ${o.def.doneWhen}` : o.id} (no effect yet)`);
  }
  return lines;
}

// ── The camp plan vendor ─────────────────────────────────────────────────────
// Sells plans up to party level; the Hunt Ticket price rises with item level
// (HUNT_PLANS, owner 2026-09-17). Numbers are placeholders until chunk 13.

/** Hunt Tickets for a plan: one per item level. */
export function planPrice(itemLevel) {
  return Math.max(1, Math.floor(itemLevel));
}

/**
 * The vendor's stock for today, rolled once per in-game day and kept on
 * ProgressionManager (saved). Re-opening the vendor, leaving and coming back,
 * or reloading returns the same stock; a new day (days pass on hunts) rolls a
 * new one. Each slot sells once. `pm` is ProgressionManager; `rollRarity` is
 * the vendor's rarity roller; both passed in so the harness can drive it.
 */
export function currentPlanStock(pm, { partyLevel, rollRarity, rng = Math.random }) {
  const day = pm.getDaysElapsed();
  const s = pm.planVendorStock;
  if (s && s.day === day && Array.isArray(s.slots)) return s;
  pm.planVendorStock = {
    day,
    slots: planStockLevels(partyLevel, 3, rng).map(itemLevel => ({
      rarity: rollRarity(), itemLevel, cost: planPrice(itemLevel), sold: false,
    })),
  };
  return pm.planVendorStock;
}

/** Marks one of today's slots sold. */
export function markPlanSold(pm, slot) {
  const s = pm.planVendorStock?.slots?.[slot];
  if (s) s.sold = true;
}

/**
 * Item levels for the vendor's slots: the first at party level, the rest
 * anywhere from 1 up to it. `rng` for the harness.
 */
export function planStockLevels(partyLevel, slots = 3, rng = Math.random) {
  const top = Math.max(1, Math.min(10, Math.floor(partyLevel) || 1));
  return Array.from({ length: slots }, (_, i) => (i === 0 ? top : 1 + Math.floor(rng() * top)));
}
