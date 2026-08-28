/**
 * TribeRelationsOverlay — the diplomacy screen.
 *
 * Four tabs:
 *   Standing    — live rep score/level per tribe (the one fully real system here)
 *   Privileges  — what your tribe unlocks as standing rises (teaser, gated on live rep)
 *   Intel       — the separate "what you know about them" track (teaser, live intel value)
 *   Favor       — what moves the rep number up and down (teaser)
 *
 * Only Standing reflects implemented mechanics. The other three read live
 * ProgressionManager state but describe systems that don't exist yet — they
 * are deliberately drawn in a locked//dimmed style so nothing reads as
 * available. Content comes from data/tribeSystems.js.
 */

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import {
  TRIBE_IDS, TRIBE_DISPLAY,
  OWN_TRIBE_LEVELS, OTHER_TRIBE_LEVELS,
  getTribeRepLevel, getThresholdForIndex,
} from '../../systems/TribeRelations.js';
import {
  TRIBE_PILLARS, INTEL_TIERS, INTEL_MAX,
  FAVOR_SOURCES, TRIBE_SPECIALTIES,
} from '../../../data/tribeSystems.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { setupSceneCursor } from '../../ui/cursor.js';

// ── Visual constants ──────────────────────────────────────────────────────────

const C = {
  ownTribeHeader:   '#ffdd44',
  otherTribeHeader: '#ccbbaa',
  score:            '#aaaaaa',
  effect:           '#999999',
  progressBg:       0x222222,
  progressFill:     0x88aaff,
  progressFillOwn:  0xffdd44,
  nextLevelHint:    '#777777',
  locked:           '#5c5c66',
  lockedDim:        '#44444c',
  unlocked:         '#cfc7b4',
  teaserNote:       '#6a6a78',
  panelFill:        0x0d1018,
  panelStroke:      0x2a3346,
};

const TABS = ['Standing', 'Privileges', 'Intel', 'Favor'];

// ── Scene ─────────────────────────────────────────────────────────────────────

export default class TribeRelationsOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'TribeRelationsOverlay' });
  }

  create() {
    const town = this.scene.get('TownScene');
    setupSceneCursor(this);
    if (town?.input) town.input.enabled = false;
    SoundManager.init(this);

    const frame = createOverlayFrame(this, {
      title:   'Tribe Relations',
      fullscreen: true,
      onClose: () => this._close(),
    });

    const { bounds, depth } = frame;
    this._depth  = depth;
    this._bounds = bounds;

    // Per-tab display objects, built lazily and then shown/hidden — same
    // pattern LevelUpOverlay's tabs use.
    this._tabItems = {};
    this._tabBtns  = {};

    this._buildTabRow();
    this._showTab('Standing');
  }

  // ── Tab chrome ────────────────────────────────────────────────────────────

  _buildTabRow() {
    const b = this._bounds;
    const d = this._depth;
    const tabY = b.y + 64;
    const tabW = 150;
    const gap  = 8;
    const totalW = TABS.length * tabW + (TABS.length - 1) * gap;
    const startX = b.centerX - totalW / 2;

    TABS.forEach((name, i) => {
      const cx = startX + i * (tabW + gap) + tabW / 2;

      const bg = this.add.rectangle(cx, tabY, tabW, 28, 0x1a1a22)
        .setOrigin(0.5).setDepth(d + 2)
        .setStrokeStyle(1, 0x3a3a4a)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._showTab(name));

      const lbl = this.add.text(cx, tabY, name,
        { fontSize: '14px', color: '#777788', fontFamily: 'Georgia, Gelasio, serif' }
      ).setOrigin(0.5).setDepth(d + 3)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._showTab(name));

      this._tabBtns[name] = { bg, lbl };
    });
  }

  _showTab(name) {
    for (const [key, btn] of Object.entries(this._tabBtns)) {
      const active = key === name;
      btn.bg.setFillStyle(active ? 0x2d2217 : 0x1a1a22);
      btn.bg.setStrokeStyle(1, active ? 0xbbaa44 : 0x3a3a4a);
      btn.lbl.setStyle({ color: active ? '#ffdd88' : '#777788' });
    }

    if (!this._tabItems[name]) {
      this._tabItems[name] = [];
      const add = (o) => { this._tabItems[name].push(o); return o; };
      if (name === 'Standing')   this._buildStandingTab(add);
      if (name === 'Privileges') this._buildPrivilegesTab(add);
      if (name === 'Intel')      this._buildIntelTab(add);
      if (name === 'Favor')      this._buildFavorTab(add);
    }

    for (const [key, items] of Object.entries(this._tabItems)) {
      items.forEach(o => o.setVisible(key === name));
    }
    this._activeTab = name;
  }

  /** Shared "this system isn't built yet" caption, pinned to the frame bottom. */
  _teaserFooter(add, text) {
    const b = this._bounds;
    add(this.add.text(b.centerX, b.y + b.height - 30, text, {
      fontSize: '12px', color: C.teaserNote, fontStyle: 'italic', align: 'center',
      wordWrap: { width: b.width - 120 },
    }).setOrigin(0.5, 0).setDepth(this._depth + 2));
  }

  /** Faint framed panel every tab draws its content inside. */
  _pane(add, x, y, w, h) {
    const p = this.add.rectangle(x + w / 2, y + h / 2, w, h, C.panelFill, 0.75)
      .setDepth(this._depth + 1)
      .setStrokeStyle(1, C.panelStroke);
    add(p);
    return p;
  }

  // ── Tab 1: Standing ───────────────────────────────────────────────────────

  _buildStandingTab(add) {
    const pm = ProgressionManager;
    const b  = this._bounds;
    const d  = this._depth;

    const ownId  = pm.tribe;
    const others = TRIBE_IDS.filter(id => id !== ownId);

    const contentTop = b.y + 96;
    const colW   = 560;
    const leftX  = b.centerX - colW - 30;
    const rightX = b.centerX + 30;

    add(this.add.text(leftX, contentTop, 'Your Tribe', {
      fontSize: '13px', color: C.ownTribeHeader, fontStyle: 'italic',
    }).setDepth(d + 2));

    add(this.add.text(rightX, contentTop, 'Other Tribes', {
      fontSize: '13px', color: C.otherTribeHeader, fontStyle: 'italic',
    }).setDepth(d + 2));

    const cardTop  = contentTop + 22;
    const availH   = (b.y + b.height - 56) - cardTop;
    const otherH   = Math.floor((availH - 24) / 3);
    const ownH     = otherH * 3 + 24;

    if (ownId) {
      this._drawTribeCard(add, leftX, cardTop, colW, ownH, ownId, pm, true);
    } else {
      this._pane(add, leftX, cardTop, colW, ownH);
      add(this.add.text(leftX + colW / 2, cardTop + ownH / 2,
        'No tribe chosen yet.\n\nPledge at the Elders\' Tower to claim a home tribe.', {
          fontSize: '14px', color: '#666666', align: 'center',
        }).setOrigin(0.5).setDepth(d + 2));
    }

    others.forEach((id, i) => {
      this._drawTribeCard(add, rightX, cardTop + i * (otherH + 12), colW, otherH, id, pm, false);
    });
  }

  _drawTribeCard(add, cx, cy, cw, ch, tribeId, pm, isOwn) {
    const d   = this._depth;
    const rep = getTribeRepLevel(tribeId, pm);
    const spec = TRIBE_SPECIALTIES[tribeId] || {};
    const displayName = TRIBE_DISPLAY[tribeId] ?? tribeId;
    const PAD = 18;

    const bg = this.add.graphics().setDepth(d + 1);
    bg.fillStyle(isOwn ? 0x1a1500 : 0x111111, 0.85);
    bg.fillRoundedRect(cx, cy, cw, ch, 6);
    bg.lineStyle(2, isOwn ? 0xbbaa44 : 0x5a4a3a, 1);
    bg.strokeRoundedRect(cx, cy, cw, ch, 6);
    add(bg);

    let y = cy + PAD;

    add(this.add.text(cx + PAD, y, displayName, {
      fontSize: '18px', color: isOwn ? C.ownTribeHeader : C.otherTribeHeader, fontStyle: 'bold',
    }).setDepth(d + 2));

    add(this.add.text(cx + cw - PAD, y, rep.name, {
      fontSize: '16px', color: rep.color, fontStyle: 'bold',
    }).setOrigin(1, 0).setDepth(d + 2));

    y += 22;

    // Epithet / who speaks for them — gives each card its own identity
    // instead of four differently-named copies of the same layout.
    if (spec.epithet) {
      add(this.add.text(cx + PAD, y, `${spec.epithet}  ·  ${spec.figure}`, {
        fontSize: '11px', color: '#7a7268', fontStyle: 'italic',
      }).setDepth(d + 2));
      y += 18;
    }

    add(this.add.text(cx + PAD, y, `Score: ${rep.score}`, {
      fontSize: '12px', color: C.score,
    }).setDepth(d + 2));

    const barX = cx + PAD;
    const barY = y + 18;
    const barW = cw - PAD * 2;
    const barH = 8;

    if (!rep.isMax) {
      const levelDef   = isOwn ? OWN_TRIBE_LEVELS : OTHER_TRIBE_LEVELS;
      const floorScore = getThresholdForIndex(rep.index);
      const ceilScore  = rep.nextThreshold;
      const range = ceilScore - floorScore;
      const fill  = range > 0 ? Phaser.Math.Clamp((rep.score - floorScore) / range, 0, 1) : 0;

      const barGfx = this.add.graphics().setDepth(d + 2);
      barGfx.fillStyle(C.progressBg, 1);
      barGfx.fillRoundedRect(barX, barY, barW, barH, 3);
      barGfx.fillStyle(isOwn ? C.progressFillOwn : C.progressFill, 1);
      barGfx.fillRoundedRect(barX, barY, barW * fill, barH, 3);
      add(barGfx);

      add(this.add.text(cx + cw - PAD, barY + barH + 4,
        `+${ceilScore - rep.score} to ${levelDef[rep.index + 1]?.name ?? '?'}`, {
          fontSize: '11px', color: C.nextLevelHint,
        }).setOrigin(1, 0).setDepth(d + 2));

      y = barY + barH + 22;
    } else {
      add(this.add.text(cx + cw - PAD, y, '★ MAX', {
        fontSize: '11px', color: rep.color, fontStyle: 'bold',
      }).setOrigin(1, 0).setDepth(d + 2));
      y = barY + 4;
    }

    add(this.add.text(cx + PAD, y, rep.effect, {
      fontSize: '12px', color: C.effect,
      wordWrap: { width: cw - PAD * 2 },
    }).setDepth(d + 2));

    // Own-tribe card has the room to also carry the tribe's specialty and a
    // live intel readout; the shorter rival cards get intel pips only.
    const intel = pm.getTribeIntel?.(tribeId) ?? 0;

    if (isOwn && spec.focus) {
      const fy = y + 46;
      add(this.add.text(cx + PAD, fy, 'SPECIALTY', {
        fontSize: '10px', color: '#6a6252', fontStyle: 'bold',
      }).setDepth(d + 2));
      add(this.add.text(cx + PAD, fy + 16, spec.focus, {
        fontSize: '13px', color: '#c9bfa8',
        wordWrap: { width: cw - PAD * 2 },
      }).setDepth(d + 2));
      add(this.add.text(cx + PAD, fy + 38, spec.offer, {
        fontSize: '12px', color: C.effect,
        wordWrap: { width: cw - PAD * 2 },
      }).setDepth(d + 2));

      // Live roll-up of the Privileges tab, so the tall own-tribe card
      // isn't mostly dead space and the two tabs visibly agree with each
      // other. Reads the same rep index the Privileges tab gates on.
      const open   = TRIBE_PILLARS.filter(p => rep.index >= p.unlockIndex);
      const locked = TRIBE_PILLARS.filter(p => rep.index <  p.unlockIndex);
      const py0 = fy + 82;

      add(this.add.text(cx + PAD, py0, 'PRIVILEGES', {
        fontSize: '10px', color: '#6a6252', fontStyle: 'bold',
      }).setDepth(d + 2));
      add(this.add.text(cx + cw - PAD, py0, `${open.length} of ${TRIBE_PILLARS.length} open`, {
        fontSize: '10px', color: '#6a6252',
      }).setOrigin(1, 0).setDepth(d + 2));

      let ly = py0 + 18;
      TRIBE_PILLARS.forEach(p => {
        const isOpen = rep.index >= p.unlockIndex;
        add(this.add.text(cx + PAD, ly, isOpen ? '●' : '🔒', {
          fontSize: isOpen ? '11px' : '10px',
          color: isOpen ? '#88ffaa' : C.locked,
        }).setDepth(d + 2));
        add(this.add.text(cx + PAD + 18, ly, p.name, {
          fontSize: '12px', color: isOpen ? '#9a9384' : C.lockedDim,
        }).setDepth(d + 2));
        if (!isOpen) {
          add(this.add.text(cx + cw - PAD, ly,
            OWN_TRIBE_LEVELS[p.unlockIndex]?.name ?? `Rank ${p.unlockIndex}`, {
              fontSize: '10px', color: C.lockedDim,
            }).setOrigin(1, 0).setDepth(d + 2));
        }
        ly += 19;
      });

      if (locked.length) {
        add(this.add.text(cx + PAD, ly + 6,
          `Next: ${locked[0].name} at ${OWN_TRIBE_LEVELS[locked[0].unlockIndex]?.name}.`, {
            fontSize: '11px', color: C.teaserNote, fontStyle: 'italic',
          }).setDepth(d + 2));
      }
    }

    // Intel pips — bottom-right of every card, so the second track is
    // visible at a glance next to the rep it is deliberately separate from.
    const pipY = cy + ch - PAD - 4;
    add(this.add.text(cx + PAD, pipY, 'INTEL', {
      fontSize: '10px', color: '#5a5a66', fontStyle: 'bold',
    }).setOrigin(0, 0.5).setDepth(d + 2));

    const pipGfx = this.add.graphics().setDepth(d + 2);
    for (let i = 0; i < INTEL_MAX; i++) {
      const px = cx + PAD + 46 + i * 16;
      if (i < intel) {
        pipGfx.fillStyle(0x88aaff, 0.95);
        pipGfx.fillCircle(px, pipY, 5);
      } else {
        pipGfx.lineStyle(1, 0x3a3a4a, 1);
        pipGfx.strokeCircle(px, pipY, 5);
      }
    }
    add(pipGfx);

    add(this.add.text(cx + PAD + 46 + INTEL_MAX * 16 + 6, pipY,
      INTEL_TIERS[intel]?.name ?? '—', {
        fontSize: '11px', color: INTEL_TIERS[intel]?.color ?? C.locked,
      }).setOrigin(0, 0.5).setDepth(d + 2));
  }

  // ── Tab 2: Privileges ─────────────────────────────────────────────────────

  _buildPrivilegesTab(add) {
    const pm = ProgressionManager;
    const b  = this._bounds;
    const d  = this._depth;
    const ownId = pm.tribe;
    const contentTop = b.y + 100;

    const rep = ownId ? getTribeRepLevel(ownId, pm) : null;
    const currentIdx = rep ? rep.index : -1;
    const tribeName  = ownId ? (TRIBE_DISPLAY[ownId] ?? ownId) : 'your tribe';

    add(this.add.text(b.centerX, contentTop,
      ownId
        ? `What ${tribeName} opens to you as your standing rises.`
        : 'Pledge to a tribe to see what they would open to you.',
      { fontSize: '13px', color: '#8a8a96', align: 'center' }
    ).setOrigin(0.5, 0).setDepth(d + 2));

    add(this.add.text(b.centerX, contentTop + 20,
      ownId ? `Currently ${rep.name} (rank ${rep.index} of 6)` : '',
      { fontSize: '12px', color: rep?.color ?? C.locked, align: 'center' }
    ).setOrigin(0.5, 0).setDepth(d + 2));

    // Two columns of pillar rows.
    const colW = 560;
    // 104, not 92 — the detail paragraph wraps to 3 lines on the longer
    // pillars and was spilling past the pane into the row below it.
    const rowH = 104;
    const leftX  = b.centerX - colW - 30;
    const rightX = b.centerX + 30;
    const listTop = contentTop + 52;

    TRIBE_PILLARS.forEach((p, i) => {
      const col = i < Math.ceil(TRIBE_PILLARS.length / 2) ? 0 : 1;
      const row = col === 0 ? i : i - Math.ceil(TRIBE_PILLARS.length / 2);
      const px = col === 0 ? leftX : rightX;
      const py = listTop + row * (rowH + 8);

      const unlocked = currentIdx >= p.unlockIndex;
      this._pane(add, px, py, colW, rowH);

      // Icon + name
      add(this.add.text(px + 16, py + 12, p.icon, { fontSize: '20px' })
        .setDepth(d + 2).setAlpha(unlocked ? 1 : 0.35));

      add(this.add.text(px + 48, py + 12, p.name, {
        fontSize: '15px', color: unlocked ? C.unlocked : C.locked,
        fontStyle: 'bold', fontFamily: 'Georgia, Gelasio, serif',
      }).setDepth(d + 2));

      // Gate marker — text label, not color alone, so the locked/unlocked
      // state survives a colorblind reading.
      const gateName = (OWN_TRIBE_LEVELS[p.unlockIndex]?.name) ?? `Rank ${p.unlockIndex}`;
      add(this.add.text(px + colW - 16, py + 13,
        unlocked ? '● OPEN' : `🔒 ${gateName}`, {
          fontSize: '11px',
          color: unlocked ? '#88ffaa' : C.locked,
          fontStyle: 'bold',
        }).setOrigin(1, 0).setDepth(d + 2));

      add(this.add.text(px + 48, py + 34, p.summary, {
        fontSize: '12px', color: unlocked ? '#9a9384' : C.lockedDim,
      }).setDepth(d + 2));

      add(this.add.text(px + 48, py + 52, p.detail, {
        fontSize: '11px', color: unlocked ? '#7a7468' : C.lockedDim,
        wordWrap: { width: colW - 64 }, lineSpacing: 2,
      }).setDepth(d + 2));

      // Home-tribe-only marker — sits on the SUMMARY line's right edge.
      // Was pinned to the row's bottom-right, where it landed on top of the
      // wrapped detail paragraph (which runs the full row width).
      if (p.scope === 'own') {
        add(this.add.text(px + colW - 16, py + 36, 'HOME TRIBE ONLY', {
          fontSize: '9px', color: '#5a5246', fontStyle: 'bold',
        }).setOrigin(1, 0).setDepth(d + 2));
      }
    });

    this._teaserFooter(add,
      'None of these systems are implemented yet — standing itself is real, what it buys is not.');
  }

  // ── Tab 3: Intel ──────────────────────────────────────────────────────────

  _buildIntelTab(add) {
    const pm = ProgressionManager;
    const b  = this._bounds;
    const d  = this._depth;
    const contentTop = b.y + 100;

    add(this.add.text(b.centerX, contentTop,
      'Standing is how a tribe treats you. Intel is what you can act on.',
      { fontSize: '13px', color: '#8a8a96', align: 'center' }
    ).setOrigin(0.5, 0).setDepth(d + 2));

    add(this.add.text(b.centerX, contentTop + 20,
      'Gathered separately for every tribe — a tribe that likes you can still be one you know nothing about.',
      { fontSize: '11px', color: C.teaserNote, align: 'center' }
    ).setOrigin(0.5, 0).setDepth(d + 2));

    // Left: per-tribe intel levels. Right: the tier ladder.
    const listTop = contentTop + 54;
    const leftW   = 460;
    const rightW  = 620;
    const leftX   = b.centerX - (leftW + rightW + 40) / 2;
    const rightX  = leftX + leftW + 40;
    const panelH  = (b.y + b.height - 56) - listTop;

    this._pane(add, leftX, listTop, leftW, panelH);
    add(this.add.text(leftX + 18, listTop + 14, 'YOUR INTEL', {
      fontSize: '11px', color: '#6a6a78', fontStyle: 'bold',
    }).setDepth(d + 2));

    TRIBE_IDS.forEach((id, i) => {
      const ry = listTop + 44 + i * 62;
      const isOwn = pm.tribe === id;
      const intel = pm.getTribeIntel?.(id) ?? 0;
      const tier  = INTEL_TIERS[intel] ?? INTEL_TIERS[0];

      add(this.add.text(leftX + 18, ry, TRIBE_DISPLAY[id] ?? id, {
        fontSize: '15px', color: isOwn ? C.ownTribeHeader : C.otherTribeHeader,
        fontStyle: 'bold',
      }).setDepth(d + 2));

      if (isOwn) {
        add(this.add.text(leftX + 18 + 90, ry + 3, '(home)', {
          fontSize: '10px', color: '#6a6252',
        }).setDepth(d + 2));
      }

      add(this.add.text(leftX + leftW - 18, ry, `${tier.name}  (${intel}/${INTEL_MAX})`, {
        fontSize: '12px', color: tier.color,
      }).setOrigin(1, 0).setDepth(d + 2));

      // Segmented bar — one segment per intel level.
      const barGfx = this.add.graphics().setDepth(d + 2);
      const segW = (leftW - 36 - (INTEL_MAX - 1) * 4) / INTEL_MAX;
      for (let s = 0; s < INTEL_MAX; s++) {
        const sx = leftX + 18 + s * (segW + 4);
        if (s < intel) {
          barGfx.fillStyle(0x88aaff, 0.9);
          barGfx.fillRoundedRect(sx, ry + 24, segW, 7, 2);
        } else {
          barGfx.fillStyle(C.progressBg, 1);
          barGfx.fillRoundedRect(sx, ry + 24, segW, 7, 2);
        }
      }
      add(barGfx);

      add(this.add.text(leftX + 18, ry + 36, tier.summary, {
        fontSize: '11px', color: intel > 0 ? '#8a8478' : C.lockedDim,
        wordWrap: { width: leftW - 36 },
      }).setDepth(d + 2));
    });

    // Right: the ladder
    this._pane(add, rightX, listTop, rightW, panelH);
    add(this.add.text(rightX + 18, listTop + 14, 'WHAT INTEL BUYS', {
      fontSize: '11px', color: '#6a6a78', fontStyle: 'bold',
    }).setDepth(d + 2));

    let ty = listTop + 40;
    INTEL_TIERS.slice(1).forEach((tier) => {
      add(this.add.text(rightX + 18, ty, `${tier.level}`, {
        fontSize: '13px', color: tier.color, fontStyle: 'bold',
      }).setDepth(d + 2));

      add(this.add.text(rightX + 40, ty, tier.name, {
        fontSize: '14px', color: tier.color, fontStyle: 'bold', fontFamily: 'Georgia, Gelasio, serif',
      }).setDepth(d + 2));

      let uy = ty + 22;
      tier.unlocks.forEach(u => {
        add(this.add.text(rightX + 40, uy, `·  ${u}`, {
          fontSize: '11px', color: '#7a7468',
          wordWrap: { width: rightW - 72 },
        }).setDepth(d + 2));
        uy += 16;
      });

      ty = uy + 12;
    });

    this._teaserFooter(add,
      'Intel is tracked and saved, but nothing raises it yet — no system writes to it so far.');
  }

  // ── Tab 4: Favor ──────────────────────────────────────────────────────────

  _buildFavorTab(add) {
    const b = this._bounds;
    const d = this._depth;
    const contentTop = b.y + 100;

    add(this.add.text(b.centerX, contentTop,
      'Favor is earned by being useful to a tribe, and lost by working against one.',
      { fontSize: '13px', color: '#8a8a96', align: 'center' }
    ).setOrigin(0.5, 0).setDepth(d + 2));

    const gains  = FAVOR_SOURCES.filter(s => s.sign === '+');
    const losses = FAVOR_SOURCES.filter(s => s.sign === '−');

    const colW  = 480;
    const leftX  = b.centerX - colW - 24;
    const rightX = b.centerX + 24;
    const listTop = contentTop + 42;
    const panelH  = Math.max(gains.length, losses.length) * 40 + 56;

    const drawCol = (x, title, titleColor, rows, rowColor) => {
      this._pane(add, x, listTop, colW, panelH);
      add(this.add.text(x + 18, listTop + 14, title, {
        fontSize: '12px', color: titleColor, fontStyle: 'bold',
      }).setDepth(d + 2));

      rows.forEach((r, i) => {
        const ry = listTop + 42 + i * 40;
        add(this.add.text(x + 18, ry, r.sign, {
          fontSize: '16px', color: rowColor, fontStyle: 'bold',
        }).setDepth(d + 2));
        add(this.add.text(x + 40, ry + 2, r.label, {
          fontSize: '12px', color: '#9a9384',
          wordWrap: { width: colW - 130 },
        }).setDepth(d + 2));
        add(this.add.text(x + colW - 18, ry + 3, r.weight, {
          fontSize: '10px', color: '#5f5a50', fontStyle: 'bold',
        }).setOrigin(1, 0).setDepth(d + 2));
      });
    };

    drawCol(leftX,  'GAINS FAVOR',  '#88ffaa', gains,  '#88ffaa');
    drawCol(rightX, 'COSTS FAVOR',  '#cc6666', losses, '#cc6666');

    // The payoff statement — why any of this matters.
    const payY = listTop + panelH + 24;
    const payW = colW * 2 + 48;
    const payX = b.centerX - payW / 2;
    const payH = 96;
    this._pane(add, payX, payY, payW, payH);

    add(this.add.text(payX + payW / 2, payY + 16, 'WHY IT MATTERS', {
      fontSize: '11px', color: '#6a6a78', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(d + 2));

    add(this.add.text(payX + payW / 2, payY + 38,
      'Without a tribe behind you, a hunt is whatever the wilds hand you — survive it and take what drops.\n'
      + 'With favor and intel, a hunt becomes a choice: a named quarry, a known shrine, a specific prize.\n'
      + 'That is the whole point of standing — it turns hunting from something you endure into something you aim.',
      { fontSize: '12px', color: '#8a8478', align: 'center', lineSpacing: 3 }
    ).setOrigin(0.5, 0).setDepth(d + 2));

    this._teaserFooter(add,
      'Leader trials already grant favor. The rest of these sources are not wired up yet.');
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  _close() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.resume('UIScene');
    this.scene.get('UIScene')?.refreshUI?.();
    this.scene.stop();
  }
}
