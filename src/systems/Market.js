// src/systems/Market.js
//
// A cult's black market (data/cultMarkets.js): what its stalls show, and
// buying from them. Pure over the parts of a save it touches, so the harness
// drives it directly:
//   pm   anything with `sinTickets` (ProgressionManager)
//   bag  where the goods go: an object with push(inst) (the camp bag)
// Everything is rolled from `rng` (the game passes Math.random, the harness a
// seeded stream).

import { SHARED_STALLS, CULT_MARKETS } from '../../data/cultMarkets.js';
import { Items } from '../../data/items.js';
import { getZone } from '../../data/zones.js';
import { HUNT_BEASTS, partBaseId } from '../../data/beastParts.js';
import { createItemInstance, getItemComputedData, pickBaseId } from './ItemFactory.js';
import { rollPartRarity } from './PartyStats.js';

const RANK = ['common', 'uncommon', 'rare', 'epic'];
const atLeast = (r, floor) => (RANK.indexOf(r) < RANK.indexOf(floor) ? floor : r);

const plainBase = (it) => !it?.locked && !it?.unique && !it?.natural && !it?.historic && !it?.renownOrigin && !it?.part;
const armorPool = () => Object.entries(Items).filter(([, it]) => it?.type === 'armor' && plainBase(it) && it.slot !== 'ring' && it.slot !== 'amulet').map(([id]) => id);

function weighted(rng, table) {
  const entries = Object.entries(table);
  let x = rng() * entries.reduce((t, [, w]) => t + w, 0);
  for (const [k, w] of entries) { x -= w; if (x < 0) return k; }
  return entries[entries.length - 1][0];
}

/** A market's stalls, each with what it sells and its price: for the screen. */
export function marketView(cultId, pm) {
  const m = CULT_MARKETS[cultId];
  if (!m) return null;
  const stall = (id, def) => ({
    id, name: def.name, kind: def.kind,
    ...(def.kind === 'gamble' ? { cost: def.cost, text: 'A random piece of armour, uncommon to epic. One in a hundred comes up Corrupted.' } : {}),
    ...(def.kind === 'goods' ? { goods: def.goods.map(g => ({ id: g.id, name: Items[g.id]?.name || g.id, cost: g.cost, text: Items[g.id]?.description || '' })) } : {}),
    ...(def.kind === 'part' ? { cost: def.cost, text: `A smuggled beast part, ${def.rarityFloor} or better.` } : {}),
  });
  const stalls = m.stalls.map(id => stall(id, SHARED_STALLS[id]));
  if (m.own) stalls.push(stall(m.own.id, m.own));
  return { cult: cultId, name: m.name, cultName: m.cult, sinTickets: pm?.sinTickets || 0, stalls };
}

/**
 * Buy from a stall: `goodsId` names the item for a goods stall. Spends the
 * price in Sin Tickets and pushes the item into `bag`. Returns
 * { ok, item, name, spent } or { ok: false, reason }.
 */
export function buy(cultId, stallId, { pm, bag, rng = Math.random, itemLevel = 1, zoneId = null, goodsId = null } = {}) {
  const m = CULT_MARKETS[cultId];
  if (!m) return { ok: false, reason: 'no such market' };
  const def = stallId === m.own?.id ? m.own : (m.stalls.includes(stallId) ? SHARED_STALLS[stallId] : null);
  if (!def) return { ok: false, reason: 'no such stall' };
  const good = def.kind === 'goods' ? def.goods.find(g => g.id === goodsId) : null;
  if (def.kind === 'goods' && !good) return { ok: false, reason: 'they do not sell that' };
  const cost = good ? good.cost : def.cost;
  if ((pm.sinTickets || 0) < cost) return { ok: false, reason: `that costs ${cost} Sin Ticket${cost === 1 ? '' : 's'}; you have ${pm.sinTickets || 0}` };

  let item = null;
  if (def.kind === 'goods') item = createItemInstance(good.id, { itemLevel, rng });
  if (def.kind === 'gamble') {
    // Armour only, at every market (owner 2026-10-03, co-op playtest).
    const id = pickBaseId(armorPool(), itemLevel, { maxBaseTier: 2, rng });
    const rarity = weighted(rng, def.rarity);
    const corrupted = rng() < (def.corruptedChance || 0);
    item = id ? createItemInstance(id, { rarity, itemLevel, rng, ...(corrupted ? { renownOrigin: 'corrupted' } : {}) }) : null;
  }
  if (def.kind === 'part') {
    const fams = Object.keys(getZone(zoneId)?.natives || {}).filter(f => HUNT_BEASTS[f]);
    const fam = fams[Math.floor(rng() * fams.length)];
    const slots = Object.keys(HUNT_BEASTS[fam]?.parts || {});
    const slot = slots[Math.floor(rng() * slots.length)];
    const rarity = atLeast(rollPartRarity('prime', 0, rng), def.rarityFloor || 'common');
    item = fam && slot ? createItemInstance(partBaseId(fam, slot), { rarity, itemLevel, rng, rollAffixes: rarity !== 'common' }) : null;
    if (item) item.grade = 'prime';
  }
  if (!item) return { ok: false, reason: 'the stall has nothing to give' };
  pm.sinTickets = (pm.sinTickets || 0) - cost;
  bag.push(item);
  return { ok: true, item, name: getItemComputedData(item)?.name || item.displayName || item.id, spent: cost };
}
