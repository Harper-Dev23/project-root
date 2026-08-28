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
import { setupSceneCursor } from '../../ui/cursor.js';
import { getAwakeningsFor, TIER_STYLE } from '../../../data/awakenings.js';

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
  CON: 'Max HP +2/pt  ·  Physical Resist',
  INT: 'Max MP +2/pt  ·  Crit chance',
  WIS: 'Max MP +1/pt  ·  Elemental Resist  ·  Necrotic Resist  ·  Crit Avoid  ·  Healing',
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
  { key: 'NecroticResist',  label: 'Necro Res'   },
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
    setupSceneCursor(this);
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
    this._awakeningNodeLabels = null;

    this._buildCharStrip();
    this._buildTabRow();
    this._showTab(this._initialTab || 'Stat Points');
  }

  // ── Character identity strip ──────────────────────────────────────────────────

  _buildCharStrip() {
    const b = this._bounds;
    const d = this._depth;
    const c = this._char;

    // Sits on the frame's own title row (left of the centered "Level Up"),
    // NOT below it. The strip used to start at b.y+53 — but _buildTabRow
    // draws opaque tab backgrounds at the same x (b.x+24) spanning
    // b.y+66..b.y+90, painted after the strip at the same depth, so they
    // covered the bottom half of the name and the whole race/class line.
    // Moving the strip up into the empty left half of the title row clears
    // the tabs entirely without shifting any tab/content geometry below.
    const y = b.y + 20;

    this.add.text(b.x + 24, y,
      c.name,
      { fontSize: '20px', color: '#ffddaa', fontStyle: 'bold', fontFamily: 'Georgia, Gelasio, serif' }
    ).setDepth(d);

    this.add.text(b.x + 24, y + 25,
      `${c.race}  ·  ${c.baseClass}  ·  Level ${c.level}`,
      { fontSize: '13px', color: '#888888' }
    ).setDepth(d);

    // Points-remaining badge — right-aligned, level with the tab row so it
    // reads as part of the same band (clear of the frame's close button,
    // which occupies the top-right corner at b.y+18).
    this._stripBadge = this.add.text(b.right - 24, b.y + 78,
      this._badgeLabel(),
      { fontSize: '15px', color: '#ffdd44', fontStyle: 'bold' }
    ).setOrigin(1, 0.5).setDepth(d);
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
    // Constellation node labels are rebuilt per selected awakening, so they
    // live outside _talentItems and need toggling explicitly.
    this._awakeningNodeLabels?.forEach(c => c.setVisible(showTalent));
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
    const newDerived = calculateDerivedStats(hypo, { basePlayerHP: 16 });

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

  // ── Talents Tab (Awakening teaser) ────────────────────────────────────────────
  // Still fully locked — nothing here is spendable or persisted. It previews
  // the three Awakening paths available to this character's base class, each
  // with its real 12-node constellation shape (3 entry / 4 adept / 4 master /
  // 1 capstone) so the eventual system reads as a real branching choice
  // rather than a generic "coming soon" panel.

  _buildTalentsTab() {
    const b = this._bounds;
    const d = this._depth;
    this._talentItems = [];
    const group = { add: (item) => this._talentItems.push(item) };

    const contentTop = b.y + 108;
    const char = this._char;
    const paths = getAwakeningsFor(char.baseClass);

    // No data for this base class — fall back to the old plain locked notice
    // rather than rendering an empty frame.
    if (!paths.length) {
      const lock = this.add.text(b.centerX, contentTop + 120, '🔒', { fontSize: '52px' })
        .setOrigin(0.5).setDepth(d + 2);
      const head = this.add.text(b.centerX, contentTop + 180, 'Awaiting Awakening',
        { fontSize: '26px', color: '#9999bb', fontStyle: 'bold', fontFamily: 'Georgia, Gelasio, serif' }
      ).setOrigin(0.5).setDepth(d + 2);
      group.add(lock); group.add(head);
      return;
    }

    this._awakeningPaths = paths;
    this._awakeningIndex = 0;

    // ── Header ────────────────────────────────────────────────────────────────
    const head = this.add.text(b.centerX, contentTop - 2,
      `🔒  Awaiting Awakening`,
      { fontSize: '20px', color: '#9999bb', fontStyle: 'bold', fontFamily: 'Georgia, Gelasio, serif' }
    ).setOrigin(0.5, 0).setDepth(d + 2);
    group.add(head);

    const sub = this.add.text(b.centerX, contentTop + 26,
      `When ${char.name} undergoes the Awakening ritual, they will choose ONE of these three paths.`,
      { fontSize: '12px', color: '#667788', align: 'center', wordWrap: { width: 660 } }
    ).setOrigin(0.5, 0).setDepth(d + 2);
    group.add(sub);

    // ── Path selector tabs (the three awakenings for this class) ──────────────
    const selY = contentTop + 52;
    const selW = 168;
    const selGap = 10;
    const totalW = paths.length * selW + (paths.length - 1) * selGap;
    let selX = b.centerX - totalW / 2;

    this._awakeningTabs = [];
    paths.forEach((path, i) => {
      const cx = selX + i * (selW + selGap) + selW / 2;

      const bg = this.add.rectangle(cx, selY + 15, selW, 30, 0x1a1a22)
        .setOrigin(0.5).setDepth(d + 2)
        .setStrokeStyle(1, 0x3a3a4a)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._showAwakening(i));

      const lbl = this.add.text(cx, selY + 15, path.name,
        { fontSize: '14px', color: '#777788', fontFamily: 'Georgia, Gelasio, serif' }
      ).setOrigin(0.5).setDepth(d + 3)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._showAwakening(i));

      group.add(bg); group.add(lbl);
      this._awakeningTabs.push({ bg, lbl });
    });

    // ── Tree canvas + per-path text, redrawn by _showAwakening ────────────────
    this._awakeningTreeGfx = this.add.graphics().setDepth(d + 2);
    group.add(this._awakeningTreeGfx);

    // Faint framed "window" the constellation sits behind, so it reads as a
    // sealed preview rather than an active panel.
    const paneX = b.x + 24;
    const paneY = selY + 40;
    const paneW = b.width - 48;
    // Fill the remaining frame height (leaving room for the motif caption
    // below) rather than a fixed short box — the 12 nodes need the vertical
    // spread or their labels collide with the row beneath them.
    const paneH = Math.max(268, (b.y + b.height) - paneY - 52);
    this._awakeningPane = { x: paneX, y: paneY, w: paneW, h: paneH };

    const paneBg = this.add.rectangle(paneX + paneW / 2, paneY + paneH / 2, paneW, paneH, 0x090c14, 0.75)
      .setDepth(d + 1).setStrokeStyle(1, 0x2a3346);
    group.add(paneBg);

    this._awakeningMotifTxt = this.add.text(b.centerX, paneY + paneH + 8, '',
      { fontSize: '12px', color: '#6a7a8a', align: 'center', wordWrap: { width: 660 }, lineSpacing: 3 }
    ).setOrigin(0.5, 0).setDepth(d + 2);
    group.add(this._awakeningMotifTxt);

    // Node labels are created per-path and destroyed on switch — tracked
    // separately from `group` so they don't leak across selections.
    this._awakeningNodeLabels = [];

    this._showAwakening(0);
  }

  // Renders one awakening's constellation into the preview pane. Everything
  // drawn here is deliberately desaturated/locked — no interaction, no state.
  _showAwakening(index) {
    const paths = this._awakeningPaths || [];
    const path = paths[index];
    if (!path) return;
    if (index !== this._awakeningIndex) SoundManager.play('select');
    this._awakeningIndex = index;

    // Selector tab visuals
    this._awakeningTabs?.forEach((t, i) => {
      const active = i === index;
      t.bg.setFillStyle(active ? 0x2a2438 : 0x1a1a22);
      t.bg.setStrokeStyle(1, active ? 0x7a6fb5 : 0x3a3a4a);
      t.lbl.setStyle({ color: active ? '#bbaaee' : '#777788' });
    });

    this._awakeningMotifTxt?.setText(`✦  ${path.motif} — ${path.motifDesc}`);

    // Clear previous constellation
    const g = this._awakeningTreeGfx;
    g.clear();
    this._awakeningNodeLabels?.forEach(t => t.destroy());
    this._awakeningNodeLabels = [];

    const pane = this._awakeningPane;
    const d = this._depth;
    // Inset so nodes at x/y 0 or 1 aren't flush against the pane border, and
    // so their text labels have room to sit beside them.
    const padX = 78, padY = 26;
    const toX = (nx) => pane.x + padX + nx * (pane.w - padX * 2);
    const toY = (ny) => pane.y + padY + ny * (pane.h - padY * 2);

    const pts = path.nodes.map(n => ({ ...n, px: toX(n.x), py: toY(n.y) }));

    // ── Edges ────────────────────────────────────────────────────────────────
    (path.edges || []).forEach(([a, bIdx, kind]) => {
      const p1 = pts[a], p2 = pts[bIdx];
      if (!p1 || !p2) return;
      if (kind === 'link') {
        // "Shared bonus" connection — visually linked but not a prerequisite.
        // Drawn as a dashed line so the distinction is readable without color.
        g.lineStyle(1, 0x6a5a8a, 0.55);
        const segs = 9;
        for (let s = 0; s < segs; s += 2) {
          const t0 = s / segs, t1 = Math.min(1, (s + 1) / segs);
          g.beginPath();
          g.moveTo(p1.px + (p2.px - p1.px) * t0, p1.py + (p2.py - p1.py) * t0);
          g.lineTo(p1.px + (p2.px - p1.px) * t1, p1.py + (p2.py - p1.py) * t1);
          g.strokePath();
        }
      } else {
        g.lineStyle(1.5, 0x3a4a66, 0.6);
        g.beginPath();
        g.moveTo(p1.px, p1.py);
        g.lineTo(p2.px, p2.py);
        g.strokePath();
      }
    });

    // ── Nodes ────────────────────────────────────────────────────────────────
    pts.forEach((p) => {
      const style = TIER_STYLE[p.t] || TIER_STYLE[1];
      const r = style.radius;

      g.fillStyle(0x11151f, 0.95);
      g.fillCircle(p.px, p.py, r);
      g.lineStyle(p.t === 4 ? 2 : 1.25, style.color, p.t === 4 ? 0.9 : 0.7);
      g.strokeCircle(p.px, p.py, r);

      // Capstone gets a second ring so it reads as the payoff by SHAPE, not
      // only by color/size (see the doc's accessibility note — state and rank
      // should never be conveyed by color alone).
      if (p.t === 4) {
        g.lineStyle(1, style.color, 0.45);
        g.strokeCircle(p.px, p.py, r + 5);
      }

      const label = this.add.text(p.px, p.py + r + 3, p.n, {
        fontSize: p.t === 4 ? '11px' : '9px',
        color: p.t === 4 ? '#c9ae5e' : '#7a879c',
        align: 'center',
        wordWrap: { width: 92 },
        fontStyle: p.t === 4 ? 'bold' : 'normal',
      }).setOrigin(0.5, 0).setDepth(d + 3);
      this._awakeningNodeLabels.push(label);
    });

    // Keep new labels hidden if the user has since switched tabs away.
    const visible = this._activeTab === 'Talents';
    this._awakeningNodeLabels.forEach(t => t.setVisible(visible));
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
    // Refresh UIScene so the alert dot reflects the updated unspent point count
    this.scene.get('UIScene')?.refreshUI?.();
    this.scene.stop();
  }
}
