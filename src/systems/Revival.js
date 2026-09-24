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
  FALSE_GOD_HIDDEN_PER_LEVEL, FALSE_GOD_BOND_PER_LEVEL,
} from '../../data/standing.js';
import { addFalseGod, adjustBond } from './Standing.js';
import { FALSE_GODS } from '../../data/falseGods.js';

const lvl = (char) => Math.max(1, Number(char?.level) || 1);

export function intercessionCost(char) {
  return INTERCESSION_COST_PER_LEVEL * lvl(char);
}

export function riteTerms(char) {
  return { days: RITE_DAYS_BASE + RITE_DAYS_PER_LEVEL * lvl(char), tickets: RITE_TICKETS_PER_LEVEL * lvl(char) };
}

/**
 * A False God's price (chunk 11c-2): the only way back from a Forsaken death.
 * The god of the region they fell in takes them back at once; the price is
 * hidden standing with that god and Bond standing with the house your tribe
 * follows (none if it follows none). Neither can be refused for lack of
 * standing: the Bond may go below 0. Letting them go (letGo) is final.
 */
export function falseGodPrice(char, { pm = ProgressionManager } = {}) {
  const lvl = Math.max(1, Number(char?.level) || 1);
  const house = followedHouse(pm.getStanding(), pm.tribe);
  return { hidden: FALSE_GOD_HIDDEN_PER_LEVEL * lvl, bond: house ? FALSE_GOD_BOND_PER_LEVEL * lvl : 0, house };
}

function payFalseGod(god, chars, pm) {
  const st = pm.getStanding();
  let hidden = 0, bond = 0, house = null;
  for (const c of chars) {
    const p = falseGodPrice(c, { pm });
    hidden += p.hidden; bond += p.bond; house = p.house;
  }
  addFalseGod(st, god, hidden);
  if (house && bond) adjustBond(st, house, -bond);
  return { hidden, bond, house };
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
  const god = char?.fell?.rule === 'forsaken' && FALSE_GODS[char.fell.god] ? char.fell.god : null;
  return {
    fell: char?.fell || null,
    falseGod: {
      open: !!god && !char.fell.lost,
      god, name: god ? FALSE_GODS[god].name : null, lost: !!char?.fell?.lost,
      ...falseGodPrice(char, { pm }),
    },
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

/** Take a False God's price at the lodge: the hunter returns to camp now. */
export function acceptFalseGod(char, { pm = ProgressionManager, gs = GameState } = {}) {
  if (!gs.slain.includes(char)) return { ok: false, reason: 'not among the Slain' };
  const o = revivalOptions(char, { pm });
  if (!o.falseGod.open) return { ok: false, reason: o.falseGod.lost ? 'they are gone' : 'no false god will take them' };
  const paid = payFalseGod(o.falseGod.god, [char], pm);
  gs.reviveFromSlain(char);
  return { ok: true, god: o.falseGod.god, name: o.falseGod.name, ...paid };
}

/** Refuse the False God's price for good: the hunter is lost (the one permanent loss). */
export function letGo(char, { gs = GameState } = {}) {
  if (!gs.slain.includes(char) || char.fell?.rule !== 'forsaken') return { ok: false, reason: 'only a Forsaken death can be let go' };
  char.fell.lost = true;
  return { ok: true };
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

/** A False God's offer at a Forsaken wipe (11c-2): every fallen hunter, at a price. */
export function falseGodOffer({ rule, god, fallen }, { pm = ProgressionManager } = {}) {
  if (rule !== 'forsaken' || !FALSE_GODS[god] || !fallen?.length) return null;
  return { kind: 'falseGod', god, name: FALSE_GODS[god].name, hunters: fallen.map(c => ({ char: c, ...falseGodPrice(c, { pm }) })) };
}

/** Pay a False God for the chosen hunters on the spot. */
export function payFalseGodSpot(god, chars, { pm = ProgressionManager } = {}) {
  return { ok: true, ...payFalseGod(god, chars, pm) };
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
