import { COLORS, FONTS, UI_DEPTH } from './styles.js';

export default class UIButton extends Phaser.GameObjects.Container {
  constructor(scene, x, y, label, callback, width = 140, height = 40) {
    super(scene, x, y);

    this.background = scene.add.rectangle(0, 0, width, height, COLORS.buttonFill)
      .setOrigin(0.5)
      .setStrokeStyle(2, COLORS.border)
      .setDepth(UI_DEPTH.panel);

    this.text = scene.add.text(0, 0, label, {
      ...FONTS.button,
      fontSize: '20px',
      color: '#ffffff',
      align: 'center',
      wordWrap: { width: width - 10 },
    }).setOrigin(0.5);

    this.add([this.background, this.text]);
    this.setSize(width, height);
    this.setInteractive();

    this.isSelected = false; // track persistent state


    this.on('pointerover', () => this.background.setFillStyle(COLORS.buttonHover));
    this.on('pointerout', () => {
      if (!this.isSelected) {
        this.background.setFillStyle(COLORS.buttonFill);
      }
    });

    this.on('pointerup', () => callback());

    scene.add.existing(this);
  }
  setFill(color) {
    this.isSelected = (color === 0x88ff88); // green = selected
    this.background.setFillStyle(color);
  }

}


