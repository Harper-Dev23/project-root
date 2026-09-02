import { COLORS } from './styles.js';

export default class StatusBar extends Phaser.GameObjects.Container {
  constructor(scene, x, y, width, height, value, maxValue,
              fgColor = COLORS.accent, bgColor = COLORS.panel) {
    super(scene, x, y);

    this.total = width;
    this.max = Math.max(maxValue, 1);
    this.val = Phaser.Math.Clamp(value, 0, this.max);
    this.shieldVal = 0;

    // background
    this.bg = scene.add.rectangle(0, 0, width, height, bgColor)
      .setOrigin(0.5)
      .setDepth(-1)
      .setScrollFactor(0)

    // fill
    this.fill = scene.add.rectangle(-width / 2, 0, width, height, fgColor)
      .setOrigin(0, 0.5);

    // Shield overlay (e.g. the Styx "of the Ward" amulet) — a light-blue
    // segment drawn immediately after the normal fill, sized proportionally
    // to shieldVal/max. Zero-width (invisible) until setShield() is called
    // with a nonzero value, so bars without a shield look unchanged.
    this.shieldFill = scene.add.rectangle(-width / 2, 0, 0, height, 0x66ccff)
      .setOrigin(0, 0.5);

    this.add([this.bg, this.fill, this.shieldFill]);    // ✅ ADD here instead of `.addToContainer(this)`
    scene.add.existing(this);

    // Apply the initial value immediately — without this the fill rectangle
    // stays at its full constructed width until the first updateCurrent()
    // call, so every bar looks full at creation regardless of starting HP/MP.
    this.updateCurrent(this.val);
  }

  /**
   * Set value AND maximum together.
   *
   * Callers were already doing `bar.update(value, max)` — but no such method
   * existed, so those calls silently hit Phaser.GameObjects.Container's own
   * inherited no-op `update()` and did nothing at all. Bars stayed correct
   * only because _updateHPMPBars separately calls updateCurrent(). Defining
   * it here makes those call sites do what they always read as doing, which
   * also means a changed maximum (weakness maxHP-down, a modified Initiative
   * gauge cap) is finally reflected in the bar.
   */
  update(newValue, newMax) {
    if (Number.isFinite(newMax)) this.max = Math.max(1, newMax);
    this.updateCurrent(newValue);
  }

  updateCurrent(newValue) {
    this.val = Phaser.Math.Clamp(newValue, 0, this.max);
    const pct = this.val / this.max;
    this.fill.displayWidth = this.total * pct;
    this._layoutShield();
  }

  // Shield renders as a light-blue segment picking up right where the
  // normal fill ends, sized to shieldValue/max — combined width (fill +
  // shield) is clamped to the bar's total width so a full-HP unit with a
  // shield on top doesn't overflow the container.
  setShield(shieldValue) {
    this.shieldVal = Math.max(0, shieldValue | 0);
    this._layoutShield();
  }

  _layoutShield() {
    if (!this.shieldFill) return;
    const hpWidth = this.fill.displayWidth;
    const shieldWidth = Math.max(0, Math.min(this.total - hpWidth, this.total * (this.shieldVal / this.max)));
    this.shieldFill.x = -this.total / 2 + hpWidth;
    this.shieldFill.displayWidth = shieldWidth;
  }
}
