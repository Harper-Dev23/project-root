// src/systems/Omens.js
//
// The Omen meter and boss hunt plans (chunk 14b-3; numbers in data/bosses.js).
// Pure functions over a save's parts, so the harness drives them directly:
//   pm   anything with `omens` ({ zoneId: n }) and hasQuestFlag
//   bag  the inventory array boss plans are added to
//
// A boss plan is an ordinary item instance (createItemInstance), so a player
// can hold several and save them up. It is used up only once its boss has been
// fought (14b-4), never at departure.

import { OMEN_FULL, OMEN_BANK, BOSSES } from '../../data/bosses.js';
import { createItemInstance } from './ItemFactory.js';

/** The region's bosses: [{ id, ...def, unlocked }]. */
export function bossesIn(zoneId, pm) {
  return Object.entries(BOSSES)
    .filter(([, b]) => b.zone === zoneId)
    .map(([id, b]) => ({ id, ...b, unlocked: !!pm?.hasQuestFlag?.(b.unlockFlag) }));
}

/** The most a region's meter can hold now. Nothing before a boss there is
 *  unlocked (owner's playtest, 2026-09-27: the questline's free plan and a
 *  meter filled on the way were a double dip), then OMEN_BANK full meters. */
export function omenCap(zoneId, pm) {
  return bossesIn(zoneId, pm).some(b => b.unlocked) ? OMEN_FULL * OMEN_BANK : 0;
}

/** The meter now: { have, full, cap, ready } (ready = full meters to claim). */
export function omenMeter(zoneId, pm) {
  const have = Math.max(0, Math.floor(pm?.omens?.[zoneId] || 0));
  const unlocked = bossesIn(zoneId, pm).some(b => b.unlocked);
  return { have, full: OMEN_FULL, cap: omenCap(zoneId, pm), ready: unlocked ? Math.floor(have / OMEN_FULL) : 0 };
}

/** Book omens to a region, up to its cap. Returns what was added. */
export function addOmens(pm, zoneId, amount) {
  const n = Math.floor(Number(amount) || 0);
  if (!zoneId || n <= 0) return 0;
  pm.omens = pm.omens || {};
  const before = Math.max(0, pm.omens[zoneId] || 0);
  const after = Math.min(omenCap(zoneId, pm), before + n);
  pm.omens[zoneId] = after;
  return after - before;
}

/**
 * Spend one full meter on an unlocked boss's hunt plan, into `bag`.
 * Returns { ok, plan } or { ok: false, reason }.
 */
export function claimBossPlan(pm, bag, bossId) {
  const boss = BOSSES[bossId];
  if (!boss) return { ok: false, reason: 'no such boss' };
  if (!pm?.hasQuestFlag?.(boss.unlockFlag)) return { ok: false, reason: `${boss.name} is not yet known to you` };
  if (omenMeter(boss.zone, pm).have < OMEN_FULL) return { ok: false, reason: 'the omens are not yet enough' };
  pm.omens[boss.zone] -= OMEN_FULL;
  const plan = createItemInstance(boss.plan, { itemLevel: 1 });
  bag.push(plan);
  return { ok: true, plan };
}

/** The step before a boss's first offer is done, and reported to Elder Varek
 *  (`offerAfterStep`, batch 4b chunk 1). A save with no report record counts
 *  as reported, as in quests.js. */
function offerOpen(pm, boss) {
  // `offerAfter` / `offerAfterStep` may each name several: all must hold.
  const flags = [].concat(boss.offerAfter || []);
  if (!flags.every(f => pm?.hasQuestFlag?.(f))) return false;
  const steps = [].concat(boss.offerAfterStep || []);
  if (!steps.length || typeof pm.isStepDone !== 'function') return true;
  return steps.every(id => pm.isStepDone(id));
}

/** Bosses whose first, free offer is waiting: the step before it done, not yet taken. */
export function offersReady(pm, zoneId = null) {
  return Object.entries(BOSSES)
    .filter(([, b]) => (!zoneId || b.zone === zoneId) && offerOpen(pm, b) && !pm.hasQuestFlag(b.unlockFlag))
    .map(([id, b]) => ({ id, ...b }));
}

/**
 * A questline's last step: the tribe gives the first plan free and the boss
 * unlocks. `questFlag` sets the flag on the save. Once only.
 */
export function takeFirstOffer(pm, bag, bossId, questFlag) {
  const boss = BOSSES[bossId];
  if (!boss) return { ok: false, reason: 'no such boss' };
  if (pm.hasQuestFlag(boss.unlockFlag)) return { ok: false, reason: 'already given' };
  if (!offerOpen(pm, boss)) return { ok: false, reason: 'your tribe has nothing to offer yet' };
  const plan = createItemInstance(boss.plan, { itemLevel: 1 });
  bag.push(plan);
  questFlag(boss.unlockFlag);
  return { ok: true, plan };
}
