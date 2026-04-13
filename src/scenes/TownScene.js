import GameState from '../systems/GameState.js';
import ProgressionManager from '../systems/ProgressionManager.js';
import { LEADER_QUEST_REP_GAIN } from '../systems/TribeRelations.js';
import InventorySystem from '../systems/InventorySystem.js';
import { Items } from '../../data/items.js';
import { COMBAT_SCENARIOS } from '../../data/combatScenarios.js';
import { createItemInstance, getItemComputedData } from '../systems/ItemFactory.js';
import Tooltip from '../ui/Tooltip.js';
import { createPanel } from '../ui/GamePanel.js';
import { SoundManager } from '../systems/SoundManager.js';
import { DevFlags } from '../systems/DevFlags.js';

// ---------------------------------------------------------------------------
// Quest flag config — maps flag IDs to the world coordinates of the "!" marker
// and the tribe vendor inventory contents per tribe.
// ---------------------------------------------------------------------------
const QUEST_FLAG_POSITIONS = {
  tribe_choice:   { x: 857, y: 342 },
  lodge_styx:     { x: 271, y: 199 },
  lodge_zafaar:   { x: 665, y: 52  },
  lodge_elseth:   { x: 935, y: 171 },
  lodge_lesse:    { x: 582, y: 478 },
  tribe_vendor:   { x: 610, y: 404 },
  vendor_row:     { x: 524, y: 344 },
  combat_pit:     { x: 824, y: 56  },
  orientation_bonfire: { x: 683, y: 302 },
  orientation_elder:   { x: 857, y: 342 },
  elder_bonepile:           { x: 857, y: 342 },
  elder_leveling:           { x: 857, y: 342 },
  samuel_mourne:            { x: 837, y: 493 },
  waystone_visit:           { x: 953, y: 404 },
  samuel_waystone_return:   { x: 837, y: 493 },
  // Brief markers — orange !, set before the encounter so the player visits for a briefing
  elseth_leader_brief:      { x: 1059, y: 310 },
  styx_leader_brief:        { x: 305,  y: 298 },
  lesse_leader_brief:       { x: 477,  y: 492 },
  zafaar_leader_brief:      { x: 928,  y: 76  },
  // Challenge markers — set after the encounter; cleared on entry, transitions to handin
  elseth_leader_challenge:  { x: 1059, y: 310 },
  styx_leader_challenge:    { x: 305,  y: 298 },
  lesse_leader_challenge:   { x: 477,  y: 492 },
  zafaar_leader_challenge:  { x: 928,  y: 76  },
  // Hand-in markers — gold ★, cleared when player clicks "Complete Quest"
  elseth_leader_handin:     { x: 1059, y: 310 },
  styx_leader_handin:       { x: 305,  y: 298 },
  lesse_leader_handin:      { x: 477,  y: 492 },
  zafaar_leader_handin:     { x: 928,  y: 76  },
};

// Flag IDs for the four lodge "explore before choosing" prompts.
const LODGE_FLAGS = ['lodge_styx', 'lodge_zafaar', 'lodge_elseth', 'lodge_lesse'];

// Lodge-specific flavour shown BEFORE the player has chosen a tribe.
// Gives enough information to make an informed decision.
const PRE_CHOICE_LODGE_TEXT = {
  styx:   '"The Styx do not rush. We study the wound before we strike."\n\nA hooded figure counts vials of dark liquid without looking up.',
  zafaar: '"Strength is the only argument the Zafaar respect. Prove yours."\n\nThe air smells of smoke and iron. Members spar in the corner.',
  elseth: '"We track, we wait, we strike once. The forest remembers everything."\n\nFurs and antlers line the walls. A hunter sharpens a blade.',
  lesse:  '"The spirit moves through all things. We simply learn to listen."\n\nLanterns sway without wind. A scribe reads at a low table.',
};

// Items each tribe vendor sells, purchasable with 1 Tribe Ticket each.
// Add more as content expands — these are starter placeholders.
const TRIBE_VENDOR_INVENTORY = {
  styx: [
    'crude_dagger', 'healing_potion', 'mana_potion',
    // Amulets
    'styx_amulet_initiative', 'styx_amulet_cooldown', 'styx_amulet_shield',
    // Rings
    'styx_ring_triage', 'styx_ring_remedy', 'styx_ring_weather',
  ],
  zafaar: [
    'crude_sword_1h', 'healing_potion', 'mana_potion',
    // Amulets
    'zafaar_amulet_disorient', 'zafaar_amulet_lacerate', 'zafaar_amulet_expose',
    // Rings
    'zafaar_ring_double_damage', 'zafaar_ring_half_damage', 'zafaar_ring_heal_proc',
  ],
  elseth: [
    'crude_spear_1h', 'healing_potion', 'mana_potion',
    // Amulets
    'elseth_amulet_phys_to_elem', 'elseth_amulet_phys_to_necro', 'elseth_amulet_elem_to_necro',
    // Rings
    'elseth_ring_elem_proc', 'elseth_ring_necro_proc', 'elseth_ring_phys_proc',
  ],
  lesse: [
    'crude_dagger', 'healing_potion', 'mana_potion',
    // Amulets
    'lesse_amulet_cold', 'lesse_amulet_fire', 'lesse_amulet_lightning',
    // Rings
    'lesse_ring_elemental_overload', 'lesse_ring_raw_force', 'lesse_ring_sever_spirit',
  ],
};

// Jewelry (amulets + rings) from each tribe's vendor pool — used as leader quest rewards.
// 3 random pieces are chosen from this pool when the player completes a leader hand-in.
const TRIBE_JEWELRY_POOL = {
  elseth: ['elseth_amulet_phys_to_elem', 'elseth_amulet_phys_to_necro', 'elseth_amulet_elem_to_necro',
           'elseth_ring_elem_proc', 'elseth_ring_necro_proc', 'elseth_ring_phys_proc'],
  styx:   ['styx_amulet_initiative', 'styx_amulet_cooldown', 'styx_amulet_shield',
           'styx_ring_triage', 'styx_ring_remedy', 'styx_ring_weather'],
  lesse:  ['lesse_amulet_cold', 'lesse_amulet_fire', 'lesse_amulet_lightning',
           'lesse_ring_elemental_overload', 'lesse_ring_raw_force', 'lesse_ring_sever_spirit'],
  zafaar: ['zafaar_amulet_disorient', 'zafaar_amulet_lacerate', 'zafaar_amulet_expose',
           'zafaar_ring_double_damage', 'zafaar_ring_half_damage', 'zafaar_ring_heal_proc'],
};

const TRIBE_DISPLAY_NAMES = {
  styx:   'Styx',
  zafaar: 'Zafaar',
  elseth: 'Elseth',
  lesse:  "Le'sse",
};

// Tribe vendor NPC key → tribe ID mapping, so we know which inventory to show.
const VENDOR_KEY_TO_TRIBE = {
  vashra:  'styx',
  baruun:  'zafaar',
  nahlia:  'elseth',
  aivorel: 'lesse',
};

// === Rarity colors ===
const RARITY_COLORS = {
  common: '#cccccc',
  uncommon: '#33cc33',
  rare: '#3399ff',
  epic: '#cc33cc',
  legendary: '#ff9933'
};



// Bias the gamble towards testing higher rarity tiers but still mostly uncommon/rare
function randomRarityForGamble() {
  const r = Math.random();
  if (r < 0.60) return 'uncommon';
  if (r < 0.90) return 'rare';
  return 'epic';
}

// Get all weapon IDs from Items.js
function getWeaponIdPool() {
  return Object.entries(Items)
    .filter(([, it]) => it?.type === 'weapon')
    .map(([id]) => id);
}

function getArmorIdPool() {
  return Object.entries(Items)
    .filter(([, it]) => it?.type === 'armor' && it?.slot !== 'ring' && it?.slot !== 'amulet')
    .map(([id]) => id);
}

function getJewelryIdPool() {
  return Object.entries(Items)
    .filter(([, it]) => it?.type === 'armor' && (it?.slot === 'ring' || it?.slot === 'amulet'))
    .map(([id]) => id);
}

const DERIVED_LABELS = {
  maxHP: 'Max HP',
  maxMP: 'Max MP',
  PhysicalResist: 'Physical Resist',
  ElementalResist: 'Elemental Resist',
  Accuracy: 'Accuracy',
  CritAvoid: 'Crit Avoid'
};

const DEFAULT_VENDOR_FLAVOR = "A selection of traders await behind makeshift stalls.";

function formatStatKey(stat) {
  if (!stat) return stat;
  switch (stat) {
    case 'STR': return 'STR';
    case 'DEX': return 'DEX';
    case 'INT': return 'INT';
    case 'CON': return 'CON';
    case 'WIS': return 'WIS';
    case 'CHA': return 'CHA';
    default:
      return stat.replace(/([A-Z])/g, ' $1').replace(/^\s+/, '').replace(/\b\w/g, s => s.toUpperCase());
  }
}

function formatSigned(value, suffix = '') {
  if (value == null || value === 0) return null;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value}${suffix}`;
}

function formatLabel(str = '') {
  if (!str) return '';
  return str
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, s => s.toUpperCase())
    .replace(/(\d)([a-z])/gi, (_, num, letter) => `${num}${letter.toUpperCase()}`);
}

export default class TownScene extends Phaser.Scene {
  constructor() {
    super({ key: 'TownScene' });
  }

  /**
 * Registers a glow animation with a hoverable hitbox.
 * @param {string} id - unique name (e.g., 'bonfire')
 * @param {object} glowConfig - config for _addGlowManual (x, y, scale, etc.)
 * @param {object} zoneConfig - { x, y, width, height, onClick }
 */
  _registerGlowZone(id, glowConfig, zoneConfig) {
    const glowSprite = this._addGlowManual({
      ...glowConfig,
      startVisible: false
    });
    this[`glow${id}`] = glowSprite;

    const zone = this.add.zone(zoneConfig.x, zoneConfig.y, zoneConfig.width, zoneConfig.height)
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    zone.on('pointerover', () => {
      if (glowSprite) glowSprite.setVisible(true);
    });
    zone.on('pointerout', () => {
      if (glowSprite) glowSprite.setVisible(false);
    });
    zone.on('pointerdown', zoneConfig.onClick);
  }

  _addGlowManual({
    key,
    frames,
    x, y,
    scale = 1,
    fps = 8,
    originX = 0.5,
    originY = 0.5,
    dx = 0, dy = 0,
    alpha = 0.6,
    startVisible = true
  }) {
    if (!this.textures.exists(key)) {
      console.warn('[GLOW] atlas missing:', key);
      return null;
    }

    const animKey = `${key}_anim_manual`;
    if (!this.anims.exists(animKey)) {
      this.anims.create({
        key: animKey,
        frames: frames.map(n => ({ key, frame: n })),
        frameRate: fps,
        yoyo: true,
        repeat: -1
      });
    }

    const s = this.add.sprite(x + dx, y + dy, key, frames[0])
      .setOrigin(originX, originY)
      .setScale(scale)
      .setAlpha(alpha)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(2)
      .setVisible(startVisible);

    s.play(animKey);
    return s;
  }

  _makeHoverZone({ x, y, w = 60, h = 50, glowSprite, onClick = null }) {
    const z = this.add.zone(x, y, w, h)
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    z.on('pointerover', () => glowSprite?.setVisible(true));
    z.on('pointerout', () => glowSprite?.setVisible(false));
    if (onClick) z.on('pointerdown', onClick);

    return z;
  }


  _setMapScale(ms) { this._mapScale = ms; }
  _getMapScale() { return this._mapScale || 1; }

  _clearGambleButtons() {
    if (this.gambleButtons) {
      this.gambleButtons.forEach(btn => btn?.destroy?.());
    }
    this.gambleButtons = [];
  }

  _resetVendorRowState() {
    this._clearGambleButtons();

    if (this.vendorInventoryContainer) {
      this.vendorInventoryContainer.removeAll(true);
      this.vendorInventoryContainer.y = 0;
      this.vendorInventoryContainer.listHeight = 0;
      this.vendorInventoryContainer.topPadding = 0;
      this.vendorInventoryContainer.lineHeight = 36;
      this._resetInventoryMask();
    }

    if (this.vendorInventoryTitle) {
      this.vendorInventoryTitle.setText('Select a Vendor');
    }

    if (this.vendorInventoryText) {
      this.vendorInventoryText.setText('');
    }

    if (this.vendorLeftFlavor) {
      this.vendorLeftFlavor.setText(DEFAULT_VENDOR_FLAVOR);
      this.vendorLeftFlavor.setVisible(true);
    }

    if (this.vendorListContainer) {
      this.vendorListContainer.removeAll(true);
      this.showVendorList();
    }

    this.tooltip?.hide();
  }

  _buildItemTooltipData(itemRef) {
    const view = getItemComputedData(itemRef);
    if (!view) return null;

    const lines = [];
    // Skip the static description for fixed-affix instances (rolled value shown via
    // misc mods below) and grantsSkills items (skill shown via Grants line below).
    if (view.description && !view.fixedAffixValue && !view.grantsSkills?.length) lines.push(view.description);

    if (view.type === 'weapon') {
      if (view.weaponType) lines.push(`Type: ${formatLabel(view.weaponType)}`);
      if (typeof view.hands === 'number') lines.push(`Hands: ${view.hands}`);
      if (view.damage && (view.damage.min != null || view.damage.max != null)) {
        const min = view.damage.min ?? '?';
        const max = view.damage.max ?? '?';
        lines.push(`Damage: ${min}–${max}`);
      }

      const weaponMods = view._weaponMods || {};
      const flat = weaponMods.damageFlat || {};
      const flatLine = [];
      if (flat.min) flatLine.push(formatSigned(flat.min, ' Min Damage'));
      if (flat.max) flatLine.push(formatSigned(flat.max, ' Max Damage'));
      if (flatLine.length) lines.push(flatLine.join(', '));

      if (weaponMods.localDamagePercent) {
        lines.push(`${formatSigned(weaponMods.localDamagePercent, '%')} Local Damage`);
      }

      const elementalFlat = weaponMods.elementalFlat || {};
      Object.entries(elementalFlat).forEach(([element, range]) => {
        if (!range) return;
        const min = range.min ?? 0;
        const max = range.max ?? min;
        lines.push(`+${min}–${max} ${formatLabel(element)} Damage`);
      });

      const buildup = weaponMods.buildupPercent || {};
      Object.entries(buildup).forEach(([family, amount]) => {
        if (!amount) return;
        lines.push(`${formatSigned(amount, '%')} ${formatLabel(family)} Buildup`);
      });
    } else if (view.type === 'armor') {
      if (view.slot) lines.push(`Slot: ${formatLabel(view.slot)}`);
    }

    const bonuses = view.bonuses || {};
    Object.entries(bonuses).forEach(([stat, amount]) => {
      if (!amount) return;
      lines.push(`${formatSigned(amount)} ${formatStatKey(stat)}`);
    });

    const derived = view._derivedMods || {};
    Object.entries(derived).forEach(([key, amount]) => {
      if (!amount) return;
      const label = DERIVED_LABELS[key] || formatLabel(key);
      lines.push(`${formatSigned(amount)} ${label}`);
    });

    const misc = view._miscMods || {};
    if (misc.resilience) lines.push(`${formatSigned(misc.resilience)} Resilience`);
    if (misc.globalDamagePercent) lines.push(`${formatSigned(misc.globalDamagePercent, '%')} Global Damage`);
    if (misc.elementalDamagePercent) lines.push(`${formatSigned(misc.elementalDamagePercent, '%')} Elemental Damage`);
    if (misc.necroticDamagePercent) lines.push(`${formatSigned(misc.necroticDamagePercent, '%')} Necrotic Damage`);
    if (misc.mpPerTurn) lines.push(`${formatSigned(misc.mpPerTurn)} MP per Turn`);
    if (misc.skillCostReductionPct) lines.push(`${formatSigned(misc.skillCostReductionPct, '%')} Skill Cost Reduction`);

    const miscBuildup = misc.buildupPercent || {};
    Object.entries(miscBuildup).forEach(([family, amount]) => {
      if (!amount) return;
      lines.push(`${formatSigned(amount, '%')} ${formatLabel(family)} Buildup`);
    });

    // Jewelry: damage conversion
    if (misc.physToElemPercent) lines.push(`${misc.physToElemPercent}% Physical → Elemental Conversion`);
    if (misc.physToNecroPercent) lines.push(`${misc.physToNecroPercent}% Physical → Necrotic Conversion`);
    if (misc.elemToNecroPercent) lines.push(`${misc.elemToNecroPercent}% Elemental → Necrotic Conversion`);
    // Jewelry: battle-start passives
    if (misc.initBonusOnBattleStart) lines.push(`+${misc.initBonusOnBattleStart} Initiative at Battle Start`);
    if (misc.shieldPctOnBattleStart) lines.push(`+${misc.shieldPctOnBattleStart}% Shield at Battle Start`);
    // Jewelry: buildup-on-hit
    Object.entries(misc.physBuildupOnPhysDmg || {}).forEach(([fam, pct]) => {
      if (pct) lines.push(`${pct}% Phys Dmg → ${formatLabel(fam)} Buildup`);
    });
    Object.entries(misc.elemBuildupOnElemDmg || {}).forEach(([fam, pct]) => {
      if (pct) lines.push(`${pct}% Elem Dmg → ${formatLabel(fam)} Buildup`);
    });
    // Jewelry: proc effects
    if (misc.procDoubleDamage)    lines.push(`${misc.procDoubleDamage}% Chance: Double Damage`);
    if (misc.procHalfDamageTaken) lines.push(`${misc.procHalfDamageTaken}% Chance: Halve Damage Taken`);
    if (misc.procHealOnHeal)      lines.push(`${misc.procHealOnHeal}% Chance: Double Heal`);
    if (misc.procPhysFlat)        lines.push(`${misc.procPhysFlat}% Chance: +20 Physical Damage`);
    if (misc.procElemFlat)        lines.push(`${misc.procElemFlat}% Chance: +20 Elemental Damage`);
    if (misc.procNecroFlat)       lines.push(`${misc.procNecroFlat}% Chance: +20 Necrotic Damage`);

    // Granted skills
    if (view.grantsSkills?.length) {
      const names = view.grantsSkills.map(id =>
        id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      );
      lines.push(`Grants: ${names.join(', ')}`);
    }

    if (!lines.length) lines.push('No additional properties.');

    return {
      title: view.name,
      titleColor: RARITY_COLORS[view.rarity || view.quality] || '#dddddd',
      lines
    };
  }

  _attachTooltip(displayObj, {
    itemRef = null,
    tooltipData = null,
    baseColor = null,
    hoverColor = '#ffffff'
  } = {}) {
    if (!displayObj?.on) return;

    displayObj.on('pointerover', (pointer) => {
      if (displayObj.setColor && hoverColor) {
        displayObj.setColor(hoverColor);
      }

      const data = tooltipData || this._buildItemTooltipData(itemRef);
      if (data && this.tooltip) {
        this.tooltip.show(pointer.worldX, pointer.worldY, data);
      }
    });

    displayObj.on('pointermove', (pointer) => {
      this.tooltip?.reposition(pointer.worldX, pointer.worldY);
    });

    displayObj.on('pointerout', () => {
      if (displayObj.setColor && baseColor) {
        displayObj.setColor(baseColor);
      }
      this.tooltip?.hide();
    });
  }


  create() {
    SoundManager.init(this);
    SoundManager.wireEmptyClick(this, 'dullClick');
    const centerX = 640;
    const centerY = 360;

    const cam = this.cameras.main;
    cam.setZoom(1);
    cam.centerOn(centerX, centerY);
    cam.setBounds(0, 0, 1280, 720);

    // === Map: lock on-screen width to 922 px (no coord drift) ===
    const MAP_DISPLAY_WIDTH = 922; // <- your measured on-screen width
    const src = this.textures.get('campMap').getSourceImage();
    const mapScale = MAP_DISPLAY_WIDTH / src.width;
    this._setMapScale(mapScale);
    this._mapDisplayWidth = MAP_DISPLAY_WIDTH;
    console.log('[MAP]', { nativeW: src.width, targetW: MAP_DISPLAY_WIDTH, scale: mapScale.toFixed(3) });

    this.campMap = this.add.image(centerX, centerY, 'campMap')
      .setOrigin(0.5)
      .setScale(mapScale)
      .setDepth(0);


    this.tooltip = new Tooltip(this);

    // Debug click coords
    this.input.on('pointerdown', pointer => {
      console.log(`📍 Clicked at X=${pointer.worldX.toFixed(0)}, Y=${pointer.worldY.toFixed(0)}`);
    });

    const COMMON_FRAMES = [
      'frame0000.png',
      'frame0001.png',
      'frame0002.png',
      'frame0003.png'
    ];

    this._registerGlowZone('Bonfire', {
      key: 'glow_bonfire',
      frames: ['frame0000.png', 'frame0001.png', 'frame0002.png', 'frame0003.png'],
      x: 649, y: 330,
      scale: 0.14,
      fps: 4,
      alpha: 0.9
    }, {
      x: 655, y: 327,
      width: 60,
      height: 50,
      onClick: () => {
        window.sceneManager.loadScene(
          'CharacterCreationScene',
          'Tip: Customize your stats before the Sacred Hunt.'
        );
      }
    });


    // Mourne Hut glow + hover zone
    this._registerGlowZone('MourneHut', {
      key: 'glow_mourne_hut',  // <-- MUST match LoadingScene GLOW_KEYS
      frames: ['frame0000.png', 'frame0001.png', 'frame0002.png', 'frame0003.png'],
      x: 888, y: 497,          // <-- GLOW's visual position (adjust here for glow placement)
      scale: 0.15,
      fps: 4,
      alpha: 0.9
    }, {
      x: 895, y: 502,          // <-- HOVER ZONE center (adjust here to move hitbox, independent of glow)
      width: 40,
      height: 40,
      onClick: () => this.enterSamuelTent()
    });

    // Tribe Vendors (row)
    this._registerGlowZone('TribeVendorRow', {
      key: 'glow_tribe_vendor',
      frames: COMMON_FRAMES,
      x: 521, y: 438,
      scale: 0.15,
      fps: 4,
      alpha: 0.8
    }, {
      x: 561, y: 423,
      width: 80, height: 60,
      onClick: () => this._enterTribeVendorRow()
    });


    // Vendor Row
    this._registerGlowZone('VendorRow', {
      key: 'glow_vendor_row',            // TEMP art; swap to a vendor-row glow when you have one
      frames: COMMON_FRAMES,
      x: 483, y: 393,                 // GLOW position (adjust here)
      scale: 0.15,
      fps: 4,
      alpha: 0.8
    }, {
      x: 490, y: 385,                 // HITBOX (existing coords)
      width: 200, height: 50,
      onClick: () => this.enterVendorRow()
    });

    // 🏚️ Lodges
    // 🏚️ Lodges (refactored to glow+zone helper)

    // --- Styx ---
    this._registerGlowZone('LodgeStyx', {
      key: 'glow_lodge_styx',                          // TEMP art; swap to your lodge atlas when ready
      frames: ['frame0000.png', 'frame0001.png', 'frame0002.png', 'frame0003.png'],
      x: 351, y: 219,                               // GLOW position (adjust here to nudge the glow)
      scale: 0.15,                                  // GLOW size
      fps: 4,
      alpha: 0.9                                    // GLOW intensity (lower = dimmer)
    }, {
      x: 361, y: 229,                               // HOVER zone center (independent of glow)
      width: 50, height: 50,                        // HOVER zone size
      onClick: () => this.enterStyxLodge()
    });

    // --- Zafaar ---
    this._registerGlowZone('LodgeZafaar', {
      key: 'glow_lodge_zafaar',                          // TEMP art
      frames: ['frame0000.png', 'frame0001.png', 'frame0002.png', 'frame0003.png'],
      x: 729, y: 66,                                // adjust glow here
      scale: 0.15,
      fps: 4,
      alpha: 0.9
    }, {
      x: 734, y: 70,                                // hitbox center
      width: 50, height: 50,
      onClick: () => this.enterZafaarLodge()
    });

    // --- Elseth ---
    this._registerGlowZone('LodgeElseth', {
      key: 'glow_lodge_elseth',                          // TEMP art
      frames: ['frame0000.png', 'frame0001.png', 'frame0002.png', 'frame0003.png'],
      x: 995, y: 190,                              // adjust glow here
      scale: 0.15,
      fps: 4,
      alpha: 0.9
    }, {
      x: 1010, y: 200,                              // hitbox center
      width: 50, height: 50,
      onClick: () => this.enterElsethLodge()
    });

    // --- Le'sse ---
    this._registerGlowZone('LodgeLesse', {
      key: 'glow_lodge_lesse',                          // TEMP art
      frames: ['frame0000.png', 'frame0001.png', 'frame0002.png', 'frame0003.png'],
      x: 638, y: 498,                               // adjust glow here
      scale: 0.15,
      fps: 4,
      alpha: 0.9
    }, {
      x: 640, y: 500,                               // hitbox center
      width: 50, height: 50,
      onClick: () => this.enterLesseLodge()
    });


    // Seers' Tent
    this._registerGlowZone('SeersTent', {
      key: 'glow_seers_tent',
      frames: COMMON_FRAMES,
      x: 999, y: 435,
      scale: 0.15,
      fps: 4,
      alpha: 0.9
    }, {
      x: 995, y: 440,
      width: 50, height: 50,
      onClick: () => this._enterSeersTent()
    });


    // Waystone
    this._registerGlowZone('Waystone', {
      key: 'glow_waystone',
      frames: COMMON_FRAMES,
      x: 935, y: 426,
      scale: 0.16,
      fps: 4,
      alpha: 0.8
    }, {
      x: 935, y: 430,
      width: 50, height: 50,
      onClick: () => this._enterWaystone()
    });


    // Elders' Tower
    this._registerGlowZone('EldersTower', {
      key: 'glow_elders_tower',
      frames: COMMON_FRAMES,
      x: 897, y: 372,
      scale: 0.15,
      fps: 4,
      alpha: 0.9
    }, {
      x: 900, y: 385,
      width: 60, height: 60,
      onClick: () => this._enterEldersTower(1)
    });


    // === NEW ZONES ===

    // Tribe‑leader huts
    // === Leader Huts (refactored to glow+zone helper) ===

    // Styx
    this._registerGlowZone('LeaderStyx', {
      key: 'glow_leader_hut_styx',  // TEMP art; swap to your own atlas when you have it
      frames: ['frame0000.png', 'frame0001.png', 'frame0002.png', 'frame0003.png'],
      x: 308, y: 325,       // GLOW position (adjust this to nudge the visual glow)
      scale: 0.16,
      fps: 4,
      alpha: 0.9
    }, {
      x: 305, y: 325,       // HOVER HITBOX center (independent of glow)
      width: 50, height: 50,
      onClick: () => this._enterLeaderHut('Styx')
    });

    // Zafaar
    this._registerGlowZone('LeaderZafaar', {
      key: 'glow_leader_hut_zafaar',
      frames: ['frame0000.png', 'frame0001.png', 'frame0002.png', 'frame0003.png'],
      x: 894, y: 110,       // adjust glow here
      scale: 0.16,
      fps: 4,
      alpha: 0.9
    }, {
      x: 893, y: 111,       // hitbox center
      width: 50, height: 50,
      onClick: () => this._enterLeaderHut('Zafaar')
    });

    // Elseth
    this._registerGlowZone('LeaderElseth', {
      key: 'glow_leader_hut_elseth',
      frames: ['frame0000.png', 'frame0001.png', 'frame0002.png', 'frame0003.png'],
      x: 1055, y: 341,      // adjust glow here
      scale: 0.16,
      fps: 4,
      alpha: 0.8
    }, {
      x: 1059, y: 339,      // hitbox center
      width: 50, height: 50,
      onClick: () => this._enterLeaderHut('Elseth')
    });

    // Le'sse
    this._registerGlowZone('LeaderLesse', {
      key: 'glow_leader_hut_lesse',
      frames: ['frame0000.png', 'frame0001.png', 'frame0002.png', 'frame0003.png'],
      x: 524, y: 493,       // adjust glow here
      scale: 0.16,
      fps: 4,
      alpha: 0.9
    }, {
      x: 523, y: 503,       // hitbox center
      width: 50, height: 50,
      onClick: () => this._enterLeaderHut("Le'sse")
    });


    // Combat Pit
    this._registerGlowZone('CombatPit', {
      key: 'glow_combat_pit',
      frames: COMMON_FRAMES,
      x: 824, y: 71,
      scale: 0.15,
      fps: 4,
      alpha: 0.9
    }, {
      x: 824, y: 88,
      width: 60, height: 60,
      onClick: () => this._enterCombatPit()
    });


    // Exit Gate
    this._registerGlowZone('ExitGate', {
      key: 'glow_exit_gate',
      frames: COMMON_FRAMES,
      x: 505, y: 147,
      scale: 0.16,
      fps: 4,
      alpha: 0.9
    }, {
      x: 495, y: 135,
      width: 80, height: 60,
      onClick: () => this._enterHuntGate()
    });

    // Refresh quest flag markers whenever TownScene wakes (e.g. returning from combat).
    this.events.on('wake', () => this._refreshQuestFlags(), this);

    // Auto-seed orientation flag on first ever load (no scenarios, no flags set).
    // This ensures a browser refresh doesn't strand the player with no guidance.
    const nothingInProgress =
      ProgressionManager.completedScenarios.length === 0 &&
      ProgressionManager.questFlags.length === 0 &&
      !ProgressionManager.getTribe();
    if (nothingInProgress) {
      ProgressionManager.setQuestFlag('orientation_bonfire');
    }

    // Show quest flags that are already active on first load.
    this._buildQuestFlags();
  }

  // ===========================================================
  // Quest Flags — pulsing "!" markers over locations
  // ===========================================================

  /**
   * Call this whenever quest flag state may have changed.
   * Also checks whether tribe state changed and clears cached interiors
   * that need to reflect the new tribe (Elder's Tower F1 and lodges).
   */
  _refreshQuestFlags() {
    const currentTribe = ProgressionManager.getTribe();

    // If tribe state changed, invalidate post-choice interiors.
    if (currentTribe !== this._lastKnownTribe) {
      if (this.eldersTowerGroups?.[1]) {
        this.eldersTowerGroups[1].destroy(true);
        this.eldersTowerGroups[1] = null;
      }
      if (this.lodgeGroups) {
        Object.values(this.lodgeGroups).forEach(g => g.destroy(true));
        this.lodgeGroups = {};
      }
      this._lastKnownTribe = currentTribe;
    }

    // Elder Tower F1 is always rebuilt fresh when tribe isn't chosen, or when
    // a pending elder lore flag means its content has changed since last visit.
    const hasElderFlag = ProgressionManager.hasQuestFlag('orientation_elder') ||
                         ProgressionManager.hasQuestFlag('elder_bonepile') ||
                         ProgressionManager.hasQuestFlag('elder_leveling');
    if (!currentTribe || hasElderFlag) {
      if (this.eldersTowerGroups?.[1]) {
        this.eldersTowerGroups[1].destroy(true);
        this.eldersTowerGroups[1] = null;
      }
      if (this.lodgeGroups) {
        Object.values(this.lodgeGroups).forEach(g => g.destroy(true));
        this.lodgeGroups = {};
      }
    }

    // Samuel interior must rebuild when the intro flag is pending.
    if (ProgressionManager.hasQuestFlag('samuel_mourne') && this.samuelInteriorGroup) {
      this.samuelInteriorGroup.destroy(true);
      this.samuelInteriorGroup = null;
    }

    this._buildQuestFlags();

    // Keep UIScene currency display in sync after returning from combat.
    this.scene.get('UIScene')?.refreshUI?.();
  }

  /**
   * Destroys any existing flag markers then creates a pulsing "!" circle
   * for every currently-active quest flag.
   */
  _buildQuestFlags() {
    // Check if the combat pit marker should now appear based on cleared flags
    ProgressionManager.refreshCombatPitFlag();

    if (this._questFlagObjects) {
      this._questFlagObjects.forEach(o => o.destroy());
    }
    this._questFlagObjects = [];

    for (const [flagId, cfg] of Object.entries(QUEST_FLAG_POSITIONS)) {
      if (!ProgressionManager.hasQuestFlag(flagId)) continue;

      // Hand-in flags render as a gold ★ to distinguish from the orange ! (quest available)
      const isHandin = flagId.endsWith('_handin');
      const color    = isHandin ? 0xffdd44 : 0xffaa00;
      const symbol   = isHandin ? '★' : '!';

      const circle = this.add.circle(cfg.x, cfg.y, 11, color).setDepth(5);
      const label  = this.add.text(cfg.x, cfg.y, symbol, {
        fontSize: '13px', color: '#000000', fontStyle: 'bold'
      }).setOrigin(0.5).setDepth(6);

      this.tweens.add({
        targets: [circle, label],
        scaleX: 1.25, scaleY: 1.25,
        duration: 550,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });

      this._questFlagObjects.push(circle, label);
    }
  }

  // ===========================================================
  // Shared helper — currency strip text used by vendor panels
  // ===========================================================

  /** Returns a formatted currency string for vendor panel headers. */
  _currencyLine() {
    return `Hunt Tickets: ${ProgressionManager.huntTickets}  |  Tribe Tickets: ${ProgressionManager.tribeTickets}`;
  }

  /** Updates any live vendor currency text objects. */
  _updateVendorCurrencyDisplay() {
    const line = this._currencyLine();
    if (this.vendorCurrencyDisplay)      this.vendorCurrencyDisplay.setText(line);
    if (this.tribeVendorCurrencyDisplay) this.tribeVendorCurrencyDisplay.setText(line);
  }

  _buildInteriorLayout({ titleText, flavorText, bgColor = 0x1e1a18, bgImage = null, titleColor = '#ffddaa', flavorColor = '#dddddd', exitText = '[ Exit ]', onExit }) {
    const PANEL_W = 915, PANEL_H = 685;
    const blocker = this.add.rectangle(640, 360, 1280, 720, 0x000000, 0)
      .setOrigin(0.5)
      .setInteractive();

    // If a painted background image is provided, display it behind the ornament frame.
    // The panel fill becomes transparent so only stroke + corners show.
    let bgImg = null;
    if (bgImage && this.textures.exists(bgImage)) {
      bgImg = this.add.image(640, 360, bgImage)
        .setDisplaySize(PANEL_W, PANEL_H)
        .setDepth(0);
    }

    const bg = createPanel(this, 640 - PANEL_W / 2, 360 - PANEL_H / 2, PANEL_W, PANEL_H, {
      fill:        bgImage ? 0x000000 : bgColor,
      fillAlpha:   bgImage ? 0        : 1,
      stroke:      0x886644,
      strokeWidth: 4,
      radius:      6,
      cornerSize:  10,
      cornerColor: 0xb8922a,
      cornerAlpha: 0.9,
    }).setDepth(0);

    const title = this.add.text(640, 120, titleText, {
      fontSize: '28px',
      color: titleColor,
      fontFamily: 'Georgia',
      fontStyle: 'bold'
    }).setOrigin(0.5);

    const flavor = this.add.text(640, 200, flavorText, {
      fontSize: '18px',
      color: flavorColor,
      fontFamily: 'Georgia',
      align: 'center',
      wordWrap: { width: 600 }
    }).setOrigin(0.5);

    const exitBtn = this.add.text(640, 620, exitText, {
      fontSize: '20px',
      color: '#ff8888'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => { SoundManager.play('handsClick'); onExit(); });

    const items = [blocker, ...(bgImg ? [bgImg] : []), bg, title, flavor, exitBtn];
    return this.add.container(0, 0, items).setDepth(11);
  }


  // =====================================================
  // 🏕 Transition into Samuel's Tent Interior
  // =====================================================
  enterSamuelTent() {
    if (this.campMap) this.campMap.setVisible(false);

    const hasIntroFlag   = ProgressionManager.hasQuestFlag('samuel_mourne');
    const hasReturnFlag  = ProgressionManager.hasQuestFlag('samuel_waystone_return');
    const anyFlag        = hasIntroFlag || hasReturnFlag;

    // Rebuild whenever a flag is pending so the right dialogue shows.
    if (anyFlag && this.samuelInteriorGroup) {
      this.samuelInteriorGroup.destroy(true);
      this.samuelInteriorGroup = null;
    }

    if (this.samuelInteriorGroup) {
      this.samuelInteriorGroup.setVisible(true);
      return;
    }

    if (hasIntroFlag) {
      // Phase 1 — First meeting after S4.
      // Samuel introduces the spiritual dimension of the hunt and sends the player to the waystone.
      ProgressionManager.clearQuestFlag('samuel_mourne');
      ProgressionManager.setQuestFlag('waystone_visit');
      GameState.save('autosave');
      this._buildQuestFlags();

      const layout = this._buildInteriorLayout({
        titleText: 'Samuel Mourne',
        flavorText: "The interior seems strangely familiar.\nSamuel studies you quietly.",
        onExit: () => this.leaveSamuelTent()
      });

      const introText = this.add.text(640, 255,
        '"You have done well to reach this point.\n\n' +
        'I am Samuel Mourne. I have watched your progress through the training grounds.\n\n' +
        'There are things about this island that the tribes do not speak of openly.\n' +
        'The Sacred Hunt is more than sport. Each prophet is a divine being that takes\n' +
        'the form of a great beast — ancient, aware, and not what the tribes call them.\n' +
        'They are not gods. They are something older. Something that was here first.\n\n' +
        'The waystones carry their resonance. Visit the one to the east — near the\n' +
        'edge of the encampment. It will know you are coming.\n' +
        'Return to me after."',
        {
          fontSize: '13px', color: '#ccddcc', fontStyle: 'italic',
          align: 'center', wordWrap: { width: 560 }
        }
      ).setOrigin(0.5, 0).setDepth(12);

      layout.add(introText);
      this.samuelInteriorGroup = layout;

    } else if (hasReturnFlag) {
      // Phase 2 — Player has attuned to the waystone. Give the shard, explain Favor.
      ProgressionManager.clearQuestFlag('samuel_waystone_return');
      GameState.save('autosave');
      this._buildQuestFlags();

      // Award the waystone shard (rare, locked, global inventory)
      const shard = createItemInstance('waystone_shard', { rarity: 'rare' });
      if (shard) {
        InventorySystem.addGlobalItem(shard);
        GameState.save('autosave');
        SoundManager.play('reward');
        this.scene.get('UIScene')?.showToast?.('Received: Waystone Shard');
      }

      const layout = this._buildInteriorLayout({
        titleText: 'Samuel Mourne',
        flavorText: "The interior seems strangely familiar.\nSamuel studies you quietly.",
        onExit: () => this.leaveSamuelTent()
      });

      const returnText = this.add.text(640, 255,
        '"The waystone accepted you. Good.\n\n' +
        'Take this shard. It is a fragment broken from the stone\'s outer shell — still\n' +
        'attuned to the same network. In time it will show you the state of the hunt\n' +
        'from wherever you carry it: prophet movements, waystone locations, the shape\n' +
        'of things to come.\n\n' +
        'There is also the matter of Favor. Each prophet is aware of those who hunt here.\n' +
        'Act in accordance with their nature and they notice. Act against it and they\n' +
        'notice that too. Your shard will reflect this standing — eventually.\n\n' +
        'More on that when it becomes relevant."',
        {
          fontSize: '13px', color: '#ccddcc', fontStyle: 'italic',
          align: 'center', wordWrap: { width: 560 }
        }
      ).setOrigin(0.5, 0).setDepth(12);

      layout.add(returnText);
      this.samuelInteriorGroup = layout;

    } else {
      // Idle — no pending flags, Samuel is available but has nothing new.
      this.samuelInteriorGroup = this._buildInteriorLayout({
        titleText: 'Samuel Mourne',
        flavorText: "The interior seems strangely familiar.\nSamuel studies you quietly.",
        onExit: () => this.leaveSamuelTent()
      });
    }
  }

  // =====================================================
  // 🔙 Return to Exterior (Samuel)
  // =====================================================
  leaveSamuelTent() {
    if (this.samuelInteriorGroup) this.samuelInteriorGroup.setVisible(false);
    if (this.campMap) this.campMap.setVisible(true);
  }


  // --- Mask helpers for the vendor inventory panel ---
  _setInventoryMaskTop(topY, bottomY) {
    // Destroy old shape if any
    if (this._inventoryMaskShape) {
      this._inventoryMaskShape.destroy();
      this._inventoryMaskShape = null;
    }

    // Build a new invisible geometry mask covering [topY, bottomY]
    const width = 500;   // your panel width (matches the rectangle mask you had)
    const centerX = 800;   // your panel center X
    const height = Math.max(0, bottomY - topY);
    const centerY = topY + height / 2;

    this._inventoryMaskShape = this.add.rectangle(centerX, centerY, width, height, 0xffffff, 0)
      .setOrigin(0.5)
      .setVisible(false);

    const mask = this._inventoryMaskShape.createGeometryMask();
    this.vendorInventoryContainer.setMask(mask);

    // Remember bounds (used by auto-scroll math)
    this._inventoryMaskTop = topY;
    this._inventoryMaskBottom = bottomY;
  }

  _resetInventoryMask() {
    // Default panel clip (top=220, bottom=595)
    if (!this.vendorInventoryContainer) return;
    this._setInventoryMaskTop(220, 595);
  }

  enterVendorRow() {
    this._hideExteriorsAndOtherInteriors();

    // Orientation flow: visiting vendor row for the first time (before S1) clears
    // the vendor_row flag and nudges the player toward the Combat Pit.
    if (ProgressionManager.hasQuestFlag('vendor_row') &&
        !ProgressionManager.isScenarioCompleted('training_encounter_1')) {
      ProgressionManager.clearQuestFlag('vendor_row');
      ProgressionManager.setQuestFlag('combat_pit');
      GameState.save('autosave');
      this._buildQuestFlags();
    }

    if (this.vendorRowGroup) {
      this.vendorRowGroup.setVisible(true);
      this._updateVendorCurrencyDisplay();
      this._resetVendorRowState();
      return;
    }

    const layout = this._buildInteriorLayout({
      titleText: 'Vendor Row',
      flavorText: '',  // Empty here — we'll manually place it lower
      bgColor: 0x1a2022,
      bgImage: 'menu_stony_background',
      titleColor: '#2a1800',
      exitText: '[ Exit Market ]',
      onExit: () => this.leaveVendorRow()
    });

    // Vendor list container
    this.vendorListContainer = this.add.container(0, 0);

    // Hide any default flavor produced by _buildInteriorLayout to prevent overlap
    if (this.vendorRowFlavorText) this.vendorRowFlavorText.setVisible(false);

    this.vendorLeftFlavor = this.add.text(230, 440,
      DEFAULT_VENDOR_FLAVOR,
      { fontSize: '16px', color: '#3a2818', wordWrap: { width: 280 } }
    );

    layout.add(this.vendorLeftFlavor);



    layout.add(this.vendorListContainer);

    // Inventory panel
    this.vendorInventoryPanel = createPanel(this, 545, 155, 510, 440, 'menu');
    this.vendorInventoryTitle = this.add.text(800, 165, 'Select a Vendor', {
      fontSize: '22px',
      color: '#ffddaa'
    }).setOrigin(0.5);
    // Currency strip — updates whenever a purchase or gamble happens.
    this.vendorCurrencyDisplay = this.add.text(800, 143, this._currencyLine(), {
      fontSize: '12px',
      color: '#3a2818'
    }).setOrigin(0.5).setDepth(13);
    this.vendorInventoryText = this.add.text(610, 210, '', {
      fontSize: '16px',
      color: '#dddddd',
      wordWrap: { width: 470 }
    }).setOrigin(0, 1);

    // Inventory scroll container
    this.vendorInventoryContainer = this.add.container(0, 0);
    this._resetInventoryMask();


    layout.add([
      this.vendorInventoryPanel,
      this.vendorInventoryTitle,
      this.vendorCurrencyDisplay,
      this.vendorInventoryText,
      this.vendorInventoryContainer
    ]);

    layout.setDepth(12);
    this.vendorRowGroup = layout;
    this.gambleButtons = [];

    this._resetVendorRowState();

    // Wheel scroll handler for inventory panel
    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
      if (!this.vendorInventoryContainer?.visible) return;

      // Inventory panel bounds
      const panelLeft = 550;
      const panelRight = 1050;
      const panelTop = 220;   // aligns with first item row
      const panelBottom = 595;   // bottom border of panel
      const lineHeight = 36;    // keep your existing snap size

      // Only scroll if pointer is inside the inventory panel
      if (pointer.x >= panelLeft && pointer.x <= panelRight &&
        pointer.y >= panelTop && pointer.y <= panelBottom) {

        // Apply scroll
        this.vendorInventoryContainer.y -= deltaY * 0.5;

        // Visible area height
        const visibleHeight = panelBottom - panelTop;

        // 👉 Total height now includes optional top padding (Bonepile uses 80)
        const topPadding = this.vendorInventoryContainer.topPadding || 0;
        const contentH = this.vendorInventoryContainer.listHeight || 0;
        const totalHeight = topPadding + contentH;

        // Compute max scroll distance (how far up we can go)
        let maxScroll = Math.max(0, totalHeight - visibleHeight);

        // Keep your existing "snap to line" feel
        if (lineHeight > 0) {
          maxScroll = Math.ceil(maxScroll / lineHeight) * lineHeight;
        }

        // Clamp scrolling
        if (this.vendorInventoryContainer.y > 0) {
          this.vendorInventoryContainer.y = 0;                 // no scrolling below top
        }
        if (-this.vendorInventoryContainer.y > maxScroll) {
          this.vendorInventoryContainer.y = -maxScroll;        // no overscroll past bottom
        }
      }
    });

  }


  leaveVendorRow() {
    this._clearGambleButtons();

    if (this.vendorRowGroup) this.vendorRowGroup.setVisible(false);
    if (this.campMap) this.campMap.setVisible(true);

    if (this.vendorLeftFlavor) this.vendorLeftFlavor.setVisible(false);
    if (this.vendorInventoryText) this.vendorInventoryText.setText('');
    this.tooltip?.hide();


    if (this.vendorButtons) {
      this.vendorButtons.forEach(btn => btn.destroy());
      this.vendorButtons = [];
    }


    if (this.vendorCategoryButtons) {
      this.vendorCategoryButtons.forEach(btn => btn.destroy());
      this.vendorCategoryButtons = [];
    }

    this._resetVendorRowState();
  }


  showVendorList() {
    this._clearGambleButtons();
    if (this.vendorListContainer) this.vendorListContainer.removeAll(true);

    if (this.vendorLeftFlavor) {
      this.vendorLeftFlavor.setText(DEFAULT_VENDOR_FLAVOR);
      this.vendorLeftFlavor.setVisible(true);
    }


    const vendors = this.getVendorDefinitions();
    const startY = 160;
    let i = 0;

    Object.keys(vendors).forEach(vKey => {
      // Bone Pile is locked until Scenario 2 is complete.
      if (vKey === 'bonepile' && !ProgressionManager.isFeatureUnlocked('bonepile')) return;

      const vendorDef = vendors[vKey];
      const txt = this.add.text(230, startY + i * 40, `• ${vendorDef.displayName}`, {
        fontSize: '20px',
        color: '#2a1800'
      })
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => txt.setColor('#4a3010'))
        .on('pointerout', () => txt.setColor('#2a1800'))
        .on('pointerdown', () => { SoundManager.play('select'); this.showSingleVendor(vKey); });

      this.vendorListContainer.add(txt);
      i++;
    });
  }

  showSingleVendor(vendorKey) {
    if (this.vendorListContainer) this.vendorListContainer.removeAll(true);

    // First visit to Bone Pile — clear vendor_row flag and move to combat_pit.
    if (vendorKey === 'bonepile' && ProgressionManager.hasQuestFlag('vendor_row')) {
      ProgressionManager.clearQuestFlag('vendor_row');
      ProgressionManager.setQuestFlag('combat_pit');
      GameState.save('autosave');
      this._buildQuestFlags();
    }

    const vendors = this.getVendorDefinitions();
    const vendorDef = vendors[vendorKey];
    if (!vendorDef) return;
    if (this.vendorLeftFlavor) {
      this.vendorLeftFlavor.setText(vendorDef.flavor ? vendorDef.flavor : '');
      this.vendorLeftFlavor.setVisible(true);
    }

    // Vendor name
    this.vendorListContainer.add(
      this.add.text(230, 160, `• ${vendorDef.displayName}`, {
        fontSize: '20px',
        color: '#2a1800'
      })
    );

    // Back button
    this.vendorListContainer.add(
      this.add.text(230, 200, '[ Back ]', {
        fontSize: '18px',
        color: '#880000'
      })
        .setInteractive({ useHandCursor: true })
        .on('pointerover', function () { this.setColor('#550000'); })
        .on('pointerout', function () { this.setColor('#880000'); })
        .on('pointerdown', () => { SoundManager.play('handsClick');
          this.vendorInventoryContainer.removeAll(true);
          this.vendorInventoryContainer.y = 0;
          this.showVendorList();
          this.vendorInventoryTitle.setText('Select a Vendor');
          // keep the layout flavor hidden; drive flavor via vendorLeftFlavor only
          if (this.vendorLeftFlavor) {
            this.vendorLeftFlavor.setText(DEFAULT_VENDOR_FLAVOR);
            this.vendorLeftFlavor.setVisible(true);
          }
          this.vendorInventoryText.setText(''); // right panel messages are for purchases only
          this.tooltip?.hide();
        })
    );

    // Open inventory
    this.openVendorInventory(vendorKey, 'all');
  }

  openVendorInventory(vendorKey, filterType = 'all') {
    this._clearGambleButtons();
    const vendors = this.getVendorDefinitions();
    const vendor = vendors[vendorKey];
    if (!vendor) {
      this.vendorInventoryTitle.setText("Unknown Vendor");
      this.vendorInventoryText.setText("");
      return;
    }

    this.vendorInventoryTitle.setText(vendor.displayName);
    this.vendorInventoryText.setText(''); // right panel used only for buy/gamble feedback


    if (this.vendorCategoryButtons) this.vendorCategoryButtons.forEach(btn => btn.destroy());
    this.vendorCategoryButtons = [];

    // 🔹 Special handling for Bonepile
    if (vendorKey === 'bonepile') {
      this.vendorInventoryContainer.removeAll(true);
      this.vendorInventoryContainer.y = 0;

      const PANEL_BOTTOM = 595;
      const BONEPILE_LOG_START_Y = 300; // <-- adjust this single number
      const LOG_X = 590;
      const LOG_LINE_H = 24;

      // Force the mask so the visible top is exactly our log start
      this._setInventoryMaskTop(BONEPILE_LOG_START_Y, PANEL_BOTTOM);

      // Bonepile scroll metrics (no extra topPadding now)
      this.vendorInventoryContainer.topPadding = 0;
      this.vendorInventoryContainer.listHeight = 0;
      this.vendorInventoryContainer.lineHeight = LOG_LINE_H;
      this.vendorInventoryContainer.y = 0;

      const createGambleButton = ({ label, y, cost, poolGetter, emptyMessage }) => {
        const ticketWord = cost === 1 ? 'Hunt Ticket' : 'Hunt Tickets';
        const btn = this.add.text(620, y, `[ Gamble ${label} — ${cost} ${ticketWord} ]`, {
          fontSize: '20px',
          color: '#ffddaa'
        })
          .setDepth(13)
          .setInteractive({ useHandCursor: true })
          .on('pointerover', function () { this.setColor('#ffffff'); })
          .on('pointerout', function () { this.setColor('#ffddaa'); })
          .on('pointerdown', () => {
            if (ProgressionManager.huntTickets < cost) {
              this.vendorInventoryText.setText(`You need at least ${cost} Hunt Ticket${cost > 1 ? 's' : ''} to gamble here.`);
              return;
            }
            ProgressionManager.huntTickets -= cost;
            GameState.save('autosave');
            this._updateVendorCurrencyDisplay();

            const pool = poolGetter();
            if (!pool.length) {
              this.vendorInventoryText.setText(emptyMessage);
              return;
            }

            const baseId = pool[(Math.random() * pool.length) | 0];
            const q = randomRarityForGamble();
            const inst = createItemInstance(baseId, { rarity: q });
            if (!inst) {
              this.vendorInventoryText.setText(`Failed to create instance for ${baseId}.`);
              return;
            }

            SoundManager.play(q === 'epic' ? 'gambleEpic' : 'gamble');
            InventorySystem.addGlobalItem(inst);

            const lineY = BONEPILE_LOG_START_Y + this.vendorInventoryContainer.listHeight;
            const displayColor = RARITY_COLORS[q] || '#ffffff';
            const line = this.add.text(LOG_X, lineY, `→ ${inst.displayName}`, {
              fontSize: '16px',
              color: displayColor
            })
              .setDepth(13)
              .setInteractive({ useHandCursor: true });

            const tooltipData = this._buildItemTooltipData(inst);
            this._attachTooltip(line, {
              tooltipData,
              baseColor: displayColor,
              hoverColor: '#ffffff'
            });

            this.vendorInventoryContainer.add(line);
            this.vendorInventoryContainer.listHeight += LOG_LINE_H;

            const visibleH = (this._inventoryMaskBottom - this._inventoryMaskTop);
            let maxScroll = Math.max(0, this.vendorInventoryContainer.listHeight - visibleH);
            if (LOG_LINE_H > 0) maxScroll = Math.ceil(maxScroll / LOG_LINE_H) * LOG_LINE_H;
            this.vendorInventoryContainer.y = -maxScroll;

            this.vendorInventoryText.setText(`You received: ${inst.displayName}`);
          });

        this.gambleButtons.push(btn);
        if (this.vendorRowGroup) this.vendorRowGroup.add(btn);
        else this.add.existing(btn);
      };

      createGambleButton({
        label: 'Weapons',
        y: 220,
        cost: 1,
        poolGetter: () => getWeaponIdPool(),
        emptyMessage: 'No weapon IDs found in Items.js.'
      });

      createGambleButton({
        label: 'Armor',
        y: 250,
        cost: 1,
        poolGetter: () => getArmorIdPool(),
        emptyMessage: 'No armor IDs found in Items.js.'
      });

      createGambleButton({
        label: 'Jewelry',
        y: 280,
        cost: 3,
        poolGetter: () => getJewelryIdPool(),
        emptyMessage: 'No jewelry IDs found in Items.js.'
      });

      return;
    }





    // === Normal vendors ===
    // Category Tabs
    const categories = [
      { key: 'all', label: 'All' },
      { key: 'weapon', label: 'Weapons' },
      { key: 'armor', label: 'Armor' },
      { key: 'item', label: 'Items' }
    ];

    categories.forEach((cat, idx) => {
      const btn = this.add.text(610 + idx * 90, 180, cat.label, {
        fontSize: '16px',
        color: filterType === cat.key ? '#ffffff' : '#ffddaa'
      })
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => { SoundManager.play('select'); this.openVendorInventory(vendorKey, cat.key); });

      this.vendorCategoryButtons.push(btn);
      if (this.vendorRowGroup) this.vendorRowGroup.add(btn);
    });

    // Clear old inventory
    this.vendorInventoryContainer.removeAll(true);

    this._resetInventoryMask(); // ensure top=220 for regular vendors
    this.vendorInventoryContainer.topPadding = 0;
    this.vendorInventoryContainer.lineHeight = 36; // your normal row height
    this.vendorInventoryContainer.listHeight = 0;

    // List Items
    let yOffset = 0;
    vendor.inventory
      .map(itemObj => {
        const base = Items[itemObj.id];
        return { ...itemObj, base };
      })
      .filter(entry => {
        if (!entry.base) return false;
        return filterType === 'all' || entry.base.type === filterType;
      })
      .forEach(entry => {
        if (!entry.base) return;
        const color = RARITY_COLORS[entry.base.rarity || entry.base.quality] || '#cccccc';

        const text = this.add.text(620, 220 + yOffset, `• ${entry.base.name} — ${entry.cost}g`, {
          fontSize: '18px',
          color
        })
          .setDepth(13)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => {
            const itemId = entry.base?.id;
            if (!itemId) {
              console.warn("No item ID found for vendor item:", entry);
              return;
            }

            const instance = createItemInstance(itemId);
            if (!instance) {
              console.warn(`Failed to create item instance for ID: ${itemId}`);
              return;
            }

            InventorySystem.addGlobalItem(instance);
            SoundManager.play('dullClick');
            this.vendorInventoryText.setText(`Purchased: ${instance.displayName || entry.base.name}`);
            console.log(`✅ Added to global inventory:`, instance);

          });

        this.vendorInventoryContainer.add(text);
        yOffset += 36;
        
        const tooltipData = this._buildItemTooltipData(entry.id);
        if (tooltipData && entry.desc) {
          const uniqueLines = tooltipData.lines.filter(line => line !== entry.desc);
          tooltipData.lines = [entry.desc, ...uniqueLines];
        }

        this._attachTooltip(text, {
          tooltipData,
          baseColor: color,
          hoverColor: '#ffffff'
        });
      });

    // Store total height for scrolling clamp
    this.vendorInventoryContainer.listHeight = yOffset;
  }


  // ===============================
  // 📦 Vendor Data
  // ===============================
  getVendorDefinitions() {
    return {
      ironbinder: {
        displayName: "Ironbinder's Stand",
        flavor: `"A hunched smith adjusts warped blades behind a curtain
         of smoke. The air smells of charcoal, sweat, and old metal. 
         'Not much, but it kills,' he mutters without looking up."`,

        inventory: [
          { id: "crude_dagger", cost: 0 },
          { id: "crude_sword_1h", cost: 0 },
          { id: "crude_sword_2h", cost: 0 },
          { id: "crude_spear_1h", cost: 0 },
          { id: "crude_whip", cost: 0 },
          { id: "crude_shield", cost: 0 },
          { id: "crude_sling", cost: 0 },
          { id: "crude_bow", cost: 0 },
          { id: "crude_gun", cost: 0 },
          { id: "crude_staff", cost: 0 },
          { id: "crude_wand", cost: 0 },
          { id: "crude_mace_2h", cost: 0 },
          { id: "crude_axe_2h", cost: 0 }
        ]
      },
      greenhollow: {
        displayName: "Greenhollow Satchel",
        flavor: `"A fragrant scent of herbs and bark lingers. 
        A cloaked figure nods as you approach, laying bundles out along 
        woven mats. 'Natural, safe... well, mostly,' they whisper."`,
        inventory: [
          { id: "healing_potion", cost: 10 },
          { id: "mana_potion", cost: 12 }
        ]
      },
      watershade: {
        displayName: "Watershade",
        flavor: `"A lean woman sits beside glinting racks of armor, each 
        piece polished but practical. She nods once. 'Defense wins wars. 
        You buying or dreaming?'"`,
        inventory: [
          { id: "simple_helm_str", cost: 0 },
          { id: "simple_helm_dex", cost: 0 },
          { id: "simple_helm_int", cost: 0 },
          { id: "simple_chest_con_str", cost: 0 },
          { id: "simple_chest_dex_int", cost: 0 },
          { id: "simple_chest_wis_con", cost: 0 },
          { id: "simple_legs_con", cost: 0 },
          { id: "simple_legs_dex", cost: 0 },
          { id: "simple_legs_wis", cost: 0 },
          { id: "simple_gloves_dex", cost: 0 },
          { id: "simple_gloves_str", cost: 0 },
          { id: "simple_gloves_int", cost: 0 },
          { id: "simple_boots_con", cost: 0 },
          { id: "simple_boots_dex", cost: 0 },
          { id: "simple_boots_wis", cost: 0 }
        ]
      },

      bonepile: {
        displayName: "Bonepile",
        flavor: `"A crooked figure wrapped in bone necklaces cackles softly.
  'Trade your coin, tempt your fate,' they beckon. You're not sure which
  items are cursed and which are just... odd."`,
        // Single logical entry; we'll render a special button in openVendorInventory
        inventory: [{ id: "__GAMBLE__", cost: 0, desc: "Random weapon (Uncommon/Rare/Epic). Free for testing." }]
      },

      embercart: {
        displayName: "Ember Cart",
        inventory: [
          { id: "coal_scuttle", cost: 20, desc: "Fuel item." },
          { id: "phoenix_ash", cost: 95, desc: "Revive at 1 HP (future mechanic)." },
          { id: "cinder_oil", cost: 70, desc: "Adds fire DOT to next attack." }
        ]
      },
      whispercloth: {
        displayName: "Whispercloth Tent",
        inventory: [
          { id: "silk_patch", cost: 28, desc: "Armor repair." },
          { id: "quiet_hood", cost: 110, desc: "Stealth / evasion boost." },
          { id: "muffled_wrap", cost: 65, desc: "Reduces noise (future stealth system)." }
        ]
      }
    };
  }


  // =====================================================
  // 🌑 Styx Lodge Interior (placeholder)
  // =====================================================
  enterStyxLodge()   { this._enterGenericLodge('Styx Lodge',   0x2a1f29, "A dusky hall draped in violet banners.",    'styx',   'lodge_styx',   'styx_interior');   }
  enterZafaarLodge() { this._enterGenericLodge('Zafaar Lodge', 0x2a2a1f, "Crackling braziers light ornate stonework.", 'zafaar', 'lodge_zafaar', 'zafaar_interior'); }
  enterElsethLodge() { this._enterGenericLodge('Elseth Lodge', 0x1f2a1f, "Pine scent fills an airy wooden hall.",      'elseth', 'lodge_elseth', 'elseth_interior'); }
  enterLesseLodge()  { this._enterGenericLodge("Le'sse Lodge", 0x1f262a, "Soft lanterns sway amid silk canopies.",    'lesse',  'lodge_lesse',  'lesse_interior');  }

  /**
   * Generic lodge builder.
   *
   * Pre-choice (tribe not chosen): shows exploration flavour to help the player
   * decide. Clears the lodge's quest flag on first visit.
   *
   * Post-choice: shows "welcome home" for their tribe, curt message for others.
   *
   * Lodges are NOT cached before a tribe is chosen (content depends on which
   * flags are still active). After choosing, they cache normally.
   */
  _enterGenericLodge(titleText, bgColor, baseFlavorText, tribeId = null, lodgeFlagId = null, bgImage = null) {
    this._hideExteriorsAndOtherInteriors();

    if (!this.lodgeGroups) this.lodgeGroups = {};

    const playerTribe    = ProgressionManager.getTribe();
    const hasLodgeFlag   = lodgeFlagId ? ProgressionManager.hasQuestFlag(lodgeFlagId) : false;

    // Clear the lodge quest flag the moment the player steps inside.
    if (hasLodgeFlag) {
      ProgressionManager.clearQuestFlag(lodgeFlagId);
      GameState.save('autosave');
      this._buildQuestFlags();
    }

    // Use cached layout if available (only cached post-choice).
    if (this.lodgeGroups[titleText]) {
      this.lodgeGroups[titleText].setVisible(true);
      return;
    }

    // Build flavour suffix based on tribe state.
    let tribeLine = '';
    if (!playerTribe) {
      // Pre-choice — show the tribe's pitch to the player.
      tribeLine = '\n\n' + (PRE_CHOICE_LODGE_TEXT[tribeId] || 'The lodge members eye you with neutral curiosity.');
    } else if (playerTribe === tribeId) {
      tribeLine = `\n\n"Welcome home, ${TRIBE_DISPLAY_NAMES[tribeId]} hunter.\nThe lodge is yours."`;
    } else {
      tribeLine = `\n\n"We've enough outsiders for one season."\n(Fewer options are available here.)`;
    }

    const group = this._buildInteriorLayout({
      titleText,
      flavorText: baseFlavorText + tribeLine,
      bgColor,
      bgImage,
      onExit: () => {
        group.setVisible(false);
        this._showExterior();
      }
    });

    // Stash button — only shown in the player's own lodge
    if (playerTribe && playerTribe === tribeId) {
      const PANEL_W = 915, PANEL_H = 685;
      const panelLeft = 640 - PANEL_W / 2;
      const panelTop  = 360 - PANEL_H / 2;

      // Chest icon background
      const stashBg = this.add.rectangle(panelLeft + 52, panelTop + 52, 72, 36, 0x1a1a2e, 1)
        .setStrokeStyle(1, 0x886644)
        .setInteractive({ useHandCursor: true })
        .setDepth(12);

      const stashLabel = this.add.text(panelLeft + 52, panelTop + 52, '🗄 Stash', {
        fontSize: '14px',
        color: '#ffddaa',
        fontFamily: 'Georgia',
      }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });

      const openStash = () => {
        SoundManager.play('handsClick');
        if (!this.scene.isActive('StashOverlay')) {
          this.scene.launch('StashOverlay');
          this.scene.bringToTop('StashOverlay');
        }
      };

      stashBg.on('pointerover',  () => stashBg.setFillStyle(0x2a2a4e, 1));
      stashBg.on('pointerout',   () => stashBg.setFillStyle(0x1a1a2e, 1));
      stashBg.on('pointerdown',  openStash);
      stashLabel.on('pointerdown', openStash);

      // Tribe HQ button — placeholder for the tribe management panel
      const hqBg = this.add.rectangle(panelLeft + 140, panelTop + 52, 84, 36, 0x1a2a1a, 1)
        .setStrokeStyle(1, 0x886644)
        .setInteractive({ useHandCursor: true })
        .setDepth(12);

      const hqLabel = this.add.text(panelLeft + 140, panelTop + 52, '⚔ Tribe HQ', {
        fontSize: '13px',
        color: '#aaffaa',
        fontFamily: 'Georgia',
      }).setOrigin(0.5).setDepth(12).setInteractive({ useHandCursor: true });

      const openHQ = () => {
        SoundManager.play('handsClick');
        this.scene.get('UIScene')?.showDialogue(
          '[ Tribe Headquarters ]\n\n' +
          'Monitor your tribe\'s hunting parties, view active objectives,\n' +
          'and respond to tribe events here.\n\n' +
          '— Coming Soon —'
        );
      };

      hqBg.on('pointerover',  () => hqBg.setFillStyle(0x2a3a2a, 1));
      hqBg.on('pointerout',   () => hqBg.setFillStyle(0x1a2a1a, 1));
      hqBg.on('pointerdown',  openHQ);
      hqLabel.on('pointerdown', openHQ);

      group.add([stashBg, stashLabel, hqBg, hqLabel]);
    }

    // Only cache post-choice layouts — pre-choice content varies by flag state.
    if (playerTribe) {
      this.lodgeGroups[titleText] = group;
    }
  }


  _enterSeersTent() {
    this._hideExteriorsAndOtherInteriors();

    if (this.seersGroup) {
      this.seersGroup.setVisible(true);
      return;
    }

    this.seersGroup = this._buildInteriorLayout({
      titleText: "Seers' Tent",
      flavorText: "Six veiled figures sit motionless.\nTheir gazes pierce reality itself.",
      bgColor: 0x201e29,
      onExit: () => {
        this.seersGroup.setVisible(false);
        this._showExterior();
      }
    });
  }

  _enterWaystone() {
    this._hideExteriorsAndOtherInteriors();

    const hasVisitFlag = ProgressionManager.hasQuestFlag('waystone_visit');
    const isAttuned    = ProgressionManager.hasQuestFlag('waystone_attuned');

    // Rebuild when the visit flag is pending (transitioning to attune state).
    if (hasVisitFlag && this.waystoneGroup) {
      this.waystoneGroup.destroy(true);
      this.waystoneGroup = null;
    }

    if (this.waystoneGroup) {
      this.waystoneGroup.setVisible(true);
      return;
    }

    if (isAttuned) {
      // Post-attunement: show full hunt progress and waystone network.
      const layout = this._buildInteriorLayout({
        titleText: "The Waystone",
        flavorText: "The stone pulses in recognition as you approach.\nGlyphs illuminate across its surface.",
        bgColor: 0x0f1a2a,
        onExit: () => {
          this.waystoneGroup.setVisible(false);
          this._showExterior();
        }
      });

      const huntText = this.add.text(640, 275,
        '— Hunt Progress —\n\n' +
        '[ Prophet tracking coming soon ]\n\n\n' +
        '— Waystone Network —\n\n' +
        '· Elder Grove  ·  Camp Nehemiah  [ Attuned ]\n' +
        '· Northern Passage  [ Locked ]\n' +
        '· The Maw  [ Locked ]\n' +
        '· Ashfield  [ Locked ]',
        {
          fontSize: '15px', color: '#88aacc', align: 'center',
          lineSpacing: 4, wordWrap: { width: 500 }
        }
      ).setOrigin(0.5, 0).setDepth(12);

      layout.add(huntText);
      layout.setDepth(11);
      this.waystoneGroup = layout;

    } else if (hasVisitFlag) {
      // Waystone visit flag active — player has been sent here by Samuel. Show attune prompt.
      const layout = this._buildInteriorLayout({
        titleText: "The Waystone",
        flavorText: "A deep resonance stirs as you draw near.\nAs if something vast is becoming aware of you.",
        bgColor: 0x0f1a2a,
        onExit: () => {
          this.waystoneGroup.setVisible(false);
          this._showExterior();
        }
      });

      const attuneDesc = this.add.text(640, 290,
        '"Glyphs shift and fade across the surface.\nThe hum grows louder — low, patient, waiting."',
        {
          fontSize: '14px', color: '#8899bb', fontStyle: 'italic',
          align: 'center', wordWrap: { width: 480 }
        }
      ).setOrigin(0.5, 0).setDepth(12);

      const attuneBtn = this.add.text(640, 390, '[ Attune to the Waystone ]', {
        fontSize: '18px', color: '#aaccff', fontStyle: 'bold'
      }).setOrigin(0.5).setDepth(12)
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => attuneBtn.setStyle({ color: '#ccddff' }))
        .on('pointerout',  () => attuneBtn.setStyle({ color: '#aaccff' }))
        .on('pointerdown', () => {
          ProgressionManager.clearQuestFlag('waystone_visit');
          ProgressionManager.setQuestFlag('waystone_attuned');
          ProgressionManager.setQuestFlag('samuel_waystone_return');
          GameState.save('autosave');
          SoundManager.play('reward');
          this.waystoneGroup.destroy(true);
          this.waystoneGroup = null;
          this._buildQuestFlags();
          this._enterWaystone(); // rebuild showing attuned state
        });

      layout.add([attuneDesc, attuneBtn]);
      layout.setDepth(11);
      this.waystoneGroup = layout;

    } else {
      // Pre-attunement, not yet directed here — faint hum only.
      const layout = this._buildInteriorLayout({
        titleText: "The Waystone",
        flavorText: "A towering monolith of dark stone.\nA faint hum resonates from somewhere deep within.",
        bgColor: 0x121520,
        onExit: () => {
          this.waystoneGroup.setVisible(false);
          this._showExterior();
        }
      });

      const humText = this.add.text(640, 310,
        '"The stone does not respond to your touch.\nThe hum continues — low, patient, indifferent."',
        {
          fontSize: '14px', color: '#445566', fontStyle: 'italic',
          align: 'center', wordWrap: { width: 480 }
        }
      ).setOrigin(0.5, 0).setDepth(12);

      layout.add(humText);
      layout.setDepth(11);
      this.waystoneGroup = layout;
    }
  }


  // =====================================================
  // 🗼 Elders' Tower (multi-floor)
  // =====================================================
  _enterEldersTower(floor = 1) {
    this._hideExteriorsAndOtherInteriors();

    if (!this.eldersTowerGroups) this.eldersTowerGroups = {};

    if (!this.eldersTowerGroups[floor]) {
      const colors = { 1: 0x30241c, 2: 0x263028, 3: 0x20202f };
      const titles = { 1: "Elders' Tower — F1", 2: "Elders' Tower — F2", 3: "Elders' Tower — F3 (Restricted)" };
      const descs  = {
        1: "A quiet reception with ancient tomes.\nAn elder looks up from the desk.",
        2: "Large stacks of scrolls and brewing incense.",
        3: "The doorway is barred by heavy iron runes."
      };

      const layout = this._buildInteriorLayout({
        titleText: titles[floor],
        flavorText: descs[floor],
        bgColor: colors[floor] || 0x222222,
        onExit: () => { this._hideAllTowerFloors(); this._showExterior(); }
      });

      // Floor navigation
      const navButtons = [];
      if (floor > 1) {
        navButtons.push(this._buildSmallButton(450, 520, '⬆ Floor ' + (floor - 1),
          () => this._enterEldersTower(floor - 1)));
      }
      if (floor < 3) {
        navButtons.push(this._buildSmallButton(830, 520, '⬇ Floor ' + (floor + 1), () => {
          if (floor === 2) {
            this.scene.get('UIScene')?.showDialogue("The elders forbid entry to the top floor.");
          } else {
            this._enterEldersTower(floor + 1);
          }
        }));
      }
      navButtons.forEach(btn => btn.setDepth(12));
      layout.add([...navButtons]);

      // Floor 1 — content depends on current quest flag state.
      if (floor === 1) {
        const tribe              = ProgressionManager.getTribe();
        const hasOrientationFlag = ProgressionManager.hasQuestFlag('orientation_elder');
        const hasTribeFlag       = ProgressionManager.hasQuestFlag('tribe_choice');
        const hasBonepileFlag    = ProgressionManager.hasQuestFlag('elder_bonepile');
        const hasLevelingFlag    = ProgressionManager.hasQuestFlag('elder_leveling');

        if (hasOrientationFlag) {
          // Very first visit — welcome the party, explain the Sacred Hunt and tickets.
          ProgressionManager.clearQuestFlag('orientation_elder');
          ProgressionManager.setQuestFlag('vendor_row');
          GameState.save('autosave');
          this._buildQuestFlags();
          this._addElderLoreToLayout(layout, 'orientation');
        } else if (!tribe && hasTribeFlag) {
          // First visit with tribe choice active — transition flags to lodge markers.
          ProgressionManager.clearQuestFlag('tribe_choice');
          LODGE_FLAGS.forEach(f => ProgressionManager.setQuestFlag(f));
          GameState.save('autosave');
          this._buildQuestFlags();
          this._addTribeChoiceToLayout(layout, true);
        } else if (!tribe && ProgressionManager.isScenarioCompleted('training_encounter_1')) {
          // Subsequent visits before choosing (S1 done, tribe choice is available).
          this._addTribeChoiceToLayout(layout, false);
        } else if (hasLevelingFlag) {
          // Scenario 3 cleared — explain stats, progression, growth.
          // Also clear bonepile flag if it was skipped; the leveling lesson supersedes it
          // and the vendor_row flag is still granted so the player can find the bone pile.
          ProgressionManager.clearQuestFlag('elder_leveling');
          if (hasBonepileFlag) {
            ProgressionManager.clearQuestFlag('elder_bonepile');
            ProgressionManager.setQuestFlag('vendor_row');
          }
          GameState.save('autosave');
          this._buildQuestFlags();
          this._addElderLoreToLayout(layout, 'leveling');
        } else if (hasBonepileFlag) {
          // Scenario 2 cleared — explain Bone Pile and gambling, then unlock vendor_row flag.
          ProgressionManager.clearQuestFlag('elder_bonepile');
          ProgressionManager.setQuestFlag('vendor_row');
          GameState.save('autosave');
          this._buildQuestFlags();
          this._addElderLoreToLayout(layout, 'bonepile');
        } else if (tribe) {
          // Tribe chosen, no pending flags — show allegiance reminder.
          const pledgeTxt = this.add.text(640, 340,
            `You are pledged to the ${TRIBE_DISPLAY_NAMES[tribe]}.\n\nVisit your lodge and tribe vendor\nto see what awaits you.`,
            { fontSize: '16px', color: '#aaddaa', align: 'center', wordWrap: { width: 500 } }
          ).setOrigin(0.5).setDepth(12);
          layout.add(pledgeTxt);
        }
        // If no flag and no tribe: choice hasn't unlocked yet — just floor flavour.
      }

      layout.setDepth(11);
      this.eldersTowerGroups[floor] = layout;
    }

    this._hideAllTowerFloors();
    this.eldersTowerGroups[floor].setVisible(true);
  }

  /**
   * Adds the tribe allegiance choice UI to an Elder's Tower F1 layout.
   * Four buttons, one per tribe, with short flavour descriptions.
   */
  _addTribeChoiceToLayout(layout, showLodgeNudge = false) {
    const quoteText = showLodgeNudge
      ? '"The four great tribes await your pledge. Do not rush this decision.\nVisit the lodges — let them speak for themselves — then return."'
      : '"The four great tribes await your pledge.\nYour allegiance will shape every door that opens — and every one that closes."';

    const elderQuote = this.add.text(640, 268, quoteText,
      { fontSize: '14px', color: '#ccddcc', align: 'center', fontStyle: 'italic', wordWrap: { width: 560 } }
    ).setOrigin(0.5).setDepth(12);
    layout.add(elderQuote);

    const tribes = [
      { id: 'styx',   name: 'Styx',   desc: 'Shadows & poison\nPatient and deadly.' },
      { id: 'zafaar', name: 'Zafaar', desc: 'Fire & fury\nStrength above all.' },
      { id: 'elseth', name: 'Elseth', desc: 'Nature & the hunt\nSwift and cunning.' },
      { id: 'lesse',  name: "Le'sse", desc: 'Spirit & mind\nMagic runs deep.' },
    ];

    // 2×2 grid of choice buttons centered in the tower panel.
    tribes.forEach((t, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x   = 440 + col * 260;
      const y   = 370 + row * 90;

      const btn = this.add.text(x, y, `[ ${t.name} ]\n${t.desc}`, {
        fontSize: '14px',
        color: '#cccccc',
        backgroundColor: '#2a2a2a',
        padding: { x: 14, y: 8 },
        align: 'center',
      }).setOrigin(0.5).setDepth(12)
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => btn.setStyle({ color: '#ffffaa', backgroundColor: '#3a3a2a' }))
        .on('pointerout',  () => btn.setStyle({ color: '#cccccc', backgroundColor: '#2a2a2a' }))
        .on('pointerdown', () => {
          this.scene.get('UIScene')?.showConfirmationDialogue(
            `Pledge your allegiance to the ${t.name}?\n\nThis cannot be undone. Your tribe defines you.`,
            () => this._pledgeTribe(t.id, t.name)
          );
        });

      layout.add(btn);
    });
  }

  /**
   * Adds elder lore text to the F1 layout for post-scenario story beats.
   * topic: 'orientation' | 'bonepile' | 'leveling'
   */
  _addElderLoreToLayout(layout, topic) {
    const lore = {
      orientation: {
        title: 'Welcome to Camp Nehemiah',
        body:
          '"You have arrived at the right time.\n\n' +
          'I am Elder Varek. This camp is home to those who participate in the Sacred Hunt —\n' +
          'a tradition of trial, combat, and growth that has shaped hunters for generations.\n\n' +
          'Your party will face a series of training encounters in the Combat Pit.\n' +
          'Victory earns Hunt Tickets — currency used at the vendor row and Bone Pile.\n\n' +
          'Visit the vendor row across the camp, then report to the Combat Pit.\n' +
          'Your first trial awaits."',
        color: '#ccddff',
      },
      bonepile: {
        title: 'The Elder speaks of the Bone Pile',
        body:
          '"The hunters who return from the Sacred Hunt bring more than trophies.\n' +
          'They bring currency — Hunt Tickets, earned through trial and combat.\n\n' +
          'The Bonepile keeper accepts these tickets. One ticket, one gamble.\n' +
          'The rewards are unpredictable, but rarely worthless.\n\n' +
          'You will find the Bonepile in the vendor row. Spend wisely — or not at all.\n' +
          'Luck has its own wisdom."',
        color: '#ddbb88',
      },
      leveling: {
        title: 'The Elder speaks of growth',
        body:
          '"Your hunters have grown stronger — this is the nature of the Sacred Hunt.\n\n' +
          'Each encounter tempers the body and sharpens the mind.\n' +
          'Statistics define a hunter: their strength, their cunning, their resilience.\n\n' +
          'As levels rise, these numbers shift — new possibilities emerge.\n' +
          'Study your party\'s sheet. Understand what each value means.\n\n' +
          'The hunt ahead will demand more than courage."',
        color: '#aaddaa',
      },
    };

    const cfg = lore[topic];
    if (!cfg) return;

    const title = this.add.text(640, 260, cfg.title, {
      fontSize: '16px', color: '#ffddaa', fontStyle: 'bold', align: 'center'
    }).setOrigin(0.5).setDepth(12);

    const body = this.add.text(640, 310, cfg.body, {
      fontSize: '14px', color: cfg.color, align: 'center',
      fontStyle: 'italic', wordWrap: { width: 560 }
    }).setOrigin(0.5, 0).setDepth(12);

    layout.add([title, body]);
  }

  /**
   * Handles the tribe pledge: saves, clears the quest flag, invalidates
   * cached interiors, and shows confirmation dialogue.
   */
  _pledgeTribe(tribeId, tribeName) {
    const success = ProgressionManager.setTribe(tribeId);
    if (!success) return;   // already pledged (shouldn't happen but guard anyway)

    // Clear any remaining lodge flags (player may have skipped some lodges).
    LODGE_FLAGS.forEach(f => ProgressionManager.clearQuestFlag(f));

    // The tribe ticket is now ready to spend — point the player at the tribe vendors.
    ProgressionManager.setQuestFlag('tribe_vendor');

    GameState.save('autosave');

    // Invalidate cached interiors that depend on tribe state.
    if (this.eldersTowerGroups?.[1]) {
      this.eldersTowerGroups[1].destroy(true);
      this.eldersTowerGroups[1] = null;
    }
    if (this.lodgeGroups) {
      Object.values(this.lodgeGroups).forEach(g => g.destroy(true));
      this.lodgeGroups = {};
    }
    this._lastKnownTribe = tribeId;

    // Rebuild quest flag markers on the map.
    this._buildQuestFlags();

    // Rebuild the right-panel menu so the Tribes button appears immediately.
    this.scene.get('UIScene')?.refreshUI?.();

    // Return to exterior and show confirmation.
    this._hideExteriorsAndOtherInteriors();
    this._showExterior();
    this.scene.get('UIScene')?.showDialogue(
      `You have pledged your allegiance to the ${tribeName}.\n\n` +
      `A Tribe Ticket has been added to your wallet.\n` +
      `Visit the tribe vendor row and your lodge — ` +
      `the ${tribeName} will greet you as one of their own.`
    );
  }

  _hideAllTowerFloors() {
    if (this.eldersTowerGroups) {
      Object.values(this.eldersTowerGroups).forEach(g => g?.setVisible(false));
    }
  }

  // =====================================================
  // Utility helpers
  // =====================================================
  _hideExteriorsAndOtherInteriors() {
    if (this.campMap) this.campMap.setVisible(false);
    if (this.samuelInteriorGroup) this.samuelInteriorGroup.setVisible(false);
    if (this.vendorRowGroup) this.vendorRowGroup.setVisible(false);
    if (this.lodgeGroups) Object.values(this.lodgeGroups).forEach(g => g.setVisible(false));
    this._hideAllTowerFloors();
    if (this.seersGroup) this.seersGroup.setVisible(false);
    if (this.waystoneGroup) this.waystoneGroup.setVisible(false);
  }

  _showExterior() {
    if (this.campMap) this.campMap.setVisible(true);
  }

  _buildExitButton(callback) {
    return this.add.text(640, 540, '[ Exit ]', {
      fontSize: '20px',
      color: '#ff8888'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', callback);
  }

  _buildSmallButton(x, y, label, callback) {
    return this.add.text(x, y, label, {
      fontSize: '16px',
      color: '#88ff88'
    })
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', callback);
  }
  /**
   * Quick helper to wire up a clickable zone.
   * @param {number} x - world X center
   * @param {number} y - world Y center
   * @param {number} w - zone width
   * @param {number} h - zone height
   * @param {string} prompt - text to show in confirmation box
   * @param {Function} onEnter - callback if user presses Enter
   */
  _registerZone(x, y, w, h, prompt, onEnter) {
    const z = this.add.zone(x, y, w, h)
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    z.on('pointerdown', () => {
      this.scene.get('UIScene')?.showConfirmationDialogue(prompt, onEnter);
    });
  }

  _enterLeaderHut(tribe) {
    this._hideExteriorsAndOtherInteriors();

    if (!this.leaderGroups) this.leaderGroups = {};

    // Map display name → internal ID
    const TRIBE_KEY = { Elseth: 'elseth', Styx: 'styx', "Le'sse": 'lesse', Zafaar: 'zafaar' };
    const tribeId       = TRIBE_KEY[tribe] ?? tribe.toLowerCase();
    const briefFlag     = `${tribeId}_leader_brief`;
    const challengeFlag = `${tribeId}_leader_challenge`;
    const handinFlag    = `${tribeId}_leader_handin`;

    const briefActive     = ProgressionManager.hasQuestFlag(briefFlag);
    const challengeActive = ProgressionManager.hasQuestFlag(challengeFlag);
    const handinActive    = ProgressionManager.hasQuestFlag(handinFlag);

    // Bust cache whenever any quest flag is live so fresh dialogue always shows
    if ((briefActive || challengeActive || handinActive) && this.leaderGroups[tribe]) {
      this.leaderGroups[tribe].destroy(true);
      delete this.leaderGroups[tribe];
    }

    if (this.leaderGroups[tribe]) {
      this.leaderGroups[tribe].setVisible(true);
      return;
    }

    const colors = {
      Styx:     0x221b24,
      Zafaar:   0x24221b,
      Elseth:   0x1b241c,
      "Le'sse": 0x1c1f24,
    };
    const interiorImages = {
      Zafaar:   'zafaar_interior',
      Styx:     'styx_interior',
      Elseth:   'elseth_interior',
      "Le'sse": 'lesse_interior',
    };

    // ── Phase 1: BRIEF — player visits before the encounter ──────────────────
    // Clear the brief flag on entry (one-time read). No Complete button.
    if (briefActive) {
      ProgressionManager.clearQuestFlag(briefFlag);
      GameState.save('autosave');
      this._buildQuestFlags();
    }

    // ── Phase 2: CHALLENGE → HANDIN transition ────────────────────────────────
    // The encounter is done. First entry converts the orange ! to a gold ★.
    if (challengeActive) {
      ProgressionManager.clearQuestFlag(challengeFlag);
      ProgressionManager.setQuestFlag(handinFlag);
      GameState.save('autosave');
      this._buildQuestFlags();
    }

    // ── Flavor text per phase ─────────────────────────────────────────────────
    const BRIEF_TEXT = {
      elseth:
        'A slight smirk crosses her face as you enter.\n' +
        'In the corner, a training dummy flickers with pale green light.\n\n' +
        '"I animate those constructs in the pit. Call it a hobby — or a warning."\n\n' +
        'She waves a hand and the dummy\'s arm jerks upright.\n\n' +
        '"I\'ve been watching your form. Sloppy, but there\'s something there.\n' +
        'Next time I send them out, they\'ll fight back properly.\n' +
        'Real weapons. Real coordination. We\'ll see what you\'re made of."',
      styx:
        '"You handled the basics. Strength is the easy part."\n\n' +
        'The hunter does not look up from the map spread across the table.\n\n' +
        '"Mettle, now — that takes coordination. Moving together,\n' +
        'covering flanks, reading what the other is going to do\n' +
        'before they do it. My hunters will test you.\n' +
        'See if your party can keep pace."',
      lesse:
        'Two figures sit motionless near the far wall,\n' +
        'eyes closed, breathing in perfect unison.\n\n' +
        'The elder speaks without turning.\n\n' +
        '"You have shown you can fight. But have you faced\n' +
        'those who bend the elements to their will?\n' +
        'My students have been waiting for a worthy test.\n' +
        'They will not hold back — nor should you."',
      zafaar:
        'The Zafaar champion stands with his back to the door,\n' +
        'arms crossed, a massive weapon leaning against the wall beside him.\n\n' +
        '"I heard you put down the Le\'sse duelists.\n' +
        'Good. Means you\'re worth something."\n\n' +
        'He turns, eyes fixed on you.\n\n' +
        '"My fighters will be waiting for you in the pit.\n' +
        'Give them a real fight."',
    };

    const HANDIN_TEXT = {
      elseth:
        'She looks up from the flickering dummy. A slight nod.\n\n' +
        '"Better than expected. You followed them into a corner\n' +
        'and kept the pressure. That\'s what I was watching for."\n\n' +
        'She gestures toward a small chest near the door.\n\n' +
        '"Take what\'s in there. You earned it."',
      styx:
        'The hunter looks up from her map for the first time.\n\n' +
        '"Your flanks held. You moved together." She taps the map.\n\n' +
        '"I\'ve seen trained hunters fall apart under that kind of pressure."\n\n' +
        'She stands.\n\n' +
        '"Consider this a debt repaid."',
      lesse:
        'The two figures open their eyes in unison.\n\n' +
        'The elder turns slowly.\n\n' +
        '"You moved with the current, not against it.\n' +
        'There is wisdom in how you resisted."\n\n' +
        'A wrapped bundle rests near the door.\n\n' +
        '"The elements leave nothing without reason."',
      zafaar:
        'The champion doesn\'t turn for a long moment.\n\n' +
        '"I heard the outcome."\n\n' +
        'A pause.\n\n' +
        '"Decent."\n\n' +
        'He nods toward a pouch on the floor beside his weapon.\n\n' +
        '"There. Don\'t make me say it again."',
    };

    const flavorText = (challengeActive || handinActive)
      ? (HANDIN_TEXT[tribeId]  ?? `The ${tribe} leader acknowledges your effort.`)
      : briefActive
        ? (BRIEF_TEXT[tribeId] ?? `The ${tribe} leader studies your approach.`)
        : `The ${tribe} leader studies your approach.`;

    const group = this._buildInteriorLayout({
      titleText: `${tribe} Leader`,
      flavorText,
      bgColor: colors[tribe] || 0x222222,
      bgImage:  interiorImages[tribe] ?? null,
      onExit: () => {
        this.leaderGroups[tribe].setVisible(false);
        this._showExterior();
      },
    });

    // ── Phase 3: COMPLETE button — shown only during hand-in ─────────────────
    if (challengeActive || handinActive) {
      const completeBtn = this.add.text(640, 520,
        '[ Collect Reward ]',
        {
          fontSize: '20px',
          color: '#111100',
          fontStyle: 'bold',
          backgroundColor: '#ffdd44',
          padding: { x: 14, y: 7 },
        }
      ).setOrigin(0.5).setInteractive({ useHandCursor: true });

      completeBtn.on('pointerover', () => completeBtn.setBackgroundColor('#ffe866'));
      completeBtn.on('pointerout',  () => completeBtn.setBackgroundColor('#ffdd44'));

      completeBtn.on('pointerdown', () => {
        SoundManager.play('reward');

        // Grant rep
        ProgressionManager.clearQuestFlag(handinFlag);
        ProgressionManager.addTribeRep(tribeId, LEADER_QUEST_REP_GAIN);

        // Award 3 random jewelry items from this tribe's pool
        const pool = [...(TRIBE_JEWELRY_POOL[tribeId] ?? [])];
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const rewardNames = [];
        pool.slice(0, 3).forEach(itemId => {
          const inst = createItemInstance(itemId, { rarity: 'uncommon' });
          if (inst) {
            InventorySystem.addGlobalItem(inst);
            rewardNames.push(inst.displayName ?? itemId);
          }
        });

        // Show a brief toast so the player knows what they received
        if (rewardNames.length > 0) {
          this.scene.get('UIScene')?.showToast(`Reward: ${rewardNames.join(', ')}`);
        }

        GameState.save('autosave');
        this._buildQuestFlags();

        // Bust cache so the next visit shows normal dialogue
        if (this.leaderGroups[tribe]) {
          this.leaderGroups[tribe].destroy(true);
          delete this.leaderGroups[tribe];
        }
        this._showExterior();
      });

      group.add(completeBtn);
    }

    this.leaderGroups[tribe] = group;
  }


  // =====================================================
  // ⚔️ Combat Pit
  // =====================================================
  _enterCombatPit() {
    // Clear the ! marker — it will reappear via refreshCombatPitFlag()
    // only after all gate flags for the next scenario are cleared.
    if (ProgressionManager.hasQuestFlag('combat_pit')) {
      ProgressionManager.clearQuestFlag('combat_pit');
      this._buildQuestFlags();
    }

    const scenarioIds = [
      'training_encounter_1',
      'training_encounter_2',
      'training_encounter_3',
      'training_encounter_4',
      'training_encounter_5',
      'training_encounter_6'
    ];

    const menuOptions = scenarioIds.map(id => {
      const scenario = COMBAT_SCENARIOS[id];
      const unlocked  = ProgressionManager.isScenarioUnlocked(id);
      const completed = ProgressionManager.isScenarioCompleted(id);

      // Label shows a checkmark for already-beaten scenarios.
      const label = completed ? `${scenario.name}  ✓` : scenario.name;

      return {
        label,
        description:     unlocked ? scenario.description : 'Complete the previous scenario to unlock.',
        longDescription: unlocked ? (scenario.longDescription || scenario.description) : 'Finish the previous scenario first to unlock this challenge.',
        portraitKey:     scenario.portraitKey || null,
        locked:          !unlocked,
        onSelect:        unlocked ? () => this._startTraining(id) : null,
      };
    });

    // Dev bypass toggle — flips the bypass and re-opens the menu so the
    // locked/unlocked state refreshes immediately.
    const bypassToggle = {
      enabled:  ProgressionManager.isBypassEnabled(),
      onToggle: () => {
        ProgressionManager.toggleBypass();
        this.scene.get('UIScene')?.cleanupPopup();
        this._enterCombatPit();
      },
    };

    this.scene.get('UIScene')?.showSelectionMenu(
      'Choose Training Scenario',
      menuOptions,
      { bypassToggle }
    );
  }


  _startTraining(scenarioId) {
    if (!GameState.party || GameState.party.length === 0) {
      this.scene.get('UIScene')?.showDialogue(
        'Assemble your party first.\nVisit the bonfire to create hunters, then add them to your party.'
      );
      return;
    }
    window.sceneManager.loadScene(
      'CombatScene',
      'Training begins…',
      {
        mode: 'pit',
        party: GameState.party,
        scenarioId
      }
    );
  }


  // =====================================================
  // 🚪 Hunt Gate (transition placeholder)
  // =====================================================
  _enterHuntGate() {
    // Don't hide the exterior — this is a placeholder dialogue only.
    // Hiding without a guaranteed restore path causes the screen to stay dark.
    this.scene.get('UIScene')?.showConfirmationDialogue(
      "Are you ready to depart for the Sacred Hunt?\n(Feature coming soon)",
      () => {
        console.log("TODO: switch to Exploration / Hunt scene.");
      }
    );
  }
  ////////////Vendors///////////////////////////

  _openTribeVendor(vendorKey, displayName) {
    this.vendorTitle.setText(displayName);

    // Clear any item buttons left over from a previous vendor selection.
    if (this._tribeVendorItemButtons) {
      this._tribeVendorItemButtons.forEach(b => b.destroy());
    }
    this._tribeVendorItemButtons = [];

    const playerTribe = ProgressionManager.getTribe();
    const vendorTribe = VENDOR_KEY_TO_TRIBE[vendorKey] || null;

    // --- No tribe chosen yet ---
    if (!playerTribe) {
      this.vendorBody.setText(
        'Pledge your allegiance at the Elder\'s Tower first.\nThen return to your tribe\'s vendor.'
      );
      return;
    }

    // --- Wrong tribe vendor ---
    if (vendorTribe !== playerTribe && !DevFlags.isAllTribesEnabled()) {
      const npcName = displayName.split(' —')[0].trim();
      this.vendorBody.setText(
        `${npcName} turns away.\n\n"We trade only with our own. Seek your tribe's vendor."`
      );
      return;
    }

    // --- Tribe vendor inventory ---
    this.vendorBody.setText('');
    // Make vendorBody hoverable for post-purchase tooltip
    if (!this.vendorBody._tribeTooltipWired) {
      this.vendorBody.setInteractive({ useHandCursor: false });
      this.vendorBody._tribeTooltipWired = true;
    }

    // Build a pre-purchase tooltip from a base item's fixedAffix definition.
    // Shows the roll range (or granted skill) since no instance exists yet.
    const buildPrePurchaseTip = (base) => {
      const affix = base.fixedAffix;
      const slotLine = base.slot ? base.slot.charAt(0).toUpperCase() + base.slot.slice(1) : '';
      const tipLines = slotLine ? [slotLine] : [];
      if (affix?.family && affix?.range) {
        const [lo, hi] = affix.range;
        const bt = affix.buildupTarget;
        const MAP = {
          physToElemPercent:    `${lo}–${hi}% Physical → Elemental Conversion`,
          physToNecroPercent:   `${lo}–${hi}% Physical → Necrotic Conversion`,
          elemToNecroPercent:   `${lo}–${hi}% Elemental → Necrotic Conversion`,
          initBonusOnBattleStart: `+${lo}–${hi} Initiative at Battle Start`,
          shieldPctOnBattleStart: `+${lo}–${hi}% Shield at Battle Start`,
          physBuildupOnPhysDmg: `${lo}–${hi}% Phys Dmg → ${bt} Buildup`,
          elemBuildupOnElemDmg: `${lo}–${hi}% Elem Dmg → ${bt} Buildup`,
          procDoubleDamage:     `${lo}–${hi}% Chance: Double Damage`,
          procHalfDamageTaken:  `${lo}–${hi}% Chance: Halve Damage Taken`,
          procHealOnHeal:       `${lo}–${hi}% Chance: Double Heal`,
          procPhysFlat:         `${lo}–${hi}% Chance: +20 Physical Damage`,
          procElemFlat:         `${lo}–${hi}% Chance: +20 Elemental Damage`,
          procNecroFlat:        `${lo}–${hi}% Chance: +20 Necrotic Damage`,
        };
        if (MAP[affix.family]) tipLines.push(MAP[affix.family]);
      }
      if (base.grantsSkills?.length) {
        const names = base.grantsSkills.map(id =>
          id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        );
        tipLines.push(`Grants: ${names.join(', ')}`);
      }
      const dispName = `${base.name}${affix?.key ? ' ' + affix.key : ''}`;
      return { title: dispName, titleColor: RARITY_COLORS[base.rarity] || '#cccccc', lines: tipLines };
    };

    const itemIds = TRIBE_VENDOR_INVENTORY[vendorTribe] || [];

    itemIds.forEach((itemId, i) => {
      const baseItem = Items[itemId];
      if (!baseItem) return;

      const stock = ProgressionManager.getTribeVendorStock(itemId);
      const soldOut = stock <= 0;

      const rowY = 240 + i * 36;
      const rarityColor = soldOut ? '#555555' : (RARITY_COLORS[baseItem.rarity] || '#cccccc');
      const slotLabel = baseItem.slot ? ` [${baseItem.slot}]` : '';
      const stockTag = soldOut ? '  [ Sold Out ]' : `  [ Free — ${stock} left ]`;
      const itemLabel = `• ${baseItem.name}${slotLabel}${stockTag}`;

      const btn = this.add.text(610, rowY, itemLabel,
        { fontSize: '15px', color: rarityColor }
      ).setDepth(13);

      if (!soldOut) {
        btn.setInteractive({ useHandCursor: true })
          .on('pointerover', (pointer) => {
            btn.setColor('#ffffaa');
            const tip = buildPrePurchaseTip(baseItem);
            if (tip && this.tooltip) this.tooltip.show(pointer.worldX, pointer.worldY, tip);
          })
          .on('pointermove', (pointer) => {
            const tip = buildPrePurchaseTip(baseItem);
            if (tip && this.tooltip) this.tooltip.show(pointer.worldX, pointer.worldY, tip);
          })
          .on('pointerout', () => {
            btn.setColor(rarityColor);
            this.tooltip?.hide();
          })
          .on('pointerdown', () => {
            SoundManager.play('dullClick');
            const inst = createItemInstance(itemId);
            InventorySystem.addGlobalItem(inst);
            ProgressionManager.decrementTribeVendorStock(itemId);

            // First-time purchase: nudge toward combat pit
            if (ProgressionManager.hasQuestFlag('tribe_vendor')) {
              ProgressionManager.clearQuestFlag('tribe_vendor');
              ProgressionManager.setQuestFlag('combat_pit');
            }

            GameState.save('autosave');
            this._buildQuestFlags();
            this.tooltip?.hide();

            // Rebuild button list so stock counts update immediately.
            // Must happen BEFORE setting vendorBody text — the rebuild resets it to ''.
            this._lastTribePurchase = inst;
            this._openTribeVendor(vendorKey, displayName);
            this.vendorBody.setText(`Received: ${inst.displayName}`);
          });
      }

      // Add to the tribe vendor group so it's cleaned up on exit.
      this.tribeVendorGroup.add(btn);
      this._tribeVendorItemButtons.push(btn);
    });

    // Wire vendorBody to show the last purchased item's tooltip on hover
    this.vendorBody.off('pointerover').on('pointerover', (p) => {
      if (!this._lastTribePurchase) return;
      const tip = this._buildItemTooltipData(this._lastTribePurchase);
      if (tip && this.tooltip) this.tooltip.show(p.worldX, p.worldY, tip);
    });
    this.vendorBody.off('pointermove').on('pointermove', (p) => {
      if (!this._lastTribePurchase) return;
      const tip = this._buildItemTooltipData(this._lastTribePurchase);
      if (tip && this.tooltip) this.tooltip.show(p.worldX, p.worldY, tip);
    });
    this.vendorBody.off('pointerout').on('pointerout', () => this.tooltip?.hide());
  }

  _enterTribeVendorRow() {
    this._hideExteriorsAndOtherInteriors();

    if (this.tribeVendorGroup) {
      this.tribeVendorGroup.setVisible(true);
      return;
    }

    const layout = this._buildInteriorLayout({
      titleText: "Tribe Vendors",
      flavorText: null,
      bgColor: 0x20201f,
      bgImage: 'menu_stony_background',
      titleColor: '#2a1800',
      exitText: '[ Exit Market ]',
      onExit: () => {
        this.tribeVendorGroup.setVisible(false);
        this._showExterior();
      }
    });

    // Vendor List
    const vendors = [
      { key: 'aivorel', name: "Aivorel — Le'sse Tribe" },
      { key: 'baruun', name: "Baruun — Zafaar Tribe" },
      { key: 'nahlia', name: "Nahlia — Elseth Tribe" },
      { key: 'vashra', name: "Vashra — Styx Tribe" }
    ];

    vendors.forEach((v, i) => {
      const txt = this.add.text(230, 160 + i * 40, `• ${v.name}`, {
        fontSize: '20px',
        color: '#2a1800'
      })
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => txt.setColor('#4a3010'))
        .on('pointerout', () => txt.setColor('#2a1800'))
        .on('pointerdown', () => { SoundManager.play('select'); this._openTribeVendor(v.key, v.name); });

      layout.add(txt);
    });

    // Inventory Panel + Info (wider + lower)
    this.vendorPanel = createPanel(this, 545, 155, 510, 440, 'menu');
    this.vendorTitle = this.add.text(800, 165, 'Select a Vendor', {
      fontSize: '22px',
      color: '#ffddaa'
    }).setOrigin(0.5);
    // Currency strip — updated on every purchase so the player always sees
    // their current ticket count without leaving the market.
    this.tribeVendorCurrencyDisplay = this.add.text(800, 143, this._currencyLine(), {
      fontSize: '12px',
      color: '#3a2818'
    }).setOrigin(0.5).setDepth(13);
    this.vendorBody = this.add.text(610, 210, '', {
      fontSize: '16px',
      color: '#dddddd',
      wordWrap: { width: 470 }
    });

    layout.add([this.vendorPanel, this.vendorTitle, this.tribeVendorCurrencyDisplay, this.vendorBody]);
    layout.setDepth(11);
    this.tribeVendorGroup = layout;
  }


  ////////////////////////////////////////////



}