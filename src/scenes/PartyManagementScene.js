// PartyManagementScene.js — FULL REPLACEMENT

import GameState from '../systems/GameState.js';
import { createPanel } from '../ui/GamePanel.js';

// ===== Central UI frame geometry =====
// Screen is 1280x720; you said side panels are 180px each; top/bottom ≈ 14px.
const LEFT_MARGIN = 180;
const RIGHT_MARGIN = 180;
const TOP_MARGIN = 14;
const BOTTOM_MARGIN = 14;

const CENTER_W = 1280 - LEFT_MARGIN - RIGHT_MARGIN; // 920 (≈922)
const CENTER_H = 720 - TOP_MARGIN - BOTTOM_MARGIN;  // 692


// Top-right info label inside inner UI frame
const INFO_LABEL_X = 870; // you asked for ~870x, 180y
const INFO_LABEL_Y = 180;
// We’ll use the *bottom-right quarter* of this central area.
const QUAD_X = LEFT_MARGIN + Math.floor(CENTER_W / 2);
const QUAD_Y = TOP_MARGIN + Math.floor(CENTER_H / 2);
const QUAD_W = Math.floor(CENTER_W / 2);
const QUAD_H = Math.floor(CENTER_H / 2);

// Slot visuals
const SLOT_SIZE = 64;
const HIT_SIZE = 64;             // visible 64x64
const SLOT_PAD_X = 20;          // inner padding inside the quadrant
const SLOT_PAD_Y = 16;
const DEBUG_UI = false;
// Bench layout constants (same numbers you use elsewhere)
const BENCH_Y_BASE = 395;
const BENCH_STRIDE = 56;

// Return the bench "row" (0,1,2,...) for a given instanceId based on
// the current party order filtered to only unassigned (not in any slot).
function _benchIndexForChar(instanceId, party, slotAssignments) {
  const assigned = new Set(slotAssignments.filter(Boolean));
  const unassigned = party.filter(c => c && !assigned.has(c.instanceId));
  return Math.max(0, unassigned.findIndex(c => c.instanceId === instanceId));
}

// Convert a bench row index to absolute Y
function _benchYForRow(row) {
  return BENCH_Y_BASE + row * BENCH_STRIDE;
}
// Build an 8-slot layout inside the quadrant while keeping your logical order:
// Back row (up-most): 8,7,6    Mid row: 4,5    Front row (lowest): 3,2,1
function getCombatStyleSlotDefs() {
  // Columns (left→right): BACK, MID, FRONT
  const colBack = QUAD_X + SLOT_PAD_X;                                  // left column
  const colFront = QUAD_X + QUAD_W - SLOT_PAD_X - SLOT_SIZE;             // right column
  const colMid = Math.round((colBack + colFront) / 2);                 // middle column

  // Rows (top→bottom): top, mid, bottom
  const rowTop = QUAD_Y + SLOT_PAD_Y;                                  // up-most
  const rowBottom = QUAD_Y + QUAD_H - SLOT_PAD_Y - SLOT_SIZE;             // lowest
  const rowMid = Math.round((rowTop + rowBottom) / 2);                 // middle

  // Use the same "step" as the 8-7-6 back column spacing
  const step = rowMid - rowTop;
  // Pull 4 and 5 INWARD toward each other by half a step
  const rowMidTop = rowTop + Math.round(step / 2);  // between top and middle
  const rowMidBottom = rowBottom - Math.round(step / 2);  // between middle and bottom

  return [
    // BACK (left) — 8,7,6
    { slotId: 8, x: colBack, y: rowTop },
    { slotId: 7, x: colBack, y: rowMid },
    { slotId: 6, x: colBack, y: rowBottom },

    // MID (center) — 4,5 (moved inward)
    { slotId: 4, x: colMid, y: rowMidTop },
    { slotId: 5, x: colMid, y: rowMidBottom },

    // FRONT (right) — 3,2,1
    { slotId: 3, x: colFront, y: rowTop },
    { slotId: 2, x: colFront, y: rowMid },
    { slotId: 1, x: colFront, y: rowBottom },
  ];
}



/* =========================
   2) HELPERS (portrait key + bench X)
   ========================= */

function getPortraitKeyForChar(_scene, char) {
  if (!char) return null;
  if (char.skin) return char.skin; // use the skin directly (e.g., "human_portrait_2")
  const race = (char.race || 'human').toLowerCase();
  return `${race}_portrait_1`;
}


function leftBenchX() {
  return LEFT_MARGIN + 260 + 25; // add +25px to the right
}

/* =========================
   3) SCENE CLASS
   ========================= */
export default class PartyManagementScene extends Phaser.Scene {
  constructor() {
    super({ key: 'PartyManagementScene' });
    this.memberTexts = [];
    this.portraits = [];
    this.slots = [];
    this.slotAssignments = []; // index → instanceId (or null)
  }

  create() {
    const { width, height } = this.scale;

    // Make this modal and block clicks to TownScene
    this.scene.bringToTop();
    this.input.setTopOnly(true);
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = false;

    // Dark, clickable blocker to stop click-through
    this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.75)
      .setDepth(1000);

    // Styled border panel (matches other overlay menus)
    const panelW = 920;
    const panelH = 692;
    const panelX = (width - panelW) / 2;
    const panelY = (height - panelH) / 2;
    if (this.textures.exists('menu_parchment_background')) {
      this.add.image(width / 2, height / 2, 'menu_parchment_background')
        .setDisplaySize(panelW, panelH)
        .setDepth(1001);
    }
    createPanel(this, panelX, panelY, panelW, panelH,
      this.textures.exists('menu_parchment_background')
        ? { fill: 0x000000, fillAlpha: 0, stroke: 0x5a4a3a, strokeWidth: 2, radius: 6, cornerSize: 0 }
        : 'default'
    ).setDepth(1001);

    // Header + Close
    this.add.text(width / 2, 40, 'Party Management', { fontSize: '32px', color: '#fff' })
      .setOrigin(0.5).setDepth(1001);
    this.add.text(width - 40, 40, '[X]', { fontSize: '24px', color: '#ff6666' })
      .setOrigin(0.5).setDepth(1001).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this._closeAndReturn());

    this.infoLabel = this.add.text(INFO_LABEL_X, INFO_LABEL_Y, '—', {
      fontSize: '22px',
      color: '#ffffff'
    }).setDepth(1500).setOrigin(0, 0);
    // Drag quality of life
    this.input.dragDistanceThreshold = 2; // tiny movement starts drag
    this.input.topOnly = true;

    // Build slots (combat-aligned)
    this._buildSlots();

    // Hook drop events (once per scene, not per portrait!)
    this.input.on('drop', (pointer, gameObject, dropZone) => {
      this._onDrop(gameObject, dropZone);
    });

    // Load saved order → assign and snap
    this._loadSavedPartyOrder();
    // Build left lists and portraits
    this.refreshListsAndPortraits();

    this._syncPortraitPositionsToSlots();
  }

  /* ---------- UI Builders ---------- */

  _buildSlots() {
    const SLOT_DEF = getCombatStyleSlotDefs();
    this.slots = [];
    this.slotAssignments = new Array(SLOT_DEF.length).fill(null);

    SLOT_DEF.forEach((def, i) => {
      const { x, y } = def;

      // FRAME: purely visual, centered, below portraits
      let frame;
      if (this.textures.exists('ui_frame')) {
        frame = this.add.image(x, y, 'ui_frame')
          .setOrigin(0.5)
          .setDisplaySize(SLOT_SIZE, SLOT_SIZE)
          .setDepth(1000)
          .setTint(0xffffff);
      } else {
        frame = this.add.rectangle(x, y, SLOT_SIZE, SLOT_SIZE, 0x000000, 0.15)
          .setOrigin(0.5)
          .setStrokeStyle(2, 0xffffff)
          .setDepth(1000);
      }
      // IMPORTANT: do NOT call frame.setInteractive()

      // DROP ZONE: same center & size as frame
      const zone = this.add.zone(x, y, SLOT_SIZE, SLOT_SIZE)
        .setOrigin(0.5)
        .setRectangleDropZone(SLOT_SIZE, SLOT_SIZE)
        .setData('slotIndex', i)
        .setDepth(1000);

      if (DEBUG_UI) {
        const dz = this.add.rectangle(x, y, SLOT_SIZE, SLOT_SIZE, 0x00ff00, 0.1)
          .setOrigin(0.5).setDepth(1001);
        dz.setStrokeStyle(1, 0x00ff00, 1);
      }

      this.slots.push({ frame, zone, def });
    });
  }


  refreshListsAndPortraits() {
    // Clear old texts
    this.memberTexts.forEach(t => t.destroy());
    this.memberTexts = [];

    const characters = GameState.characters || [];
    const party = GameState.party || [];
    const startY = 100;
    const pad = 30;

    // Available Hunters
    this.memberTexts.push(
      this.add.text(LEFT_MARGIN, startY - 40, 'Available Hunters:', { fontSize: '20px', color: '#fff' })
        .setDepth(1001)
    );

    characters.forEach((char, i) => {
      const t = this.add.text(
        LEFT_MARGIN, startY + i * pad,
        `${char.name} (Lv${char.level}) - ${char.race} ${char.baseClass} | HP: ${char.derived?.maxHP ?? char.maxHP ?? '?'} | MP: ${char.derived?.maxMP ?? char.maxMP ?? '?'}`,
        { fontSize: '18px', color: '#fff' }
      )
        .setDepth(1001)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => {
          if (!party.includes(char) && party.length < 6) {
            party.push(char);
            this.refreshListsAndPortraits();
          }
        });
      this.memberTexts.push(t);
    });

    // Current Party header
    const partyY = startY + characters.length * pad + 40;
    this.memberTexts.push(
      this.add.text(LEFT_MARGIN, partyY, 'Current Party (drag portraits into positions):', { fontSize: '20px', color: '#fff' })
        .setDepth(1001)
    );

    // Current party list (click to remove)
    party.forEach((char, i) => {
      const t = this.add.text(
        LEFT_MARGIN, partyY + 30 + i * pad,
        `• ${char.name} (${char.baseClass})`,
        { fontSize: '18px', color: '#64ff64' }
      )
        .setDepth(1001)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => {
          const idx = GameState.party.indexOf(char);
          if (idx >= 0) GameState.party.splice(idx, 1);
          const sidx = this.slotAssignments.findIndex(id => id === char.instanceId);
          if (sidx >= 0) this.slotAssignments[sidx] = null;
          this.refreshListsAndPortraits();
        });
      this.memberTexts.push(t);
    });

    // Save button
    this.memberTexts.push(
      this.add.text(LEFT_MARGIN, this.scale.height - 50, '[ Save Party Order ]', { fontSize: '20px', color: '#88ff88' })
        .setDepth(1001)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._commitPartyOrder())
    );

    // Rebuild portraits each refresh
    this._buildPortraits();
  }

  _buildPortraits() {
    // Clear old
    if (this.portraits) this.portraits.forEach(p => { p.border?.destroy(); p.destroy(); });
    this.portraits = [];

    const party = (GameState.party || []).filter(Boolean);
    const benchX = leftBenchX();
    const benchY = 395;
    const stride = 56;

    // --- TEMP ALIGNMENT KNOB (tweak if the draggable feels offset relative to pointer) ---
    const HITBOX_OX = 0;  // try small positives like 6 if it feels up-left
    const HITBOX_OY = 0;

    const W = 56, H = 56;

    // drag QoL
    this.input.topOnly = true;
    this.input.dragDistanceThreshold = 2;

    party.forEach((char, i) => {
      const key = (char.skin && this.textures.exists(char.skin))
        ? char.skin
        : `${(char.race || 'human').toLowerCase()}_portrait_1`;

      // default spawn on bench
      let x = benchX;
      let y = benchY + i * stride;

      // visible, DRAGGABLE portrait (Image is interactive)
      const img = (key && this.textures.exists(key))
        ? this.add.image(x, y, key).setOrigin(0.5).setDisplaySize(W, H)
        : this.add.circle(x, y, W / 2, 0x303a45, 1);

      img.setDepth(1005);

      // interactive using default geometry (HITBOX_O* compensates during drag)
      if (img.setInteractive) {
        img.setInteractive({ cursor: 'pointer' });
      } else {
        img.setInteractive(new Phaser.Geom.Circle(0, 0, W / 2), Phaser.Geom.Circle.Contains);
      }
      this.input.setDraggable(img);

      // selection outline (white by default)
      const border = this.add.rectangle(x, y, 64, 64, 0x000000, 0)
        .setStrokeStyle(2, 0xffffff)
        .setOrigin(0.5)
        .setDepth(1006);

      // metadata
      img.setData('char', char);
      img.border = border;

      // --- INITIAL SNAP TO CURRENT ASSIGNMENT ---
      // if this char is already in a party slot, start at that slot center
      const assignedIndex = this.slotAssignments
        ? this.slotAssignments.findIndex(id => id === char.instanceId)
        : -1;

      if (assignedIndex >= 0 && this.slots && this.slots[assignedIndex]?.zone) {
        const slot = this.slots[assignedIndex];
        x = Math.round(slot.zone.x);
        y = Math.round(slot.zone.y);
        img.x = x; img.y = y;
        border.x = x; border.y = y;
      } else {
        // otherwise stay on the bench defaults already set
        img.x = x; img.y = y;
        border.x = x; border.y = y;
      }

      // Drag state (ensure we return to where the portrait *actually* started)
      let startX = img.x, startY = img.y;

      img.on('dragstart', () => {
        startX = img.x; startY = img.y;
        img.setDepth(2000); border.setDepth(2001);
        border.setStrokeStyle(2, 0xffff00); // yellow while dragging
      });

      // manual offset to compensate “feel” if you need it
      img.on('drag', (_pointer, dragX, dragY) => {
        const nx = dragX + HITBOX_OX;
        const ny = dragY + HITBOX_OY;
        img.x = nx; img.y = ny;
        border.x = nx; border.y = ny;
      });

      img.on('dragend', (_p, _go, dropped) => {
        border.setStrokeStyle(2, 0xffffff);
        img.setDepth(1005); border.setDepth(1006);

        if (!dropped) {
          // miss → return to where it started (bench or slot)
          img.x = startX; img.y = startY;
          border.x = startX; border.y = startY;
        }
      });

      // select (green)
      img.on('pointerdown', (pointer) => {
        if (pointer.rightButtonDown() || pointer.ctrlKey) return;
        if (this._clearAllPortraitHighlights) this._clearAllPortraitHighlights();
        border.setStrokeStyle(2, 0x00ff00);
        if (this._showCharInfo) this._showCharInfo(char);
      });

      // right/ctrl click → bench
      img.on('pointerup', (pointer) => {
        if (pointer.rightButtonDown() || pointer.ctrlKey) {
          const sidx = this.slotAssignments?.findIndex?.(id => id === char.instanceId);
          if (sidx >= 0) this.slotAssignments[sidx] = null;
          if (this._sendPortraitToBench) this._sendPortraitToBench(img);
          if (this._showCharInfo) this._showCharInfo(char);

          // after sending to bench, keep the border with it
          startX = img.x; startY = img.y; // update return point
          border.x = img.x; border.y = img.y;
        }
      });

      // (Optional) magenta debug for the drag target (set DEBUG_UI=false to hide)
      if (typeof DEBUG_UI !== 'undefined' && DEBUG_UI) {
        const hb = this.add.rectangle(img.x, img.y, W, H, 0xff00ff, 0.12)
          .setStrokeStyle(1, 0xff00ff, 1)
          .setOrigin(0.5)
          .setDepth(1004);
        img.on('drag', (_p, dx, dy) => { hb.x = dx + HITBOX_OX; hb.y = dy + HITBOX_OY; });
        img.once('destroy', () => hb.destroy());
      }

      this.portraits.push(img);
    });
  }




  // helper to clear selection borders
  _clearAllPortraitHighlights() {
    (this.portraits || []).forEach(p => p.border?.setStrokeStyle(2, 0xffffff));
  }

  /* ---------- DnD + Persistence ---------- */

  _onDrop(gameObject, dropZone) {
    if (!gameObject || !dropZone) return;

    // Accept either a Zone handle or the Image directly
    const img = (gameObject.getData && gameObject.getData('img'))
      ? gameObject.getData('img')
      : gameObject;

    const char = img.getData('char');
    if (!char) return;

    const slotIndex = dropZone.getData('slotIndex');
    if (slotIndex == null) return;

    // clear previous assignment for this char
    const prev = this.slotAssignments.findIndex(id => id === char.instanceId);
    if (prev >= 0) this.slotAssignments[prev] = null;

    // evict occupant if any
    const occupyingId = this.slotAssignments[slotIndex];
    if (occupyingId) {
      const other = (this.portraits || []).find(p => p.getData('char')?.instanceId === occupyingId);
      if (other) this._sendPortraitToBench(other);
    }

    // assign + snap to slot center
    this.slotAssignments[slotIndex] = char.instanceId;
    const slot = this.slots[slotIndex];
    if (slot) {
      img.x = Math.round(slot.zone.x);
      img.y = Math.round(slot.zone.y);
      if (img.border) { img.border.x = img.x; img.border.y = img.y; }
      const handle = img.getData('handle');
      if (handle) handle.setPosition(img.x, img.y);
    }

    // keep correct draw order
    img.setDepth(1005);
    if (img.border) img.border.setDepth(1006);
  }


  _sendPortraitToBench(img) {
    const x = leftBenchX();
    const baseY = 395;
    const stride = 56;

    // compact bench based on current order of unassigned portraits
    const assigned = new Set(this.slotAssignments.filter(Boolean));
    const unassigned = (this.portraits || []).filter(p => {
      const id = p.getData('char')?.instanceId;
      return id && !assigned.has(id);
    });

    const idx = unassigned.indexOf(img);
    const row = (idx >= 0 ? idx : unassigned.length);

    img.x = x; img.y = baseY + row * stride;
    img.setDepth(1005);

    if (img.border) {
      img.border.x = img.x;
      img.border.y = img.y;
      img.border.setDepth(1006);
    }
    const handle = img.getData && img.getData('handle');
    if (handle) handle.setPosition(img.x, img.y);
  }


  _syncPortraitPositionsToSlots() {
    for (let i = 0; i < this.slotAssignments.length; i++) {
      const id = this.slotAssignments[i];
      if (!id) continue;
      const slot = this.slots[i];
      const portrait = this.portraits.find(p => p.getData('char')?.instanceId === id);
      if (portrait && slot) {
        portrait.x = slot.zone.x;
        portrait.y = slot.zone.y;
      }
    }
  }

  _loadSavedPartyOrder() {
    const defs = getCombatStyleSlotDefs();
    this.slotAssignments = new Array(defs.length).fill(null);

    const partyIds = new Set((GameState.party || []).map(c => c.instanceId));

    // Prefer explicit slot map
    if (GameState.partySlots && typeof GameState.partySlots === 'object') {
      defs.forEach((def, i) => {
        const id = GameState.partySlots[def.slotId];
        this.slotAssignments[i] = partyIds.has(id) ? id : null;
      });
      return;
    }

    // Fallback to legacy visual order
    const saved = GameState.partyOrder;
    if (Array.isArray(saved) && saved.length) {
      for (let i = 0; i < defs.length && i < saved.length; i++) {
        const id = saved[i];
        this.slotAssignments[i] = partyIds.has(id) ? id : null;
      }
    }
  }

  _commitPartyOrder() {
    const defs = getCombatStyleSlotDefs();
    const party = GameState.party || [];
    const idToChar = new Map(party.map(c => [c.instanceId, c]));

    // Snapshot before applying so we can detect a real change.
    const prevSlots = JSON.stringify(GameState.partySlots || {});
    const prevOrder = JSON.stringify((GameState.party || []).map(c => c.instanceId));

    // 1) ordered list (visual left→right)
    const ordered = this.slotAssignments
      .map(id => (id ? idToChar.get(id) : null))
      .filter(Boolean);

    // 2) append unplaced members, preserve their prior order
    const remaining = party.filter(c => !this.slotAssignments.includes(c.instanceId));
    const finalOrder = [...ordered, ...remaining].slice(0, 8);

    // Persist both
    GameState.party = finalOrder;
    GameState.partyOrder = this.slotAssignments.slice();

    // slotId → instanceId map
    const slotMap = {};
    defs.forEach((def, i) => {
      const id = this.slotAssignments[i];
      if (id) slotMap[def.slotId] = id;
    });
    GameState.partySlots = slotMap;

    this.sound?.play?.('ui_confirm');
    this._syncPortraitPositionsToSlots();

    // Only show feedback if something actually changed.
    const newSlots = JSON.stringify(GameState.partySlots);
    const newOrder = JSON.stringify(finalOrder.map(c => c.instanceId));
    if (prevSlots !== newSlots || prevOrder !== newOrder) {
      this._showSaveFeedback();
    }
  }

  _showSaveFeedback() {
    // Kill any in-progress feedback tween so it can't stack.
    if (this._saveFeedbackText) {
      this.tweens.killTweensOf(this._saveFeedbackText);
      this._saveFeedbackText.destroy();
      this._saveFeedbackText = null;
    }

    const x = LEFT_MARGIN;
    const y = this.scale.height - 78; // just above the save button at height-50

    this._saveFeedbackText = this.add.text(x, y, 'Party saved!', {
      fontSize: '16px',
      color: '#88ff88',
    }).setDepth(1100).setAlpha(1);

    this.tweens.add({
      targets: this._saveFeedbackText,
      alpha: 0,
      delay: 1200,
      duration: 600,
      onComplete: () => {
        this._saveFeedbackText?.destroy();
        this._saveFeedbackText = null;
      }
    });
  }

  _showCharInfo(char) {
    if (!char) {
      this.infoLabel?.setText('—');
      return;
    }
    const name = char.name || 'Unknown';
    const base = char.baseClass || char.class || '—';
    this.infoLabel?.setText(`${name} — ${base}`);
  }

  /* ---------- Scene lifecycle ---------- */

  _closeAndReturn() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    // Refresh quest flags — TownScene stays running throughout (never sleeps),
    // so its 'wake' event never fires. We must call it explicitly here.
    town?._refreshQuestFlags?.();
    const ui = this.scene.get('UIScene');
    ui?.refreshUI?.();
    this.scene.stop('PartyManagementScene');
  }

  shutdown() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
  }
}
