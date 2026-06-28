// src/scenes/overlays/HuntHubOverlay.js
// The persistent Hunt screen — launched from TownScene's Exit Gate and kept
// open (paused, not stopped) while sub-screens like the location picker or
// an encounter investigation are shown on top of it.
//
// Deliberately launched WITHOUT bringing itself above UIScene — TownScene
// stays input-disabled underneath, but UIScene's frame, right panel, toggle
// button, and bottom dialogue bar all stay visible and clickable above this,
// so the player can check inventory/HP mid-hunt.
//
// Phases (derived from state, not tracked separately, so they can't drift):
//   'pick'    — no zone chosen yet
//   'loadout' — zone chosen, supplies/Hunt Plan being configured, not departed
//   'hunting' — HuntManager is active

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createButton } from '../../ui/Button.js';
import { createPanel } from '../../ui/GamePanel.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { HuntManager } from '../../systems/HuntManager.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import { getZone } from '../../../data/zones.js';

const BASE_SUPPLIES          = 40;
const SUPPLIES_PER_TICKET    = 10;
const MAX_TICKETS_SPENDABLE  = 10;
const LOG_LINES_SHOWN        = 10;

export default class HuntHubOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntHubOverlay' });
  }

  init() {
    this.zoneId = null;
    this.ticketsToSpend = 0;
  }

  create() {
    const town = this.scene.get('TownScene');
    setupSceneCursor(this);
    if (town?.input) town.input.enabled = false;

    const frame = createOverlayFrame(this, {
      title: 'The Sacred Hunt',
      onClose: () => this._close(),
      bgImage: 'menu_parchment_background',
    });

    this._depth = frame.depth;
    this._bounds = frame.bounds;

    this.events.on('resume', () => this._render());
    this._render();
  }

  setZone(zoneId) {
    this.zoneId = zoneId;
    this._render();
  }

  // ── Render dispatch ──────────────────────────────────────────────────────

  _render() {
    if (this._content) this._content.destroy(true);
    this._content = this.add.container(0, 0).setDepth(this._depth);

    if (HuntManager.isActive()) {
      this._renderHunting();
    } else if (this.zoneId) {
      this._renderLoadout();
    } else {
      this._renderPick();
    }
  }

  _text(x, y, str, style) {
    const t = this.add.text(x, y, str, style);
    this._content.add(t);
    return t;
  }

  _button(x, y, label, cb, style = 'primary') {
    const b = createButton(this, x, y, label, cb, style);
    this._content.add(b);
    return b;
  }

  // ── Phase: no zone chosen ────────────────────────────────────────────────

  _renderPick() {
    const { x, y, width } = this._bounds;
    const left = x + 40;

    this._text(left, y + 80, 'No location chosen.', { fontSize: '18px', color: '#ffffaa', fontStyle: 'bold' });
    this._text(left, y + 116, `Hunt Tickets: ${ProgressionManager.huntTickets}`, { fontSize: '15px', color: '#cccccc' });
    this._text(left, y + 142, `Hunt Points (total): ${ProgressionManager.huntPoints}`, { fontSize: '15px', color: '#88ddff' });

    this._text(left, y + 190,
      'Choose a location to begin planning your hunt. You will be able to set\nsupplies and any Hunt Plan before departing.',
      { fontSize: '14px', color: '#999999', wordWrap: { width: width - 80 } }
    );

    this._button(x + width / 2, y + 280, 'Choose Location', () => this._openMap(), 'confirm');
  }

  // ── Phase: zone chosen, configuring loadout ─────────────────────────────

  _renderLoadout() {
    const zone = getZone(this.zoneId);
    const { x, y, width, bottom } = this._bounds;
    const left = x + 40;

    this._text(left, y + 64, zone.name, { fontSize: '20px', color: '#ffdd88', fontFamily: 'Georgia' });
    this._text(left, y + 92, zone.flavor, { fontSize: '14px', color: '#cccccc', wordWrap: { width: width - 80 } });
    this._button(x + width - 140, y + 64, 'Change Location', () => this._openMap(), 'danger');

    // ── Supplies ───────────────────────────────────────────────────────
    const suppliesY = y + 150;
    this._text(left, suppliesY, 'Supplies', { fontSize: '18px', color: '#ffffaa', fontStyle: 'bold' });

    const supplies = BASE_SUPPLIES + this.ticketsToSpend * SUPPLIES_PER_TICKET;
    this._suppliesText = this._text(left, suppliesY + 30,
      `${supplies} supplies (Base ${BASE_SUPPLIES} + ${this.ticketsToSpend} Hunt Ticket${this.ticketsToSpend === 1 ? '' : 's'} × ${SUPPLIES_PER_TICKET})`,
      { fontSize: '15px', color: '#d0d0d0' }
    );
    this._ticketsText = this._text(left, suppliesY + 56,
      `Hunt Tickets available: ${ProgressionManager.huntTickets - this.ticketsToSpend} / ${ProgressionManager.huntTickets}`,
      { fontSize: '13px', color: '#999999' }
    );

    this._button(left + 280, suppliesY + 32, '−', () => this._adjustTickets(-1));
    this._button(left + 330, suppliesY + 32, '+', () => this._adjustTickets(1));

    // ── Hunt Plan + modifiers (stub) ─────────────────────────────────────
    const planY = suppliesY + 110;
    this._text(left, planY, 'Hunt Plan', { fontSize: '18px', color: '#ffffaa', fontStyle: 'bold' });
    this._text(left, planY + 30, 'None — no Hunt Plan items yet.', { fontSize: '14px', color: '#999999' });

    const modY = planY + 64;
    const modPanel = createPanel(this, left, modY, width - 80, 90, 'slot');
    this._content.add(modPanel);
    this._text(left + 16, modY + 10, 'Active Modifiers', { fontSize: '14px', color: '#ffdd88', fontStyle: 'bold' });
    this._text(left + 16, modY + 36,
      'Zone: none  ·  Hunt Plan: none  ·  Items: none',
      { fontSize: '13px', color: '#999999' }
    );

    this._button(x + width / 2, bottom - 50, 'Depart', () => this._depart(), 'confirm');
  }

  _adjustTickets(delta) {
    const maxAffordable = Math.min(MAX_TICKETS_SPENDABLE, ProgressionManager.huntTickets);
    this.ticketsToSpend = Phaser.Math.Clamp(this.ticketsToSpend + delta, 0, maxAffordable);
    SoundManager.play('select');
    this._render();
  }

  _depart() {
    SoundManager.play('select');
    const supplies = BASE_SUPPLIES + this.ticketsToSpend * SUPPLIES_PER_TICKET;
    ProgressionManager.huntTickets -= this.ticketsToSpend;
    HuntManager.start(this.zoneId, { supplies });
    this._render();
  }

  // ── Phase: actively hunting ──────────────────────────────────────────────

  _renderHunting() {
    const state = HuntManager.getState();
    const zone = getZone(state.zoneId);
    const { x, y, width, bottom } = this._bounds;
    const left = x + 40;

    this._text(left, y + 60, zone.name, { fontSize: '20px', color: '#ffdd88', fontFamily: 'Georgia' });

    // Supply bar
    const barY = y + 96;
    const barW = width - 80;
    const pct = state.maxSupplies > 0 ? state.supplies / state.maxSupplies : 0;
    const barBg = this.add.rectangle(left, barY, barW, 16, 0x222222).setOrigin(0, 0.5);
    const barFill = this.add.rectangle(left, barY, barW * pct, 16, pct > 0.3 ? 0x44aa66 : 0xaa4444).setOrigin(0, 0.5);
    this._content.add(barBg);
    this._content.add(barFill);
    this._text(left, barY - 22, `Supplies: ${state.supplies} / ${state.maxSupplies}`, { fontSize: '13px', color: '#cccccc' });

    this._text(left, barY + 18, `Day ${state.day} — ${state.isNight ? 'Night' : 'Day'}  ·  Depth ${state.depth}`, { fontSize: '15px', color: '#ffffaa' });
    this._text(left, barY + 42, `Hunt Points this trip: ${state.sessionHuntPoints}  ·  Total: ${ProgressionManager.huntPoints}`, { fontSize: '13px', color: '#88ddff' });

    // ── Log ──────────────────────────────────────────────────────────────
    const logY = barY + 76;
    const logH = bottom - logY - 70;
    const logPanel = createPanel(this, left, logY, width - 80, logH, 'default');
    this._content.add(logPanel);

    if (state.pendingEncounter) {
      this._text(left + 16, logY + 16, 'Something stirs nearby — its nature is unclear.', { fontSize: '15px', color: '#ffaa88' });
      this._button(left + (width - 80) / 2, logY + logH - 36, 'Investigate', () => this._investigate(), 'confirm');
    } else if (state.log.length > 0) {
      const lines = state.log.slice(-LOG_LINES_SHOWN).map(e => `• ${e.label}  (+${e.huntPoints} Hunt Points)`);
      this._text(left + 16, logY + 16, lines.join('\n'), { fontSize: '14px', color: '#d0d0d0', wordWrap: { width: width - 112 } });
    } else {
      this._text(left + 16, logY + 16, 'The hunt has just begun.', { fontSize: '14px', color: '#999999' });
    }

    // ── Controls ─────────────────────────────────────────────────────────
    const canAdvance = !state.pendingEncounter && state.supplies > 0;
    const advanceBtn = this._button(x + width / 2 - 90, bottom - 30, 'Advance', () => this._advance(), canAdvance ? 'primary' : 'danger');
    if (!canAdvance) advanceBtn.disableInteractive().setAlpha(0.4);

    const canReturn = !state.pendingEncounter;
    const returnBtn = this._button(x + width / 2 + 90, bottom - 30, 'Return to Camp', () => this._returnToCamp(), 'danger');
    if (!canReturn) returnBtn.disableInteractive().setAlpha(0.4);
  }

  _advance() {
    SoundManager.play('select');
    HuntManager.advance();
    this._render();
  }

  _investigate() {
    this.scene.pause();
    this.scene.launch('HuntEncounterOverlay', { encounter: HuntManager.getState().pendingEncounter });
    this.scene.bringToTop('HuntEncounterOverlay');
  }

  /** Called by HuntEncounterOverlay after the player resolves the pending encounter. */
  onEncounterResolved() {
    HuntManager.resolveEncounter();
    this._render();
  }

  _returnToCamp() {
    SoundManager.play('select');
    const summary = HuntManager.getState();
    HuntManager.end();
    this.zoneId = null;
    this.ticketsToSpend = 0;
    this.scene.get('UIScene')?.showDialogue(
      `You return to Camp Nehemiah.\nHunt Points earned this trip: ${summary.sessionHuntPoints}`
    );
    this._close();
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  _openMap() {
    this.scene.pause();
    this.scene.launch('HuntMapOverlay');
    this.scene.bringToTop('HuntMapOverlay');
  }

  _close() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.stop();
  }
}
