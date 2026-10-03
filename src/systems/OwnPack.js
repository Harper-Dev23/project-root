// src/systems/OwnPack.js
//
// A player's OWN pack on a co-op hunt (owner 2026-09-30, the co-op gaps).
//
// Solo, the hunt pack lives in the hunt (HuntEngine's pack) and the camp bag
// stays in camp (batch 4b chunk 7, the extraction model). On a co-op hunt the
// host's hunt holds the SHARED pack: the Rations everyone pledged and the
// finds, which every save gets a copy of at the end (CoopRewards rule 1).
// What each player chose to bring besides (draughts, chants, spare gear) is
// theirs alone, so it lives in their own save: GameState.flags.coopPack. So
// does their copy of every find (syncFinds, below).
//
//   { code, items: [item instances], copied: { sharedInstanceId: qty } }
//
// While it exists it is that player's active bag (GameState.packHunt, so
// InventorySystem's bag helpers, combat items and mid-hunt equipping all
// use it), and the camp bag is out of reach, exactly as solo. When the hunt
// is taken home it settles by the solo rules (HuntManager.settlePack): an
// exit, or a wipe under Sheltered, brings it back (fresh food spoils);
// a wipe under Watched or Forsaken loses it.
//
// Pure over the flags object it is given, so it is testable headlessly.

import { addToList, stackQty } from './ItemStacks.js';
import { Items } from '../../data/items.js';

// ── Finds (owner 2026-10-02, co-op playtest) ──────────────────────────────────
// Everything the party finds lands in the host's SHARED pack, which is what
// the party eats from and pays events with. Each player also gets a copy of
// every find in their OWN pack the moment it shows up, so they can equip and
// use it mid-hunt as they would solo. `pack.copied` remembers how much of each
// shared entry (by instanceId) this save has copied, so a snapshot seen twice
// copies nothing twice, and the take-home banks only what was never copied.
// Fresh food is left out: it feeds the shared pool and spoils on the way home.

const fresh = (it) => !!Items[it?.id]?.food;
const newId = () => 'itm_' + Math.random().toString(36).slice(2, 10);

/**
 * Copy the shared pack's new finds into this player's own pack. A stack that
 * grew copies only the new units. Returns how many entries were copied.
 * (A shared stack that was spent from and then refilled copies only what
 * rises past its highest count: the cost of not tracking every unit.)
 */
export function syncFinds(flags, found = []) {
  const pack = ownPack(flags);
  if (!pack) return 0;
  const copied = (pack.copied ||= {});
  let n = 0;
  for (const it of found) {
    if (!it?.instanceId || fresh(it)) continue;
    const have = stackQty(it), had = copied[it.instanceId] || 0;
    if (have <= had) continue;
    const copy = JSON.parse(JSON.stringify(it));
    if (had > 0) { copy.instanceId = newId(); copy.qty = have - had; }
    copy._isNew = true;
    addToList((pack.items ||= []), copy);
    copied[it.instanceId] = have;
    n++;
  }
  return n;
}

/** What this save has copied so far ({ instanceId: qty }), for the take-home. */
export function copiedFinds(flags) {
  return { ...(ownPack(flags)?.copied || {}) };
}

/** The finds in `items` this save never copied: what the take-home still banks. */
export function uncopied(items = [], copied = {}) {
  const out = [];
  for (const it of items) {
    const left = stackQty(it) - (copied[it?.instanceId] || 0);
    if (left <= 0) continue;
    out.push(left === stackQty(it) ? it : { ...it, qty: left });
  }
  return out;
}

/** The pack in `flags`, or null. */
export function ownPack(flags) {
  return flags?.coopPack || null;
}

/** Start a pack in `flags` holding `items` (already out of the camp bag). */
export function startOwnPack(flags, { code = null, items = [] } = {}) {
  const pack = { code, items: [] };
  for (const it of items) addToList(pack.items, it);
  flags.coopPack = pack;
  return pack;
}

// The pack is the active bag only while its co-op hunt is running in THIS
// session (the lobby marks it when the map opens). After a reload the town is
// the camp again until the player rejoins; the pack waits in the save.
let liveCode = undefined;
/** The co-op hunt with this lobby code is running here (or null: none is). */
export function markOwnPackLive(code) { liveCode = code === null ? undefined : code; }

/**
 * The pack as the active bag (the shape InventorySystem reads from a hunt:
 * packItems / takeFromPack / putInPack / spendOneFromPack), or null.
 */
export function ownPackHandle(flags) {
  const pack = ownPack(flags);
  if (!pack || liveCode === undefined || pack.code !== liveCode) return null;
  const items = () => (pack.items ||= []);
  return {
    ownPack: true,
    packItems: () => [...items()],
    takeFromPack(instanceId) {
      const i = items().findIndex(x => x?.instanceId === instanceId);
      return i >= 0 ? items().splice(i, 1)[0] : null;
    },
    putInPack(inst) {
      if (!inst) return false;
      addToList(items(), inst);
      return true;
    },
    spendOneFromPack(instanceId) {
      const it = items().find(x => x?.instanceId === instanceId);
      if (!it) return false;
      if (stackQty(it) > 1) it.qty = stackQty(it) - 1;
      else this.takeFromPack(instanceId);
      return true;
    },
  };
}

/**
 * Settle the pack as the hunt ends and clear it. `settlePack` is
 * HuntManager's (passed in, so this module stays free of the game's imports).
 * Returns { home, lost, spoiled } (item lists); `home` is for the camp bag.
 */
export function settleOwnPack(flags, { ending = 'exit', deathRule = 'sheltered', settlePack }) {
  const pack = ownPack(flags);
  if (!pack) return { home: [], lost: [], spoiled: [] };
  const out = settlePack({ pack: { brought: pack.items || [], found: [] }, supplies: 0, deathRule, ending: ending === 'wipe' ? 'wipe' : 'exit' });
  delete flags.coopPack;
  liveCode = undefined;
  return { home: out.home.brought, lost: out.lost.brought, spoiled: out.spoiled };
}
