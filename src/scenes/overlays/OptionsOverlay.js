import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { HOTKEYS } from '../../systems/HotkeyManager.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { AudioSettings } from '../../systems/AudioSettings.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { DevFlags } from '../../systems/DevFlags.js';

const TAB_NAMES = ['Audio', 'Graphics', 'Gameplay', 'Hotkeys', 'Cheats'];

export default class OptionsOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'OptionsOverlay' });
  }

  create() {
    const town = this.scene.get('TownScene');
    setupSceneCursor(this);
    if (town?.input) town.input.enabled = false;

    const frame = createOverlayFrame(this, {
      title: 'Options',
      onClose: () => this._close(),
      bgImage: 'menu_stony_background'
    });

    this._depth  = frame.depth;
    this._bounds = frame.bounds;

    this._buildTabs();
    this._showTab('Audio');
  }

  // ── Tabs ────────────────────────────────────────────────────────────────

  _buildTabs() {
    const { x, y, width } = this._bounds;
    const depth = this._depth;

    const tabY    = y + 72;
    const tabW    = 100;
    const tabH    = 28;
    const startX  = x + (width - TAB_NAMES.length * tabW) / 2;

    this._tabBtns = {};
    this._tabContent = {};

    TAB_NAMES.forEach((name, i) => {
      const tx = startX + i * tabW + tabW / 2;

      const bg = this.add.rectangle(tx, tabY, tabW - 4, tabH, 0x1a1a1a)
        .setOrigin(0.5)
        .setDepth(depth)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._showTab(name))
        .on('pointerover', () => {
          if (this._activeTab !== name) bg.setFillStyle(0x2a2a2a);
        })
        .on('pointerout', () => {
          if (this._activeTab !== name) bg.setFillStyle(0x1a1a1a);
        });

      const label = this.add.text(tx, tabY, name, {
        fontSize: '14px',
        color: '#cccccc'
      }).setOrigin(0.5).setDepth(depth + 1).setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._showTab(name));

      const underline = this.add.rectangle(tx, tabY + tabH / 2 + 1, tabW - 4, 2, 0xffdd88)
        .setOrigin(0.5, 0)
        .setDepth(depth + 1)
        .setVisible(false);

      this._tabBtns[name] = { bg, label, underline };
    });

    // Divider below tabs
    const divGfx = this.add.graphics().setDepth(depth);
    divGfx.lineStyle(1, 0x5a4a3a, 0.7);
    divGfx.beginPath();
    divGfx.moveTo(x + 20, tabY + tabH / 2 + 4);
    divGfx.lineTo(x + width - 20, tabY + tabH / 2 + 4);
    divGfx.strokePath();
  }

  _showTab(name) {
    // Hide all content groups
    for (const key of TAB_NAMES) {
      this._tabContent[key]?.setVisible(false);

      const btn = this._tabBtns[key];
      if (btn) {
        btn.bg.setFillStyle(0x1a1a1a);
        btn.label.setStyle({ color: '#cccccc' });
        btn.underline.setVisible(false);
      }
    }

    // Highlight active tab
    this._activeTab = name;
    const btn = this._tabBtns[name];
    if (btn) {
      btn.bg.setFillStyle(0x2d2217);
      btn.label.setStyle({ color: '#ffdd88' });
      btn.underline.setVisible(true);
    }

    // Build content on first visit, then just show it
    if (!this._tabContent[name]) {
      this._buildTabContent(name);
    }
    this._tabContent[name]?.setVisible(true);
  }

  _buildTabContent(name) {
    const { x, y, width } = this._bounds;
    const depth    = this._depth;
    const left     = x + 40;
    const contentY = y + 120;

    const sectionStyle = { fontSize: '18px', color: '#ffffaa', fontStyle: 'bold' };
    const itemStyle    = { fontSize: '15px', color: '#d0d0d0' };
    const noteStyle    = { fontSize: '13px', color: '#999999' };

    const group = this.add.group();

    const addText = (tx, ty, str, style) => {
      const t = this.add.text(tx, ty, str, style).setDepth(depth);
      group.add(t);
      return t;
    };

    if (name === 'Audio') {
      let cy = contentY;
      addText(left, cy, 'Audio', sectionStyle); cy += 40;
      this._buildVolumeSlider(group, left + 20, cy, 'Master Volume', 'master', depth);  cy += 50;
      this._buildVolumeSlider(group, left + 20, cy, 'Music Volume',  'music',  depth);   cy += 50;
      this._buildVolumeSlider(group, left + 20, cy, 'Effects Volume', 'sfx',   depth);

    } else if (name === 'Graphics') {
      let cy = contentY;
      addText(left, cy, 'Graphics', sectionStyle); cy += 32;
      addText(left + 20, cy, '• Display Mode: Fullscreen / Windowed', itemStyle); cy += 26;
      addText(left + 20, cy, '• VSync: On / Off', itemStyle); cy += 26;
      addText(left + 20, cy, '• Brightness [placeholder slider]', itemStyle);

    } else if (name === 'Gameplay') {
      let cy = contentY;
      addText(left, cy, 'Gameplay', sectionStyle); cy += 32;
      addText(left + 20, cy, '• Combat Hints: Enabled', itemStyle); cy += 26;
      addText(left + 20, cy, '• Auto-Pause on Encounter: Enabled', itemStyle); cy += 26;
      addText(left + 20, cy, '• Tooltip Detail Level: Standard', itemStyle);

    } else if (name === 'Hotkeys') {
      this._buildHotkeysTab(group, left, contentY, width, sectionStyle, itemStyle, noteStyle, depth);

    } else if (name === 'Cheats') {
      this._buildCheatsTab(group, left, contentY, sectionStyle, noteStyle, depth);
    }

    // Note at bottom for placeholder tabs
    if (name !== 'Hotkeys' && name !== 'Audio' && name !== 'Cheats') {
      const note = this.add.text(
        left,
        this._bounds.bottom - 80,
        'Options are placeholders — not yet functional.',
        noteStyle
      ).setDepth(depth);
      group.add(note);
    }

    this._tabContent[name] = group;
  }

  // ── Audio sliders ───────────────────────────────────────────────────────

  /**
   * Builds one labeled, draggable volume slider bound to AudioSettings[settingKey].
   * Dragging or clicking the track updates the setting live (SoundManager
   * picks up music volume changes immediately via AudioSettings.onChange).
   */
  _buildVolumeSlider(group, x, y, label, settingKey, depth) {
    const trackW = 260;
    const trackH = 6;
    const trackX = x + 150;

    const labelText = this.add.text(x, y, label, {
      fontSize: '15px',
      color: '#d0d0d0'
    }).setOrigin(0, 0.5).setDepth(depth);
    group.add(labelText);

    const track = this.add.rectangle(trackX, y, trackW, trackH, 0x3a3a3a)
      .setOrigin(0, 0.5)
      .setDepth(depth);
    group.add(track);

    const value = AudioSettings[settingKey];
    const fill = this.add.rectangle(trackX, y, trackW * value, trackH, 0xffdd88)
      .setOrigin(0, 0.5)
      .setDepth(depth + 1);
    group.add(fill);

    const handle = this.add.circle(trackX + trackW * value, y, 8, 0xffffff)
      .setDepth(depth + 2)
      .setInteractive({ useHandCursor: true, draggable: true });
    group.add(handle);

    const pctText = this.add.text(trackX + trackW + 16, y, `${Math.round(value * 100)}%`, {
      fontSize: '14px',
      color: '#999999'
    }).setOrigin(0, 0.5).setDepth(depth);
    group.add(pctText);

    const applyValue = (rawX) => {
      const clamped = Phaser.Math.Clamp(rawX, trackX, trackX + trackW);
      const ratio = (clamped - trackX) / trackW;
      handle.x = clamped;
      fill.width = trackW * ratio;
      pctText.setText(`${Math.round(ratio * 100)}%`);
      AudioSettings.set(settingKey, ratio);
      return ratio;
    };

    this.input.setDraggable(handle);
    handle.on('drag', (pointer) => applyValue(pointer.x));
    handle.on('dragend', () => {
      if (settingKey !== 'music') SoundManager.play('select');
    });

    track.setInteractive({ useHandCursor: true })
      .on('pointerdown', (pointer) => {
        applyValue(pointer.x);
        if (settingKey !== 'music') SoundManager.play('select');
      });
  }

  _buildHotkeysTab(group, left, startY, panelWidth, sectionStyle, itemStyle, noteStyle, depth) {
    const addT = (tx, ty, str, style) => {
      const t = this.add.text(tx, ty, str, style).setDepth(depth);
      group.add(t);
      return t;
    };

    // Group hotkeys by category
    const byCategory = {};
    for (const hk of HOTKEYS) {
      if (!byCategory[hk.category]) byCategory[hk.category] = [];
      byCategory[hk.category].push(hk);
    }

    const keyColX    = left;
    const labelColX  = left + 80;
    const rowH       = 24;
    let cy = startY;

    for (const [cat, entries] of Object.entries(byCategory)) {
      addT(keyColX, cy, cat, sectionStyle);
      cy += 30;

      for (const hk of entries) {
        // Key badge
        addT(keyColX, cy, `[${hk.key}]`, {
          fontSize: '14px',
          color: '#ffdd88',
          fontStyle: 'bold',
          backgroundColor: '#1a1a1a',
          padding: { x: 5, y: 2 }
        });
        addT(labelColX, cy, hk.label, itemStyle);
        cy += rowH;
      }
      cy += 12; // gap between categories
    }

    addT(keyColX, cy + 8,
      'Hotkeys are not yet configurable — this list is for reference only.',
      noteStyle
    );
  }

  // ── Cheats (moved here from the in-combat Skills overlay corner buttons) ──

  _buildCheatsTab(group, left, startY, sectionStyle, noteStyle, depth) {
    const addT = (tx, ty, str, style) => {
      const t = this.add.text(tx, ty, str, style).setDepth(depth);
      group.add(t);
      return t;
    };

    addT(left, startY, 'Cheats', sectionStyle);

    const rowH = 28;
    let cy = startY + 40;

    const makeToggle = (label, isOn, onToggle) => {
      const box = this.add.text(left, cy, isOn ? '[✓]' : '[ ]', {
        fontSize: '15px', color: isOn ? '#88ff88' : '#888888', fontFamily: 'Georgia'
      }).setDepth(depth).setInteractive({ useHandCursor: true });
      group.add(box);

      const lbl = this.add.text(left + 34, cy, label, {
        fontSize: '15px', color: isOn ? '#88ff88' : '#888888'
      }).setDepth(depth).setInteractive({ useHandCursor: true });
      group.add(lbl);

      const refresh = () => {
        const on = onToggle();
        box.setText(on ? '[✓]' : '[ ]');
        box.setColor(on ? '#88ff88' : '#888888');
        lbl.setColor(on ? '#88ff88' : '#888888');
      };
      box.on('pointerdown', refresh);
      lbl.on('pointerdown', refresh);

      cy += rowH;
    };

    makeToggle('Free Mana (0 MP cost)', DevFlags.isFreeManaEnabled(), () => DevFlags.toggleFreeMana());
    makeToggle('No Cooldowns', DevFlags.isNoCooldownEnabled(), () => DevFlags.toggleNoCooldown());
    makeToggle('No Range Restrictions', DevFlags.isNoRangeEnabled(), () => DevFlags.toggleNoRange());
    makeToggle('Breakthrough (free MP + zero stat reqs, bundles the above two)', DevFlags.isBreakthroughEnabled(), () => DevFlags.toggleBreakthrough());
    makeToggle('Buildup ×5', DevFlags.isBuildupEnabled(), () => DevFlags.toggleBuildup());
    makeToggle('Super Saiyan (×10 damage)', DevFlags.isSuperSaiyanEnabled(), () => DevFlags.toggleSuperSaiyan());
    makeToggle('All Tribes (bypass vendor tribe lock)', DevFlags.isAllTribesEnabled(), () => DevFlags.toggleAllTribes());

    cy += 10;
    addT(left, cy, 'Persist across sessions (stored locally) — never touch save-slot data.', noteStyle);
  }

  // ── Close ────────────────────────────────────────────────────────────────

  _close() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
