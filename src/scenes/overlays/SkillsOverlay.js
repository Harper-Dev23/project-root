// src/scenes/overlays/SkillsOverlay.js
import Tooltip from '../../ui/Tooltip.js';
import { DEPTH } from '../../ui/styles.js';
import { SKILLS } from '../../../data/skills.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { DevFlags } from '../../systems/DevFlags.js';
import { buildSkillTooltipLines } from '../../ui/skillTooltip.js';
import { setupSceneCursor } from '../../ui/cursor.js';

export default class SkillsOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'SkillsOverlay' });
    this.scrollY = 0;
    this.scrollMin = 0;
    this.scrollMax = 0;

    this.items = []; // metrics only
    this.filter = { weapon: 'Any', stats: new Set() };
    this.weaponOptions = ['Any'];
    this.statOptions = [];

    this.tooltip = null;

    // persistent UI refs
    this.root = null;
    this.header = null;
    this.weaponLabel = null;
    this.weaponLeft = null;
    this.weaponRight = null;
    this.statChips = []; // [{key, chipRect, chipText}]
  }

  create() {
    const town = this.scene.get('TownScene');
    setupSceneCursor(this);
    if (town?.input) town.input.enabled = false;

    const frame = createOverlayFrame(this, {
      title: 'Skills',
      onClose: () => this._close(),
      bgImage: 'menu_stony_background'
    });

    this.root = frame.content;

    const panelX = frame.bounds.x;
    const panelY = frame.bounds.y;
    const panelW = frame.bounds.width;
    const panelH = frame.bounds.height;

    this._panelRect = new Phaser.Geom.Rectangle(panelX, panelY, panelW, panelH);


    const viewport = new Phaser.Geom.Rectangle(panelX + 16, panelY + 84, panelW - 32, panelH - 120);
    this.graphViewport = viewport;

    const maskShape = this.add.rectangle(
      viewport.x + viewport.width / 2,
      viewport.y + viewport.height / 2,
      viewport.width, viewport.height,
      0x000000, 0
    );
    const geomMask = maskShape.createGeometryMask();
    this.root.add(maskShape);

    this.content = this.add.container(0, 0);
    this.content.setMask(geomMask);
    this.root.add(this.content);

    const viewportFrame = this.add.graphics();
    viewportFrame.lineStyle(1, 0xffffff, 1);
    viewportFrame.strokeRect(viewport.x, viewport.y, viewport.width, viewport.height);
    this.root.add(viewportFrame);

    // Tooltip
    this.tooltip = new Tooltip(this);
    if (this.tooltip?.container) {
      this.tooltip.container.setDepth(DEPTH.TOOLTIP);
    }

    // Build options
    this._computeWeaponOptions();
    this._computeStatOptions();

    // Header (persistent; never destroyed on click)
    this._initHeader(panelX, panelY + 48, panelW);

    // Dev toggles
    this._initDevToggles(panelX, panelY, panelW, frame.depth);

    // First render
    this._buildCards();

    // Scroll
    this.input.on('wheel', (_p, _go, _dx, dy) => {
      const { x, y } = this.input.activePointer;
      if (Phaser.Geom.Rectangle.Contains(this.graphViewport, x, y)) {
        this._setScroll(this.scrollY + dy * 0.6);
      }
    });
    this.input.keyboard?.on('keydown-UP', () => this._setScroll(this.scrollY - 40));
    this.input.keyboard?.on('keydown-DOWN', () => this._setScroll(this.scrollY + 40));
    this.input.keyboard?.on('keydown-PAGEUP', () => this._setScroll(this.scrollY - this.graphViewport.height * 0.9));
    this.input.keyboard?.on('keydown-PAGEDOWN', () => this._setScroll(this.scrollY + this.graphViewport.height * 0.9));

    // Tooltip follow
    this.input.on('pointermove', (pointer) => {
      if (this.tooltip?.reposition) this.tooltip.reposition(pointer.x, pointer.y);
    });
  }

  // ---------- Options ----------
  _computeWeaponOptions() {
    const set = new Set();
    for (const id in SKILLS) {
      const s = SKILLS[id];
      if (!s || s.type !== 'weapon') continue;
      const rw = s.requiredWeapon;
      if (Array.isArray(rw)) rw.forEach(w => set.add(String(w)));
      else if (rw) set.add(String(rw));
    }
    const arr = Array.from(set).sort();
    this.weaponOptions = ['Any', ...arr];
    if (!this.weaponOptions.includes(this.filter.weapon)) this.filter.weapon = 'Any';
  }

  _computeStatOptions() {
    const set = new Set();
    for (const id in SKILLS) {
      const s = SKILLS[id];
      if (!s || s.type !== 'weapon') continue;
      if (s.requiredStat) set.add(String(s.requiredStat));
    }
    this.statOptions = Array.from(set).sort(); // e.g., ['CHA','CON','DEX','INT','STR','WIS']
  }

  // ---------- Dev toggles (bottom-right corner of panel) ----------
  _initDevToggles(panelX, panelY, panelW, depth) {
    const rightX  = panelX + panelW - 20;
    const topY    = panelY + 1;
    const lineH   = 22;

    const makeToggle = (label, isOn, onToggle, y) => {
      const box  = this.add.text(rightX - 180, y,
        isOn ? '[✓]' : '[ ]',
        { fontSize: '13px', color: isOn ? '#88ff88' : '#888888', fontFamily: 'Georgia' }
      ).setOrigin(0, 0).setDepth(depth).setInteractive({ useHandCursor: true });

      const lbl  = this.add.text(rightX - 155, y,
        label,
        { fontSize: '13px', color: isOn ? '#88ff88' : '#888888', fontFamily: 'Georgia' }
      ).setOrigin(0, 0).setDepth(depth).setInteractive({ useHandCursor: true });

      const refresh = () => {
        const on = onToggle();
        box.setText(on ? '[✓]' : '[ ]');
        box.setColor(on ? '#88ff88' : '#888888');
        lbl.setColor(on ? '#88ff88' : '#888888');
        // Rebuild cards so stat-gated skills appear/disappear immediately
        this._buildCards();
      };
      box.on('pointerdown', refresh);
      lbl.on('pointerdown', refresh);

      this.root.add([box, lbl]);
    };

    makeToggle('devBreakthrough',    DevFlags.isBreakthroughEnabled(),
      () => DevFlags.toggleBreakthrough(), topY);
    makeToggle('devBuildup (5×)',     DevFlags.isBuildupEnabled(),
      () => DevFlags.toggleBuildup(),      topY + lineH);
    makeToggle('devAllTribes',       DevFlags.isAllTribesEnabled(),
      () => DevFlags.toggleAllTribes(),    topY + lineH * 2);
    makeToggle('devSuperSaiyan (10×dmg)', DevFlags.isSuperSaiyanEnabled(),
      () => DevFlags.toggleSuperSaiyan(),  topY + lineH * 3);
  }

  // ---------- Header (persistent, no destroy on click) ----------
  _initHeader(x, y, w) {
    this.header = this.add.container(0, 0);
    this.header.setDepth(2);
    this.root.add(this.header);

    // Weapon cycler
    const cx = x + w / 2;
    this.header.add(this.add.text(x + 16, y, 'Filter:', { fontSize: '14px', color: '#cccccc' }));

    this.weaponLeft = this.add.text(cx - 120, y, '◀', { fontSize: '16px', color: '#ffffff' })
      .setInteractive({ useHandCursor: true });
    this.weaponLabel = this.add.text(cx - 100, y, `Weapon: ${this.filter.weapon}`, { fontSize: '14px', color: '#ffffff' });
    this.weaponRight = this.add.text(cx + 120, y, '▶', { fontSize: '16px', color: '#ffffff' })
      .setInteractive({ useHandCursor: true });

    this.weaponLeft.on('pointerdown', () => {
      const i = this.weaponOptions.indexOf(this.filter.weapon);
      const ni = (i <= 0) ? (this.weaponOptions.length - 1) : (i - 1);
      this.filter.weapon = this.weaponOptions[ni];
      this.weaponLabel.setText(`Weapon: ${this.filter.weapon}`);
      this._buildCards();
    });
    this.weaponRight.on('pointerdown', () => {
      const i = this.weaponOptions.indexOf(this.filter.weapon);
      const ni = (i + 1) % this.weaponOptions.length;
      this.filter.weapon = this.weaponOptions[ni];
      this.weaponLabel.setText(`Weapon: ${this.filter.weapon}`);
      this._buildCards();
    });

    this.header.add([this.weaponLeft, this.weaponLabel, this.weaponRight]);

    // Stat chips (persistent objects; toggle styles in-place)
    const chipsY = y + 26;
    let chipsX = x + 16;

    this.statChips = [];
    this.statOptions.forEach((statKey) => {
      const txt = this.add.text(chipsX + 10, chipsY + 6, statKey, { fontSize: '12px', color: '#ffffff' }).setOrigin(0, 0);
      const padW = txt.width + 20;
      const chip = this.add.rectangle(chipsX + padW / 2, chipsY + 14, padW, 24, 0x333333, 1)
        .setStrokeStyle(1, 0x555555)
        .setInteractive({ useHandCursor: true });

      chip.on('pointerdown', () => this._toggleStatChip(statKey));

      this.header.add(chip);
      this.header.add(txt);

      this.statChips.push({ key: statKey, chipRect: chip, chipText: txt, padW });
      chipsX += padW + 8;
    });

    // Clear chip (persistent)
    const clearTxt = this.add.text(chipsX + 10, chipsY + 6, 'Clear', { fontSize: '12px', color: '#ffffff' }).setOrigin(0, 0);
    const clearW = clearTxt.width + 20;
    const clearChip = this.add.rectangle(chipsX + clearW / 2, chipsY + 14, clearW, 24, 0x4a2f2f, 1)
      .setStrokeStyle(1, 0xaa6666)
      .setInteractive({ useHandCursor: true });
    clearChip.on('pointerdown', () => {
      if (this.filter.stats.size === 0) return;
      this.filter.stats.clear();
      this._refreshChipStyles();
      this._buildCards();
    });
    this.header.add(clearChip);
    this.header.add(clearTxt);

    // Initial styles
    this._refreshChipStyles();
  }

  _toggleStatChip(statKey) {
    if (this.filter.stats.has(statKey)) this.filter.stats.delete(statKey);
    else this.filter.stats.add(statKey);
    this._refreshChipStyles();
    this._buildCards();
  }

  _refreshChipStyles() {
    // Update each chip style without destroying anything
    this.statChips.forEach(({ key, chipRect }) => {
      const isOn = this.filter.stats.has(key);
      chipRect.setFillStyle(isOn ? 0x355a35 : 0x333333, 1);
      chipRect.setStrokeStyle(1, isOn ? 0x66aa66 : 0x555555);
    });
  }

  // ---------- Cards (sorted ASC by required stat value) ----------
  _buildCards() {
    // Clear prior content only (safe)
    this.content.removeAll(true);
    this.items = [];
    this._hideTooltip();

    // Data → filtered list
    const all = [];
    for (const id in SKILLS) {
      const s = SKILLS[id];
      if (!s || s.type !== 'weapon') continue;

      // Weapon filter
      if (this.filter.weapon !== 'Any') {
        const rw = s.requiredWeapon;
        const has = Array.isArray(rw) ? rw.includes(this.filter.weapon) : (rw === this.filter.weapon);
        if (!has) continue;
      }

      // Stat multi-filter
      if (this.filter.stats.size > 0) {
        const rs = s.requiredStat ? String(s.requiredStat) : null;
        if (!rs || !this.filter.stats.has(rs)) continue;
      }

      const reqVal = Number.isFinite(s.requiredValue) ? s.requiredValue : 0;

      all.push({
        id,
        raw: s,
        name: s.name || id,
        desc: s.description || s.desc || '',
        reqStat: s.requiredStat || '—',
        reqVal,
        weaponList: Array.isArray(s.requiredWeapon) && s.requiredWeapon.length ? s.requiredWeapon : (s.requiredWeapon ? [s.requiredWeapon] : []),
      });
    }

    // Sort ascending (lowest first), then name
    all.sort((a, b) => (a.reqVal - b.reqVal) || a.name.localeCompare(b.name));

    // Layout
    const left = this.graphViewport.x + 12;
    const top = this.graphViewport.y + 12;
    const cardH = 70;
    const cardW = this.graphViewport.width - 24;

    all.forEach((s, i) => {
      const y = top + i * (cardH + 8);

      const bg = this.add.rectangle(left + cardW / 2, y + cardH / 2, cardW, cardH, 0x262626, 1)
        .setStrokeStyle(1, 0x555555)
        .setInteractive({ useHandCursor: true });

      const name = this.add.text(left + 10, y + 6, s.name, { fontSize: '15px', color: '#ffffff' });
      const meta = this.add.text(
        left + 10, y + 30,
        `Required: ${s.reqStat} ${s.reqVal || 0}   •   Weapon: ${s.weaponList.length ? s.weaponList.join(', ') : 'Any'}`,
        { fontSize: '12px', color: '#bbbbbb' }
      );

      const showTip = () => {
        const { x, y } = this.input.activePointer;
        // Generic mode (no actor) — shows formula text, not live numbers
        const { lines, tags, titleColor } = buildSkillTooltipLines(s.raw, null);
        this._showTooltipAt(x, y, { title: s.name, titleColor, lines, tags });
        bg.setFillStyle(0x303030, 1);
      };
      const hideTip = () => { this._hideTooltip(); bg.setFillStyle(0x262626, 1); };

      bg.on('pointerover', showTip);
      bg.on('pointerout', hideTip);
      name.setInteractive({ useHandCursor: true });
      name.on('pointerover', showTip);
      name.on('pointerout', hideTip);
      meta.setInteractive({ useHandCursor: true });
      meta.on('pointerover', showTip);
      meta.on('pointerout', hideTip);

      // No-op click for now
      bg.on('pointerdown', () => {
        bg.setStrokeStyle(2, 0xffffff);
        this.time.delayedCall(120, () => bg.setStrokeStyle(1, 0x555555));
      });

      this.content.add([bg, name, meta]);
      this.items.push({ y, h: cardH + 8 });
    });

    // Empty state
    if (this.items.length === 0) {
      const t = this.add.text(this.graphViewport.x + 16, this.graphViewport.y + 16,
        this.filter.stats.size > 0 || this.filter.weapon !== 'Any'
          ? 'No skills match the current filters.'
          : 'No weapon skills found.',
        { fontSize: '14px', color: '#aaaaaa' });
      this.content.add(t);
      this.scrollMin = 0; this.scrollMax = 0; this._setScroll(0);
      return;
    }

    // Scroll bounds
    const last = this.items[this.items.length - 1];
    const contentBottom = last.y + last.h + 8;
    const minBottom = this.graphViewport.y + this.graphViewport.height;
    const usedBottom = Math.max(contentBottom, minBottom);

    const totalContentHeight = usedBottom - this.graphViewport.y;
    this.scrollMin = 0;
    this.scrollMax = Math.max(0, totalContentHeight - this.graphViewport.height);
    this._setScroll(this.scrollY);
  }

  // ---------- Tooltip helpers ----------
  // Delegated to shared skillTooltip.js — see buildSkillTooltipLines(sk, actor, opts)


  _close() {
    this._hideTooltip();
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.resume('UIScene');
    this.scene.stop();
  }

  _showTooltipAt(x, y, data) { if (this.tooltip?.show) this.tooltip.show(x, y, data); }
  _hideTooltip() { if (this.tooltip?.hide) this.tooltip.hide(); }

  // ---------- Scroll ----------
  _setScroll(y) {
    const ny = Number.isFinite(y) ? y : 0;
    this.scrollY = Phaser.Math.Clamp(ny, this.scrollMin, this.scrollMax);
    this.content.y = -this.scrollY;
  }
}
