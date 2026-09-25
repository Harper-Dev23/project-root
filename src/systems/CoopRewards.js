// src/systems/CoopRewards.js
//
// What each player's save takes home from a co-op map hunt (Exploration System
// v2, chunk 12d; COOP_EXPLORATION, all seven rules signed off 2026-09-18).
//
// The host's hunt recorded every save-side effect in its LEDGER (CoopHunt.js),
// and every player holds the whole ledger. Each client applies it to its OWN
// save here, by one rule set:
//
//   rule 1  loot and finds: the whole list, COPIED to every save;
//           completion reward and bonus objectives: in full, to every save;
//           XP: the pool split over the WHOLE party, each save paying only its
//           own hunters their share; Hunt Points: to each save's own tribe
//   rule 2  Rations: what is left comes back split by what each player brought
//   rule 4  standing: every Bond records the hunt's favor, false-god standing,
//           Bond price and tribe regard (a tribe named as "the host's own"
//           means each player's own)
//   rule 5  the calendar: every nightfall and daybreak, in every save
//   rule 6  deaths: the region's rule, each save applying it to its own hunters
//   rule 7  a host gone past the grace period: a CLEAN EXIT for the guests from
//           the last snapshot (the pack's finds, the completion reward only if
//           the objectives were done) -- computed by the hunt's own settlePack
//           and exitReward, never re-derived
//
// Applied ONCE per entry: a save keeps how far into each hunt's ledger it has
// applied (GameState.flags.coopHunts), so a player who leaves early and comes
// back, or a reload, never pays anything twice.

import { xpShare } from '../../data/xpTable.js';
import { fellRecord } from './Standing.js';
import { settlePack } from './HuntManager.js';
import { exitReward } from './HuntObjectives.js';
import { restoreMapHunt } from './HuntEngine.js';
import { getZone } from '../../data/zones.js';
import { stackQty } from './ItemStacks.js';

/** The ledger entries a clean exit from this snapshot would have written
 *  (rule 7): what the pack brings home, and the exit's reward. */
export function cleanExitEntries(env) {
  const led = [];
  const record = (verb) => (...args) => { led.push({ verb, args: JSON.parse(JSON.stringify(args)) }); };
  const world = { party: () => [], bankItems: record('bankItems'), awardHuntPoints: record('awardHuntPoints'), awardXP: record('awardXP') };
  const hunt = restoreMapHunt(env.hunt, world, { view: true });
  const s = hunt.getState();
  if (s.finished) return [];                 // it ended properly; the ledger has it
  const reward = exitReward(s);
  const out = settlePack({ pack: s.pack, supplies: s.supplies, deathRule: s.deathRule, ending: 'exit' });
  if (out.home.brought.length) world.bankItems(out.home.brought, { found: false });
  if (out.home.found.length) world.bankItems(out.home.found, { found: true });
  if (reward.huntPoints > 0) world.awardHuntPoints(reward.huntPoints);
  if (reward.xpPool > 0) world.awardXP(reward.xpPool);
  return led;
}

/**
 * This player's share of what the party brought home (rule 2): of the
 * Rations left, each player gets the floor of their fraction of what was
 * brought; the host gets whatever the rounding leaves, and anything brought
 * that is not Rations (the host packed it).
 */
export function broughtShare(items, { contributions = {}, me, hostId }) {
  const total = Object.values(contributions).reduce((t, n) => t + (n || 0), 0);
  const left = items.filter(i => i.id === 'rations').reduce((t, i) => t + stackQty(i), 0);
  const others = items.filter(i => i.id !== 'rations');
  const shareOf = (pid) => (total > 0 ? Math.floor(left * (contributions[pid] || 0) / total) : 0);
  let mine = shareOf(me);
  if (me === hostId) {
    const theirs = Object.keys(contributions).filter(pid => pid !== hostId).reduce((t, pid) => t + shareOf(pid), 0);
    mine = left - theirs;
  }
  const out = me === hostId ? others.map(i => JSON.parse(JSON.stringify(i))) : [];
  const stack = items.find(i => i.id === 'rations');
  if (mine > 0 && stack) out.push({ ...JSON.parse(JSON.stringify(stack)), qty: mine });
  return out;
}

/**
 * Apply ledger entries to ONE save.
 *
 * @param entries   ledger entries, in order ({ verb, args })
 * @param ctx       { me, hostId, contributions, partySize, zoneId, myRefs,
 *                    vitals (final, { ref: { hp, mp, status } }) or null }
 * @param target    the save: { world (GAME_WORLD's shape), hunter(ref) -> the
 *                  saved character or null, awardXPTo(chars, n),
 *                  moveToSlain(char, fell), day() }
 * @returns a summary of what this save took home
 */
export function applyTakeHome(entries, ctx, target) {
  const { me, hostId, contributions = {}, partySize = 1, zoneId = null, myRefs = [] } = ctx;
  const w = target.world;
  const mine = () => myRefs.map(r => target.hunter(r)).filter(Boolean);
  const sum = { huntPoints: 0, xp: 0, items: 0, rations: 0, days: 0, fallen: [], standing: 0 };
  for (const e of entries) {
    const a = e.args || [];
    switch (e.verb) {
      case 'nightFalls': w.nightFalls(); break;
      case 'dayBreaks': w.dayBreaks(); sum.days++; break;
      case 'awardHuntPoints': w.awardHuntPoints(a[0]); sum.huntPoints += a[0] || 0; break;
      case 'awardXP': {
        const share = xpShare(a[0], partySize);
        const living = mine().filter(c => c.status !== 'dead');
        target.awardXPTo(living, share);
        sum.xp += share * living.length;
        break;
      }
      case 'bankItems': {
        const [items = [], opts = {}] = a;
        if (opts.found) { w.bankItems(items.map(i => JSON.parse(JSON.stringify(i))), { found: true }); sum.items += items.length; }
        else {
          const got = broughtShare(items, { contributions, me, hostId });
          if (got.length) w.bankItems(got, { found: false });
          sum.rations += got.filter(i => i.id === 'rations').reduce((t, i) => t + stackQty(i), 0);
        }
        break;
      }
      case 'tribeRep': w.tribeRep(a[0] === OWN_TRIBE ? w.ownTribe() : a[0], a[1]); sum.standing++; break;
      case 'favor': case 'falseGod': case 'bond': case 'rivalDevotion':
        w[e.verb](...a); sum.standing++; break;
      case 'questFlag': case 'lore': w[e.verb](...a); break;
      case 'fell': {
        const [rule, refs = []] = a;
        if (rule === 'sheltered') break;
        const zone = getZone(zoneId);
        const fell = fellRecord({ zoneId, prophet: zone?.divineAlignment ?? null, rule, day: target.day(), god: zone?.falseGod ?? null });
        for (const ref of refs) {
          if (!myRefs.includes(ref)) continue;
          const c = target.hunter(ref);
          if (!c) continue;
          c.status = 'dead';
          target.moveToSlain(c, fell);
          sum.fallen.push(c.name);
        }
        break;
      }
      default: break;   // unknown verbs are skipped, never guessed at
    }
  }
  // The hunters come home as the hunt left them (the dead went to the Slain
  // above; nobody else is down after a hunt).
  if (ctx.vitals) {
    for (const ref of myRefs) {
      const c = target.hunter(ref);
      const v = ctx.vitals[ref];
      if (!c || !v || c.status === 'dead') continue;
      if (Number.isFinite(v.hp)) c.currentHP = Math.max(1, Math.min(c.maxHP ?? v.hp, v.hp));
      if (Number.isFinite(v.mp)) c.currentMP = Math.max(0, Math.min(c.maxMP ?? v.mp, v.mp));
      c.status = 'alive';
    }
  }
  return sum;
}

/**
 * Take a hunt home from this save's RECORD alone (chunk 12d): the player
 * reloaded, and the lobby is gone (the host long gone, or the server
 * restarted). Rule 7's clean exit from the last snapshot the save kept, with
 * whatever of its ledger this save had not applied. Once, like takeHome.
 */
export function takeHomeFromRecord(rec, target) {
  if (!rec?.env || !rec.id) return null;
  const all = target.record();
  const r = all[rec.id] || (all[rec.id] = { applied: 0, closed: false });
  if (r.closed) { target.forget?.(); return null; }
  const led = rec.env.ledger || [];
  const entries = [...led.slice(r.applied), ...cleanExitEntries(rec.env)];
  const sum = applyTakeHome(entries, {
    me: rec.playerId, hostId: rec.hostId, contributions: rec.contributions, partySize: rec.partySize,
    zoneId: rec.zoneId, myRefs: rec.myRefs || [], vitals: rec.env.vitals,
  }, target);
  r.applied = led.length;
  r.closed = true;
  target.forget?.();
  target.save?.();
  return sum;
}

/** How the host's ledger names "the host's own tribe" (tribeRep), so each
 *  player's regard goes to their OWN tribe (rule 4). */
export const OWN_TRIBE = '@own';

// ── The game's save ───────────────────────────────────────────────────────────

/** The real save as a take-home target, and its per-hunt record. */
export async function gameTarget() {
  const GameState = (await import('./GameState.js')).default;
  const ProgressionManager = (await import('./ProgressionManager.js')).default;
  const { GAME_WORLD } = await import('./HuntManager.js');
  const byRef = (ref) => (GameState.characters || []).find(c => (c.instanceId || c.id) === ref)
    || (GameState.party || []).find(c => (c.instanceId || c.id) === ref) || null;
  return {
    world: GAME_WORLD,
    hunter: byRef,
    awardXPTo: (chars, n) => GameState.awardXPTo(chars, n),
    moveToSlain: (c, fell) => GameState.moveToSlain(c, fell),
    day: () => ProgressionManager.getDaysElapsed(),
    record: () => ((GameState.flags ||= {}).coopHunts ||= {}),
    // The hunt this save is in, for a reload (CoopHunt's remember()).
    remember: (rec) => { (GameState.flags ||= {}).coopActive = rec; GameState.save('autosave'); },
    forget: () => { if (GameState.flags) delete GameState.flags.coopActive; },
    save: () => GameState.save('autosave'),
  };
}
