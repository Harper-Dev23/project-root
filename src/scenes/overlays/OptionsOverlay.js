import { createOverlayFrame } from '../../ui/OverlayFrame.js';

export default class OptionsOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'OptionsOverlay' });
  }

  create() {
    const frame = createOverlayFrame(this, {
      title: 'Options',
      onClose: () => this._close()
    });

    const depth = frame.depth;
    const bounds = frame.bounds;
    const left = bounds.x + 40;
    let cursorY = bounds.y + 90;

    const sectionStyle = { fontSize: '20px', color: '#ffffaa', fontStyle: 'bold' };
    const itemStyle = { fontSize: '16px', color: '#e0e0e0' };

    this.add.text(left, cursorY, 'Audio', sectionStyle).setDepth(depth);
    cursorY += 30;
    this.add.text(left + 20, cursorY, '• Master Volume [placeholder slider]', itemStyle).setDepth(depth);
    cursorY += 24;
    this.add.text(left + 20, cursorY, '• Music Volume [placeholder slider]', itemStyle).setDepth(depth);
    cursorY += 24;
    this.add.text(left + 20, cursorY, '• Effects Volume [placeholder slider]', itemStyle).setDepth(depth);

    cursorY += 40;
    this.add.text(left, cursorY, 'Graphics', sectionStyle).setDepth(depth);
    cursorY += 30;
    this.add.text(left + 20, cursorY, '• Display Mode: Fullscreen / Windowed', itemStyle).setDepth(depth);
    cursorY += 24;
    this.add.text(left + 20, cursorY, '• VSync: On / Off', itemStyle).setDepth(depth);
    cursorY += 24;
    this.add.text(left + 20, cursorY, '• Brightness [placeholder slider]', itemStyle).setDepth(depth);

    cursorY += 40;
    this.add.text(left, cursorY, 'Gameplay', sectionStyle).setDepth(depth);
    cursorY += 30;
    this.add.text(left + 20, cursorY, '• Combat Hints: Enabled', itemStyle).setDepth(depth);
    cursorY += 24;
    this.add.text(left + 20, cursorY, '• Auto-Pause on Encounter: Enabled', itemStyle).setDepth(depth);
    cursorY += 24;
    this.add.text(left + 20, cursorY, '• Tooltip Detail Level: Standard', itemStyle).setDepth(depth);

    const note = 'All options are currently non-interactive placeholders to illustrate the planned menu.';
    this.add.text(left, bounds.bottom - 80, note, {
      fontSize: '14px',
      color: '#bbbbbb',
      wordWrap: { width: bounds.width - 80 }
    }).setDepth(depth);
  }

  _close() {
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}