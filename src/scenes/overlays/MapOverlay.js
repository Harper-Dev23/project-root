// MapOverlay.js
// Overlay for displaying a world or town map

export default class MapOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'MapOverlay' });
  }

  create() {
    this.add.text(100, 100, "Map Overlay", { fontSize: '24px', fill: '#ffffff' });
    this.input.keyboard.once('keydown-ESC', () => this.scene.stop());
  }
}
