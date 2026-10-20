// src/systems/PackPlan.js
//
// What goes with the party on a hunt (Exploration System v2, chunk 15f): the
// Pack step of the departure flow, solo and in the co-op lobby. Free of
// Phaser, so it is checked headlessly (tools/headless/packplan.mjs).
//
// ── What can be packed, and whose it is (owner, 2026-10-20) ─────────────────
// Every packable item is one of two kinds, decided by the item, never by the
// player (no extra choice when packing):
//   PARTY  what the party uses together: Rations, the Escape Rope, and food
//          (trade goods events ask for, like fish). In co-op it goes into the
//          one SHARED hunt pack, which events and the map draw on; whatever is
//          left comes home split by who brought it (CoopRewards, rule 2).
//   OWN    what you use in your own fights: draughts, tinctures, chants,
//          tonics, Smoke Pots, spare gear. In co-op it stays in your own pack
//          (OwnPack.js). Solo there is one pack and the kinds only group rows.
// Nothing is ever copied: each item leaves exactly one camp bag.
// Items with no use on a hunt (proficiency tokens, the Tabula Rasa, hunt
// plans, materials and parts) are not offered. Hunt plans have their own step.
//
// ── The plan ─────────────────────────────────────────────────────────────────
//   { rations, items: { itemId: units }, gear: [instanceId] }
// Stackable items are packed by count (units of that id, from any stacks);
// gear and other unstackable items by instance. Rations are counted apart,
// in steps of 10 and capped by rationPackCap.

import { Items } from '../../data/items.js';
import { countInList, takeFromList, stackQty } from './ItemStacks.js';

export const PARTY = 'party';
export const OWN = 'own';

/** The rows of the Pack step, in order. `kind` says whose a group is. */
export const PACK_GROUPS = [
  { id: 'ways', name: 'Ways out', kind: null, about: 'An Escape Rope gets the party out of an event it is committed to; a Smoke Pot gets it out of a fight.' },
  { id: 'potions', name: 'Draughts and tinctures', kind: OWN, about: 'Drunk in a fight, as a bonus action, by the hunter who uses one.' },
  { id: 'chants', name: 'Chants and tonics', kind: OWN, about: 'Used in a fight: Severing Chants cut a soul-bond, tonics read gear.' },
  { id: 'food', name: 'Food and trade goods', kind: PARTY, about: 'Eaten on the way, or asked for by an event. Fresh food spoils on the way home.' },
  { id: 'gear', name: 'Spare gear', kind: OWN, about: 'Equipped on the map, if a hunter needs it.' },
];

/** The Ways-out items, always shown even with none in camp (the Draughtwell sells them). */
export const WAYS_OUT = ['escape_rope', 'smoke_pot'];

const GEAR_TYPES = ['weapon', 'armor', 'armour', 'jewelry', 'shield', 'offhand'];

/** Which group an item goes in, or null when it has no use on a hunt. */
export function groupOf(id) {
  const it = Items[id];
  if (!it || id === 'rations' || it.type === 'huntPlan') return null;
  if (WAYS_OUT.includes(id)) return 'ways';
  const use = it.combatUse?.kind;
  if (use === 'restore') return 'potions';
  if (use === 'sever' || use === 'identify') return 'chants';
  if (use) return 'potions';
  if (it.food || it.type === 'food') return 'food';
  if (GEAR_TYPES.includes(it.type) && !it.natural) return 'gear';
  return null;
}

/** Whose an item is on a co-op hunt: PARTY (the shared pack) or OWN. */
export function kindOf(id) {
  if (id === 'rations' || id === 'escape_rope') return PARTY;
  const g = groupOf(id);
  if (!g) return null;
  if (g === 'ways') return OWN;          // the Smoke Pot: thrown in your own fights
  return PACK_GROUPS.find(x => x.id === g).kind;
}

/** An empty plan. */
export const emptyPlan = () => ({ rations: 0, items: {}, gear: [] });

/**
 * The Pack step's rows from a camp bag: one per stackable item id the bag
 * holds (plus the Ways out, always), one per piece of gear. Each row:
 *   { key, id, group, kind, name, stack, have, packed }
 * where `have` is in camp, `packed` is from the plan (clamped to have).
 */
export function packRows(bag = [], plan = emptyPlan()) {
  const rows = [];
  const seen = new Set();
  for (const it of bag) {
    const g = groupOf(it?.id);
    if (!g || !it?.instanceId) continue;
    if (Items[it.id].stackable) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      const have = countInList(bag, it.id);
      rows.push({ key: it.id, id: it.id, group: g, kind: kindOf(it.id), name: Items[it.id].name, stack: true,
        have, packed: Math.min(have, plan.items?.[it.id] || 0) });
    } else {
      rows.push({ key: it.instanceId, id: it.id, group: g, kind: kindOf(it.id), name: it.displayName || Items[it.id].name,
        stack: false, have: 1, packed: (plan.gear || []).includes(it.instanceId) ? 1 : 0, instanceId: it.instanceId });
    }
  }
  for (const id of WAYS_OUT) {
    if (seen.has(id) || !Items[id]) continue;
    rows.push({ key: id, id, group: 'ways', kind: kindOf(id), name: Items[id].name, stack: true, have: 0, packed: 0 });
  }
  const order = PACK_GROUPS.map(g => g.id);
  return rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name));
}

/** A plan with every count clamped to what the bag holds (and gear that is still there). */
export function clampPlan(bag = [], plan = emptyPlan(), rationCap = Infinity) {
  const out = emptyPlan();
  out.rations = Math.max(0, Math.min(plan.rations || 0, countInList(bag, 'rations'), rationCap));
  for (const [id, n] of Object.entries(plan.items || {})) {
    if (!groupOf(id) || !Items[id]?.stackable) continue;
    const k = Math.max(0, Math.min(n, countInList(bag, id)));
    if (k > 0) out.items[id] = k;
  }
  out.gear = (plan.gear || []).filter(iid => bag.some(it => it?.instanceId === iid && groupOf(it.id) && !Items[it.id].stackable));
  return out;
}

/** Change one row's count by `delta` (a gear row toggles). Returns a new plan. */
export function adjust(plan, row, delta) {
  const p = { rations: plan.rations || 0, items: { ...(plan.items || {}) }, gear: [...(plan.gear || [])] };
  if (row.stack) {
    const n = Math.max(0, Math.min(row.have, (p.items[row.id] || 0) + delta));
    if (n > 0) p.items[row.id] = n; else delete p.items[row.id];
  } else {
    const on = p.gear.includes(row.instanceId);
    if (delta > 0 && !on) p.gear.push(row.instanceId);
    if (delta < 0 && on) p.gear = p.gear.filter(x => x !== row.instanceId);
  }
  return p;
}

/**
 * Gentle reminders for the Review step (owner: "not too much of a pain to
 * remember to take all your stuff"). Warnings, never blocks: something you
 * own and left in camp, or a way out you have none of.
 */
export function reminders(bag = [], plan = emptyPlan()) {
  const out = [];
  for (const id of WAYS_OUT) {
    const have = countInList(bag, id), packed = plan.items?.[id] || 0;
    if (have > 0 && packed === 0) out.push(`No ${Items[id].name} packed (you have ${have} in camp).`);
  }
  const potions = packRows(bag, plan).filter(r => r.group === 'potions');
  if (potions.some(r => r.have > 0) && !potions.some(r => r.packed > 0)) out.push('No draughts or tinctures packed.');
  if ((plan.rations || 0) === 0 && countInList(bag, 'rations') > 0) out.push('No Rations packed: only the camp\'s free issue.');
  return out;
}

/** What the plan packs, as short lines ("2 × Escape Rope"), Rations first. */
export function describePlan(bag = [], plan = emptyPlan()) {
  const lines = [];
  if (plan.rations > 0) lines.push(`${plan.rations} × Rations`);
  for (const r of packRows(bag, plan)) if (r.packed > 0) lines.push(r.stack ? `${r.packed} × ${r.name}` : r.name);
  return lines;
}

/**
 * Take the plan out of the camp bag (in place). Returns { rations, party, own }:
 * the Rations stack (or null), and every other entry taken, split by kind.
 * Solo, the caller packs all of it; co-op, `party` goes to the shared pack and
 * `own` to the player's own. The bag must hold what the plan asks (clampPlan).
 */
export function takePlan(bag, plan) {
  const p = clampPlan(bag, plan);
  const rations = p.rations > 0 ? takeFromList(bag, 'rations', p.rations) : null;
  const party = [], own = [];
  for (const [id, n] of Object.entries(p.items)) {
    const st = takeFromList(bag, id, n);
    if (st) (kindOf(id) === PARTY ? party : own).push(st);
  }
  for (const iid of p.gear) {
    const i = bag.findIndex(it => it?.instanceId === iid);
    if (i >= 0) own.push(...bag.splice(i, 1));
  }
  return { rations, party, own };
}

/** The plan to remember for next time (GameState.flags.lastPack): counts only. */
export function rememberPlan(plan) {
  return { rations: plan.rations || 0, items: { ...(plan.items || {}) } };
}

/** Units in a list of entries, for messages. */
export const unitsOf = (list) => (list || []).reduce((t, it) => t + stackQty(it), 0);

/**
 * One player's pledge to a co-op hunt's SHARED pack (chunk 15f-2), from the
 * server's contributions: { rations, items: { itemId: units } }. Before 15f-2
 * a pledge was a number of Rations; that still reads as one.
 */
export function pledgeOf(c) {
  if (typeof c === 'number') return { rations: Math.max(0, c | 0), items: {} };
  return { rations: Math.max(0, (c?.rations | 0) || 0), items: { ...(c?.items || {}) } };
}

/** The party items of a plan: what it pledges to the shared pack (Rations apart). */
export function partyItemsOf(plan) {
  return Object.fromEntries(Object.entries(plan?.items || {}).filter(([id, n]) => n > 0 && kindOf(id) === PARTY));
}
