import { COLORS } from './styles.js';

export default class StatusBar extends Phaser.GameObjects.Container {
  constructor(scene, x, y, width, height, value, maxValue,
              fgColor = COLORS.accent, bgColor = COLORS.panel) {
    super(scene, x, y);

    this.total = width;
    this.max = Math.max(maxValue, 1);
    this.val = Phaser.Math.Clamp(value, 0, this.max);

    // background
    this.bg = scene.add.rectangle(0, 0, width, height, bgColor)
      .setOrigin(0.5)
      .setDepth(-1)
      .setScrollFactor(0)

    // fill
    this.fill = scene.add.rectangle(-width / 2, 0, width, height, fgColor)
      .setOrigin(0, 0.5);

    this.add([this.bg, this.fill]);    // ✅ ADD here instead of `.addToContainer(this)`
    scene.add.existing(this);
  }

  updateCurrent(newValue) {
    this.val = Phaser.Math.Clamp(newValue, 0, this.max);
    const pct = this.val / this.max;
    this.fill.displayWidth = this.total * pct;
  }
}
