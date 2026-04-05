
import { DEPTH } from './styles.js';
import { createPanel } from './GamePanel.js';

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

    const Phaser = globalThis.Phaser;

    if (!Phaser) {
        throw new Error('Phaser global is not available. Ensure the Phaser script is loaded before using overlay helpers.');
    }

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
        .setDepth(depth);
    const closeRegions = [];

    const registerCloseZone = (x, y, width, height) => {
        if (width <= 0 || height <= 0) return;
        const zone = scene.add.zone(x, y, width, height)
            .setDepth(depth)
            .setInteractive({ useHandCursor: false });
        zone.on('pointerdown', close);
        closeRegions.push(zone);
    };

    // Create four blocker zones around the panel so clicks outside the panel
    // still dismiss the overlay without stealing events from the panel itself.
    registerCloseZone(gameWidth / 2, bounds.y / 2, gameWidth, bounds.y);
    registerCloseZone(
        gameWidth / 2,
        bounds.bottom + (gameHeight - bounds.bottom) / 2,
        gameWidth,
        gameHeight - bounds.bottom
    );
    registerCloseZone(bounds.x / 2, bounds.y + bounds.height / 2, bounds.x, bounds.height);
    registerCloseZone(
        bounds.right + (gameWidth - bounds.right) / 2,
        bounds.y + bounds.height / 2,
        gameWidth - bounds.right,
        bounds.height
    );

    const panel = createPanel(scene, bounds.x, bounds.y, width, height, 'default')
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

    return { bounds, dimmer, panel, titleText, closeButton, content, close, blockers: closeRegions, depth: depth + 2 };
}