// src/scenes/overlays/SkillsOverlay.js
import Tooltip from '../../ui/Tooltip.js';
import { DEPTH } from '../../ui/styles.js';
import { SKILLS } from '../../../data/skills.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { buildSkillTooltipLines } from '../../ui/skillTooltip.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createScrollbar } from '../../ui/Scrollbar.js';
import GameState from '../../systems/GameState.js';
import { getProficiencyMap } from '../../systems/CombatLogic.js';

export default class SkillsOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'SkillsOverlay' });
    this.scrollY = 0;
    this.scrollMin = 0;
    this.scrollMax = 0;

    this.items = []; // metrics only
    this.filter = { weapon: 'Any', stats: new Set(), search: '' };
    // -1 = nobody selected; the browser then behaves exactly as before.
    this.selectedCharIndex = -1;
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


    // Viewport top is +110, not +84.
    //
    // The header occupies two rows starting at panelY+48 (it cannot start any
    // higher -- the frame's own title runs from +18 to roughly +48). Its second
    // row holds the stat chips and the Hunter selector: chips are 24px tall
    // centred at chipsY+14, so that row ends at panelY+100. With the list
    // starting at +84 the chips and the selector were drawn straddling the
    // viewport's top edge, i.e. half inside the scrolling window.
    const viewport = new Phaser.Geom.Rectangle(panelX + 16, panelY + 110, panelW - 32, panelH - 146);
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

    // ── Hunter selector (beneath the weapon cycler, centre) ──
    // Sits on the chips row rather than a new one: the header is only 36px
    // tall before the list viewport starts, and the right half of that row is
    // empty because the chips run from the left edge.
    //
    // Picking a Hunter dims every skill their Proficiency cannot reach, and
    // prints their per-stat Proficiency beside the name. That per-stat part is
    // the whole point -- Proficiency is not one number, so "can I use this"
    // can only be answered against the specific stat a skill asks for.
    // Arrows and label use the SAME x offsets as the weapon cycler directly
    // above (cx-120 / cx-100 / cx+120) so the two controls read as one column.
    // The Proficiency readout then starts past the right arrow at cx+140; the
    // search box is on row 1, so this half of row 2 is free.
    const charY = y + 26;
    this._charLeft = this.add.text(cx - 120, charY + 4, '◀', { fontSize: '16px', color: '#ffffff' })
      .setInteractive({ useHandCursor: true });
    this._charLabel = this.add.text(cx - 100, charY + 6, '', { fontSize: '14px', color: '#ffffff' });
    this._charRight = this.add.text(cx + 120, charY + 4, '▶', { fontSize: '16px', color: '#ffffff' })
      .setInteractive({ useHandCursor: true });
    // Per-stat Proficiency for the selected Hunter, tinted with the game's own
    // stat colours so a glance tells you which requirement you actually meet.
    this._charProf = this.add.text(cx + 140, charY + 7, '', { fontSize: '12px', color: '#9a9186' });

    const cycleChar = (dir) => {
      const n = (GameState.party || []).length;
      // -1 (None) is a real position in the cycle, so a player can always get
      // back to the plain browser without hunting for a "clear" control.
      const span = n + 1;
      let i = this.selectedCharIndex + 1 + dir;   // shift so None is index 0
      i = ((i % span) + span) % span;
      this.selectedCharIndex = i - 1;
      this._renderCharSelector();
      this._buildCards();
    };
    this._charLeft.on('pointerdown', () => cycleChar(-1));
    this._charRight.on('pointerdown', () => cycleChar(1));
    this.header.add([this._charLeft, this._charLabel, this._charRight, this._charProf]);
    this._renderCharSelector();

    // ── Search box ──
    // Phaser has no native text input, so this is a drawn box plus a raw
    // keydown handler. Click to focus (caret shows); Enter or a click outside
    // blurs. ESC is deliberately NOT bound here — createOverlayFrame owns it
    // for closing the overlay, and stealing it would break that everywhere.
    const searchW = Math.min(320, Math.max(180, w - 32 - (chipsX - x) - 90));
    const searchX = x + w - 16 - searchW;
    // y-4 put the box's top edge at panelY+45, just under the frame title's
    // descender. Aligned to the row instead.
    const searchY = y;
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
      // Phaser REUSES this scene instance when the overlay is opened again, so
      // anything stored on `this` survives a close -- but the display list is
      // destroyed. A scrollbar left here points at a dead Zone, and the next
      // opening refreshed it before rebuilding it (_buildCards calls _setScroll
      // ahead of _buildScrollbar), which crashed in setInteractive reading
      // `this.scene.sys` on a destroyed object. Reported from play as
      // "Cannot read properties of undefined (reading 'sys')".
      this._scrollbar?.destroy();
      this._scrollbar = null;
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
      // the sub-skills that back multi-strike and reaction abilities
      // (volley_arrow, hail_of_arrows_shot, farsight_volley_shot,
      // carrion_strike_swing, twin_fang_offhand, arterial_rush_cut,
      // aftershock_slam) were each listed as a SECOND
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

    // ---- Layout: grouped Proficiency ladder ------------------------------
    //
    // Was one full-width card per skill, stacked. At ~150 skills that is a very
    // long scroll where each card is mostly empty, and it never answers the
    // question a player actually has: what do I get if I put my next points
    // here? Cards are now GROUPED under the Proficiency that unlocks them and
    // flowed into as many columns as the panel is wide.
    // Measured against the selected Hunter, if there is one. Locked skills are
    // DIMMED rather than hidden: the point of the grouped ladder is to show
    // what you are working toward, and filtering them out would delete exactly
    // that information.
    const selChar = this._selectedChar();
    const selProf = selChar ? getProficiencyMap(selChar) : null;

    const STAT_TINT = {
      STR: 0xff7755, DEX: 0x88dd88, CON: 0xcc9955,
      INT: 0x5599ff, WIS: 0xbb88ff, CHA: 0xffcc44,
    };
    const left = this.graphViewport.x + 12;
    const top = this.graphViewport.y + 12;
    // 14px reserved on the right for the scrollbar, so the bar sits beside
    // the cards rather than on top of them.
    const availW = this.graphViewport.width - 24 - 14;

    const GUTTER_W = 62;          // left rail holding the Proficiency number
    const CARD_MIN = 210;
    const CARD_H = 46;
    const GAP = 7;

    const gridW = availW - GUTTER_W;
    const cols = Math.max(1, Math.floor((gridW + GAP) / (CARD_MIN + GAP)));
    const cardW = Math.floor((gridW - GAP * (cols - 1)) / cols);

    // Group by required Proficiency, ascending.
    const groups = new Map();
    for (const sk of all) {
      if (!groups.has(sk.reqVal)) groups.set(sk.reqVal, []);
      groups.get(sk.reqVal).push(sk);
    }
    const gateKeys = [...groups.keys()].sort((a, b) => a - b);

    let y = top;
    for (const gate of gateKeys) {
      const inGroup = groups.get(gate);
      const rows = Math.ceil(inGroup.length / cols);
      const blockH = rows * CARD_H + (rows - 1) * GAP;

      // Left rail: the gate value, once per group, instead of repeating
      // "Required: X" on every single card.
      const gnum = this.add.text(left + GUTTER_W - 14, y, String(gate), {
        fontSize: '22px', color: '#c8a060', fontStyle: 'bold',
      }).setOrigin(1, 0);
      const glab = this.add.text(left + GUTTER_W - 14, y + 24, 'PROF', {
        fontSize: '9px', color: '#7d7368',
      }).setOrigin(1, 0);
      this.content.add([gnum, glab]);

      inGroup.forEach((sk, i) => {
        const cx = left + GUTTER_W + (i % cols) * (cardW + GAP);
        const cy = y + Math.floor(i / cols) * (CARD_H + GAP);
        const tint = STAT_TINT[sk.reqStat] || 0x888888;
        const have = selProf ? (selProf[sk.reqStat] ?? 0) : null;
        const locked = have != null && have < sk.reqVal;

        const bg = this.add.rectangle(cx + cardW / 2, cy + CARD_H / 2, cardW, CARD_H,
          locked ? 0x1b1b1b : 0x262626, 1)
          .setStrokeStyle(1, locked ? 0x3a3a3a : 0x555555)
          .setInteractive({ useHandCursor: true });
        // Stat is carried by a colored edge rather than a word, so the card can
        // spend its width on the skill's name.
        const edge = this.add.rectangle(cx + 1.5, cy + CARD_H / 2, 3, CARD_H, tint, 1)
          .setAlpha(locked ? 0.35 : 1);

        const name = this.add.text(cx + 10, cy + 6, sk.name,
          { fontSize: '14px', color: locked ? '#7c7468' : '#ffffff' });
        // With a Hunter selected the meta line shows their standing in the
        // gate's own stat ("DEX 5 / 9"), which is the only form of the
        // question that means anything -- Proficiency differs per stat.
        const metaText = have != null
          ? `${sk.reqStat} ${have} / ${sk.reqVal}  ·  ${sk.weaponList.length ? sk.weaponList.join(', ') : 'Any'}`
          : `${sk.reqStat}  ·  ${sk.weaponList.length ? sk.weaponList.join(', ') : 'Any'}`;
        const meta = this.add.text(cx + 10, cy + 25, metaText,
          { fontSize: '10px', color: locked ? '#6d6459' : (have != null ? '#8fbf7a' : '#9a9186') });

        const showTip = () => {
          const { x, y: py } = this.input.activePointer;
          const { lines, tags, titleColor, aoeGrid } = buildSkillTooltipLines(sk.raw, null);
          this._showTooltipAt(x, py, { title: sk.name, titleColor, lines, tags, aoeGrid });
          bg.setFillStyle(locked ? 0x242424 : 0x303030, 1);
        };
        const hideTip = () => { this._hideTooltip(); bg.setFillStyle(locked ? 0x1b1b1b : 0x262626, 1); };

        // Only the BACKGROUND is interactive — the text and edge sit on top but
        // stay non-interactive, so Phaser's hit test falls through to bg. Making
        // each element interactive meant 4 input zones per card, which is what
        // made the search bar lag across ~240 skills.
        bg.on('pointerover', showTip);
        bg.on('pointerout', hideTip);
        bg.on('pointerdown', () => {
          bg.setStrokeStyle(2, 0xffffff);
          this.time.delayedCall(120, () => bg.setStrokeStyle(1, locked ? 0x3a3a3a : 0x555555));
        });

        this.content.add([bg, edge, name, meta]);
      });

      // One scroll entry per GROUP, not per card — the list is now 2-D, so a
      // per-card entry would report a content height several times too tall.
      this.items.push({ y, h: blockH + 22 });
      y += blockH + 22;
    }

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
      this._buildScrollbar();
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
    this._buildScrollbar();
  }

  /**
   * Draggable scrollbar down the right edge of the list viewport. Rebuilt with
   * the list because scrollMax changes whenever a filter or the search text
   * does, and a stale bar would scrub against the wrong range.
   */
  _buildScrollbar() {
    this._scrollbar?.destroy();
    const vp = this.graphViewport;
    const total = vp.height + (this.scrollMax || 0);
    this._scrollbar = createScrollbar(this, {
      x: vp.x + vp.width - 10,
      y: vp.y,
      height: vp.height,
      getScroll: () => this.scrollY,
      getMax: () => this.scrollMax,
      setScroll: (v) => this._setScroll(v),
      viewRatio: () => (total > 0 ? vp.height / total : 1),
    });
  }

  /** The Hunter the list is being measured against, or null for none. */
  _selectedChar() {
    const party = GameState.party || [];
    return this.selectedCharIndex >= 0 ? (party[this.selectedCharIndex] || null) : null;
  }

  _renderCharSelector() {
    const char = this._selectedChar();
    if (!char) {
      this._charLabel.setText('Hunter: None');
      this._charProf.setText('');
      return;
    }
    this._charLabel.setText(`Hunter: ${char.name}`);
    const m = getProficiencyMap(char);
    this._charProf.setText(
      ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map(k => `${k} ${m[k] ?? 0}`).join('   '));
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
    this._scrollbar?.refresh();
    this.content.y = -this.scrollY;
  }
}
