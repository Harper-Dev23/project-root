// src/systems/logKinds.js
//
// What kind of line a combat log entry is, so a player can hide the noisy kinds.
//
// A single attack commonly writes five or more lines — the hit, then buildup,
// amplification, resilience, tier crossings — and every turn start adds
// initiative and MP bookkeeping. All of it is worth being ABLE to read, but not
// every player wants the log flooded with it. The owner asked for a way to see
// just the damage without losing the rest as an option.
//
// Classified from the line's TEXT, in one place, because the game has well over a
// hundred _log call sites (plus more inside skill apply() functions) and tagging
// each by hand would drift the moment a new line was added. The rules are
// deliberately conservative: anything that reports damage, healing, a miss, a
// death, or WHY an action did not happen is always shown, whatever else the line
// mentions. Hiding "lacks the MP to use X" would leave a player clicking a skill
// that silently does nothing.
//
// Dependency-free, so tools/headless/logkinds.mjs can run the classifier over the
// log of real fights and check what it would hide.

export const LOG_KIND = Object.freeze({
  KEEP: 'keep',         // damage, healing, misses, deaths, refusals — never hidden
  BUILDUP: 'buildup',   // weakness buildup, tiers, decay, amplification
  RESOURCE: 'resource', // initiative and MP bookkeeping
  OTHER: 'other',       // everything else (skill use, statuses) — never hidden
});

// Checked FIRST. A line matching any of these is always shown.
const ALWAYS_SHOW = [
  /\bdamage\b/i,
  /\bheal(s|ed|ing)?\b/i,
  // Anything that moves hit points, including lines that never say "damage":
  // "hemorrhages 12 (5% of Max HP)", "siphons 4 HP", "burns 10 of his own HP".
  /\bHP\b/,
  /\bhemorrhages \d+/i,
  // Damage-over-time ticks: "Ablaze: tick 14.0 (m=300) ⇒ 14 → 11 burn (magic)".
  /\btick\b[^\n]*⇒/i,
  /\b(miss|misses|missed|dodges|dodged|evades|evaded)\b/i,
  /\bcritical\b|\bcrit\b/i,
  /\b(defeated|slain|dies|died|falls|fallen|knocked out|incapacitated)\b/i,
  // Why something did not happen. Hiding these makes a click look broken.
  /\b(lacks|cannot|can't|not enough|no \w+ actions? left|on cooldown|fizzles?|fails|failed|immobilized|refused|unavailable)\b/i,
  // What someone DID. "Ilse uses Mana Shield" mentions mana, but it is the only
  // line saying the skill was used, so it must never be filtered with MP noise.
  /\buses\b/i,
  /\bspends \d+ MP on\b/i,
];

const FAMILY = '(fire|cold|lightning|toxic|disease|curse|disorient|lacerate|expose)';

const BUILDUP = [
  /\bbuildup\b/i,
  /\bweakness(es)?\b|\bweakens\b/i,
  /\bmeter\b/i,
  /\bdecay(s|ed)?\b/i,
  /\bresilience\b/i,
  /\bT[0-2]\b|\btier [0-2]\b/i,
  // A meter moving: "fire 40→80  T0→T1", "bleeds more: Lacerate 30 → 45",
  // "acts while Singed: Fire 60 → 40".
  new RegExp(`\\b${FAMILY}\\s+\\d+\\s*→\\s*\\d+`, 'i'),
  // Expose's armour readout: "Expose: PDR 12%→-3% (−15%)".
  /\bPDR\b/,
  /\b(is|becomes|now) (Raw|Flayed|Singed|Ablaze|Chilled|Frostbitten|Zapped|Shocked|Dazed|Concussed|Bleeding|Hemorrhaging|Poisoned|Envenomed|Sickened|Plagued|Hexed|Afflicted)\b/i,
];

const RESOURCE = [
  /\binitiative\b/i,
  /\bgauge\b/i,
  /\bMP\b/,
  /\bmana\b/i,
];

/** The plain text of a normalized log entry (`{ segments: [{ text }] }`). */
export function entryText(entry) {
  if (!entry || entry.separator) return '';
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry.segments)) return entry.segments.map(s => s?.text ?? '').join('');
  return typeof entry.text === 'string' ? entry.text : '';
}

/** The kind of a log line, from its text. */
export function logKindOf(text) {
  const t = String(text || '');
  if (!t) return LOG_KIND.OTHER;
  if (ALWAYS_SHOW.some(re => re.test(t))) return LOG_KIND.KEEP;
  if (BUILDUP.some(re => re.test(t))) return LOG_KIND.BUILDUP;
  if (RESOURCE.some(re => re.test(t))) return LOG_KIND.RESOURCE;
  return LOG_KIND.OTHER;
}

/**
 * Whether an entry should be drawn under the player's filter settings.
 * `hide` is { buildup: boolean, resource: boolean }. Separators are handled by
 * the renderer, which also collapses runs of them left behind by hidden lines.
 */
export function isEntryShown(entry, hide = {}) {
  if (!entry || entry.separator) return true;
  const kind = entry.kind || logKindOf(entryText(entry));
  if (kind === LOG_KIND.BUILDUP) return !hide.buildup;
  if (kind === LOG_KIND.RESOURCE) return !hide.resource;
  return true;
}

export default { LOG_KIND, entryText, logKindOf, isEntryShown };
