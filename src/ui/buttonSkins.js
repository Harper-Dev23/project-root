// src/ui/buttonSkins.js
//
// How a button's face is drawn (owner 2026-09-30, the button art pass). Both
// button kinds use it: createButton (panels, vendors, the hunt map) and
// UIButton (combat's action menu, End Turn, Flee, character creation). Sizes
// never change here, only the face, so no layout moves with the skin.
//
//   bone     a bone plaque: light, chamfered, dark text (the owner's pick to try)
//   bronze   a carved bronze frame on dark wood, gold text
//   classic  the flat silver boxes the game had before
//
// Options > Graphics > Button style switches it (stored locally, like the
// cheat toggles; never in a save). A screen already open keeps its buttons
// until it is reopened.
//
// Later, an asset of the owner's can replace a skin's drawing: add a skin
// whose draw() paints a nine-slice texture, and nothing else changes.

export const BUTTON_SKINS = ['bone', 'bronze', 'classic'];
export const BUTTON_SKIN_NAMES = { bone: 'Bone plaque', bronze: 'Carved bronze', classic: 'Classic' };
const KEY = 'bm_button_skin';
const DEFAULT_SKIN = 'bone';

let cached = null;
export function buttonSkin() {
  if (cached) return cached;
  let v = null;
  try { v = globalThis.localStorage?.getItem(KEY); } catch { v = null; }
  cached = BUTTON_SKINS.includes(v) ? v : DEFAULT_SKIN;
  return cached;
}
export function setButtonSkin(skin) {
  if (!BUTTON_SKINS.includes(skin)) return buttonSkin();
  cached = skin;
  try { globalThis.localStorage?.setItem(KEY, skin); } catch { /* private window: this session only */ }
  return skin;
}
export const isClassicSkin = () => buttonSkin() === 'classic';

// ── Drawing ──────────────────────────────────────────────────────────────────

const chamfer = (w, h, c) => [[-w / 2 + c, -h / 2], [w / 2 - c, -h / 2], [w / 2, -h / 2 + c], [w / 2, h / 2 - c],
  [w / 2 - c, h / 2], [-w / 2 + c, h / 2], [-w / 2, h / 2 - c], [-w / 2, -h / 2 + c]];
function poly(g, pts, fill) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
  if (fill) g.fillPath(); else g.strokePath();
}
const shift = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy]);
function lerpColor(a, b, t) {
  const ch = (c, s) => (c >> s) & 0xff;
  const mix = (s) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}
/** Top-to-bottom shading in a few bands, inside the button's width. */
function bands(g, w, h, top, bot, inset = 1) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    g.fillStyle(lerpColor(top, bot, i / (n - 1)), 1);
    g.fillRect(-w / 2 + inset, -h / 2 + (h * i) / n, w - inset * 2, h / n + 0.5);
  }
}

// Palettes: [top, bottom, border, text] per variant and state.
const BONE = {
  primary: { rest: [0xcfc2a2, 0xa89a76, 0x3a2c1c, '#2b2118'], hover: [0xe4d9ba, 0xc0b18e, 0x3a2c1c, '#120c06'], selected: [0xecd9a0, 0xc4a462, 0x8a5a10, '#2a1800'] },
  danger:  { rest: [0xb57a6a, 0x8a4a3e, 0x4a1a14, '#2a0c08'], hover: [0xcb8c7c, 0x9c5a4c, 0x4a1a14, '#1a0604'], selected: [0xcb8c7c, 0x9c5a4c, 0x8a5a10, '#1a0604'] },
  confirm: { rest: [0xaebb92, 0x808f66, 0x2c3a1c, '#18220c'], hover: [0xc2cea6, 0x93a278, 0x2c3a1c, '#0c1406'], selected: [0xc2cea6, 0x93a278, 0x8a5a10, '#0c1406'] },
};
const BRONZE = {
  primary: { rest: [0x221d17, 0x100d0a, 0x8a6a3a, '#d9c08a'], hover: [0x2e2820, 0x14110d, 0xd8b070, '#fff0c8'], selected: [0x2e2410, 0x140f06, 0xf0c060, '#f0c060'] },
  danger:  { rest: [0x221612, 0x100a08, 0x9a3a2a, '#f0a090'], hover: [0x2e1c16, 0x140c0a, 0xd05040, '#ffd0c8'], selected: [0x2e1c16, 0x140c0a, 0xf0c060, '#f0c060'] },
  confirm: { rest: [0x1a1f14, 0x0c100a, 0x6a8a3a, '#c8e0a0'], hover: [0x222a1a, 0x10140c, 0x9ac060, '#eaffd0'], selected: [0x222a1a, 0x10140c, 0xf0c060, '#f0c060'] },
};

/**
 * Paint a button face into Graphics `g` (cleared first), centred on 0,0.
 * `state`: 'rest' | 'hover' | 'selected'; `variant`: 'primary' | 'danger' |
 * 'confirm' (anything else reads as primary). Returns the text colour to use.
 * Classic is drawn by the buttons' own old code, not here (returns null).
 */
export function drawButtonFace(g, w, h, { state = 'rest', variant = 'primary', skin = buttonSkin() } = {}) {
  g.clear();
  if (skin === 'classic') return null;
  const c = Math.max(2, Math.min(6, Math.floor(h / 5)));
  if (skin === 'bone') {
    const [top, bot, border, text] = (BONE[variant] || BONE.primary)[state] || BONE.primary.rest;
    g.fillStyle(0x000000, 0.5); poly(g, shift(chamfer(w, h, c), 2, 3), true);
    g.fillStyle(bot, 1); poly(g, chamfer(w, h, c), true);
    g.fillStyle(top, 1); poly(g, shift(chamfer(w - 4, h - 6, Math.max(1, c - 1)), 0, -1), true);
    g.lineStyle(state === 'selected' ? 2.5 : 2, border, 1); poly(g, chamfer(w, h, c), false);
    if (h >= 24) { g.lineStyle(1, 0x3a2c1c, 0.3); g.lineBetween(-w / 2 + c + 4, h / 2 - 4, w / 2 - c - 4, h / 2 - 4); }
    return text;
  }
  // bronze
  const [top, bot, border, text] = (BRONZE[variant] || BRONZE.primary)[state] || BRONZE.primary.rest;
  const c2 = Math.max(2, Math.min(7, Math.floor(h / 5)));
  g.fillStyle(0x000000, 0.55); poly(g, shift(chamfer(w, h, c2), 2, 3), true);
  bands(g, w, h, top, bot, 2);
  g.lineStyle(state === 'selected' ? 2.5 : 2, border, 1); poly(g, chamfer(w, h, c2), false);
  if (h >= 24 && w >= 40) { g.lineStyle(1, 0x4a3a22, 1); poly(g, chamfer(w - 8, h - 8, Math.max(1, c2 - 3)), false); }
  if (w >= 60) {
    g.fillStyle(border, 1);
    for (const sx of [-1, 1]) {
      g.beginPath(); g.moveTo(sx * (w / 2 + 4), 0); g.lineTo(sx * w / 2, -4); g.lineTo(sx * (w / 2 - 4), 0); g.lineTo(sx * w / 2, 4);
      g.closePath(); g.fillPath();
    }
  }
  return text;
}
