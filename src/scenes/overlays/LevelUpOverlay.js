/**
 * LevelUpOverlay — Stat point allocation and talent tree placeholder.
 *
 * Launched with:  scene.launch('LevelUpOverlay', { characterId: char.instanceId })
 *
 * Two tabs:
 *   Stat Points — 6 stat cards in a 3×2 grid with +/− buttons, live derived preview,
 *                 and an Apply button that calls rebuildCharacterStats + full restore.
 *   Talents     — Decorative locked talent tree, awaiting the Awakening system.
 */

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import GameState from '../../systems/GameState.js';
import { rebuildCharacterStats, calculateDerivedStats } from '../../systems/CharacterBuilder.js';
import { SoundManager } from '../../systems/SoundManager.js';

// ── Static config ─────────────────────────────────────────────────────────────

const STAT_ORDER = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

const STAT_COLORS = {
  STR: 0xff7755,  STR_HEX: '#ff7755',
  DEX: 0x88dd88,  DEX_HEX: '#88dd88',
  CON: 0xcc9955,  CON_HEX: '#cc9955',
  INT: 0x5599ff,  INT_HEX: '#5599ff',
  WIS: 0xbb88ff,  WIS_HEX: '#bb88ff',
  CHA: 0xffcc44,  CHA_HEX: '#ffcc44',
};

const STAT_HEX = {
  STR: '#ff7755', DEX: '#88dd88', CON: '#cc9955',
  INT: '#5599ff', WIS: '#bb88ff', CHA: '#ffcc44',
};

const STAT_LABELS = {
  STR: 'Strength',     DEX: 'Dexterity',    CON: 'Constitution',
  INT: 'Intelligence', WIS: 'Wisdom',        CHA: 'Charisma',
};

const STAT_EFFECTS = {
  STR: 'Melee damage  ·  Crit chance',
  DEX: 'Accuracy +2/pt  ·  Crit chance',
  CON: 'Max HP +5/pt  ·  Physical Resist',
  INT: 'Max MP +2/pt  ·  Crit chance',
  WIS: 'Max MP +1/pt  ·  Elemental Resist  ·  Crit Avoid',
  CHA: 'Max MP +1/pt  ·  Initiative  ·  Elemental Resist',
};

// Which derived fields to show in the preview strip
const PREVIEW_DEFS = [
  { key: 'maxHP',           label: 'Max HP'      },
  { key: 'maxMP',           label: 'Max MP'      },
  { key: 'Accuracy',        label: 'Accuracy'    },
  { key: 'CritChance',      label: 'Crit %'      },
  { key: 'PhysicalResist',  label: 'Phys Res'    },
  { key: 'ElementalResist', label: 'Elem Res'    },
];

// Card dimensions
const CARD_W   = 268;
const CARD_H   = 128;
const CARD_GAP = 10;
const COLS     = 3;

// ── Scene ─────────────────────────────────────────────────────────────────────

export default class LevelUpOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'LevelUpOverlay' });
  }

  init(data) {
    this._characterId = data?.characterId ?? null;
    this._initialTab  = data?.initialTab ?? 'Stat Points';
  }

  create() {
    this._char = GameState.party.find(c => c.instanceId === this._characterId);
    if (!this._char) {
      console.warn('LevelUpOverlay: character not found:', this._characterId);
      this.scene.stop();
      return;
    }

    SoundManager.init(this);

    const frame = createOverlayFrame(this, { title: 'Level Up', onClose: () => this._close() });
    this._depth  = frame.depth;
    this._bounds = frame.bounds;

    // Allocation state — tracks points assigned this session (not yet committed)
    this._pending    = { STR: 0, DEX: 0, CON: 0, INT: 0, WIS: 0, CHA: 0 };
    this._pointsLeft = this._char.unspentStatPoints || 0;

    // Text refs updated on every adjustment (no full rebuild needed)
    this._statCards   = {};
    this._previewTxts = {};

    // Must null these each create() — they're instance props that survive stop/launch,
    // so without this _showTab() would skip rebuilding against destroyed game objects.
    this._statItems   = null;
    this._talentItems = null;

    this._buildCharStrip();
    this._buildTabRow();
    this._showTab(this._initialTab || 'Stat Points');
  }

  // ── Character identity strip ──────────────────────────────────────────────────

  _buildCharStrip() {
    const b = this._bounds;
    const d = this._depth;
    const c = this._char;

    const y = b.y + 53;

    this.add.text(b.x + 24, y,
      c.name,
      { fontSize: '20px', color: '#ffddaa', fontStyle: 'bold', fontFamily: 'Georgia' }
    ).setDepth(d);

    this.add.text(b.x + 24, y + 22,
      `${c.race}  ·  ${c.baseClass}  ·  Level ${c.level}`,
      { fontSize: '13px', color: '#888888' }
    ).setDepth(d);

    // Points-remaining badge (top-right of strip), updated as points are spent
    this._stripBadge = this.add.text(b.right - 24, y + 10,
      this._badgeLabel(),
      { fontSize: '15px', color: '#ffdd44', fontStyle: 'bold' }
    ).setOrigin(1, 0.5).setDepth(d);

    // Thin divider under strip
    const divGfx = this.add.graphics().setDepth(d);
    divGfx.lineStyle(1, 0x5a4a3a, 0.5);
    divGfx.beginPath();
    divGfx.moveTo(b.x + 16, y + 38);
    divGfx.lineTo(b.right - 16, y + 38);
    divGfx.strokePath();
  }

  _badgeLabel() {
    if (this._pointsLeft === 0) return '✓  All points allocated';
    return `★  ${this._pointsLeft} point${this._pointsLeft !== 1 ? 's' : ''} to allocate`;
  }

  // ── Tab row ───────────────────────────────────────────────────────────────────

  _buildTabRow() {
    const b = this._bounds;
    const d = this._depth;
    const tabY  = b.y + 78;
    const tabW  = 138;
    const tabH  = 24;
    const startX = b.x + 24;

    this._tabBtns = {};

    ['Stat Points', 'Talents'].forEach((name, i) => {
      const cx = startX + i * (tabW + 8) + tabW / 2;

      const bg = this.add.rectangle(cx, tabY, tabW - 2, tabH, 0x1a1a1a)
        .setOrigin(0.5).setDepth(d)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._showTab(name));

      const lbl = this.add.text(cx, tabY, name, { fontSize: '13px', color: '#777777' })
        .setOrigin(0.5).setDepth(d + 1)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._showTab(name));

      const ul = this.add.rectangle(cx, tabY + tabH / 2 + 1, tabW - 2, 2, 0xffdd88)
        .setOrigin(0.5, 0).setDepth(d + 1).setVisible(false);

      this._tabBtns[name] = { bg, lbl, ul };
    });

    // Divider
    const divY = tabY + tabH / 2 + 5;
    const gfx  = this.add.graphics().setDepth(d);
    gfx.lineStyle(1, 0x5a4a3a, 0.6);
    gfx.beginPath();
    gfx.moveTo(b.x + 16, divY);
    gfx.lineTo(b.right - 16, divY);
    gfx.strokePath();
  }

  _showTab(name) {
    // Tab button visuals
    for (const [key, btn] of Object.entries(this._tabBtns)) {
      const active = key === name;
      btn.bg.setFillStyle(active ? 0x2d2217 : 0x1a1a1a);
      btn.lbl.setStyle({ color: active ? '#ffdd88' : '#777777' });
      btn.ul.setVisible(active);
    }

    this._activeTab = name;

    // Build tab content once, then show/hide
    if (name === 'Stat Points' && !this._statItems)   this._buildStatTab();
    if (name === 'Talents'     && !this._talentItems)  this._buildTalentsTab();

    const showStat   = name === 'Stat Points';
    const showTalent = name === 'Talents';
    this._statItems?.forEach(c => c.setVisible(showStat));
    this._talentItems?.forEach(c => c.setVisible(showTalent));
  }

  // ── Stat Points Tab ───────────────────────────────────────────────────────────

  _buildStatTab() {
    const b = this._bounds;
    const d = this._depth;
    this._statItems = [];
    const group = { add: (item) => this._statItems.push(item) };

    const contentTop = b.y + 108;

    // ── Points counter ──────────────────────────────────────────────────────────
    this._pointsCounterTxt = this.add.text(b.centerX, contentTop + 6,
      this._counterLabel(),
      { fontSize: '17px', color: '#ffdd44', fontStyle: 'bold' }
    ).setOrigin(0.5, 0).setDepth(d);
    group.add(this._pointsCounterTxt);

    // ── Stat card grid ──────────────────────────────────────────────────────────
    const GRID_W    = COLS * CARD_W + (COLS - 1) * CARD_GAP;
    const gridLeft  = b.x + (b.width - GRID_W) / 2;
    const gridTop   = contentTop + 40;

    STAT_ORDER.forEach((stat, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cx  = gridLeft + col * (CARD_W + CARD_GAP) + CARD_W / 2;
      const cy  = gridTop  + row * (CARD_H + CARD_GAP) + CARD_H / 2;
      this._buildStatCard(group, stat, cx, cy, d);
    });

    // ── Derived preview strip ───────────────────────────────────────────────────
    const previewTop = gridTop + 2 * (CARD_H + CARD_GAP) + 16;
    this._buildPreview(group, b.x + 24, previewTop, b.width - 48, d);

    // ── Action buttons ──────────────────────────────────────────────────────────
    this._buildActionBtns(group, b, b.bottom - 48, d);
  }

  _buildStatCard(group, stat, cx, cy, d) {
    const char     = this._char;
    const totalVal = char.totalStats[stat] || 0;
    const pending  = this._pending[stat];
    const hexColor = STAT_HEX[stat];
    const intColor = STAT_COLORS[stat];

    // Card background
    const bg = this.add.rectangle(cx, cy, CARD_W, CARD_H, 0x0d0d0d, 0.93).setDepth(d);
    group.add(bg);

    // Colored left accent bar
    const accent = this.add.rectangle(cx - CARD_W / 2 + 3, cy, 4, CARD_H - 4, intColor, 0.7).setDepth(d);
    group.add(accent);

    // Thin border (drawn via graphics for alpha control)
    const border = this.add.graphics().setDepth(d);
    border.lineStyle(1, intColor, 0.3);
    border.strokeRect(cx - CARD_W / 2, cy - CARD_H / 2, CARD_W, CARD_H);
    group.add(border);

    // Stat abbreviation (top-left)
    const abbrevTxt = this.add.text(cx - CARD_W / 2 + 14, cy - CARD_H / 2 + 8,
      stat, { fontSize: '12px', color: hexColor, fontStyle: 'bold' }
    ).setDepth(d);
    group.add(abbrevTxt);

    // Stat full name (top-left, smaller)
    const labelTxt = this.add.text(cx - CARD_W / 2 + 40, cy - CARD_H / 2 + 10,
      STAT_LABELS[stat], { fontSize: '11px', color: '#666666' }
    ).setDepth(d);
    group.add(labelTxt);

    // Current value (large)
    const valTxt = this.add.text(cx - CARD_W / 2 + 14, cy - CARD_H / 2 + 26,
      `${totalVal}`, { fontSize: '32px', color: '#ffffff', fontStyle: 'bold' }
    ).setDepth(d);
    group.add(valTxt);

    // Pending delta (next to value, green)
    const pendTxt = this.add.text(cx - CARD_W / 2 + 60, cy - CARD_H / 2 + 38,
      pending > 0 ? `+${pending}` : '',
      { fontSize: '16px', color: '#88ff88', fontStyle: 'bold' }
    ).setDepth(d);
    group.add(pendTxt);

    // New total preview (top-right corner)
    const previewTxt = this.add.text(cx + CARD_W / 2 - 10, cy - CARD_H / 2 + 34,
      pending > 0 ? `→ ${totalVal + pending}` : '',
      { fontSize: '15px', color: '#88ff88' }
    ).setOrigin(1, 0.5).setDepth(d);
    group.add(previewTxt);

    // Effects label (bottom)
    const effectTxt = this.add.text(cx - CARD_W / 2 + 14, cy + CARD_H / 2 - 32,
      STAT_EFFECTS[stat], { fontSize: '11px', color: '#555566' }
    ).setDepth(d);
    group.add(effectTxt);

    // [ − ] button
    const minusColor = () => pending > 0 ? '#ff8888' : '#333333';
    const minusBtn = this.add.text(cx - CARD_W / 2 + 14, cy + 12,
      '[ − ]', { fontSize: '15px', color: minusColor() }
    ).setDepth(d)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this._adjust(stat, -1))
      .on('pointerover', () => { if (this._pending[stat] > 0) minusBtn.setStyle({ color: '#ffaaaa' }); })
      .on('pointerout',  () => minusBtn.setStyle({ color: minusColor() }));
    group.add(minusBtn);

    // [ + ] button
    const plusColor = () => this._pointsLeft > 0 ? '#88ff88' : '#333333';
    const plusBtn = this.add.text(cx + CARD_W / 2 - 14, cy + 12,
      '[ + ]', { fontSize: '15px', color: plusColor() }
    ).setOrigin(1, 0).setDepth(d)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this._adjust(stat, +1))
      .on('pointerover', () => { if (this._pointsLeft > 0) plusBtn.setStyle({ color: '#aaffaa' }); })
      .on('pointerout',  () => plusBtn.setStyle({ color: plusColor() }));
    group.add(plusBtn);

    // Store refs for live updates
    this._statCards[stat] = {
      valTxt, pendTxt, previewTxt,
      minusBtn, plusBtn,
      minusColor, plusColor,
    };
  }

  _buildPreview(group, left, top, width, d) {
    const headerTxt = this.add.text(left, top,
      'Derived preview:',
      { fontSize: '13px', color: '#c8a060', fontStyle: 'bold' }
    ).setDepth(d);
    group.add(headerTxt);

    const colW = Math.floor(width / 3);
    PREVIEW_DEFS.forEach(({ key, label }, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x   = left + col * colW;
      const y   = top + 20 + row * 22;

      const curVal = this._getDerived(key);
      const txt = this.add.text(x, y,
        `${label}: ${curVal}`,
        { fontSize: '13px', color: '#666666' }
      ).setDepth(d);
      group.add(txt);

      this._previewTxts[key] = { txt, label, curVal };
    });
  }

  _buildActionBtns(group, b, y, d) {
    // Cancel
    const cancelBtn = this.add.text(b.x + 40, y, '[ Cancel ]', {
      fontSize: '18px', color: '#ff8888'
    }).setDepth(d)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => { SoundManager.play('handsClick'); this._close(); })
      .on('pointerover', () => cancelBtn.setStyle({ color: '#ffaaaa' }))
      .on('pointerout',  () => cancelBtn.setStyle({ color: '#ff8888' }));
    group.add(cancelBtn);

    // Confirm
    this._confirmBtn = this.add.text(b.right - 40, y,
      this._confirmLabel(),
      { fontSize: '18px', color: '#88ff88' }
    ).setOrigin(1, 0).setDepth(d)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this._applyAllocation())
      .on('pointerover', () => this._confirmBtn?.setStyle({ color: '#aaffaa' }))
      .on('pointerout',  () => this._confirmBtn?.setStyle({ color: '#88ff88' }));
    group.add(this._confirmBtn);
  }

  // ── Stat adjustment ───────────────────────────────────────────────────────────

  _adjust(stat, delta) {
    if (delta > 0 && this._pointsLeft <= 0)       return;
    if (delta < 0 && this._pending[stat] <= 0)    return;

    SoundManager.play('select');

    this._pending[stat] += delta;
    this._pointsLeft    -= delta;

    // ── Update this stat's card ─────────────────────────────────────────────────
    const card     = this._statCards[stat];
    const totalVal = this._char.totalStats[stat] || 0;
    const pend     = this._pending[stat];

    card.pendTxt.setText(pend > 0 ? `+${pend}` : '');
    card.previewTxt.setText(pend > 0 ? `→ ${totalVal + pend}` : '');
    card.minusBtn.setStyle({ color: card.minusColor() });
    card.minusBtn.input.enabled = pend > 0;

    // Update ALL plus buttons (points remaining changed)
    for (const c of Object.values(this._statCards)) {
      c.plusBtn.setStyle({ color: c.plusColor() });
      c.plusBtn.input.enabled = this._pointsLeft > 0;
    }

    // ── Update counters and preview ─────────────────────────────────────────────
    this._pointsCounterTxt?.setText(this._counterLabel());
    this._stripBadge?.setText(this._badgeLabel());
    this._refreshPreview();
    this._confirmBtn?.setText(this._confirmLabel());
  }

  _refreshPreview() {
    // Hypothetical totalStats with pending applied
    const hypo = { ...this._char.totalStats };
    for (const [s, pts] of Object.entries(this._pending)) {
      hypo[s] = (hypo[s] || 0) + pts;
    }
    const newDerived = calculateDerivedStats(hypo);

    for (const [key, ref] of Object.entries(this._previewTxts)) {
      const curVal = ref.curVal;
      const newVal = newDerived[key] ?? curVal;
      const changed = newVal !== curVal;
      ref.txt.setText(changed ? `${ref.label}: ${curVal} → ${newVal}` : `${ref.label}: ${curVal}`);
      ref.txt.setStyle({ color: changed ? '#88ff88' : '#666666' });
    }
  }

  // ── Apply allocation ──────────────────────────────────────────────────────────

  _applyAllocation() {
    const char = this._char;
    const spent = Object.values(this._pending).reduce((a, b) => a + b, 0);

    // Write allocated points into baseStats
    for (const [stat, pts] of Object.entries(this._pending)) {
      if (pts > 0) char.baseStats[stat] = (char.baseStats[stat] || 0) + pts;
    }

    // Deduct spent points (unspent remainder carries forward)
    char.unspentStatPoints = Math.max(0, (char.unspentStatPoints || 0) - spent);

    // Recalculate all derived stats from updated baseStats
    rebuildCharacterStats(char);

    // Level-up restore: full HP and MP after confirming allocation
    char.currentHP = char.maxHP;
    char.currentMP = char.maxMP;

    GameState.save('autosave');
    SoundManager.play('select');
    this._close();
  }

  // ── Talents Tab (placeholder) ─────────────────────────────────────────────────

  _buildTalentsTab() {
    const b = this._bounds;
    const d = this._depth;
    this._talentItems = [];
    const group = { add: (item) => this._talentItems.push(item) };

    const contentTop = b.y + 108;
    const char = this._char;

    // ── Ghost node tree ─────────────────────────────────────────────────────────
    const treeCX = b.centerX;
    const treeTop = contentTop + 20;

    const nodes = [
      { x: treeCX,       y: treeTop        },
      { x: treeCX - 130, y: treeTop + 80   },
      { x: treeCX + 130, y: treeTop + 80   },
      { x: treeCX - 210, y: treeTop + 170  },
      { x: treeCX - 60,  y: treeTop + 170  },
      { x: treeCX + 60,  y: treeTop + 170  },
      { x: treeCX + 210, y: treeTop + 170  },
      { x: treeCX - 180, y: treeTop + 255  },
      { x: treeCX,       y: treeTop + 255  },
      { x: treeCX + 180, y: treeTop + 255  },
    ];

    const edges = [[0,1],[0,2],[1,3],[1,4],[2,5],[2,6],[3,7],[4,8],[6,9]];

    const treeGfx = this.add.graphics().setDepth(d);
    group.add(treeGfx);

    // Edges
    treeGfx.lineStyle(1, 0x334455, 0.45);
    edges.forEach(([a, b_]) => {
      treeGfx.beginPath();
      treeGfx.moveTo(nodes[a].x, nodes[a].y);
      treeGfx.lineTo(nodes[b_].x, nodes[b_].y);
      treeGfx.strokePath();
    });

    // Node circles
    nodes.forEach(n => {
      treeGfx.fillStyle(0x1a2233, 0.9);
      treeGfx.fillCircle(n.x, n.y, 20);
      treeGfx.lineStyle(1, 0x334466, 0.55);
      treeGfx.strokeCircle(n.x, n.y, 20);
    });

    // ── Lock overlay ────────────────────────────────────────────────────────────
    const overlayH = 310;
    const overlayRect = this.add.rectangle(
      b.centerX, contentTop + 165, b.width - 48, overlayH, 0x000000, 0.62
    ).setDepth(d + 1);
    group.add(overlayRect);

    // Lock icon
    const lockTxt = this.add.text(b.centerX, contentTop + 108,
      '🔒', { fontSize: '52px' }
    ).setOrigin(0.5).setDepth(d + 2);
    group.add(lockTxt);

    // Heading
    const heading = this.add.text(b.centerX, contentTop + 174,
      'Awaiting Awakening',
      { fontSize: '26px', color: '#9999bb', fontStyle: 'bold', fontFamily: 'Georgia' }
    ).setOrigin(0.5).setDepth(d + 2);
    group.add(heading);

    // Divider line
    const lineGfx = this.add.graphics().setDepth(d + 2);
    lineGfx.lineStyle(1, 0x445566, 0.5);
    lineGfx.beginPath();
    lineGfx.moveTo(b.centerX - 140, contentTop + 205);
    lineGfx.lineTo(b.centerX + 140, contentTop + 205);
    lineGfx.strokePath();
    group.add(lineGfx);

    // Flavor text
    const flavor = this.add.text(b.centerX, contentTop + 215,
      `${char.name}'s talent tree will unlock when they undergo the Awakening ritual.\n\n` +
      `Through the Awakening, a fighter transcends their base class — gaining access to\n` +
      `specialized paths, passive abilities, and signature techniques unique to their journey.`,
      {
        fontSize: '14px', color: '#667788', align: 'center',
        wordWrap: { width: 560 }, lineSpacing: 4
      }
    ).setOrigin(0.5, 0).setDepth(d + 2);
    group.add(flavor);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  _counterLabel() {
    if (this._pointsLeft === 0) return '✓  All points allocated';
    return `Points Remaining: ${this._pointsLeft}`;
  }

  _confirmLabel() {
    const spent = Object.values(this._pending).reduce((a, b) => a + b, 0);
    const leftover = (this._char.unspentStatPoints || 0) - spent;
    if (spent === 0) return '[ Apply (no changes) ]';
    if (leftover > 0) return `[ Apply  (${leftover} pts unspent) ]`;
    return '[ Apply & Restore ]';
  }

  _getDerived(key) {
    return this._char.derived?.[key] ?? this._char[key] ?? 0;
  }

  // ── Close ─────────────────────────────────────────────────────────────────────

  _close() {
    // Refresh CharacterListOverlay if it's still open
    if (this.scene.isActive('CharacterListOverlay')) {
      const charList = this.scene.get('CharacterListOverlay');
      const char = GameState.party.find(c => c.instanceId === this._characterId);
      charList?.refreshCharacterList?.();
      if (char) charList?.inspectCharacter?.(char);
    }
    this.scene.stop();
  }
}
