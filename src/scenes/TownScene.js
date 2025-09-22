import GameState from '../systems/GameState.js';
import InventorySystem from '../systems/InventorySystem.js';
import { Items } from '../../data/items.js';
import { COMBAT_SCENARIOS } from '../../data/combatScenarios.js';
import { createItemInstance } from '../systems/ItemFactory.js';
import Tooltip from '../ui/Tooltip.js';

// === Shared quality colors ===
const QUALITY_COLORS = {
  common: '#cccccc',
  uncommon: '#33cc33',
  rare: '#3399ff',
  epic: '#cc33cc',
  legendary: '#ff9933'
};



// Bias the gamble towards testing higher tiers but still mostly uncommon/rare
function randomQualityForGamble() {
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


  create() {
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
      x: 648, y: 330,
      scale: 0.17,
      fps: 4,
      alpha: 0.9
    }, {
      x: 654, y: 327,
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

    // --- Le’sse ---
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


    // Seers’ Tent
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


    // Elders’ Tower
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
      x: 823, y: 70,
      scale: 0.15,
      fps: 4,
      alpha: 0.9
    }, {
      x: 823, y: 87,
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



  }

  _buildInteriorLayout({ titleText, flavorText, bgColor = 0x1e1a18, exitText = '[ Exit ]', onExit }) {
    const bg = this.add.rectangle(640, 360, 915, 685, bgColor, 1)
      .setStrokeStyle(4, 0x886644)
      .setDepth(0);

    const title = this.add.text(640, 120, titleText, {
      fontSize: '28px',
      color: '#ffddaa',
      fontFamily: 'Georgia',
      fontStyle: 'bold'
    }).setOrigin(0.5);

    const flavor = this.add.text(640, 200, flavorText, {
      fontSize: '18px',
      color: '#dddddd',
      fontFamily: 'Georgia',
      align: 'center',
      wordWrap: { width: 600 }
    }).setOrigin(0.5);

    const exitBtn = this.add.text(640, 620, exitText, {
      fontSize: '20px',
      color: '#ff8888'
    }).setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', onExit);

    return this.add.container(0, 0, [bg, title, flavor, exitBtn]).setDepth(11);
  }


  // =====================================================
  // 🏕 Transition into Samuel's Tent Interior
  // =====================================================
  enterSamuelTent() {
    if (this.campMap) this.campMap.setVisible(false);

    if (this.samuelInteriorGroup) {
      this.samuelInteriorGroup.setVisible(true);
      return;
    }

    this.samuelInteriorGroup = this._buildInteriorLayout({
      titleText: 'Samuel Mourne',
      flavorText: "The interior seems strangely familiar.\nSamuel studies you quietly.",
      onExit: () => this.leaveSamuelTent()
    });
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

    if (this.vendorRowGroup) {
      this.vendorRowGroup.setVisible(true);
      return;
    }

    const layout = this._buildInteriorLayout({
      titleText: 'Vendor Row',
      flavorText: '',  // Empty here — we'll manually place it lower
      bgColor: 0x1a2022,
      exitText: '[ Exit Market ]',
      onExit: () => this.leaveVendorRow()
    });

    // Vendor list container
    this.vendorListContainer = this.add.container(0, 0);
    this.showVendorList();

    // Hide any default flavor produced by _buildInteriorLayout to prevent overlap
    if (this.vendorRowFlavorText) this.vendorRowFlavorText.setVisible(false);

    this.vendorLeftFlavor = this.add.text(230, 440,
      "A selection of traders await behind makeshift stalls.",
      { fontSize: '16px', color: '#aaaaaa', wordWrap: { width: 280 } }
    );

    layout.add(this.vendorLeftFlavor);



    layout.add(this.vendorListContainer);

    // Inventory panel
    this.vendorInventoryPanel = this.add.rectangle(800, 375, 510, 440, 0x111111, 0.9)
      .setStrokeStyle(2, 0xffffff);
    this.vendorInventoryTitle = this.add.text(800, 165, 'Select a Vendor', {
      fontSize: '22px',
      color: '#ffddaa'
    }).setOrigin(0.5);
    this.vendorInventoryText = this.add.text(610, 250, '', {
      fontSize: '16px',
      color: '#dddddd',
      wordWrap: { width: 470 }
    });

    // Inventory scroll container
    this.vendorInventoryContainer = this.add.container(0, 0);
    this._resetInventoryMask();


    layout.add([
      this.vendorInventoryPanel,
      this.vendorInventoryTitle,
      this.vendorInventoryText,
      this.vendorInventoryContainer
    ]);

    layout.setDepth(12);
    this.vendorRowGroup = layout;

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
    if (this.gambleButton) { this.gambleButton.destroy(); this.gambleButton = null; }
    if (this.vendorRowGroup) this.vendorRowGroup.setVisible(false);
    if (this.campMap) this.campMap.setVisible(true);

    if (this.vendorLeftFlavor) this.vendorLeftFlavor.setVisible(false);
    if (this.vendorInventoryText) this.vendorInventoryText.setText(''); // right panel cleared
    this.tooltip?.hide();


    // ✅ Cleanup vendor buttons
    if (this.vendorButtons) {
      this.vendorButtons.forEach(btn => btn.destroy());
      this.vendorButtons = [];
    }

    // ✅ Cleanup category tabs
    if (this.vendorCategoryButtons) {
      this.vendorCategoryButtons.forEach(btn => btn.destroy());
      this.vendorCategoryButtons = [];
    }

    // ✅ Reset inventory scroll container
    if (this.vendorInventoryContainer) {
      this.vendorInventoryContainer.removeAll(true);
      this.vendorInventoryContainer.y = 0;
    }

    // ✅ Optionally reset text fields
    if (this.vendorInventoryTitle) this.vendorInventoryTitle.setText('Select a Vendor');
    if (this.vendorInventoryText) this.vendorInventoryText.setText('');
  }


  showVendorList() {
    if (this.gambleButton) { this.gambleButton.destroy(); this.gambleButton = null; }
    if (this.vendorListContainer) this.vendorListContainer.removeAll(true);

    if (this.vendorLeftFlavor) {
      this.vendorLeftFlavor.setText("A selection of traders await behind makeshift stalls.");
      this.vendorLeftFlavor.setVisible(true);
    }


    const vendors = this.getVendorDefinitions();
    const startY = 160;
    let i = 0;

    Object.keys(vendors).forEach(vKey => {
      const vendorDef = vendors[vKey];
      const txt = this.add.text(230, startY + i * 40, `• ${vendorDef.displayName}`, {
        fontSize: '20px',
        color: '#cccccc'
      })
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => txt.setColor('#ffffff'))
        .on('pointerout', () => txt.setColor('#cccccc'))
        .on('pointerdown', () => this.showSingleVendor(vKey));

      this.vendorListContainer.add(txt);
      i++;
    });
  }

  showSingleVendor(vendorKey) {
    if (this.vendorListContainer) this.vendorListContainer.removeAll(true);

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
        color: '#ffffff'
      })
    );

    // Back button
    this.vendorListContainer.add(
      this.add.text(230, 200, '[ Back ]', {
        fontSize: '18px',
        color: '#ff6666'
      })
        .setInteractive({ useHandCursor: true })
        .on('pointerover', function () { this.setColor('#ffffff'); })
        .on('pointerout', function () { this.setColor('#ff6666'); })
        .on('pointerdown', () => {
          this.vendorInventoryContainer.removeAll(true);
          this.vendorInventoryContainer.y = 0;
          this.showVendorList();
          this.vendorInventoryTitle.setText('Select a Vendor');
          // keep the layout flavor hidden; drive flavor via vendorLeftFlavor only
          if (this.vendorLeftFlavor) {
            this.vendorLeftFlavor.setText("A selection of traders await behind makeshift stalls.");
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
    if (this.gambleButton) { this.gambleButton.destroy(); this.gambleButton = null; }
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

      // Fixed button OUTSIDE the scroll container
      this.gambleButton = this.add.text(620, 220, '[ Gamble (Free) ]', {
        fontSize: '20px',
        color: '#ffddaa'
      })
        .setDepth(13)
        .setInteractive({ useHandCursor: true })
        .on('pointerover', function () { this.setColor('#ffffff'); })
        .on('pointerout', function () { this.setColor('#ffddaa'); })
        .on('pointerdown', () => {
          const pool = getWeaponIdPool();
          if (!pool.length) {
            this.vendorInventoryText.setText('No weapon IDs found in Items.js.');
            return;
          }
          const baseId = pool[(Math.random() * pool.length) | 0];
          const q = randomQualityForGamble();
          const inst = createItemInstance(baseId, { quality: q });
          if (!inst) {
            this.vendorInventoryText.setText(`Failed to create instance for ${baseId}.`);
            return;
          }

          InventorySystem.addGlobalItem(inst);

          // log line
          const BONEPILE_LOG_START_Y = 300;
          const LOG_X = 590;
          const LOG_LINE_H = 24;
          const lineY = BONEPILE_LOG_START_Y + this.vendorInventoryContainer.listHeight;
          const line = this.add.text(LOG_X, lineY, `→ ${inst.displayName}`, {
            fontSize: '16px',
            color: QUALITY_COLORS[q] || '#ffffff'
          }).setDepth(13);
          this.vendorInventoryContainer.add(line);
          this.vendorInventoryContainer.listHeight += LOG_LINE_H;

          // auto-scroll
          const visibleH = (this._inventoryMaskBottom - this._inventoryMaskTop);
          let maxScroll = Math.max(0, this.vendorInventoryContainer.listHeight - visibleH);
          if (LOG_LINE_H > 0) maxScroll = Math.ceil(maxScroll / LOG_LINE_H) * LOG_LINE_H;
          this.vendorInventoryContainer.y = -maxScroll;

          this.vendorInventoryText.setText(`You received: ${inst.displayName}`);
        });

      if (this.vendorRowGroup) this.vendorRowGroup.add(this.gambleButton);
      else this.add.existing(this.gambleButton);
      
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
        .on('pointerdown', () => this.openVendorInventory(vendorKey, cat.key));

      this.vendorCategoryButtons.push(btn);
      if (this.vendorRowGroup) this.vendorRowGroup.add(btn);
    });

    // Clear old inventory
    this.vendorInventoryContainer.removeAll(true);

    this._resetInventoryMask(); // ensure top=220 for regular vendors
    this.vendorInventoryContainer.topPadding = 0;
    this.vendorInventoryContainer.lineHeight = 36; // your normal row height

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
        const color = QUALITY_COLORS[entry.base.quality] || '#cccccc';

        const text = this.add.text(620, 220 + yOffset, `• ${entry.base.name} — ${entry.cost}g`, {
          fontSize: '18px',
          color
        })
          .setDepth(13)
          .setInteractive({ useHandCursor: true })
          .on('pointerover', (pointer) => {
            text.setColor('#ffffff');
            const base = entry.base;
            const lines = [];

            if (base.description || entry.desc) lines.push(base.description || entry.desc);
            // Show some quick specs if present
            if (base.type) lines.push(`Type: ${base.type}`);
            if (base.slot) lines.push(`Slot: ${base.slot}`);
            if (typeof base.hands === 'number') lines.push(`Hands: ${base.hands}`);
            if (base.damage && (base.damage.min != null || base.damage.max != null)) {
              const min = base.damage.min ?? '?', max = base.damage.max ?? '?';
              lines.push(`Damage: ${min}–${max}`);
            }

            this.tooltip.show(pointer.worldX, pointer.worldY, {
              title: base.name,
              titleColor: QUALITY_COLORS[base.quality] || '#dddddd',
              lines
            });
          })
          .on('pointermove', (pointer) => {
            this.tooltip.reposition(pointer.worldX, pointer.worldY);
          })

          .on('pointerout', () => {
            text.setColor(color);
            this.tooltip.hide();
          })

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
            this.vendorInventoryText.setText(`Purchased: ${instance.displayName || entry.base.name}`);
            console.log(`✅ Added to global inventory:`, instance);

          });

        this.vendorInventoryContainer.add(text);
        yOffset += 36;
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
        displayName: "Ironbinder’s Stand",
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
  'Trade your coin, tempt your fate,' they beckon. You’re not sure which
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
  enterStyxLodge() {
    this._enterGenericLodge(
      'Styx Lodge',
      0x2a1f29,
      "A dusky hall draped in violet banners."
    );
  }

  // =====================================================
  // 🔥 Zafaar Lodge Interior (placeholder)
  // =====================================================
  enterZafaarLodge() {
    this._enterGenericLodge(
      'Zafaar Lodge',
      0x2a2a1f,
      "Crackling braziers light ornate stonework."
    );
  }

  // =====================================================
  // 🌲 Elseth Lodge Interior (placeholder)
  // =====================================================
  enterElsethLodge() {
    this._enterGenericLodge(
      'Elseth Lodge',
      0x1f2a1f,
      "Pine scent fills an airy wooden hall."
    );
  }

  // =====================================================
  // 🍃 Le'sse Lodge Interior (placeholder)
  // =====================================================
  enterLesseLodge() {
    this._enterGenericLodge(
      "Le'sse Lodge",
      0x1f262a,
      "Soft lanterns sway amid silk canopies."
    );
  }

  _enterGenericLodge(titleText, bgColor, flavorText) {
    this._hideExteriorsAndOtherInteriors();

    if (!this.lodgeGroups) this.lodgeGroups = {};
    if (this.lodgeGroups[titleText]) {
      this.lodgeGroups[titleText].setVisible(true);
      return;
    }

    const group = this._buildInteriorLayout({
      titleText,
      flavorText,
      bgColor,
      onExit: () => {
        this.lodgeGroups[titleText].setVisible(false);
        this._showExterior();
      }
    });

    this.lodgeGroups[titleText] = group;
  }


  _enterSeersTent() {
    this._hideExteriorsAndOtherInteriors();

    if (this.seersGroup) {
      this.seersGroup.setVisible(true);
      return;
    }

    this.seersGroup = this._buildInteriorLayout({
      titleText: "Seers’ Tent",
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

    if (this.waystoneGroup) {
      this.waystoneGroup.setVisible(true);
      return;
    }

    const layout = this._buildInteriorLayout({
      titleText: "The Waystone",
      flavorText: "A towering monolith humming with sacred energy.\nGlyphs shift to display hunt progress.",
      bgColor: 0x1a1f26,
      onExit: () => {
        this.waystoneGroup.setVisible(false);
        this._showExterior();
      }
    });

    // Add dynamic hunt info text
    this.waystoneInfo = this.add.text(640, 300,
      "[Hunt progress will appear here]",
      { fontSize: '16px', color: '#ffffff', align: 'center' }
    ).setOrigin(0.5);

    layout.add(this.waystoneInfo);
    layout.setDepth(11);
    this.waystoneGroup = layout;
  }


  // =====================================================
  // 🗼 Elders’ Tower (multi‑floor prototype)
  // =====================================================
  _enterEldersTower(floor = 1) {
    this._hideExteriorsAndOtherInteriors();

    // Build once if needed
    if (!this.eldersTowerGroups) this.eldersTowerGroups = {};

    // Build requested floor if not yet created
    if (!this.eldersTowerGroups[floor]) {
      const colors = { 1: 0x30241c, 2: 0x263028, 3: 0x20202f };
      const titles = { 1: "Elders’ Tower — F1", 2: "Elders’ Tower — F2", 3: "Elders’ Tower — F3 (Restricted)" };
      const descs = {
        1: "A quiet reception with ancient tomes.",
        2: "Large stacks of scrolls and brewing incense.",
        3: "The doorway is barred by heavy iron runes."
      };

      const layout = this._buildInteriorLayout({
        titleText: titles[floor],
        flavorText: descs[floor],
        bgColor: colors[floor] || 0x222222,
        onExit: () => {
          this._hideAllTowerFloors();
          this._showExterior();
        }
      });

      // Floor navigation buttons
      const navButtons = [];
      if (floor > 1) {
        navButtons.push(this._buildSmallButton(450, 520, '⬆ Floor ' + (floor - 1), () => {
          this._enterEldersTower(floor - 1);
        }));
      }
      if (floor < 3) {
        navButtons.push(this._buildSmallButton(830, 520, '⬇ Floor ' + (floor + 1), () => {
          if (floor === 2) {
            // Floor 3 is restricted: simple notice
            this.scene.get('UIScene')?.showDialogue("The elders forbid entry to the top floor.");
          } else {
            this._enterEldersTower(floor + 1);
          }
        }));
      }


      layout.add([...navButtons]);
      navButtons.forEach(btn => btn.setDepth(12));
      const group = layout;

      group.setDepth(11);
      this.eldersTowerGroups[floor] = layout;
    }

    // Hide all floors then show requested one
    this._hideAllTowerFloors();
    this.eldersTowerGroups[floor].setVisible(true);
  }

  _hideAllTowerFloors() {
    if (this.eldersTowerGroups) {
      Object.values(this.eldersTowerGroups).forEach(g => g.setVisible(false));
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
    if (this.leaderGroups[tribe]) {
      this.leaderGroups[tribe].setVisible(true);
      return;
    }

    const colors = {
      Styx: 0x221b24,
      Zafaar: 0x24221b,
      Elseth: 0x1b241c,
      "Le'sse": 0x1c1f24
    };

    const group = this._buildInteriorLayout({
      titleText: `${tribe} Leader Hut`,
      flavorText: `The ${tribe.toLowerCase()} leader studies your approach.`,
      bgColor: colors[tribe] || 0x222222,
      onExit: () => {
        this.leaderGroups[tribe].setVisible(false);
        this._showExterior();
      }
    });

    this.leaderGroups[tribe] = group;
  }


  // =====================================================
  // ⚔️ Combat Pit
  // =====================================================
  _enterCombatPit() {
    const scenarioIds = [
      'training_easy_1',
      'training_easy_2',
      'training_medium_1',
      'training_medium_2',
      'training_hard',
      'training_savage'
    ];

    const menuOptions = scenarioIds.map(id => {
      const scenario = COMBAT_SCENARIOS[id];
      return {
        label: scenario.name,
        description: scenario.description, // short blurb for left column
        longDescription: scenario.longDescription || scenario.description, // detailed text for right panel
        portraitKey: scenario.portraitKey || null, // optional texture for right panel portrait
        onSelect: () => this._startTraining(id)
      };
    });

    // Call UIScene's selection menu with full data
    this.scene.get('UIScene')?.showSelectionMenu("Choose Training Scenario", menuOptions);
  }


  _startTraining(scenarioId) {
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
    this._hideExteriorsAndOtherInteriors();

    this.scene.get('UIScene')?.showConfirmationDialogue(
      "Are you ready to depart for the Sacred Hunt?\n(Feature coming soon)",
      () => {
        console.log("TODO: switch to Exploration / Hunt scene.");
        this._showExterior();
      }
    );
  }
  ////////////Vendors///////////////////////////

  _openTribeVendor(key, displayName) {
    this.vendorTitle.setText(displayName);
    this.vendorBody.setText(`Inventory for ${displayName}\n\n(Tribe inventory placeholder)`);
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
        color: '#cccccc'
      })
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => txt.setColor('#ffffff'))
        .on('pointerout', () => txt.setColor('#cccccc'))
        .on('pointerdown', () => this._openTribeVendor(v.key, v.name));

      layout.add(txt);
    });

    // Inventory Panel + Info (wider + lower)
    this.vendorPanel = this.add.rectangle(800, 375, 510, 440, 0x111111, 0.9)
      .setStrokeStyle(2, 0xffffff);
    this.vendorTitle = this.add.text(800, 165, 'Select a Vendor', {
      fontSize: '22px',
      color: '#ffddaa'
    }).setOrigin(0.5);
    this.vendorBody = this.add.text(610, 210, '', {
      fontSize: '16px',
      color: '#dddddd',
      wordWrap: { width: 470 }
    });

    layout.add([this.vendorPanel, this.vendorTitle, this.vendorBody]);
    layout.setDepth(11);
    this.tribeVendorGroup = layout;
  }


  ////////////////////////////////////////////



}