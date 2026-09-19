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
//
// A hunt is saved, so every action that changes it autosaves straight after:
// departing, advancing, and resolving an event. A reload then lands the
// player back in the hunt exactly where they were (see HuntManager.js).
//
// Supplies are Rations, a stackable item in the camp bag. Hunt Tickets buy
// them here; the loadout packs some on top of the camp's free issue, and the
// packed ones are at risk in the hunt pack. What is left of them comes home on
// a clean exit (HuntManager.js, the hunt pack).

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createButton } from '../../ui/Button.js';
import { createPanel } from '../../ui/GamePanel.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { HuntManager, CAMP_ISSUE, zoneDeathRule } from '../../systems/HuntManager.js';
import { InventorySystem } from '../../systems/InventorySystem.js';
import { countInList, takeFromList, makeStack } from '../../systems/ItemStacks.js';
import { Items } from '../../../data/items.js';
import { describeModifiers, describeLoadout } from '../../systems/HuntModifiers.js';
import { describePlanHeader, makeBasicPlan, isBasicPlan } from '../../systems/HuntPlans.js';
import { getItemComputedData } from '../../systems/ItemFactory.js';
import { RARITY_COLORS } from '../../ui/styles.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import GameState from '../../systems/GameState.js';
import { getZone } from '../../../data/zones.js';

// The camp's free issue (CAMP_ISSUE, 60) is ~2.5 day/night cycles at the
// default drain rate. Packing is capped where ticket spending used to be:
// 10 tickets x 10 supplies then, 100 rations now.
const RATIONS_PER_TICKET     = 10;
const MAX_RATIONS_PACKED     = 100;
const PACK_STEP              = 10;
const LOG_LINES_SHOWN        = 10;

// Shown before departure, never a surprise (DEATH_AND_REVIVAL).
const DEATH_RULE_TEXT = {
  sheltered: 'Sheltered: a wipe loses nothing in your pack.',
  watched:   'Watched: a wipe loses everything in your pack.',
  forsaken:  'Forsaken: a wipe loses everything in your pack.',
};

export default class HuntHubOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntHubOverlay' });
  }

  init() {
    this.zoneId = null;
    this.rationsToPack = 0;
    this.huntPlanInstance = null;
  }

  create() {
    const town = this.scene.get('TownScene');
    setupSceneCursor(this);
    if (town?.input) town.input.enabled = false;

    const frame = createOverlayFrame(this, {
      title: 'The Sacred Hunt',
      treatAsLocation: true,
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

  setHuntPlan(instance) {
    this.huntPlanInstance = instance;
    this._render();
  }

  /** The chosen plan, or the basic plan when none is. */
  _plan() {
    if (!this.huntPlanInstance) this.huntPlanInstance = makeBasicPlan();
    return this.huntPlanInstance;
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

    this._text(left, y + 64, zone.name, { fontSize: '20px', color: '#ffdd88', fontFamily: 'Georgia, Gelasio, serif' });
    this._text(left, y + 92, zone.flavor, { fontSize: '14px', color: '#cccccc', wordWrap: { width: width - 80 } });
    this._button(x + width - 140, y + 64, 'Change Location', () => this._openMap(), 'danger');

    // ── Supplies: the camp's issue plus packed Rations ──────────────────
    const suppliesY = y + 150;
    this._text(left, suppliesY, 'Supplies', { fontSize: '18px', color: '#ffffaa', fontStyle: 'bold' });

    const inBag = this._rationsInBag();
    this.rationsToPack = Math.min(this.rationsToPack, inBag, MAX_RATIONS_PACKED);
    this._suppliesText = this._text(left, suppliesY + 30,
      `${this._departSupplies()} supplies (camp issue ${CAMP_ISSUE} + ${this.rationsToPack} Rations packed)`,
      { fontSize: '15px', color: '#d0d0d0' }
    );
    this._ticketsText = this._text(left, suppliesY + 56,
      `Rations in camp bag: ${inBag}   ·   Hunt Tickets: ${ProgressionManager.huntTickets}`,
      { fontSize: '13px', color: '#999999' }
    );
    this._text(left, suppliesY + 78,
      `Packed Rations are at risk. What you don't eat comes home when you leave. ${DEATH_RULE_TEXT[zoneDeathRule(zone)]}`,
      { fontSize: '12px', color: '#c9a36a', wordWrap: { width: width - 80 } }
    );

    // Right-aligned: the supplies line is longer than it was under tickets.
    this._button(x + width - 350, suppliesY + 32, '−', () => this._adjustPacked(-PACK_STEP));
    this._button(x + width - 280, suppliesY + 32, '+', () => this._adjustPacked(PACK_STEP));
    const buy = this._button(x + width - 130, suppliesY + 32, `Buy ${RATIONS_PER_TICKET} (1 Ticket)`, () => this._buyRations());
    if (ProgressionManager.huntTickets < 1) buy.disableInteractive().setAlpha(0.4);

    // ── Hunt Plan ────────────────────────────────────────────────────────
    const planY = suppliesY + 124;
    this._text(left, planY, 'Hunt Plan', { fontSize: '18px', color: '#ffffaa', fontStyle: 'bold' });

    // Never empty: with nothing chosen, the hunt goes on the free basic plan.
    const plan = this._plan();
    this._text(left, planY + 30, getItemComputedData(plan).name, {
      fontSize: '14px', color: RARITY_COLORS[plan.rarity] || RARITY_COLORS.common,
    });
    this._text(left + 420, planY + 4, describePlanHeader(plan).join('\n'), {
      fontSize: '11px', color: '#aaaaaa', wordWrap: { width: width - 500 },
    });
    this._button(left + 280, planY + 18, 'Choose Hunt Plan', () => this._openHuntPlanPicker(), 'primary');

    // ── Active Modifiers (region + Hunt Plan — weather stays unknown until you depart) ──
    const modY = planY + 64;
    const modPanel = createPanel(this, left, modY, width - 80, 90, 'slot');
    this._content.add(modPanel);
    this._text(left + 16, modY + 10, 'Active Modifiers (region + Hunt Plan — weather unknown until you depart)', {
      fontSize: '13px', color: '#ffdd88', fontStyle: 'bold', wordWrap: { width: width - 112 },
    });

    const previewLines = describeLoadout(zone.modifiers, plan.instanceMods?.misc);
    this._text(left + 16, modY + 34,
      previewLines.length ? previewLines.join('   ·   ') : 'No active modifiers.',
      { fontSize: '13px', color: '#cccccc', wordWrap: { width: width - 112 } }
    );

    this._button(x + width / 2, bottom - 50, 'Depart', () => this._depart(), 'confirm');
  }

  _rationsInBag() {
    return countInList(GameState.inventory, 'rations');
  }

  /** Supplies the hunt would start with: the free issue plus what is packed. */
  _departSupplies() {
    return CAMP_ISSUE + this.rationsToPack * (Items.rations?.supply ?? 1);
  }

  _adjustPacked(delta) {
    const most = Math.min(MAX_RATIONS_PACKED, this._rationsInBag());
    this.rationsToPack = Phaser.Math.Clamp(this.rationsToPack + delta, 0, most);
    SoundManager.play('select');
    this._render();
  }

  /** Hunt Tickets -> Rations, straight into the camp bag. Spent now, not at departure. */
  _buyRations() {
    if (ProgressionManager.huntTickets < 1) return;
    ProgressionManager.huntTickets -= 1;
    InventorySystem.addGlobalItem(makeStack('rations', RATIONS_PER_TICKET));
    GameState.save('autosave');
    SoundManager.play('select');
    this._render();
  }

  _depart() {
    SoundManager.play('select');
    const packed = Math.min(this.rationsToPack, this._rationsInBag(), MAX_RATIONS_PACKED);
    const supplies = CAMP_ISSUE + packed * (Items.rations?.supply ?? 1);
    // Out of the bag and into the pack: from here they are at risk.
    const rations = packed > 0 ? takeFromList(GameState.inventory, 'rations', packed) : null;
    const plan = this._plan();
    const huntPlanModifiers = plan.instanceMods?.misc || null;
    HuntManager.start(this.zoneId, { supplies, huntPlanModifiers, bring: rations ? [rations] : [] });
    this.rationsToPack = 0;

    // A general plan is used up on departure; the basic plan is free and
    // unlimited, and was never in the bag.
    if (!isBasicPlan(plan)) GameState.removeFromInventory(plan.instanceId);
    this.huntPlanInstance = null;

    // One write for the rations, the plan and the new hunt, so a reload can
    // never refund either while keeping the hunt, or the other way round.
    GameState.save('autosave');
    this._render();
  }

  // ── Phase: actively hunting ──────────────────────────────────────────────

  _renderHunting() {
    const state = HuntManager.getState();
    const zone = getZone(state.zoneId);
    const { x, y, width, bottom } = this._bounds;
    const left = x + 40;

    this._text(left, y + 60, zone.name, { fontSize: '20px', color: '#ffdd88', fontFamily: 'Georgia, Gelasio, serif' });

    // Supply bar
    const barY = y + 96;
    const barW = width - 80;
    const pct = state.maxSupplies > 0 ? state.supplies / state.maxSupplies : 0;
    const barBg = this.add.rectangle(left, barY, barW, 16, 0x222222).setOrigin(0, 0.5);
    const barFill = this.add.rectangle(left, barY, barW * pct, 16, pct > 0.3 ? 0x44aa66 : 0xaa4444).setOrigin(0, 0.5);
    this._content.add(barBg);
    this._content.add(barFill);
    this._text(left, barY - 22, `Supplies: ${state.supplies} / ${state.maxSupplies}`, { fontSize: '13px', color: '#cccccc' });
    const packed = state.pack.brought.filter(i => i.id === 'rations').reduce((n, i) => n + (i.qty || 1), 0);
    this._text(left + barW, barY - 22,
      `Pack: ${state.pack.rationsLeft} of ${packed} Rations left  ·  ${state.pack.found.length} found`,
      { fontSize: '13px', color: '#c9a36a' }).setOrigin(1, 0);

    this._text(left, barY + 18, `Day ${state.day} — ${state.isNight ? 'Night' : 'Day'}  ·  Depth ${state.depth}`, { fontSize: '15px', color: '#ffffaa' });
    this._text(left, barY + 42, `Hunt Points this trip: ${state.sessionHuntPoints}  ·  Total: ${ProgressionManager.huntPoints}`, { fontSize: '13px', color: '#88ddff' });

    this._text(left, barY + 64, `Weather: ${state.weather.name} — ${state.weather.flavor}`, {
      fontSize: '12px', color: '#aaccff', wordWrap: { width: width },
    });
    const modLines = describeModifiers(state.combinedModifiers);
    this._text(left, barY + 84, modLines.length ? `Modifiers: ${modLines.join('   ·   ')}` : 'Modifiers: none active.', {
      fontSize: '12px', color: '#999999', wordWrap: { width: width },
    });

    // ── Log ──────────────────────────────────────────────────────────────
    const logY = barY + 116;
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

    // Return to Camp is only enabled once the hunt is actually over (supplies
    // depleted) — no abandoning a hunt early yet. Revisit once a real
    // "hunt complete" condition beyond running out of supplies exists.
    const canReturn = !state.pendingEncounter && state.supplies <= 0;
    const returnBtn = this._button(x + width / 2 + 90, bottom - 30, 'Return to Camp', () => this._returnToCamp(), 'danger');
    if (!canReturn) returnBtn.disableInteractive().setAlpha(0.4);
  }

  _advance() {
    SoundManager.play('select');
    HuntManager.advance();
    GameState.save('autosave');
    this._render();
  }

  /** Fights get the small low-key preview; Events skip straight to the full, locked-in event screen. */
  _investigate() {
    this.scene.pause();
    const pending = HuntManager.getState().pendingEncounter;
    const overlayKey = pending?.kind === 'encounter' ? 'HuntEncounterOverlay' : 'HuntEventOverlay';
    this.scene.launch(overlayKey, { encounter: pending });
    this.scene.bringToTop(overlayKey);
  }

  /** Called by HuntEncounterOverlay/HuntEventOverlay after the player resolves the pending encounter. */
  /** Called by HuntEncounterOverlay once it's worked out a choice/check/puzzle outcome. */
  onEncounterResolved(outcome) {
    HuntManager.resolveEncounter(outcome);
    GameState.save('autosave');
    this._render();
  }

  _returnToCamp() {
    SoundManager.play('select');
    const summary = HuntManager.getState();
    // A clean exit: the pack is banked into the camp bag.
    const pack = HuntManager.exit();
    GameState.restorePartyToFull();
    GameState.save('autosave');
    this.zoneId = null;
    this.rationsToPack = 0;
    this.huntPlanInstance = null;
    const uiScene = this.scene.get('UIScene');
    uiScene?.refreshUI();
    const found = pack?.home.found.length || 0;
    uiScene?.showDialogue(
      `You return to Camp Nehemiah.\nHunt Points earned this trip: ${summary.sessionHuntPoints}` +
      (pack?.rationsPacked ? `\nRations brought home: ${pack.rationsLeft} of ${pack.rationsPacked}` : '') +
      (found ? `\nItems from your pack: ${found}` : '')
    );
    this._close();
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  _openMap() {
    this.scene.pause();
    this.scene.launch('HuntMapOverlay');
    this.scene.bringToTop('HuntMapOverlay');
  }

  _openHuntPlanPicker() {
    this.scene.pause();
    this.scene.launch('HuntPlanPickerOverlay');
    this.scene.bringToTop('HuntPlanPickerOverlay');
  }

  /**
   * Closing (the X button, clicking outside the panel, or ESC — all route
   * through OverlayFrame's onClose) is refused while a hunt is active. The
   * only way out mid-hunt is finishing it — _returnToCamp() already calls
   * HuntManager.end() before calling this, so that path still works.
   */
  _close() {
    if (HuntManager.isActive()) return;
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.stop();
  }
}
