// src/systems/PartsBuyer.js
//
// The Bone Pile keeper buys beast parts for Hunt Tickets (owner 2026-09-29,
// playtest batch 4b chunk 6; batch 3 item 5). Parts had no use and filled the
// camp bag.
//
// Prices: 10 Common or 4 Uncommon parts a ticket, a Rare part 1 ticket, an
// Epic 3 (a Legendary 6). A part from an apex-grade beast ("great": the
// region's apex and the Vowback) pays double; a boss's parts (its loot
// family, data/bosses.js) triple. Only whole tickets are paid: a stack sells
// in bundles, and what is left over stays in the bag.
//
// Pure: the overlay (PartsBuyerOverlay) and the harness hand in the lists.

import { Items } from '../../data/items.js';
import { BOSSES } from '../../data/bosses.js';
import { isItemInstance } from './ItemFactory.js';
import { stackQty } from './ItemStacks.js';

/** Tickets one part of each rarity is worth, before the beast's multiplier. */
export const PART_TICKET_VALUE = { common: 1 / 10, uncommon: 1 / 4, rare: 1, epic: 3, legendary: 6 };
/** An apex-grade beast's parts, and a boss's. */
export const APEX_PART_MULT = 2;
export const BOSS_PART_MULT = 3;

const BOSS_FAMILIES = new Set(Object.values(BOSSES).map(b => b.loot?.family).filter(Boolean));

/** True for a harvested beast part the keeper will buy. */
export function isSellablePart(inst) {
  return isItemInstance(inst) && !!Items[inst.id]?.part && !inst.historic;
}

/** The part's multiplier: boss x3, apex grade x2, else x1. */
export function partMultiplier(inst) {
  if (BOSS_FAMILIES.has(Items[inst.id]?.part?.family)) return BOSS_PART_MULT;
  if (inst.grade === 'great') return APEX_PART_MULT;
  return 1;
}

/**
 * What the keeper pays for one entry: { bundle, ticketsPerBundle, sellable,
 * tickets }. `bundle` parts pay `ticketsPerBundle` whole tickets; `sellable`
 * is how many of the stack go (whole bundles), `tickets` what they pay.
 */
export function partOffer(inst) {
  if (!isSellablePart(inst)) return null;
  const value = (PART_TICKET_VALUE[inst.rarity] ?? PART_TICKET_VALUE.common) * partMultiplier(inst);
  const bundle = value >= 1 ? 1 : Math.ceil(1 / value - 1e-9);
  const ticketsPerBundle = Math.floor(value * bundle + 1e-9);
  const bundles = Math.floor(stackQty(inst) / bundle);
  return { bundle, ticketsPerBundle, sellable: bundles * bundle, tickets: bundles * ticketsPerBundle };
}

/**
 * Sell one entry's whole bundles out of `list` (the camp bag): the rest of
 * the stack stays. Returns the tickets paid (0 if nothing could be sold).
 */
export function sellPart(list, inst, pm) {
  const offer = partOffer(inst);
  if (!offer || offer.sellable <= 0) return 0;
  const left = stackQty(inst) - offer.sellable;
  if (left > 0) inst.qty = left;
  else list.splice(list.indexOf(inst), 1);
  pm.huntTickets = (pm.huntTickets || 0) + offer.tickets;
  return offer.tickets;
}

/** Sell every part in `list` that pays at least a ticket. Returns { tickets, entries }. */
export function sellAllParts(list, pm) {
  let tickets = 0, entries = 0;
  for (const inst of [...list]) {
    const paid = sellPart(list, inst, pm);
    if (paid > 0) { tickets += paid; entries++; }
  }
  return { tickets, entries };
}
