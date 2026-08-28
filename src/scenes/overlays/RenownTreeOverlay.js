// RenownTreeOverlay.js
//
// Displays the renown web for one renown-capable item. DISPLAY ONLY: nothing
// here spends renown, allocates a node, or touches combat. The point is to see
// the shape of the system and judge the layout.
//
// The web is far larger than the screen (67 nodes over a ~3000x3600 design
// canvas), so it pans and zooms rather than fitting. Same interaction model as
// MapOverlay, which solves the same problem for the island map.
//
// Arm lighting: an item enters the web at its own origin's node. Its own arm
// and the shared middle are lit; every OTHER origin's arm is dimmed, because
// per the design those arms are one-way and unreachable from elsewhere.

import { RENOWN_TREE, ORIGIN_START } from '../../../data/renownTree.js';
import { RENOWN_ORIGINS } from '../../systems/ItemFactory.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { MENU_THEME } from '../../ui/styles.js';

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.4;
const NODE_R = 13;

// Per-arm accent, so the origins read as distinct territories at a glance.
const ARM_COLORS = {
  bone: 0xd8d2c0,
  severed: 0xc08ad0,
  soulbound: 0x8ab4d8,
  prophet: 0xe0c46a,
  falsegod: 0xd06a6a,
  undetermined: 0x9aa0a8,
  shared: 0xb0b4bc,
  orphan: 0x707680,
};

export default class RenownTreeOverlay extends Phaser.Scene {
  constructor() { super({ key: 'RenownTreeOverlay' }); }

  init(data) {
    this._item = data?.item || null;
    this._originId = this._item?.renownOrigin || null;
  }

  create() {
    const W = this.scale.width, H = this.scale.height;
    setupSceneCursor(this);

    const originLabel = RENOWN_ORIGINS[this._originId]?.label || 'Unknown';
    const itemName = this._item?.displayName || 'Item';

    this._frame = createOverlayFrame(this, {
      title: `Renown — ${itemName}`,
      fullscreen: true,
      onClose: () => this._close(),
    });

    // ---- viewport ---------------------------------------------------------
    // Everything pannable lives in this container; the frame/HUD do not.
    const padTop = 96, padBottom = 64;
    this._view = { x: W / 2, y: (padTop + (H - padBottom)) / 2, zoom: 0.8 };
    // Above DEPTH.MENU (2000) - createOverlayFrame paints its full-screen
    // panel at that depth, so anything below it is simply covered.
    this._world = this.add.container(0, 0).setDepth(2010);

    const maskShape = this.make.graphics({ add: false });
    maskShape.fillStyle(0xffffff).fillRect(20, padTop, W - 40, H - padTop - padBottom);
    this._world.setMask(maskShape.createGeometryMask());

    this._edgeGfx = this.add.graphics();
    this._world.add(this._edgeGfx);
    this._nodeObjs = [];

    this._buildNodes();
    this._layout();

    // ---- input ------------------------------------------------------------
    // A full-screen zone under the HUD captures drag/wheel without stealing
    // clicks from the frame's own close button.
    const zone = this.add.zone(20, padTop, W - 40, H - padTop - padBottom)
      .setOrigin(0, 0).setInteractive({ draggable: true }).setDepth(2005);

    let dragging = false, lastX = 0, lastY = 0;
    zone.on('pointerdown', (p) => { dragging = true; lastX = p.x; lastY = p.y; });
    this.input.on('pointerup', () => { dragging = false; });
    this.input.on('pointermove', (p) => {
      if (!dragging) return;
      this._view.x += p.x - lastX;
      this._view.y += p.y - lastY;
      lastX = p.x; lastY = p.y;
      this._layout();
    });
    this.input.on('wheel', (_p, _o, _dx, dy) => {
      const prev = this._view.zoom;
      const next = Phaser.Math.Clamp(prev * (dy > 0 ? 0.9 : 1.1), MIN_ZOOM, MAX_ZOOM);
      if (next === prev) return;
      this._view.zoom = next;
      this._layout();
    });

    // ---- HUD --------------------------------------------------------------
    this.add.text(W / 2, 62,
      `Origin: ${originLabel}   ·   Renown ${this._item?.renown ?? 0} / ${this._item?.renownMax ?? 0}`,
      { fontSize: '15px', color: '#c8ccd4', fontFamily: 'Georgia, Gelasio, serif' }
    ).setOrigin(0.5, 0).setDepth(2020);

    this.add.text(W / 2, H - 44,
      'Drag to pan  ·  Scroll to zoom  ·  Nothing is allocatable yet — this is a preview of the system',
      { fontSize: '12px', color: '#6f7681' }
    ).setOrigin(0.5, 0).setDepth(2020);

    this._tip = this.add.text(0, 0, '', {
      fontSize: '13px', color: '#f0f0f0', backgroundColor: '#12141a',
      padding: { x: 8, y: 6 }, wordWrap: { width: 320 },
    }).setDepth(2300).setVisible(false);

    this.input.keyboard?.on('keydown-ESC', () => this._close());
    this._centreOnStart();
  }

  /** Is this node reachable for the item being inspected? */
  _isLit(node) {
    if (!this._originId) return true;
    if (node.arm === 'shared' || node.arm === 'orphan') return true;
    return node.arm === this._originId;
  }

  _buildNodes() {
    RENOWN_TREE.nodes.forEach((n, i) => {
      const lit = this._isLit(n);
      const base = ARM_COLORS[n.arm] ?? ARM_COLORS.shared;
      const isStart = !!n.start;

      const circle = this.add.circle(0, 0, isStart ? NODE_R + 4 : NODE_R, 0x14161c, 1)
        .setStrokeStyle(isStart ? 3 : 2, base, lit ? 1 : 0.22)
        .setInteractive({ useHandCursor: true });
      if (!lit) circle.setAlpha(0.4);

      // Placeholder nodes from the drawing get a hollow, dashed-feeling look
      // so it's obvious at a glance which parts are designed and which aren't.
      if (n.placeholder) circle.setFillStyle(0x14161c, 0.35);

      const label = this.add.text(0, 0, n.label || '', {
        fontSize: isStart ? '13px' : '11px',
        color: lit ? (isStart ? '#ffffff' : '#c2c7cf') : '#5a606a',
        fontStyle: isStart ? 'bold' : 'normal',
        align: 'center', wordWrap: { width: 130 },
      }).setOrigin(0.5, 0);

      circle.on('pointerover', () => {
        circle.setStrokeStyle(isStart ? 4 : 3, 0xffffaa, 1);
        this._showTip(n, circle);
      });
      circle.on('pointerout', () => {
        circle.setStrokeStyle(isStart ? 3 : 2, base, lit ? 1 : 0.22);
        this._tip.setVisible(false);
      });

      this._world.add([circle, label]);
      this._nodeObjs.push({ n, i, circle, label, lit });
    });
  }

  _showTip(n, at) {
    const lines = [];
    lines.push(n.label || '(undesigned node)');
    lines.push('');
    lines.push(n.start ? `Starting place — ${RENOWN_ORIGINS[n.start]?.label || n.start}`
      : `Branch: ${n.arm === 'shared' ? 'shared web' : n.arm}`);
    if (n.flavour) lines.push(`"${n.flavour}"`);
    if (n.note) lines.push(n.note);
    if (!this._isLit(n)) lines.push('\nUnreachable from this item\'s origin.');
    if (n.placeholder) lines.push('\nNot yet designed.');
    this._tip.setText(lines.join('\n'))
      .setPosition(Phaser.Math.Clamp(at.x + 20, 10, this.scale.width - 340),
                   Phaser.Math.Clamp(at.y + 14, 10, this.scale.height - 140))
      .setVisible(true);
  }

  /** Normalised tree coords -> screen, honouring pan/zoom. */
  _toScreen(n) {
    const S = 1400 * this._view.zoom;          // design-space span in px at 1x
    return {
      x: this._view.x + (n.x - 0.5) * S,
      y: this._view.y + (n.y - 0.5) * S * 1.15,
    };
  }

  _layout() {
    const z = this._view.zoom;
    this._edgeGfx.clear();

    RENOWN_TREE.edges.forEach(([a, b]) => {
      const na = RENOWN_TREE.nodes[a], nb = RENOWN_TREE.nodes[b];
      if (!na || !nb) return;
      const pa = this._toScreen(na), pb = this._toScreen(nb);
      const bothLit = this._isLit(na) && this._isLit(nb);
      this._edgeGfx.lineStyle(bothLit ? 1.5 : 1,
        bothLit ? 0x6d7480 : 0x33383f, bothLit ? 0.85 : 0.3);
      this._edgeGfx.beginPath();
      this._edgeGfx.moveTo(pa.x, pa.y);
      this._edgeGfx.lineTo(pb.x, pb.y);
      this._edgeGfx.strokePath();
    });

    this._nodeObjs.forEach(({ n, circle, label }) => {
      const p = this._toScreen(n);
      circle.setPosition(p.x, p.y).setScale(Phaser.Math.Clamp(z, 0.6, 1.4));
      label.setPosition(p.x, p.y + NODE_R * 1.6);
      // Label policy, tuned against the real web: at 67 nodes the labels
      // overlap into soup at the default zoom, so only the START anchors are
      // always named. Everything else appears once you zoom in far enough to
      // have room, and unreachable arms stay unlabelled entirely - they're
      // context, not content. Hovering any node gives the full text regardless.
      const named = !!n.start || (this._isLit(n) && z >= 1.05);
      label.setVisible(named).setScale(Phaser.Math.Clamp(z, 0.8, 1.15));
    });
  }

  _centreOnStart() {
    const startId = ORIGIN_START[this._originId];
    const idx = RENOWN_TREE.nodes.findIndex(n => n.id === startId);
    if (idx < 0) return;
    const n = RENOWN_TREE.nodes[idx];
    const S = 1400 * this._view.zoom;
    const H = this.scale.height;
    this._view.x = this.scale.width / 2 - (n.x - 0.5) * S;
    this._view.y = (96 + (H - 64)) / 2 - (n.y - 0.5) * S * 1.15;
    this._layout();
  }

  _close() {
    SoundManager.play('select');
    this.scene.stop();
  }
}
