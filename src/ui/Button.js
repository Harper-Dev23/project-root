import { COLORS, FONTS, UI_DEPTH, BUTTON_STYLES } from './styles.js';
import { SoundManager } from '../systems/SoundManager.js';
import { drawButtonFace, isClassicSkin } from './buttonSkins.js';

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
  // The button skin (buttonSkins.js); classic is the drawing below.
  const variant = typeof style === 'string' ? style : 'primary';
  const skinned = !isClassicSkin();
  let skinText = null;

  const drawBg = (hover) => {
    if (skinned) { skinText = drawButtonFace(bg, bw, bh, { state: hover ? 'hover' : 'rest', variant }); return; }
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

  const restText = skinned ? skinText : cfg.textColor;
  const txt = scene.add.text(0, 0, label, {
    fontSize,
    fontFamily,
    color: restText,
    ...textStyle,
    color: restText, // keep theme color; callers use style arg to customize
  }).setOrigin(0.5);

  const container = scene.add.container(cx, cy, [bg, txt]);
  container.setSize(bw, bh);
  container.setInteractive({ useHandCursor: true })
    .on('pointerover', () => { drawBg(true);  txt.setStyle({ color: skinned ? skinText : cfg.hoverTextColor }); })
    .on('pointerout',  () => { drawBg(false); txt.setStyle({ color: skinned ? skinText : cfg.textColor }); })
    .on('pointerdown', () => { SoundManager.play('select'); callback(); });

  return container;
}

export default class UIButton extends Phaser.GameObjects.Container {
  constructor(scene, x, y, label, callback, width = 140, height = 40) {
    super(scene, x, y);

    this._isSelected = false;
    this._w = width; this._h = height;
    this._variant = 'primary';
    // The button skin (buttonSkins.js). Skinned, the face is drawn on
    // this.face and the old rectangle is kept, hidden, for callers that
    // still style it (harmless).
    this._skinned = !isClassicSkin();

    this.background = scene.add.rectangle(0, 0, width, height, 0x1c1c1c)
      .setOrigin(0.5)
      .setStrokeStyle(1.5, 0x6a7080);   // silver-gray border
    if (this._skinned) this.background.setVisible(false);
    this.face = scene.add.graphics();

    this.text = scene.add.text(0, 0, label, {
      ...FONTS.button,
      fontSize: '18px',
      color: '#b8bccf',               // silver text
      align: 'center',
      wordWrap: { width: width - 10 },
    }).setOrigin(0.5);

    this.add([this.background, this.face, this.text]);
    if (this._skinned) this._applyState();
    this.setSize(width, height);
    this.setInteractive({ useHandCursor: true });

    this.on('pointerover', () => {
      if (this._skinned) { if (!this._isSelected) this._paint('hover'); return; }
      if (!this._isSelected) {
        // Bright silver, not crimson — see BUTTON_STYLES.primary in styles.js
        // for why. Amber-gold below is the SELECTED state, so hover has to be
        // a different axis: the resting silver simply gets brighter.
        this.background.setFillStyle(0x2a2f3a);
        this.background.setStrokeStyle(1.5, 0xc8d0e4);
        this.text.setStyle({ color: '#ffffff' });
      }
    });
    this.on('pointerout', () => this._applyState());
    this.on('pointerup', () => { SoundManager.play('select'); callback(); });

    scene.add.existing(this);
  }

  /** Skinned: draw the face in a state and colour the text to match. */
  _paint(state) {
    const color = drawButtonFace(this.face, this._w, this._h, { state, variant: this._variant });
    if (color && this.text?.active) this.text.setStyle({ color });
  }

  /** 'primary' | 'danger' | 'confirm': the skinned face's colour family. */
  setVariant(variant) {
    this._variant = variant;
    this._applyState();
    return this;
  }

  _applyState() {
    if (this._skinned) { this._paint(this._isSelected ? 'selected' : 'rest'); return; }
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
