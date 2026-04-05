import { COLORS, FONTS, UI_DEPTH, BUTTON_STYLES } from './styles.js';

// ---------------------------------------------------------------------------
// createButton — factory for themed, interactive buttons
// Returns a Phaser.GameObjects.Container (setDepth, destroy, setPosition all work)
// ---------------------------------------------------------------------------
export function createButton(scene, cx, cy, label, callback, style = 'primary', textStyle = {}) {
  const cfg = typeof style === 'string'
    ? { ...(BUTTON_STYLES[style] ?? BUTTON_STYLES.primary) }
    : { ...BUTTON_STYLES.primary, ...style };

  const fontSize   = textStyle.fontSize   ?? '18px';
  const fontFamily = textStyle.fontFamily ?? 'Georgia';

  // Auto-size from text dimensions
  const probe = scene.add.text(0, -9999, label, { fontSize, fontFamily });
  const bw = Math.max(probe.width  + cfg.padX * 2, 80);
  const bh = Math.max(probe.height + cfg.padY * 2, 32);
  probe.destroy();

  const bg = scene.add.graphics();

  const drawBg = (hover) => {
    bg.clear();
    const fill   = hover ? cfg.hoverFill   : cfg.fill;
    const stroke = hover ? cfg.hoverStroke : cfg.stroke;
    const cc     = hover ? (cfg.hoverCornerColor ?? cfg.cornerColor) : cfg.cornerColor;
    const { fillAlpha, strokeWidth, radius, cornerSize, cornerAlpha } = cfg;

    bg.fillStyle(fill, fillAlpha);
    bg.fillRoundedRect(-bw / 2, -bh / 2, bw, bh, radius);

    if (strokeWidth > 0) {
      bg.lineStyle(strokeWidth, stroke, 1);
      bg.strokeRoundedRect(-bw / 2, -bh / 2, bw, bh, radius);
    }

    if (cornerSize > 0) {
      const s = cornerSize;
      const d = 2.5;
      const lw = strokeWidth + 0.5;
      const inset = radius * 0.5;
      bg.lineStyle(lw, cc, cornerAlpha);
      bg.fillStyle(cc, cornerAlpha);

      const drawCorner = (ox, oy, hDir, vDir) => {
        bg.beginPath();
        bg.moveTo(ox + hDir * s, oy);
        bg.lineTo(ox, oy);
        bg.lineTo(ox, oy + vDir * s);
        bg.strokePath();
        bg.beginPath();
        bg.moveTo(ox,            oy - d * vDir);
        bg.lineTo(ox + d * hDir, oy);
        bg.lineTo(ox,            oy + d * vDir);
        bg.lineTo(ox - d * hDir, oy);
        bg.closePath();
        bg.fillPath();
      };

      drawCorner(-bw / 2 + inset, -bh / 2 + inset,  1,  1);
      drawCorner( bw / 2 - inset, -bh / 2 + inset, -1,  1);
      drawCorner(-bw / 2 + inset,  bh / 2 - inset,  1, -1);
      drawCorner( bw / 2 - inset,  bh / 2 - inset, -1, -1);
    }
  };

  drawBg(false);

  const txt = scene.add.text(0, 0, label, {
    fontSize,
    fontFamily,
    color: cfg.textColor,
    ...textStyle,
    color: cfg.textColor, // keep theme color; callers use style arg to customize
  }).setOrigin(0.5);

  const container = scene.add.container(cx, cy, [bg, txt]);
  container.setSize(bw, bh);
  container.setInteractive({ useHandCursor: true })
    .on('pointerover', () => { drawBg(true);  txt.setStyle({ color: cfg.hoverTextColor }); })
    .on('pointerout',  () => { drawBg(false); txt.setStyle({ color: cfg.textColor }); })
    .on('pointerdown', callback);

  return container;
}

export default class UIButton extends Phaser.GameObjects.Container {
  constructor(scene, x, y, label, callback, width = 140, height = 40) {
    super(scene, x, y);

    this._isSelected = false;

    this.background = scene.add.rectangle(0, 0, width, height, 0x1c1c1c)
      .setOrigin(0.5)
      .setStrokeStyle(1.5, 0x6a7080);   // silver-gray border

    this.text = scene.add.text(0, 0, label, {
      ...FONTS.button,
      fontSize: '18px',
      color: '#b8bccf',               // silver text
      align: 'center',
      wordWrap: { width: width - 10 },
    }).setOrigin(0.5);

    this.add([this.background, this.text]);
    this.setSize(width, height);
    this.setInteractive({ useHandCursor: true });

    this.on('pointerover', () => {
      if (!this._isSelected) {
        this.background.setFillStyle(0x280d0d);       // dark crimson
        this.background.setStrokeStyle(1.5, 0xaa2222); // crimson border
        this.text.setStyle({ color: '#ff9999' });
      }
    });
    this.on('pointerout', () => this._applyState());
    this.on('pointerup', () => callback());

    scene.add.existing(this);
  }

  _applyState() {
    if (this._isSelected) {
      this.background.setFillStyle(0x1a1200);
      this.background.setStrokeStyle(1.5, 0xb8922a);  // amber-gold = active selection
      this.text.setStyle({ color: '#f0c060' });
    } else {
      this.background.setFillStyle(0x1c1c1c);
      this.background.setStrokeStyle(1.5, 0x6a7080);
      this.text.setStyle({ color: '#b8bccf' });
    }
  }

  // Called by CharacterCreationScene.updateButtonHighlights()
  // Legacy: 0x88ff88 = selected, anything else = deselected
  setFill(color) {
    this._isSelected = (color === 0x88ff88);
    this._applyState();
  }
}


