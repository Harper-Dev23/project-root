// src/ui/styles.js

// ---- Colors --------------------------------------------------
export const COLORS = {
  // Greyscale palette
  background: 0x1a1a1a,
  panelBorder: 0x3c3c3c,
  panelFill: 0x202020,

  // Button tones
  buttonFill: 0x333333,
  buttonHover: 0x555555,

  // Accent colors
  accent: 0x7090a0,
  danger: 0x8c1f1f,

  // Text colors
  text: '#e0e0e0',
  subtext: '#999999',
  border: 0xaaaaaa,

  // HP/MP bar colors
  hpFill: 0xff4444,
  hpBG: 0x222222,
  manaFill: 0x4466ff,
  manaBG: 0x222244,

  // Generic panel fill
  panel: 0x111111,

  // Rarity (text) colors, low to high: common < uncommon < rare < epic <
  // legendary < historic. 'historic' is the top tier for one-of-a-kind
  // quest/story items (e.g. Bloodthirster) — no separate "unique" tier name,
  // this IS that tier, just named to match the historic/renown system.
  rarityCommon:   '#cccccc',
  rarityUncommon: '#33cc33',
  rarityRare:     '#3399ff',
  rarityEpic:     '#cc33cc',
  rarityLegend:   '#ff9933',
  rarityHistoric: '#d4a017',
};

// Central rarity → color map. THE single source of truth for this — every
// other file that needs rarity colors should import RARITY_COLORS (or
// getRarityColor below) from here rather than keeping its own copy. This
// used to be redefined independently in CombatScene.js, InventoryOverlay.js,
// and StashOverlay.js (four separate copies total, one of which had drifted
// to include an ad-hoc 'historic' entry none of the others had) — collapsed
// down to just this one.
export const RARITY_COLORS = {
  common:    COLORS.rarityCommon,
  uncommon:  COLORS.rarityUncommon,
  rare:      COLORS.rarityRare,
  epic:      COLORS.rarityEpic,
  legendary: COLORS.rarityLegend,
  historic:  COLORS.rarityHistoric,
};

// Helper if you prefer a function
export const getRarityColor = (rarity = 'common') =>
  RARITY_COLORS[rarity] || RARITY_COLORS.common;


// ---- Fonts ---------------------------------------------------
export const FONTS = {
  heading: {
    fontSize: '28px',
    color: COLORS.text,
    fontFamily: 'Cinzel, Georgia, Gelasio, serif', // Classic, sharp, elegant
  },
  body: {
    fontSize: '18px',
    color: COLORS.subtext,
    fontFamily: '"Cormorant Garamond", Times, serif', // Old-world readable serif
  },
  button: {
    fontSize: '20px',
    color: COLORS.text,
    fontFamily: 'Lato, Arial, sans-serif', // Clear, modern, readable
  },
  // Added for Tooltip.js and muted UI text
  muted: {
    fontSize: '12px',
    color: '#dddddd',
    fontFamily: 'Arial, sans-serif',
  },
};


// ---- Class Colors --------------------------------------------
export const CLASS_COLORS = {
  Grunt:      '#c0392b',
  Beggar:     '#95a5a6',
  Performer:  '#e67e22',
  Acolyte:    '#f1c40f',
  Scholar:    '#2980b9',
  Shepherd:   '#2ecc71'
};


// ---- Spacing -------------------------------------------------
export const SPACING = {
  padding: 16,
  margin: 12,
  borderRadius: 4, // Smaller radius for harsh edges
  // add more spacing tokens here if needed
};


// ---- Menu Theme ------------------------------------------------
// Single place to tweak the full-screen menu redesign (Character/Party/
// Inventory/Skills/Map/Quest/Tribes/Journal/Options) — silver/dark-gray/
// light-gray/white, replacing the old parchment/stony texture panels.
// Change a value here and every menu that reads it (OverlayFrame.js's
// 'silverMenu' panel style + title color, plus the accentHover swap below)
// picks it up automatically — this is the "try a couple things" knob.
export const MENU_THEME = {
  panelFill:   0x2a2a2e,   // dark charcoal-gray panel body
  panelStroke: 0xb0b4bc,   // light silver-gray border
  panelCorner: 0xd8dce2,   // near-white silver corner ornament
  titleColor:  '#e8eaf0',  // near-white cool silver title text
  // Current muted-yellow hover accent — kept at its existing value so this
  // refactor is a no-visual-change pass; edit this one line to try a new
  // accent color everywhere it's used (menu launch buttons, list rows, etc.)
  accentHover: '#ffffaa',
};

// ---- Panel Styles --------------------------------------------
// Used by GamePanel.js. Pass a key name or a custom config object to createPanel().
export const PANEL_STYLES = {
  // Standard dark info panel — combat log, stat displays
  default: {
    fill:        0x0d0d0d,
    fillAlpha:   0.82,
    stroke:      0x5a4a3a,   // warm dark brown
    strokeWidth: 2,
    radius:      6,
    cornerSize:  10,         // length of the L-bracket arms
    cornerColor: 0xb8922a,   // amber gold
    cornerAlpha: 0.9,
  },
  // Action menus, selection lists
  menu: {
    fill:        0x111111,
    fillAlpha:   0.88,
    stroke:      0x7a6a5a,
    strokeWidth: 2,
    radius:      4,
    cornerSize:  8,
    cornerColor: 0xb8922a,
    cornerAlpha: 0.85,
  },
  // Combat unit slots — kept subtle
  slot: {
    fill:        0x000000,
    fillAlpha:   0.25,
    stroke:      0xaaaaaa,
    strokeWidth: 2,
    radius:      3,
    cornerSize:  6,
    cornerColor: 0xc8a84a,
    cornerAlpha: 0.7,
  },
  // Full-screen menu redesign — silver/gray/white, see MENU_THEME above.
  silverMenu: {
    fill:        MENU_THEME.panelFill,
    fillAlpha:   0.96,
    stroke:      MENU_THEME.panelStroke,
    strokeWidth: 2,
    radius:      6,
    cornerSize:  10,
    cornerColor: MENU_THEME.panelCorner,
    cornerAlpha: 0.9,
  },
};


// ---- Button Styles -------------------------------------------
// Used by Button.js createButton(). Silver resting state → crimson on hover.
export const BUTTON_STYLES = {
  // Standard interactive button — silver outline, BRIGHT SILVER hover.
  // Hover used to be crimson, which read as a warning/destructive cue on
  // ordinary buttons. Amber-gold is already spoken for as the SELECTED state
  // (see UIButton._applyState), so hover lifts toward white instead: the
  // resting silver simply brightens, which reads as "this is under the
  // cursor" without implying anything about what the button does. The
  // `danger` and `confirm` styles below keep their red/green hovers, since
  // there the colour genuinely carries meaning.
  primary: {
    fill:             0x1c1c1c,
    fillAlpha:        0.92,
    stroke:           0x6a7080,   // cool silver-gray border
    strokeWidth:      1.5,
    radius:           4,
    cornerSize:       6,
    cornerColor:      0x8890a8,   // steel blue-silver ornament
    cornerAlpha:      0.8,
    textColor:        '#b8bccf',  // silver text
    hoverFill:        0x2a2f3a,   // lifted slate
    hoverStroke:      0xc8d0e4,   // bright silver border
    hoverTextColor:   '#ffffff',  // white text
    hoverCornerColor: 0xdfe6f5,
    padX: 18,
    padY:  8,
  },
  // Destructive / exit actions — red-tinted resting state
  danger: {
    fill:             0x200808,
    fillAlpha:        0.92,
    stroke:           0x882222,
    strokeWidth:      1.5,
    radius:           4,
    cornerSize:       6,
    cornerColor:      0xaa3333,
    cornerAlpha:      0.8,
    textColor:        '#cc7777',
    hoverFill:        0x300a0a,
    hoverStroke:      0xff3333,
    hoverTextColor:   '#ff8888',
    hoverCornerColor: 0xff4444,
    padX: 18,
    padY:  8,
  },
  // Confirmations / proceed actions — green-tinted
  confirm: {
    fill:             0x0a1a10,
    fillAlpha:        0.92,
    stroke:           0x336644,
    strokeWidth:      1.5,
    radius:           4,
    cornerSize:       6,
    cornerColor:      0x44aa66,
    cornerAlpha:      0.8,
    textColor:        '#88cc99',
    hoverFill:        0x0f2a1a,
    hoverStroke:      0x44ff88,
    hoverTextColor:   '#aaffcc',
    hoverCornerColor: 0x44ff88,
    padX: 18,
    padY:  8,
  },
};


// ---- Depths --------------------------------------------------
// styles.js
export const DEPTH = {
  // World & TownScene
  WORLD: 0,
  WORLD_OVERLAY: 200,

  // Persistent UI (your right panel, HUD, etc.)
  UI_BASE: 1000,
  UI_OVERLAY: 1200,

  // Menus (your showSelectionMenu ~2k)
  MENU: 2000,

  // Modal parts:
  // - Blocker sits ABOVE world, BELOW persistent UI (so it blocks TownScene but not your UI)
  MODAL_BLOCKER: 900,

  // - Panel sits ABOVE everything (including MENU)
  MODAL_PANEL: 2100,

  TOOLTIP: 2200 //TOOLTIPS above all else
    
};

// Shared depth tokens for UI building (kept simple/intuitive)
export const UI_DEPTH = {
  world: DEPTH.WORLD,
  worldOverlay: DEPTH.WORLD_OVERLAY,
  base: DEPTH.UI_BASE,
  overlay: DEPTH.UI_OVERLAY,
  panel: DEPTH.UI_OVERLAY,     // panels/buttons sit on the overlay layer
  menu: DEPTH.MENU,
  modalBlocker: DEPTH.MODAL_BLOCKER,
  modal: DEPTH.MODAL_PANEL,
  tooltip: DEPTH.TOOLTIP       // tooltips are the top-most layer
};
