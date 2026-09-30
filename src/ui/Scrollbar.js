// @ts-nocheck
/**
 * Scrollbar.js — a thin, draggable scrollbar for any scrolling panel.
 *
 * Written because two overlays needed one and their scroll models are
 * completely different: SkillsOverlay tracks a scalar `scrollY` against a
 * `scrollMax` and moves one content container, while InventoryOverlay clamps
 * two independent list containers by their own `y`. Rather than reimplement
 * the widget twice against those two shapes, this takes ACCESSORS — the caller
 * says how to read and write its own scroll position, and keeps its model.
 *
 * Usage:
 *   const bar = createScrollbar(scene, {
 *     x, y, height,                 // where the track sits
 *     getScroll: () => this.scrollY,
 *     getMax:    () => this.scrollMax,
 *     setScroll: (v) => this._setScroll(v),
 *     viewRatio: () => visibleH / contentH,   // optional, sizes the thumb
 *     parent: someContainer,        // optional; added here instead of the scene
 *   });
 *   bar.refresh();   // after content changes
 *   bar.destroy();
 *
 * The track hides itself when there is nothing to scroll, so a short list does
 * not get a decorative bar implying otherwise.
 */

const TRACK_W = 8;
const MIN_THUMB = 22;
const COL_TRACK = 0x000000;
const COL_THUMB = 0x6a6152;
const COL_THUMB_HOVER = 0x968c7c;

export function createScrollbar(scene, opts = {}) {
  const {
    x = 0, y = 0, height = 100,
    getScroll = () => 0,
    getMax = () => 0,
    setScroll = () => { },
    viewRatio = null,
    parent = null,
    depth = null,
  } = opts;

  const track = scene.add.graphics();
  const thumb = scene.add.graphics();
  // Wider than the visible thumb so it stays comfortable to grab.
  const zone = scene.add.zone(x + TRACK_W / 2, y, TRACK_W + 10, height)
    .setOrigin(0.5, 0)
    .setInteractive({ useHandCursor: true, draggable: true });

  if (depth != null) { track.setDepth(depth); thumb.setDepth(depth); zone.setDepth(depth); }
  if (parent) parent.add([track, thumb, zone]); else { /* scene-level is fine */ }

  let hovered = false;
  let thumbH = MIN_THUMB;

  // Phaser clears a game object's `scene` when it is destroyed, and a scene's
  // whole display list is destroyed when the scene shuts down. A caller that
  // keeps this widget on `this` -- and Phaser REUSES scene instances, so every
  // overlay does -- can therefore be holding a scrollbar whose parts are dead.
  const alive = () => !!zone.scene;

  function refresh() {
    // A dead scrollbar does nothing, rather than crash. Refreshing one used to
    // reach setInteractive, which reads `this.scene.sys` and threw
    // "Cannot read properties of undefined (reading 'sys')" -- the Skills
    // overlay did exactly that on every second opening. Checked BEFORE the
    // graphics are touched too, since they are destroyed along with the Zone.
    if (!alive()) return;
    const max = Math.max(0, getMax() || 0);
    track.clear();
    thumb.clear();

    // Nothing to scroll — hide the whole widget rather than draw a dead rail.
    if (max <= 0) {
      zone.disableInteractive();
      return;
    }
    if (!zone.input?.enabled) zone.setInteractive({ useHandCursor: true, draggable: true });

    track.fillStyle(COL_TRACK, 0.28);
    track.fillRoundedRect(x, y, TRACK_W, height, TRACK_W / 2);

    // Thumb length is the visible fraction of the content when the caller can
    // tell us, otherwise a fixed proportion — either way clamped so it stays
    // grabbable on a very long list.
    const ratio = viewRatio ? Math.max(0.05, Math.min(1, viewRatio())) : 0.25;
    thumbH = Math.max(MIN_THUMB, Math.round(height * ratio));
    const usable = Math.max(1, height - thumbH);
    const pos = Math.min(1, Math.max(0, (getScroll() || 0) / max));

    thumb.fillStyle(hovered ? COL_THUMB_HOVER : COL_THUMB, 1);
    thumb.fillRoundedRect(x, y + pos * usable, TRACK_W, thumbH, TRACK_W / 2);
  }

  // Where on the thumb the pointer took hold. Grabbing the thumb keeps that
  // point under the cursor while dragging; clicking the bare track jumps the
  // thumb's centre there (owner's notes, 2026-09-29: every grab snapped the
  // thumb to its centre, or to the top, and dragging felt stuck).
  let grab = null;
  const thumbTop = () => {
    const max = Math.max(0, getMax() || 0);
    const usable = Math.max(1, height - thumbH);
    return y + (max > 0 ? Math.min(1, Math.max(0, (getScroll() || 0) / max)) : 0) * usable;
  };
  const toScroll = (pointerY) => {
    const max = Math.max(0, getMax() || 0);
    if (max <= 0) return;
    const usable = Math.max(1, height - thumbH);
    const local = Phaser.Math.Clamp(pointerY - y - (grab ?? thumbH / 2), 0, usable);
    setScroll((local / usable) * max);
    refresh();
  };

  zone.on('pointerover', () => { hovered = true; refresh(); });
  zone.on('pointerout', () => { hovered = false; refresh(); });
  // The POINTER's y, not the drag event's dragY: that is where the dragged
  // object would move to, and this zone never moves, so it read as the top of
  // the track and threw the thumb there.
  zone.on('drag', (p) => toScroll(p.worldY));
  zone.on('pointerdown', (p) => {
    const top = thumbTop();
    const onThumb = p.worldY >= top && p.worldY <= top + thumbH;
    grab = onThumb ? p.worldY - top : thumbH / 2;
    if (!onThumb) toScroll(p.worldY);
  });
  zone.on('dragend', () => { grab = null; });
  // An interrupted drag (mouse released off-canvas, or the list rebuilding
  // underneath) can otherwise leave the zone dead for the rest of the scene.
  zone.on('dragend', () => {
    if (!alive()) return;
    if (!zone.input?.enabled) zone.setInteractive({ useHandCursor: true, draggable: true });
  });

  refresh();

  return {
    refresh,
    destroy() {
      try { track.destroy(); thumb.destroy(); zone.destroy(); } catch { }
    },
    setVisible(v) { track.setVisible(v); thumb.setVisible(v); zone.setVisible(v); },
  };
}
