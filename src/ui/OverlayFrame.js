
import { DEPTH, MENU_THEME } from './styles.js';
import { createPanel } from './GamePanel.js';
import { SoundManager } from '../systems/SoundManager.js';

// How many overlay frames are currently stacked open (e.g. HuntHubOverlay
// paused underneath while HuntMapOverlay is launched on top of it) — used
// so closing an INNER overlay doesn't re-enable TownScene/UIScene input
// while an OUTER one is still open. Only re-enable once this hits 0.
let _openOverlayCount = 0;

/**
 * Creates a standardized overlay frame with a dimmer, panel, title, and close button.
 * Returns references for bounds/depth so content scenes can align consistently.
 *
 * width/height default to the classic fixed 910x690 centered panel. Pass
 * `fullscreen: true` to span the whole screen instead (used by the
 * Character/Party/Inventory/Skills/Map/Quest/Tribes/Journal/Options
 * redesign) — this is opt-in per caller rather than a new shared default,
 * so the Hunt, Stash, LevelUp, and WaystoneShard overlays (which never
 * asked for it) aren't silently affected.
 *
 * `treatAsLocation: true` — for screens that are conceptually a PLACE the
 * player is standing at (e.g. the Sacred Hunt hub/map/plan-picker), not a
 * traditional modal menu: TownScene still gets blocked (you're not looking
 * at town anymore), but the persistent UIScene side panels stay enabled
 * AND visible (dimmer stays translucent instead of fully opaque) so the
 * player can still open Inventory/Character/Quest from here, and clicking
 * outside the panel does NOT close it.
 */
export function createOverlayFrame(scene, {
    title = '',
    width = 910,
    height = 690,
    fullscreen = false,
    treatAsLocation = false,
    onClose = () => scene.scene.stop(),
    depth = DEPTH.MENU,
    bgImage = null
} = {}) {
    const gameWidth = scene.scale.width;
    const gameHeight = scene.scale.height;
    if (fullscreen) {
        width = gameWidth;
        height = gameHeight;
    }

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

    // Block input to TownScene AND the persistent UIScene (side-panel/HUD
    // buttons) while this overlay is open — every overlay already disabled
    // TownScene's own input individually, but none disabled UIScene's, so
    // its buttons stayed clickable underneath (invisibly, but still live)
    // the whole time. Centralized here once instead of per-caller so it's
    // guaranteed rather than relying on each overlay to remember it.
    const townScene = scene.scene.get('TownScene');
    const uiScene = scene.scene.get('UIScene');
    if (townScene?.input) townScene.input.enabled = false;
    if (!treatAsLocation && uiScene?.input) uiScene.input.enabled = false;
    _openOverlayCount++;

    // Re-enable on the scene's actual 'shutdown' lifecycle event, NOT just
    // inside the close()/closeButton path below — several overlays close
    // themselves via their own internal logic that calls this.scene.stop()
    // directly (e.g. HuntMapOverlay._pickZone, InventoryOverlay._handleClose)
    // without ever going through the close() this function returns. Tying
    // it to 'shutdown' guarantees it fires no matter which path triggered
    // the stop, instead of leaving TownScene/UIScene input permanently
    // disabled whenever a caller bypasses close(). Gated on the stacked-open
    // count so closing an inner overlay (e.g. HuntMapOverlay, launched on
    // top of a merely-paused HuntHubOverlay) doesn't re-enable input while
    // the outer one is still open.
    scene.events.once('shutdown', () => {
        _openOverlayCount = Math.max(0, _openOverlayCount - 1);
        if (_openOverlayCount === 0) {
            if (townScene?.input) townScene.input.enabled = true;
            if (uiScene?.input) uiScene.input.enabled = true;
        }
    });

    const close = () => {
        if (typeof onClose === 'function') {
            onClose();
        } else {
            scene.scene.stop();
        }
    };

    // Fully opaque for normal modal menus — not just dimmed — so nothing
    // behind (TownScene, the side panels) shows through at all. A
    // treatAsLocation screen skips dimming entirely — it shouldn't affect
    // the look of the persistent side panels at all, same as TownScene
    // itself doesn't dim them.
    const dimmer = scene.add.rectangle(gameWidth / 2, gameHeight / 2, gameWidth, gameHeight, 0x000000, treatAsLocation ? 0 : 1)
        .setDepth(depth);
    const closeRegions = [];

    const registerCloseZone = (x, y, width, height) => {
        if (width <= 0 || height <= 0) return;
        const zone = scene.add.zone(x, y, width, height)
            .setDepth(depth)
            .setInteractive({ useHandCursor: false });
        zone.on('pointerdown', () => { SoundManager.play('handsClick'); close(); });
        closeRegions.push(zone);
    };

    // Create four blocker zones around the panel so clicks outside the panel
    // still dismiss the overlay without stealing events from the panel itself.
    // Skipped for treatAsLocation screens — clicking outside a "place" like
    // the Sacred Hunt hub shouldn't exit it, same as clicking away from a
    // building in TownScene doesn't do anything.
    if (!treatAsLocation) {
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
    }

    // Optional painted background image (e.g. parchment texture)
    if (bgImage && scene.textures.exists(bgImage)) {
        scene.add.image(bounds.x + width / 2, bounds.y + height / 2, bgImage)
            .setDisplaySize(width, height)
            .setDepth(depth + 1);
    }

    const panel = createPanel(scene, bounds.x, bounds.y, width, height,
        bgImage ? { fill: 0x000000, fillAlpha: 0, stroke: 0x5a4a3a, strokeWidth: 2, radius: 6, cornerSize: 0 } : 'silverMenu'
    ).setDepth(depth + 1);

    const titleStyle = {
        fontSize: '28px',
        color: MENU_THEME.titleColor,
        fontFamily: 'Georgia'
    };

    // depth + 3 — strictly above frame.content (depth + 2), so an overlay's
    // own content (e.g. JournalOverlay's custom view, which draws its own
    // full-bounds background) can never visually bury the close button.
    const titleText = title
        ? scene.add.text(centerX, bounds.y + 18, title, titleStyle)
            .setOrigin(0.5, 0)
            .setDepth(depth + 3)
        : null;

    const closeButton = scene.add.text(bounds.right - 18, bounds.y + 18, '✕', {
        fontSize: '24px',
        color: '#ff8888',
        fontFamily: 'Georgia'
    })
        .setOrigin(1, 0)
        .setInteractive({ useHandCursor: true })
        .setDepth(depth + 3);

    const closeWithSound = () => { SoundManager.play('handsClick'); close(); };
    closeButton.on('pointerdown', closeWithSound);

    // ESC key closes this overlay
    const onEsc = () => closeWithSound();
    scene.input.keyboard?.on('keydown-ESC', onEsc);
    // Clean up the listener when this scene shuts down so it doesn't stack
    scene.events.once('shutdown', () => scene.input.keyboard?.off('keydown-ESC', onEsc));

    const content = scene.add.container(0, 0).setDepth(depth + 2);

    return { bounds, dimmer, panel, titleText, closeButton, content, close, blockers: closeRegions, depth: depth + 2 };
}