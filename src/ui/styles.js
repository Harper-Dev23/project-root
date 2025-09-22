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

// Optional backward-compat so older files with UI_DEPTH.tooltip still work:
export const UI_DEPTH = { tooltip: DEPTH.TOOLTIP };
