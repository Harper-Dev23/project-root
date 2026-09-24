// src/systems/EventEffects.js
//
// The events engine's rules (Exploration System v2, chunk 11a; design in the
// vault's EVENTS note, decisions in IMPLEMENTATION_PLAN "Chunk 11"). Templates
// live in data/events.js; the hunt engine (HuntEngine) opens and resolves an
// event site with these.
//
// Three layers (EVENTS): effects (the verbs below, one engine consumer each),
// shapes (choice / check / puzzle / offer / trade), and templates (content).
// Adding an event never touches this file; adding a verb or a shape does.
//
// ── Roles ────────────────────────────────────────────────────────────────────
// Text and numbers in a template name roles in braces, filled from where the
// event happens:
//   danger    the region's danger (a number)
//   region    the region's name
//   house     the region's major house, as a name ("Jeremiah")      nullable
//   prophet   the prophet watching the region (a minor counts)      nullable
//   followed  whether your tribe follows that house (true/false)
//   ground    the ground the site is on ("marsh")
//   rival     the rival tribe holding the region's house            nullable
//   beast     the nearest beast family within 3 steps              nullable
//   falsegod  the false god that tempts in this region (11c)        nullable
// A template that uses a nullable role must list it in appears.needs; a site
// whose needs are not met now stays quiet. The validator enforces it.
//
// ── Numbers ──────────────────────────────────────────────────────────────────
// A number may be written as an expression over roles: '{danger}*2+1'. Only
// numbers, + - * / and parentheses; no functions, no names but roles.
//
// ── Effects ──────────────────────────────────────────────────────────────────
// An outcome is a list of effects, each an object with exactly one verb key.
// VERBS below: validate(value) returns an error string or null; apply(value,
// api) does it and returns a line for the player (or null). `api` is what the
// hunt engine hands over (see HuntEngine._eventApi).

import { Items } from '../../data/items.js';

export const SHAPES = ['choice', 'check', 'puzzle', 'offer', 'trade'];
export const ROLES = ['danger', 'region', 'house', 'prophet', 'followed', 'ground', 'rival', 'beast', 'falsegod'];
export const NULLABLE_ROLES = ['house', 'prophet', 'rival', 'beast', 'falsegod'];
export const CORE_STATS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
export const PARTY_CHECK_STATS = ['perception', 'foraging', 'cooking'];
export const HUNGER_STAGES = ['sated', 'fed', 'hungry', 'starving'];
const D20 = 20;

// ── Roles and numbers ────────────────────────────────────────────────────────

/** Every {role} a string uses. */
export function rolesIn(str) {
  return [...String(str ?? '').matchAll(/\{([a-z]+)\}/g)].map(m => m[1]);
}

/** Text with its roles filled. A role with no value reads as an empty string. */
export function fillText(str, roles) {
  return String(str ?? '').replace(/\{([a-z]+)\}/g, (_, r) => (roles?.[r] == null ? '' : String(roles[r])));
}

/**
 * A number, or an expression over roles ('{danger}*2+1'). Throws on anything
 * else, so a typo is caught by the validator rather than read as 0.
 */
export function evalNumber(expr, roles = {}) {
  if (typeof expr === 'number') return expr;
  if (typeof expr !== 'string') throw new Error(`not a number or an expression: ${JSON.stringify(expr)}`);
  const src = expr.replace(/\{([a-z]+)\}/g, (_, r) => {
    const v = roles[r];
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (!Number.isFinite(v)) throw new Error(`role {${r}} is not a number here`);
    return `(${v})`;
  });
  if (!/^[\d\s+\-*/().]+$/.test(src)) throw new Error(`bad expression '${expr}'`);
  let i = 0;
  const peek = () => { while (src[i] === ' ') i++; return src[i]; };
  const num = () => {
    const c = peek();
    if (c === '(') { i++; const v = sum(); if (peek() !== ')') throw new Error(`unclosed ( in '${expr}'`); i++; return v; }
    if (c === '-') { i++; return -num(); }
    const m = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (!m) throw new Error(`bad expression '${expr}'`);
    i += m[0].length;
    return Number(m[0]);
  };
  const prod = () => { let v = num(); for (;;) { const c = peek(); if (c === '*') { i++; v *= num(); } else if (c === '/') { i++; v /= num(); } else return v; } };
  const sum = () => { let v = prod(); for (;;) { const c = peek(); if (c === '+') { i++; v += prod(); } else if (c === '-') { i++; v -= prod(); } else return v; } };
  const v = sum();
  if (peek() !== undefined) throw new Error(`bad expression '${expr}'`);
  return v;
}

/** A modifier on the d20 (EventResolver's rule, kept): floor((stat - 10) / 2). */
export function statModifier(stat = 10) {
  return Math.floor((stat - 10) / 2);
}

/** The same scale for a 0-100 party rating (decision 4): 50 is +0, 100 is +5. */
export function ratingModifier(rating = 50) {
  return Math.floor(rating / 10) - 5;
}

/** A d20 roll, or the die face the player's dice token settled on. */
export function rollD20(rng, roll = null) {
  if (Number.isInteger(roll) && roll >= 1 && roll <= D20) return roll;
  return Math.floor(rng() * D20) + 1;
}

// ── The verbs ────────────────────────────────────────────────────────────────

const isNum = (v) => { try { evalNumber(v, { danger: 1 }); return true; } catch { return false; } };
const numErr = (v) => (isNum(v) ? null : `not a number or an expression over roles: ${JSON.stringify(v)}`);

export const VERBS = {
  text: {
    reader: 'the event panel (the lines a resolution returns)',
    validate: (v) => (typeof v === 'string' && v.length ? null : 'text must be a non-empty string'),
    apply: (v, api) => fillText(v, api.roles),
  },
  huntPoints: {
    reader: 'GAME_WORLD.awardHuntPoints, scaled by the plan\'s huntPointsPercent',
    validate: numErr,
    apply: (v, api) => {
      const n = Math.round(evalNumber(v, api.roles) * (1 + (api.s.mods.huntPointsPercent || 0) / 100));
      if (n > 0) api.world.awardHuntPoints(n);
      return n > 0 ? `+${n} Hunt Points.` : null;
    },
  },
  xp: {
    reader: 'GAME_WORLD.awardXP (a pool split over the party), scaled by the plan\'s xpPercent',
    validate: numErr,
    apply: (v, api) => {
      const n = Math.round(evalNumber(v, api.roles) * (1 + (api.s.mods.xpPercent || 0) / 100));
      if (n > 0) api.world.awardXP?.(n);
      return n > 0 ? `+${n} XP for the party.` : null;
    },
  },
  hp: {
    reader: 'the hunters\' currentHP: one random living hunter, or every one with who: "all"; never below 1',
    validate: (v) => (typeof v === 'object' && v !== null ? numErr(v.amount) || (v.who && v.who !== 'all' && v.who !== 'one' ? 'hp.who is "one" or "all"' : null) : numErr(v)),
    apply: (v, api) => {
      const amount = Math.round(evalNumber(typeof v === 'object' ? v.amount : v, api.roles));
      const living = api.party().filter(c => c.status !== 'dead' && c.status !== 'incapacitated');
      if (!living.length || !amount) return null;
      const who = typeof v === 'object' && v.who === 'all' ? living : [living[Math.floor(api.rng() * living.length)]];
      for (const c of who) c.currentHP = Math.min(c.maxHP, Math.max(1, (c.currentHP || 0) + amount));
      const names = who.length === living.length && who.length > 1 ? 'Every hunter' : who.map(c => c.name).join(', ');
      return amount < 0 ? `${names} lost ${-amount} HP.` : `${names} recovered ${amount} HP.`;
    },
  },
  supplies: {
    reader: 'the hunt\'s supplies (never below 0)',
    validate: numErr,
    apply: (v, api) => {
      const n = evalNumber(v, api.roles);
      const before = api.s.supplies;
      api.s.supplies = Math.max(0, before + n);
      api.s.maxSupplies = Math.max(api.s.maxSupplies, api.s.supplies);
      api.noteSupplies();
      const d = api.s.supplies - before;
      return d ? `${d > 0 ? '+' : ''}${Math.round(d * 10) / 10} supplies.` : null;
    },
  },
  hunger: {
    reader: 'the hunt\'s satedUntil: "sated" keeps the party Sated as a Hearty meal does; "unsated" ends it',
    validate: (v) => (v === 'sated' || v === 'unsated' ? null : 'hunger is "sated" or "unsated"'),
    apply: (v, api) => {
      if (v === 'sated') { api.s.satedUntil = api.s.time + api.SATED_TIME; return 'The party is sated.'; }
      if (api.s.satedUntil > api.s.time) { api.s.satedUntil = api.s.time; return 'The party is no longer sated.'; }
      return null;
    },
  },
  item: {
    reader: 'the hunt pack\'s found list (at risk until the exit)',
    validate: (v) => (!v?.id || !Items[v.id] ? `item: unknown item '${v?.id}'` : numErr(v.qty ?? 1)),
    apply: (v, api) => {
      const qty = Math.max(1, Math.round(evalNumber(v.qty ?? 1, api.roles)));
      api.addItem(v.id, qty);
      return `Found ${qty > 1 ? `${qty} × ` : ''}${Items[v.id].name}.`;
    },
  },
  boon: {
    reader: 'the hunt\'s boon (HuntEngine._earnFavor): favor with the region\'s house',
    validate: numErr,
    apply: (v, api) => {
      const got = api.earnFavor(evalNumber(v, api.roles), 'event');
      return got > 0 ? `${api.roles.house || 'The prophet'} notices (+${Math.round(got * 10) / 10} favor).` : null;
    },
  },
  standing: {
    reader: 'GAME_WORLD.favor (the Bond and your devotion) or, with target: "rival", GAME_WORLD.rivalDevotion',
    validate: (v) => (typeof v === 'object' && v !== null
      ? numErr(v.amount) || (v.target && v.target !== 'bond' && v.target !== 'rival' ? 'standing.target is "bond" or "rival"' : null)
      : numErr(v)),
    apply: (v, api) => {
      const amount = evalNumber(typeof v === 'object' ? v.amount : v, api.roles);
      const house = api.houseId;
      if (!house || !amount) return null;
      if (typeof v === 'object' && v.target === 'rival') {
        if (!api.rivalId) return null;
        api.world.rivalDevotion?.(api.rivalId, house, amount);
        return `${api.roles.rival}'s devotion to ${api.roles.house} ${amount < 0 ? 'falters' : 'grows'}.`;
      }
      api.world.favor?.(house, amount);
      return `${api.roles.house} ${amount < 0 ? 'is displeased' : 'looks on you more kindly'} (${amount > 0 ? '+' : ''}${amount} standing).`;
    },
  },
  tribeRep: {
    reader: 'GAME_WORLD.tribeRep (ProgressionManager.addTribeRep): your own tribe, or the rival holding the region\'s house',
    validate: (v) => (typeof v === 'object' && v !== null && (v.tribe === 'own' || v.tribe === 'rival') ? numErr(v.amount) : 'tribeRep is { tribe: "own" | "rival", amount }'),
    apply: (v, api) => {
      const amount = Math.round(evalNumber(v.amount, api.roles));
      const tribe = v.tribe === 'own' ? api.world.ownTribe?.() : api.rivalId;
      if (!tribe || !amount) return null;
      api.world.tribeRep?.(tribe, amount);
      return `${v.tribe === 'own' ? 'Your tribe' : api.roles.rival} ${amount > 0 ? 'thinks better' : 'thinks less'} of you.`;
    },
  },
  questFlag: {
    reader: 'GAME_WORLD.questFlag (ProgressionManager quest flags; quests read them, src/data/quests.js)',
    validate: (v) => (typeof v === 'string' || typeof v?.clear === 'string' ? null : 'questFlag is a flag name, or { clear: flag }'),
    apply: (v, api) => {
      if (typeof v === 'string') api.world.questFlag?.(v, true);
      else api.world.questFlag?.(v.clear, false);
      return null;
    },
  },
  lore: {
    // A journal entry id ('divinity/lake_genesis'). It unlocks the flag
    // loreFlag(id), which that entry must list in its `requires` to be hidden
    // until then; the validator refuses an entry that does not, so a lore
    // effect can never silently unlock nothing.
    reader: 'GAME_WORLD.lore (JournalState.addUnlock) of loreFlag(entry), which that journal entry requires',
    validate: (v) => (typeof v === 'string' && /^[a-z_]+\/[a-z0-9_]+$/.test(v) ? null : 'lore is a journal entry id, like "divinity/lake_genesis"'),
    apply: (v, api) => { api.world.lore?.(loreFlag(v)); return 'Something here belongs in your journal.'; },
  },
  reveal: {
    reader: 'the hunt\'s fog: tiles within `radius` of the party become remembered',
    validate: (v) => numErr(v?.radius),
    apply: (v, api) => {
      const n = api.revealAround(Math.max(0, Math.round(evalNumber(v.radius, api.roles))));
      return n ? `You see further across the land (${n} tiles).` : null;
    },
  },
  fight: {
    reader: 'the encounter trigger (HuntWorld.makeEncounter): the nearest hostile occupant within 2 steps; `weaken` cuts its members\' HP (fightSpec)',
    validate: (v) => (v === true ? null : typeof v === 'object' && v !== null ? (v.weaken == null ? null : numErr(v.weaken)) : 'fight is true or { weaken }'),
    apply: (v, api) => {
      const weaken = typeof v === 'object' && v.weaken != null ? evalNumber(v.weaken, api.roles) : 0;
      const occ = api.startFight(weaken);
      return occ ? `It comes to a fight.` : null;
    },
  },
  blight: {
    reader: 'the hunt\'s tiles: cleanse the N nearest blighted tiles, or spread blight onto the N nearest clean ones',
    validate: (v) => (v && (v.cleanse != null) !== (v.spread != null) ? numErr(v.cleanse ?? v.spread) : 'blight is { cleanse: N } or { spread: N }'),
    apply: (v, api) => {
      const n = Math.max(0, Math.round(evalNumber(v.cleanse ?? v.spread, api.roles)));
      const done = v.cleanse != null ? api.cleanseNear(n) : api.spreadNear(n);
      if (!done) return null;
      return v.cleanse != null ? `The blight recedes (${done} tile${done === 1 ? '' : 's'}).` : `Blight creeps outward (${done} tile${done === 1 ? '' : 's'}).`;
    },
  },
  falseGod: {
    // { pact: true }: accept the region's false god's pact, or deepen it one
    // level (HuntEngine._pactStep pays the price). A number: hidden standing
    // with that god alone.
    reader: 'HuntEngine._pactStep (the pact, its price) or GAME_WORLD.falseGod (hidden standing)',
    validate: (v) => (v && typeof v === 'object' ? (v.pact === true ? null : 'falseGod is a number or { pact: true }') : numErr(v)),
    apply: (v, api) => {
      if (typeof v === 'object') return api.pactStep();
      const n = evalNumber(v, api.roles);
      if (api.godId && n) api.world.falseGod?.(api.godId, n);
      return null;
    },
  },
  time: {
    reader: 'the clock (HuntEngine._spendTime): the world ticks',
    validate: numErr,
    apply: (v, api) => {
      const n = evalNumber(v, api.roles);
      if (n > 0) api.spendTime(n);
      return null;
    },
  },
};

/** The journal unlock flag a `lore` effect sets for an entry. */
export function loreFlag(entryId) {
  return `lore:${entryId}`;
}

/** The one verb an effect object names, or an error. */
export function verbOf(effect) {
  const keys = Object.keys(effect || {});
  if (keys.length !== 1) return { error: `an effect names exactly one verb (got ${keys.join(', ') || 'none'})` };
  if (!VERBS[keys[0]]) return { error: `unknown verb '${keys[0]}'` };
  return { verb: keys[0], value: effect[keys[0]] };
}

/** Apply an outcome (a list of effects) in order. Returns the lines for the player. */
export function applyEffects(list, api) {
  const lines = [];
  for (const e of list || []) {
    const { verb, value, error } = verbOf(e);
    if (error) throw new Error(error);
    const line = VERBS[verb].apply(value, api);
    if (line) lines.push(line);
  }
  return lines;
}

// ── Where an event may appear (data/events.js `appears`) ──────────────────────

export const APPEARS_KEYS = ['zones', 'houses', 'followed', 'danger', 'grounds', 'setPiece', 'weight', 'maxPerMap',
  'night', 'hunger', 'questFlag', 'notQuestFlag', 'needs', 'pact'];

/**
 * Conditions known when the map is made: region, its house, whether your
 * tribe follows it, danger, the site's ground. `ctx` is
 * { zoneId, house, followed, danger, ground }.
 */
export function staticEligible(tpl, ctx) {
  const a = tpl.appears || {};
  if (a.zones && !a.zones.includes(ctx.zoneId)) return false;
  if (a.houses === 'any' && !ctx.house) return false;
  if (a.houses === 'none' && ctx.house) return false;
  if (Array.isArray(a.houses) && !a.houses.includes(ctx.house)) return false;
  if (a.followed === true && !ctx.followed) return false;
  if (a.followed === false && ctx.followed) return false;
  if (Array.isArray(a.danger) && (ctx.danger < a.danger[0] || ctx.danger > a.danger[1])) return false;
  if (a.grounds && ctx.ground != null && !a.grounds.includes(ctx.ground)) return false;
  return true;
}

/**
 * Conditions checked on arrival: night or day, the party's hunger, quest
 * flags, and the nullable roles the template needs. `ctx` is
 * { isNight, hunger, hasQuestFlag(flag), roles }. Returns null when the site
 * may open, or the reason it stays quiet.
 */
export function dynamicBlock(tpl, ctx) {
  const a = tpl.appears || {};
  if (a.night === true && !ctx.isNight) return 'by day nothing stirs here';
  if (a.night === false && ctx.isNight) return 'nothing stirs here at night';
  if (a.hunger && !a.hunger.includes(ctx.hunger)) return 'nothing here for you now';
  if (a.questFlag && !ctx.hasQuestFlag?.(a.questFlag)) return 'nothing here for you now';
  if (a.notQuestFlag && ctx.hasQuestFlag?.(a.notQuestFlag)) return 'nothing here for you now';
  // A false god's temptations (11c): the first only outside a pact, deeper
  // ones only within one.
  if (a.pact === true && !ctx.pact) return 'nothing here for you now';
  if (a.pact === false && ctx.pact) return 'nothing here for you now';
  for (const r of a.needs || []) if (ctx.roles?.[r] == null) return 'nothing here for you now';
  return null;
}
