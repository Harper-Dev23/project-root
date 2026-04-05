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

  // Rarity (text) colors
  rarityCommon:   '#cccccc',
  rarityUncommon: '#33cc33',
  rarityRare:     '#3399ff',
  rarityEpic:     '#cc33cc',
  rarityLegend:   '#ff9933',
};

// Central rarity map for reuse across scenes/UI
export const RARITY_COLORS = {
  common:    COLORS.rarityCommon,
  uncommon:  COLORS.rarityUncommon,
  rare:      COLORS.rarityRare,
  epic:      COLORS.rarityEpic,
  legendary: COLORS.rarityLegend,
};

// Helper if you prefer a function
export const getRarityColor = (rarity = 'common') =>
  RARITY_COLORS[rarity] || RARITY_COLORS.common;


// ---- Fonts ---------------------------------------------------
export const FONTS = {
  heading: {
    fontSize: '28px',
    color: COLORS.text,
    fontFamily: 'Cinzel, Georgia, serif', // Classic, sharp, elegant
  },
  body: {
    fontSize: '18px',
    color: COLORS.subtext,
    fontFamily: 'Cormorant Garamond, Times, serif', // Old-world readable serif
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
