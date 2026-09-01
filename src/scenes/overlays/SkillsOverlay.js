// src/scenes/overlays/SkillsOverlay.js
import Tooltip from '../../ui/Tooltip.js';
import { DEPTH } from '../../ui/styles.js';
import { SKILLS } from '../../../data/skills.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { buildSkillTooltipLines } from '../../ui/skillTooltip.js';
import { setupSceneCursor } from '../../ui/cursor.js';

export default class SkillsOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'SkillsOverlay' });
    this.scrollY = 0;
    this.scrollMin = 0;
    this.scrollMax = 0;

    this.items = []; // metrics only
    this.filter = { weapon: 'Any', stats: new Set(), search: '' };
    this._searchFocused = false;
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
      fullscreen: true,
      onClose: () => this._close(),
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

    // ── Search box ──
    // Phaser has no native text input, so this is a drawn box plus a raw
    // keydown handler. Click to focus (caret shows); Enter or a click outside
    // blurs. ESC is deliberately NOT bound here — createOverlayFrame owns it
    // for closing the overlay, and stealing it would break that everywhere.
    const searchW = Math.min(320, Math.max(180, w - 32 - (chipsX - x) - 90));
    const searchX = x + w - 16 - searchW;
    const searchY = y - 4;
    this._searchBox = this.add.rectangle(searchX + searchW / 2, searchY + 14, searchW, 26, 0x1e1e1e, 1)
      .setStrokeStyle(1, 0x555555)
      .setInteractive({ useHandCursor: true });
    this._searchTxt = this.add.text(searchX + 8, searchY + 6, '', {
      fontSize: '13px', color: '#ffffff', fixedWidth: searchW - 34
    }).setOrigin(0, 0);
    this._searchClear = this.add.text(searchX + searchW - 16, searchY + 6, '✕', {
      fontSize: '13px', color: '#aa6666'
    }).setOrigin(0.5, 0).setInteractive({ useHandCursor: true });

    this._searchBox.on('pointerdown', () => { this._searchFocused = true; this._renderSearch(); });
    this._searchClear.on('pointerdown', () => {
      this.filter.search = '';
      this._renderSearch();
      this._buildCards();
    });

    // Blur when clicking anywhere that isn't the box itself.
    const onPointer = (pointer, over) => {
      const hitBox = Array.isArray(over) && over.includes(this._searchBox);
      if (!hitBox && this._searchFocused) { this._searchFocused = false; this._renderSearch(); }
    };
    this.input.on('pointerdown', onPointer);

    const onKey = (event) => {
      if (!this._searchFocused) return;
      const k = event.key;
      if (k === 'Backspace') {
        this.filter.search = this.filter.search.slice(0, -1);
      } else if (k === 'Enter') {
        this._searchFocused = false;
      } else if (k && k.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (this.filter.search.length >= 40) return;
        this.filter.search += k;
      } else {
        return;   // arrows/pageup/etc fall through to the scroll handlers
      }
      // Caret feedback is instant; the expensive card rebuild is debounced so
      // holding a key or typing quickly does not rebuild the whole list once
      // per character. Without this every keystroke destroyed and recreated
      // every visible card.
      this._renderSearch();
      this._queueCardRebuild();
    };
    this.input.keyboard?.on('keydown', onKey);
    this.events.once('shutdown', () => {
      this.input.keyboard?.off('keydown', onKey);
      this.input.off('pointerdown', onPointer);
      // A raw setTimeout outlives the scene, so it must be cancelled here.
      if (this._pendingCardRebuild) {
        clearTimeout(this._pendingCardRebuild);
        this._pendingCardRebuild = null;
      }
    });

    this.header.add([this._searchBox, this._searchTxt, this._searchClear]);
    this._renderSearch();

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

  /**
   * Debounced _buildCards — see the search keydown handler.
   *
   * Uses window.setTimeout rather than this.time.delayedCall on purpose. The
   * Phaser clock only advances while the scene is ACTIVE, and this overlay can
   * sit inactive (a harness check found it parked with time.now frozen), which
   * would strand a queued rebuild and leave the results list stale forever.
   * This is pure UI debouncing, not gameplay timing, so it has no reason to
   * respect scene pause. Cleared on shutdown below.
   */
  _queueCardRebuild(delay = 130) {
    if (this._pendingCardRebuild) clearTimeout(this._pendingCardRebuild);
    this._pendingCardRebuild = setTimeout(() => {
      this._pendingCardRebuild = null;
      // The scene may have been torn down while this was pending.
      if (!this.scene || !this.sys || this.sys.isDestroyed?.()) return;
      try { this._buildCards(); } catch (err) { console.error('[skills search]', err); }
    }, delay);
  }

  _renderSearch() {
    if (!this._searchTxt) return;
    const q = this.filter.search;
    if (!q) {
      this._searchTxt.setText(this._searchFocused ? '|' : 'Search skills\u2026');
      this._searchTxt.setColor(this._searchFocused ? '#ffffff' : '#777777');
    } else {
      this._searchTxt.setText(q + (this._searchFocused ? '|' : ''));
      this._searchTxt.setColor('#ffffff');
    }
    this._searchBox?.setStrokeStyle(1, this._searchFocused ? 0xc8a060 : 0x555555);
  }

  // Every token must match SOMEWHERE in the skill's searchable text, so
  // "dagger toxic" narrows rather than widens. Covers name, description, id,
  // tags, required stat and required weapon(s) — the tags are what make
  // keyword searches like "aoe", "lightning" or "projectile" work.
  _matchesSearch(id, sk) {
    const q = (this.filter.search || '').trim().toLowerCase();
    if (!q) return true;
    const rw = Array.isArray(sk.requiredWeapon) ? sk.requiredWeapon : (sk.requiredWeapon ? [sk.requiredWeapon] : []);
    const hay = [
      sk.name || '', sk.description || sk.desc || '', id,
      (sk.tags || []).join(' '),
      sk.requiredStat || '',
      rw.join(' '),
      Object.keys(sk.buildupHint || {}).join(' '),
      String(sk.actionCost || ''),
    ].join(' ').toLowerCase();
    return q.split(/\s+/).every(tok => hay.includes(tok));
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
      // Mirror getWeaponSkillsFor's own exclusions. Without the `hidden` check
      // the six sub-skills that back multi-strike abilities (volley_arrow,
      // hail_of_arrows_shot, farsight_volley_shot, carrion_strike_swing,
      // twin_fang_offhand, arterial_rush_cut) were each listed as a SECOND
      // card under the same display name as their parent — they are engine
      // plumbing, not skills a player can pick.
      if (s.hidden || s.disabled || s.enemyOnly) continue;

      // Weapon filter
      if (this.filter.weapon !== 'Any') {
        const rw = s.requiredWeapon;
        const has = Array.isArray(rw) ? rw.includes(this.filter.weapon) : (rw === this.filter.weapon);
        if (!has) continue;
      }

      // Free-text search (name/description/tags/id/stat/weapon)
      if (!this._matchesSearch(id, s)) continue;

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
        const { lines, tags, titleColor, aoeGrid } = buildSkillTooltipLines(s.raw, null);
        this._showTooltipAt(x, y, { title: s.name, titleColor, lines, tags, aoeGrid });
        bg.setFillStyle(0x303030, 1);
      };
      const hideTip = () => { this._hideTooltip(); bg.setFillStyle(0x262626, 1); };

      // Only the BACKGROUND is interactive. The two Text objects sit on top of
      // it but are left non-interactive, and Phaser's hit test only considers
      // interactive objects — so the pointer falls straight through to bg and
      // hover still works everywhere on the card. Making all three interactive
      // meant 3 input zones and 6 listeners per card; across ~240 skills that
      // is ~1450 listeners torn down and rebuilt on EVERY keystroke, which is
      // what made the search bar lag.
      bg.on('pointerover', showTip);
      bg.on('pointerout', hideTip);

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
        (this.filter.search || '').trim()
          ? `No skills match \u201c${this.filter.search}\u201d.`
          : (this.filter.stats.size > 0 || this.filter.weapon !== 'Any'
              ? 'No skills match the current filters.'
              : 'No weapon skills found.'),
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
