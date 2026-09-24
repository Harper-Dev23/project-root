// src/systems/Revival.js
//
// The ways back for a Slain hunter (Exploration System v2, chunk 10c; design
// in the vault's DEATH_AND_REVIVAL note, decisions 11-13 and owner idea B).
// Numbers live in data/standing.js; who may use which way is
// Standing.routesBack, read off the `fell` record each hunter carries onto
// the Slain roster (chunk 10a).
//
//   intercession  immediate. A Watched death in the lands of the house your
//                 tribe follows; costs INTERCESSION_COST_PER_LEVEL x level of
//                 the Bond's standing with that house, refused if the Bond
//                 cannot pay. Offered at the lodge shrine, and on the spot
//                 after a wipe (10c-2).
//   lesser rite   slow. Any Watched death; RITE_DAYS_BASE + RITE_DAYS_PER_LEVEL
//                 x level days on the save clock (which only moves while
//                 hunting) and RITE_TICKETS_PER_LEVEL x level Hunt Tickets.
//                 The hunter stays on the Slain roster, benched, until
//                 completeRites (GAME_WORLD.dayBreaks) brings them back.
//   Forsaken      neither: a False God's price, chunk 11.
//
// A hunter whose rite is under way is not offered intercession too: the
// offering is already made, and nothing is refunded.
//
// `ctx` is { pm, gs } (ProgressionManager, GameState) so the harness can hand
// in the real ones it set up; the game uses the defaults.

import ProgressionManager from './ProgressionManager.js';
import GameState from './GameState.js';
import { routesBack, spendBond, followedHouse } from './Standing.js';
import {
  INTERCESSION_COST_PER_LEVEL, RITE_DAYS_BASE, RITE_DAYS_PER_LEVEL, RITE_TICKETS_PER_LEVEL,
} from '../../data/standing.js';

const lvl = (char) => Math.max(1, Number(char?.level) || 1);

export function intercessionCost(char) {
  return INTERCESSION_COST_PER_LEVEL * lvl(char);
}

export function riteTerms(char) {
  return { days: RITE_DAYS_BASE + RITE_DAYS_PER_LEVEL * lvl(char), tickets: RITE_TICKETS_PER_LEVEL * lvl(char) };
}

/** What each way back looks like for a Slain hunter right now. */
export function revivalOptions(char, { pm = ProgressionManager } = {}) {
  const st = pm.getStanding();
  const routes = routesBack(st, pm.tribe, char?.fell);
  const house = char?.fell?.house || null;
  const cost = intercessionCost(char);
  const have = house ? (st.bond[house] || 0) : 0;
  const terms = riteTerms(char);
  const day = pm.getDaysElapsed();
  return {
    fell: char?.fell || null,
    intercession: {
      open: routes.intercession && !char.rite,
      house, cost, have, canPay: have >= cost,
    },
    rite: {
      open: routes.rite && !char.rite,
      ...terms, have: pm.huntTickets || 0, canPay: (pm.huntTickets || 0) >= terms.tickets,
      active: char?.rite ? { untilDay: char.rite.untilDay, daysLeft: Math.max(0, char.rite.untilDay - day) } : null,
    },
  };
}

/** Intercede for a Slain hunter now: the Bond pays, the hunter is back in camp. */
export function intercede(char, { pm = ProgressionManager, gs = GameState } = {}) {
  if (!gs.slain.includes(char)) return { ok: false, reason: 'not among the Slain' };
  const o = revivalOptions(char, { pm });
  if (!o.intercession.open) return { ok: false, reason: char.rite ? 'the rite is already under way' : 'no prophet will speak for them' };
  if (!o.intercession.canPay) return { ok: false, reason: 'not enough standing', need: o.intercession.cost - o.intercession.have };
  const paid = spendBond(pm.getStanding(), o.intercession.house, o.intercession.cost);
  if (!paid.ok) return paid;
  gs.reviveFromSlain(char);
  return { ok: true, house: o.intercession.house, cost: o.intercession.cost };
}

/** Begin the lesser rite: pay the offering; the hunter returns when the days have passed. */
export function beginRite(char, { pm = ProgressionManager, gs = GameState } = {}) {
  if (!gs.slain.includes(char)) return { ok: false, reason: 'not among the Slain' };
  const o = revivalOptions(char, { pm });
  if (!o.rite.open) return { ok: false, reason: char.rite ? 'the rite is already under way' : 'the rite cannot reach them' };
  if (!o.rite.canPay) return { ok: false, reason: 'not enough Hunt Tickets', need: o.rite.tickets - o.rite.have };
  pm.huntTickets -= o.rite.tickets;
  const day = pm.getDaysElapsed();
  char.rite = { startDay: day, untilDay: day + o.rite.days };
  return { ok: true, days: o.rite.days, tickets: o.rite.tickets, untilDay: char.rite.untilDay };
}

// ── Intercession on the spot (owner idea B, chunk 10c-2) ─────────────────────
//
// When the party wipes in a Watched region of the house your tribe follows,
// the prophet may speak for the fallen before anyone joins the Slain. Each
// hunter costs what intercession at the lodge would. Nothing here moves a
// hunter: CombatScene decides who falls, and the hunt goes on (HuntEngine
// survive) only if someone was saved.

/**
 * What the prophet offers at a wipe, or null when there is nothing to offer:
 * not Watched, not your followed house's lands, or the Bond cannot pay for
 * even one of the fallen.
 */
export function spotOffer({ rule, house, fallen }, { pm = ProgressionManager } = {}) {
  if (rule !== 'watched' || !house || !fallen?.length) return null;
  const st = pm.getStanding();
  if (followedHouse(st, pm.tribe) !== house) return null;
  const bond = st.bond[house] || 0;
  const hunters = fallen.map(c => ({ char: c, cost: intercessionCost(c) }));
  if (!hunters.some(h => h.cost <= bond)) return null;
  return { house, bond, hunters };
}

/** Pay for the chosen hunters, all or nothing. */
export function payForSpot(house, chars, { pm = ProgressionManager } = {}) {
  const total = chars.reduce((t, c) => t + intercessionCost(c), 0);
  if (!chars.length) return { ok: true, total: 0 };
  const paid = spendBond(pm.getStanding(), house, total);
  return paid.ok ? { ok: true, total } : { ...paid, total };
}

/** Every rite whose days have passed brings its hunter back. Returns who came back. */
export function completeRites(day, { gs = GameState } = {}) {
  const done = (gs.slain || []).filter(c => c.rite && c.rite.untilDay <= day);
  for (const c of done) gs.reviveFromSlain(c);
  return done;
}
