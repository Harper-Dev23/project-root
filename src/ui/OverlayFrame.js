import Phaser from 'phaser';
import { DEPTH } from './styles.js';

/**
 * Creates a standardized overlay frame with a dimmer, panel, title, and close button.
 * Returns references for bounds/depth so content scenes can align consistently.
 */
export function createOverlayFrame(scene, {
  title = '',
  width = 910,
  height = 690,
  onClose = () => scene.scene.stop(),
  depth = DEPTH.MENU
} = {}) {
  const gameWidth = scene.scale.width;
  const gameHeight = scene.scale.height;

  const bounds = new Phaser.Geom.Rectangle(
    (gameWidth - width) / 2,
    (gameHeight - height) / 2,
    width,
    height
  );
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  const close = () => {
    if (typeof onClose === 'function') {
      onClose();
    } else {
      scene.scene.stop();
    }
  };

  const dimmer = scene.add.rectangle(gameWidth / 2, gameHeight / 2, gameWidth, gameHeight, 0x000000, 0.6)
    .setInteractive()
    .setDepth(depth);
  dimmer.on('pointerdown', (pointer) => {
    if (!Phaser.Geom.Rectangle.Contains(bounds, pointer.x, pointer.y)) {
      close();
    }
  });

  const panel = scene.add.rectangle(centerX, centerY, width, height, 0x111111, 0.95)
    .setStrokeStyle(3, 0xffffff)
    .setDepth(depth + 1);

  const titleStyle = {
    fontSize: '28px',
    color: '#ffddaa',
    fontFamily: 'Georgia'
  };

  const titleText = title
    ? scene.add.text(centerX, bounds.y + 18, title, titleStyle)
      .setOrigin(0.5, 0)
      .setDepth(depth + 2)
    : null;

  const closeButton = scene.add.text(bounds.right - 18, bounds.y + 18, '✕', {
    fontSize: '24px',
    color: '#ff8888',
    fontFamily: 'Georgia'
  })
    .setOrigin(1, 0)
    .setInteractive({ useHandCursor: true })
    .setDepth(depth + 2);
  closeButton.on('pointerdown', close);

  const content = scene.add.container(0, 0).setDepth(depth + 2);

  return { bounds, dimmer, panel, titleText, closeButton, content, close, depth: depth + 2 };
}