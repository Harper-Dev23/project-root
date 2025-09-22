import { COLORS, FONTS, SPACING, UI_DEPTH } from './styles.js';

export default class DialogBox extends Phaser.GameObjects.Container {
  constructor(scene, x, y, width, height, text = '') {
    super(scene, x, y);

    this.bg = scene.add.rectangle(0, 0, width, height, COLORS.panel)
      .setOrigin(0.5)
      .setStrokeStyle(SPACING.border, COLORS.border)
      .setDepth(UI_DEPTH.overlay);

    this.text = scene.add.text(-width / 2 + SPACING.padding, -height / 2 + SPACING.padding, text, {
      ...FONTS.body,
      wordWrap: { width: width - SPACING.padding * 2 }
    }).setOrigin(0);

    this.add([this.bg, this.text]);
    this.setSize(width, height);
    scene.add.existing(this);
  }

  setText(newText) {
    this.text.setText(newText);
  }
}
