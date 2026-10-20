// data/vignettes.js
//
// Event vignettes (Exploration System v2, chunk 15b): the picture on the left
// of the event screen.
//
// ── How the art works ─────────────────────────────────────────────────────────
// Every event template names its KIND (`art` in data/events.js). Each kind has
// one shared vignette, tinted by region, so a new event needs no new art. An
// event may also name a UNIQUE vignette (`vignette` in data/events.js); until
// that picture is drawn, it shows its kind's.
//
// To add a picture:
//   1. Draw it at 600 × 800 (shown at 300 × 400, drawn at double size).
//      Keep it fairly neutral in colour: the region tint is laid over it.
//   2. Save it as assets/sprites/vignettes/<key>.png, where <key> is a kind
//      below (shrine, water, ...) or a unique name an event uses.
//   3. Add <key> to VIGNETTE_ART. The game loads only what is listed there,
//      and `npm run verify` checks every listed file exists.
// Until a kind's art is listed, the screen draws a placeholder: the kind's
// name and mark on its region's tint.

/** The shared kinds, in the order they were agreed (owner, 2026-10-20). */
export const VIGNETTE_KINDS = {
  shrine:  { name: 'Shrine',        mark: '✝', about: 'prophet shrines, idols, vigils' },
  water:   { name: 'Mud and water', mark: '≈', about: 'mud, pools, tides, voices in the water' },
  cult:    { name: 'Cult camp',     mark: '☩', about: 'cult camps, rites, cult questline steps' },
  trader:  { name: 'Trader',        mark: '⚖', about: 'traders, markets, hermits, other camps' },
  remains: { name: 'Remains',       mark: '☠', about: 'graves, wrecks, carcasses, the wounded' },
  sign:    { name: 'Beast sign',    mark: '⌇', about: 'tracks, signs, blinds, the wild itself' },
  ruin:    { name: 'Ruin',          mark: '⌂', about: 'ruins, stones, cairns, sigils' },
  night:   { name: 'Night',         mark: '☾', about: 'what only comes after dark' },
};

/**
 * The pictures that exist (drawn and saved), by key: a kind, or a unique name.
 * Empty until the first one is drawn. Example: ['shrine', 'lament_pools'].
 */
export const VIGNETTE_ART = [];

/** Region tints laid over a vignette (and the placeholder's ground). */
export const REGION_TINT = {
  reeds_of_gethsemane: 0x7f9a6a,   // reed green
  bay_of_solace: 0x7fb0c8,         // grey-blue sea
  aurora_shores: 0x9a8ac8,         // aurora violet
  cradle_coast: 0xc8a07f,          // warm sand
};
export const DEFAULT_TINT = 0x9a9a8a;

export const vignettePath = (key) => `assets/sprites/vignettes/${key}.png`;
export const vignetteTextureKey = (key) => `vignette_${key}`;

/**
 * Which picture an event shows: its unique vignette if that is drawn, else its
 * kind's if drawn, else none (the placeholder). Returns
 * { kind, art: texture key or null, tint }.
 */
export function vignetteFor(tpl, zoneId, drawn = VIGNETTE_ART) {
  const kind = VIGNETTE_KINDS[tpl?.art] ? tpl.art : 'sign';
  const key = (tpl?.vignette && drawn.includes(tpl.vignette)) ? tpl.vignette
    : drawn.includes(kind) ? kind : null;
  return { kind, art: key ? vignetteTextureKey(key) : null, tint: REGION_TINT[zoneId] ?? DEFAULT_TINT };
}
