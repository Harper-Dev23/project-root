// src/systems/ItemStacks.js
// Item stacking. Before this, nothing stacked: every item was its own entry.
//
// A stack is an ordinary item instance with a `qty`. Only a base that declares
// `stackable: true` ever gets one, and only an AFFIX-LESS instance of it: two
// items with different rolls can never be merged, because a stack has one set
// of rolls. That is the rule the design needs for both of its users —
// rations (HUNT_STRUCTURE) and, later, common/uncommon beast parts, which drop
// their affixes on harvest and stack by family + slot + rarity (BEAST_PARTS).
// Family and slot are part of a part's base id, so id + rarity is the key.
//
// A missing `qty` means 1. Saves written before stacking existed have no qty
// anywhere, and need no rewriting to stay correct.
//
// Lists here are the plain arrays the game already uses (GameState.inventory,
// a tribe stash, a hunt pack). Merging raises an existing stack's qty in place
// and keeps its instanceId, so anything holding a reference to that stack
// still sees it.

import { Items } from '../../data/items.js';
import { createItemInstance, isItemInstance } from './ItemFactory.js';

/** Units in one entry. A non-stack, or a stack saved before qty existed, is 1. */
export function stackQty(inst) {
  const q = inst?.qty;
  return Number.isInteger(q) && q > 0 ? q : 1;
}

/** True if this instance may sit in a stack: stackable base, no rolls, nothing unique about it. */
export function isStackable(inst) {
  if (!isItemInstance(inst)) return false;
  const base = Items[inst.id];
  if (!base?.stackable) return false;
  if ((inst.prefixes?.length || 0) > 0 || (inst.suffixes?.length || 0) > 0) return false;
  if (inst.unique || inst.historic || inst.renownOrigin || inst.fixedAffixKey) return false;
  return true;
}

/** Two entries that may be merged into one. */
export function canStack(a, b) {
  return isStackable(a) && isStackable(b) && a.id === b.id && a.rarity === b.rarity;
}

/**
 * Put `inst` into `list`, merging into a matching stack when there is one.
 * Mutates and returns `list`. A merge folds the incoming units into the
 * existing entry; the incoming instance is then gone. An unseen incoming
 * stack makes the merged one unseen too, so the "new" dot still appears.
 */
export function addToList(list, inst) {
  if (!isItemInstance(inst)) return list;
  if (isStackable(inst)) {
    const into = list.find(it => it !== inst && canStack(it, inst));
    if (into) {
      into.qty = stackQty(into) + stackQty(inst);
      if (inst._isNew) into._isNew = true;
      return list;
    }
    inst.qty = stackQty(inst);
  }
  list.push(inst);
  return list;
}

/** Total units of a base id across every entry in a list. */
export function countInList(list, id) {
  return (list || []).reduce((n, it) => (isItemInstance(it) && it.id === id ? n + stackQty(it) : n), 0);
}

/**
 * Split `n` units off a stack. Returns the new stack (a fresh instanceId);
 * the source keeps the rest. Refuses (null) unless 0 < n < qty — taking the
 * whole stack is a move, not a split, and the caller should move it.
 */
export function splitStack(inst, n) {
  const have = stackQty(inst);
  if (!isStackable(inst) || !Number.isInteger(n) || n <= 0 || n >= have) return null;
  const part = JSON.parse(JSON.stringify(inst));
  part.instanceId = 'itm_' + Math.random().toString(36).slice(2, 10);
  part.qty = n;
  delete part._isNew;
  inst.qty = have - n;
  return part;
}

/**
 * Take `n` units of base `id` out of `list`, from as many stacks as it takes.
 * Returns one stack holding exactly `n`, or null — and leaves the list
 * untouched — when the list holds fewer than `n`. Emptied entries are removed.
 * Mutates `list`.
 */
export function takeFromList(list, id, n) {
  if (!Number.isInteger(n) || n <= 0 || countInList(list, id) < n) return null;
  let taken = null;
  let need = n;
  for (let i = list.length - 1; i >= 0 && need > 0; i--) {
    const it = list[i];
    if (!isItemInstance(it) || it.id !== id || !isStackable(it)) continue;
    const have = stackQty(it);
    const piece = have <= need ? (list.splice(i, 1), it) : splitStack(it, need);
    need -= stackQty(piece);
    if (taken) taken.qty = stackQty(taken) + stackQty(piece);
    else taken = piece;
  }
  if (need > 0) return null; // unreachable: the count check above guarantees enough
  taken.qty = n;
  delete taken._isNew;
  return taken;
}

/** A fresh stack of `n` units of a stackable base. */
export function makeStack(id, n) {
  if (!Items[id]?.stackable || !Number.isInteger(n) || n <= 0) return null;
  const inst = createItemInstance(id);
  if (inst) inst.qty = n;
  return inst;
}
