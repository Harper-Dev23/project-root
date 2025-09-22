import { COLORS, SPACING, UI_DEPTH } from './styles.js';

export default class Panel extends Phaser.GameObjects.Container {
  constructor(scene, x, y, width, height) {
    super(scene, x, y);

    this.bg = scene.add.rectangle(0, 0, width, height, COLORS.background)
      .setOrigin(0.5)
      .setStrokeStyle(SPACING.border, COLORS.border)
      .setDepth(UI_DEPTH.panel);

    this.add(this.bg);
    this.setSize(width, height);
    scene.add.existing(this);
  }
}


// src/ui/UIUtils.js
export function centerObject(scene, object, offsetX = 0, offsetY = 0) {
  const { width, height } = scene.scale;
  object.setPosition(width / 2 + offsetX, height / 2 + offsetY);
}

export function createLabel(scene, text, fontStyle) {
  return scene.add.text(0, 0, text, fontStyle).setOrigin(0.5);
}
