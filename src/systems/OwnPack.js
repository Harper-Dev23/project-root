// src/systems/OwnPack.js
//
// A player's OWN pack on a co-op hunt (owner 2026-09-30, the co-op gaps).
//
// Solo, the hunt pack lives in the hunt (HuntEngine's pack) and the camp bag
// stays in camp (batch 4b chunk 7, the extraction model). On a co-op hunt the
// host's hunt holds the SHARED pack: the Rations everyone pledged and the
// finds, which every save gets a copy of at the end (CoopRewards rule 1).
// What each player chose to bring besides (draughts, chants, spare gear) is
// theirs alone, so it lives in their own save: GameState.flags.coopPack.
//
//   { code, items: [item instances] }
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
