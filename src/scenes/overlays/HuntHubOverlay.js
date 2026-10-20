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
//   'loadout' — zone chosen, supplies/Hunt Plan being configured, not departed;
//               shows all eight party stats and who provides each (chunk 8c)
//   'hunting' — an OLD Advance hunt a save still holds (chunk 8c, owner
//               decision 6). Depart now always starts a hunt on the hex map,
//               which this screen hands straight to HuntFieldOverlay.
//
// A hunt is saved, so every action that changes it autosaves straight after:
// departing, advancing, and resolving an event. A reload then lands the
// player back in the hunt exactly where they were (see HuntManager.js).
//
// Supplies are Rations, a stackable item in the camp bag. Hunt Tickets buy
// them here; the loadout packs some on top of the camp's free issue, and the
// packed ones are at risk in the hunt pack. What is left of them comes home on
// a clean exit (HuntManager.js, the hunt pack).

import { wakeTown } from '../../ui/townInput.js';
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createButton } from '../../ui/Button.js';
import { createPanel } from '../../ui/GamePanel.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { HuntManager, CAMP_ISSUE, zoneDeathRule } from '../../systems/HuntManager.js';
import { InventorySystem } from '../../systems/InventorySystem.js';
import { countInList, makeStack, stackQty } from '../../systems/ItemStacks.js';
import { Items } from '../../../data/items.js';
import { describeModifiers, describeLoadout } from '../../systems/HuntModifiers.js';
import { describePlanHeader, makeBasicPlan, isBasicPlan } from '../../systems/HuntPlans.js';
import { getItemComputedData, huntPlanView } from '../../systems/ItemFactory.js';
import { RARITY_COLORS } from '../../ui/styles.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import GameState from '../../systems/GameState.js';
import { getZone } from '../../../data/zones.js';
import { rationPackCap, huntMods } from '../../systems/HuntRules.js';
import { partyStats } from '../../systems/PartyStats.js';
import { planMapInputs } from '../../systems/HuntMapGen.js';
import { launchMapHunt } from './HuntFieldOverlay.js';
import { bossesIn, omenMeter, offersReady } from '../../systems/Omens.js';
import { PACK_GROUPS, packRows, clampPlan, adjust, emptyPlan, reminders, describePlan, takePlan, rememberPlan } from '../../systems/PackPlan.js';
import { questSitesFor, questTitleForStep } from '../../systems/HuntQuests.js';
import { huntItemLevel } from '../../systems/HuntScaling.js';
import { owedExplorationPicks } from '../../systems/PartyStats.js';

// The camp's free issue (CAMP_ISSUE, 60) comes on top of what is packed. The
// packing cap is rationPackCap (HuntRules.js): 60 since the hunt moved onto
// the map (chunk 7 decision 12, applied in 8c), plus Pack Mule's 20.
const RATIONS_PER_TICKET     = 10;
const PACK_STEP              = 10;
const LOG_LINES_SHOWN        = 10;
const FONT = 'Georgia, Gelasio, serif';
/** The departure flow's steps (chunk 15f), in order. */
const FLOW_STEPS = ['Where', 'The plan', 'The party', 'Pack', 'Review'];

// Shown before departure, never a surprise (DEATH_AND_REVIVAL).
const DEATH_RULE_TEXT = {
  sheltered: 'Sheltered: a wipe loses nothing in your pack.',
  watched:   'Watched: a wipe loses everything in your pack.',
  forsaken:  'Forsaken: a wipe loses everything in your pack.',
};

/**
 * Spend a departure: the packed Rations come out of the camp bag (into the
 * hunt pack, at risk from here) and a general plan is used up (the basic plan
 * is free and was never in the bag). Returns what the hunt starts with: the
 * plan's map inputs (base type -> objective and size, item level -> tier and
 * rewards), the supplies, and what is brought. One definition for the solo
 * Depart and the co-op host's start (CoopLobbyScene), so they cannot drift.
 * The caller saves.
 */
/** The older packing choice (whole camp-bag entries by instance id) as a
 *  PackPlan: a stack counts its units, anything else is gear. */
function legacyPlan(rations, packIds = []) {
  const plan = { rations, items: {}, gear: [] };
  for (const id of packIds) {
    const inst = (GameState.inventory || []).find(it => it?.instanceId === id);
    if (!inst) continue;
    if (Items[inst.id]?.stackable) plan.items[inst.id] = (plan.items[inst.id] || 0) + stackQty(inst);
    else plan.gear.push(id);
  }
  return plan;
}

export function takeDeparture({ plan, pack = null, rationsToPack = 0, packIds = [] }) {
  // The Pack step's plan (chunk 15f, PackPlan.js): { rations, items, gear }.
  // The older { rationsToPack, packIds } still reads as one (gear by instance).
  const p = clampPlan(GameState.inventory || [], pack || legacyPlan(rationsToPack, packIds), rationPackCap(GameState.party));
  p.gear = p.gear.filter(id => id !== plan?.instanceId);
  const supplies = CAMP_ISSUE + p.rations * (Items.rations?.supply ?? 1);
  const taken = takePlan(GameState.inventory, p);
  // party: the shared side (Rations apart); own: fights and gear. Solo it is
  // all one pack; a co-op start splits them (CoopLobbyScene).
  const bring = [...(taken.rations ? [taken.rations] : []), ...taken.party, ...taken.own];
  const view = huntPlanView(plan);
  // A boss plan stays in the bag until its boss is fought (14b-4): the hunt
  // carries its id and uses it up then (HuntEngine.beginFight).
  if (view.boss) return { plan: { ...planMapInputs(view), itemLevel: view.itemLevel, bossPlanId: plan.instanceId }, supplies, bring };
  if (!isBasicPlan(plan)) GameState.removeFromInventory(plan.instanceId);
  return { plan: { ...planMapInputs(view), itemLevel: view.itemLevel }, supplies, bring };
}

export default class HuntHubOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'HuntHubOverlay' });
  }

  init() {
    // Last hunt's region and pack, remembered (chunk 15f): a returning
    // player can click straight through.
    const last = GameState.flags?.lastHunt || null;
    this.zoneId = last?.zoneId && getZone(last.zoneId) ? last.zoneId : null;
    this.huntPlanInstance = null;
    this.step = 1;
    this.pack = clampPlan(GameState.inventory || [], last?.pack || emptyPlan(), rationPackCap(GameState.party || []));
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

    // Catch every click on the panel. Without it a click on empty parchment
    // was "uncaught" and Phaser handed it to TownScene below, whose Bonfire
    // opens character creation (found in chunk 8b, owner folded the fix into
    // 8c). Buttons sit above this and take their own clicks first.
    const b = frame.bounds;
    this.add.zone(b.x, b.y, b.width, b.height).setOrigin(0).setDepth(frame.depth - 0.5).setInteractive();

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

    if (HuntManager.mode() === 'map') {
      // A hunt on the hex map is played on its own scene (chunk 8c).
      this._handOverToMap();
      return;
    }
    if (HuntManager.isActive()) {
      this._renderHunting();
    } else {
      this._renderFlow();
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

  // ── The departure flow (chunk 15f; owner, 2026-10-20) ─────────────────────
  //
  // Five steps clicked through in order, so nothing is missed and nothing is
  // crammed onto one page: Where, The plan, The party, Pack, Review. Depart
  // is only on the last. The step names along the top go back to any step
  // already reached; Back and Next walk them. Last hunt's region and pack
  // are remembered (GameState.flags.lastHunt), so a returning player can
  // click Next four times and go.

  _renderFlow() {
    const { x, y, width, bottom } = this._bounds;
    if (!this.zoneId) this.step = 1;
    // The step names, along the top.
    const stepW = (width - 80) / FLOW_STEPS.length;
    FLOW_STEPS.forEach((name, i) => {
      const n = i + 1;
      const reachable = n === 1 || !!this.zoneId;
      const t = this._text(x + 40 + stepW * i + stepW / 2, y + 58, `${n}  ${name}`, {
        fontSize: '15px', fontFamily: FONT,
        color: n === this.step ? '#ffdd88' : reachable ? '#d8cfbf' : '#7a7468',
        fontStyle: n === this.step ? 'bold' : 'normal',
      }).setOrigin(0.5, 0);
      if (reachable && n !== this.step) t.setInteractive({ useHandCursor: true }).on('pointerdown', () => this._go(n));
    });
    const line = this.add.graphics();
    line.lineStyle(1, 0x8a7a5a, 0.6).lineBetween(x + 40, y + 84, x + width - 40, y + 84);
    this._content.add(line);

    const top = y + 98;
    if (this.step === 1) this._renderWhere(top);
    if (this.step === 2) this._renderPlanStep(top);
    if (this.step === 3) this._renderPartyStep(top);
    if (this.step === 4) this._renderPackStep(top);
    if (this.step === 5) this._renderReview(top);

    // The foot: Back and Next; on the last step, the two ways to leave.
    if (this.step > 1) this._button(x + 110, bottom - 40, 'Back', () => this._go(this.step - 1), 'primary');
    if (this.step < FLOW_STEPS.length) {
      const next = this._button(x + width - 110, bottom - 40, 'Next', () => this._go(this.step + 1), 'confirm');
      if (!this.zoneId) next.disableInteractive().setAlpha(0.4);
    } else {
      this._button(x + width - 140, bottom - 40, 'Depart', () => this._depart(), 'confirm');
      // Co-op (chunk 12c): the same departure, taken into a co-op lobby.
      // Nothing is spent until the hunt actually starts there.
      this._button(x + width - 340, bottom - 40, 'Depart with friends', () => this._departWithFriends(), 'primary');
    }
  }

  _go(n) {
    if (n > 1 && !this.zoneId) return;
    SoundManager.play('select');
    this.step = Math.max(1, Math.min(FLOW_STEPS.length, n));
    this._render();
  }

  _heading(left, y, s) {
    return this._text(left, y, s, { fontSize: '18px', color: '#ffffaa', fontStyle: 'bold' });
  }

  // ── 1. Where ────────────────────────────────────────────────────────────

  _renderWhere(top) {
    const { x, width } = this._bounds;
    const left = x + 40;
    if (!this.zoneId) {
      this._text(left, top, 'No region chosen.', { fontSize: '18px', color: '#ffffaa', fontStyle: 'bold' });
      this._text(left, top + 34, `Hunt Tickets: ${ProgressionManager.huntTickets}   ·   Hunt Points (total): ${ProgressionManager.huntPoints}`, { fontSize: '15px', color: '#cccccc' });
      this._text(left, top + 70, 'Choose a region to hunt. Then you choose a Hunt Plan, look over the party, pack, and depart.',
        { fontSize: '14px', color: '#999999', wordWrap: { width: width - 80 } });
      this._button(x + width / 2, top + 150, 'Choose Location', () => this._openMap(), 'confirm');
      return;
    }
    const zone = getZone(this.zoneId);
    this._text(left, top, zone.name, { fontSize: '22px', color: '#ffdd88', fontFamily: FONT });
    this._button(x + width - 140, top + 12, 'Change Location', () => this._openMap(), 'danger');
    const flavor = this._text(left, top + 34, zone.flavor, { fontSize: '14px', color: '#cccccc', wordWrap: { width: width - 80 } });
    let ty = flavor.y + flavor.height + 14;
    this._text(left, ty, `Danger ${zone.danger ?? 1}: gear found here is item level ${huntItemLevel(zone.danger)}.`, { fontSize: '14px', color: '#d0d0d0' });
    ty += 24;
    this._text(left, ty, `${DEATH_RULE_TEXT[zoneDeathRule(zone)]} Everything you pack is at risk on a hunt.`, { fontSize: '13px', color: '#c9a36a', wordWrap: { width: width - 80 } });
    ty += 30;
    const omensH = this._renderOmens(left, ty, x + width - 40, zone);
    ty += omensH ? omensH + 8 : 0;
    // The quests that will place something on this region's maps (14b-2).
    const quests = [...new Set(questSitesFor(this.zoneId, ProgressionManager)
      .filter(s => !String(s.step).includes(':')).map(s => questTitleForStep(s.step)).filter(Boolean))];
    this._heading(left, ty + 6, 'Your quests here');
    this._text(left, ty + 34, quests.length ? quests.map(q => `·  ${q}`).join('\n') : 'None. Your quest log may point somewhere else.',
      { fontSize: '14px', color: quests.length ? '#c59bff' : '#999999', lineSpacing: 4 });
  }

  // ── 2. The plan ─────────────────────────────────────────────────────────

  _renderPlanStep(top) {
    const zone = getZone(this.zoneId);
    const { x, width } = this._bounds;
    const left = x + 40;
    this._heading(left, top, 'Hunt Plan');
    // Never empty: with nothing chosen, the hunt goes on the free basic plan.
    const plan = this._plan();
    this._button(x + width - 150, top + 10, 'Choose Hunt Plan', () => this._openHuntPlanPicker(), 'primary');
    const name = this._text(left, top + 34, getItemComputedData(plan).name, {
      fontSize: '16px', color: RARITY_COLORS[plan.rarity] || RARITY_COLORS.common, wordWrap: { width: width - 80 },
    });
    const head = this._text(left, name.y + name.height + 8, describePlanHeader(plan).join('\n'), {
      fontSize: '13px', color: '#cfcfcf', wordWrap: { width: width - 80 }, lineSpacing: 3,
    });
    // Active modifiers (region + plan; the weather stays unknown until you depart).
    const modY = head.y + head.height + 16;
    const modPanel = createPanel(this, left, modY, width - 80, 110, 'slot');
    this._content.add(modPanel);
    this._text(left + 16, modY + 10, 'Active Modifiers (region + Hunt Plan — weather unknown until you depart)', {
      fontSize: '13px', color: '#ffdd88', fontStyle: 'bold', wordWrap: { width: width - 112 },
    });
    const previewLines = describeLoadout(zone.modifiers, plan.instanceMods?.misc);
    this._text(left + 16, modY + 34, previewLines.length ? previewLines.join('   ·   ') : 'No active modifiers.',
      { fontSize: '13px', color: '#cccccc', wordWrap: { width: width - 112 } });
  }

  // ── 3. The party ────────────────────────────────────────────────────────

  _renderPartyStep(top) {
    const zone = getZone(this.zoneId);
    const { x, width } = this._bounds;
    const left = x + 40;
    const party = GameState.party || [];
    this._heading(left, top, `The party (${party.length})`);
    this._button(x + width - 140, top + 10, 'Party sheet', () => this._openPartySheet(), 'primary');
    const colW = (width - 80) / 2;
    party.forEach((c, i) => {
      const cx = left + (i % 2) * colW, cy = top + 34 + Math.floor(i / 2) * 22;
      this._text(cx, cy, `${c.name}  ·  level ${c.level || 1} ${c.baseClass || ''}`.trim(), { fontSize: '14px', color: '#e8e8e8' });
    });
    let ty = top + 34 + Math.ceil(party.length / 2) * 22 + 8;
    // Exploration picks a hunter has earned but not chosen (PARTY_STATS).
    const owed = party.filter(c => owedExplorationPicks(c).length).map(c => c.name);
    if (owed.length) {
      this._text(left, ty, `${owed.join(', ')} ${owed.length === 1 ? 'has' : 'have'} an exploration pick to choose: open the Party sheet.`,
        { fontSize: '13px', color: '#c9a36a', wordWrap: { width: width - 80 } });
      ty += 26;
    }
    this._renderPartyStats(left, ty + 8, width - 80, zone, this._plan());
  }

  _openPartySheet() {
    SoundManager.play('select');
    this.scene.pause();
    this.scene.launch('PartyManagementScene', { onClose: () => { this.scene.resume(); this._render(); } });
    this.scene.bringToTop('PartyManagementScene');
  }

  // ── 4. Pack ─────────────────────────────────────────────────────────────

  _renderPackStep(top) {
    const { x, width, bottom } = this._bounds;
    const left = x + 40;
    const bag = GameState.inventory || [];
    const cap = rationPackCap(GameState.party);
    this.pack = clampPlan(bag, this.pack, cap);

    // Rations: the camp's free issue plus what is packed, in steps of 10.
    this._heading(left, top, 'Supplies');
    const inBag = countInList(bag, 'rations');
    this._text(left, top + 28, `${this._departSupplies()} supplies: the camp's issue of ${CAMP_ISSUE} and ${this.pack.rations} Rations packed (${inBag} in camp, ${cap} at most)`,
      { fontSize: '14px', color: '#d0d0d0', wordWrap: { width: width - 420 } });
    const stepper = { minWidth: 46, padX: 14 };
    this._button(x + width - 370, top + 34, '−', () => this._adjustRations(-PACK_STEP), stepper);
    this._button(x + width - 310, top + 34, '+', () => this._adjustRations(PACK_STEP), stepper);
    const buy = this._button(x + width - 150, top + 34, `Buy ${RATIONS_PER_TICKET} (1 Ticket)`, () => this._buyRations());
    if (ProgressionManager.huntTickets < 1) buy.disableInteractive().setAlpha(0.4);

    // Everything else, by group, in two columns. A group with nothing in camp
    // is left out, except the Ways out (the Draughtwell sells them).
    const rows = packRows(bag, this.pack);
    const colW = (width - 100) / 2;
    const rowH = 25;
    let col = 0, ty = top + 74;
    const colTop = ty, colBottom = bottom - 130;
    const place = (h) => { if (ty + h > colBottom && col === 0) { col = 1; ty = colTop; } return left + col * (colW + 20); };
    for (const g of PACK_GROUPS) {
      const mine = rows.filter(r => r.group === g.id);
      if (!mine.length) continue;
      let cx = place(rowH * 2);
      this._text(cx, ty, g.name, { fontSize: '14px', color: '#ffdd88', fontStyle: 'bold' });
      ty += 22;
      for (const r of mine) {
        cx = place(rowH);
        this._packRow(cx, ty, colW, r);
        ty += rowH;
      }
      ty += 6;
    }
    if (!rows.some(r => r.have > 0)) {
      this._text(left, colTop + 110, 'Nothing else in camp to pack. The Draughtwell sells draughts, Escape Ropes and Smoke Pots.', { fontSize: '13px', color: '#999999' });
    }

    // Last time, and clearing.
    const last = GameState.flags?.lastHunt?.pack;
    if (last) this._button(left + 110, bottom - 96, 'Pack as last time', () => { this.pack = clampPlan(bag, last, cap); SoundManager.play('select'); this._render(); }, 'primary');
    this._button(left + (last ? 300 : 80), bottom - 96, 'Unpack all', () => { this.pack = emptyPlan(); SoundManager.play('select'); this._render(); }, 'danger');
    this._text(x + width - 40, bottom - 104, `Everything packed is at risk. ${DEATH_RULE_TEXT[zoneDeathRule(getZone(this.zoneId))]}`,
      { fontSize: '12px', color: '#c9a36a', wordWrap: { width: 380 }, align: 'right' }).setOrigin(1, 0);
  }

  /** One row of the Pack step: its name, how many are in camp, − count +. */
  _packRow(cx, cy, w, r) {
    const dim = r.have === 0;
    this._text(cx, cy, r.name, { fontSize: '13px', color: dim ? '#8a8478' : r.packed ? '#f2e6c8' : '#cfcfcf' });
    this._text(cx + w - 150, cy, r.stack ? `in camp ${r.have}` : '', { fontSize: '11px', color: '#9a9a9a' });
    // Padded, so the click target is bigger than the glyph.
    const less = this._text(cx + w - 76, cy - 4, '−', { fontSize: '18px', color: r.packed ? '#ffdd88' : '#6a6458', padding: { x: 6, y: 1 } });
    const n = this._text(cx + w - 44, cy, r.stack ? String(r.packed) : (r.packed ? 'yes' : 'no'), { fontSize: '13px', color: r.packed ? '#9fe09f' : '#9a9a9a' }).setOrigin(0.5, 0);
    const more = this._text(cx + w - 26, cy - 4, '+', { fontSize: '18px', color: r.packed < r.have ? '#ffdd88' : '#6a6458', padding: { x: 6, y: 1 } });
    for (const [t, d] of [[less, -1], [more, +1]]) {
      t.setInteractive({ useHandCursor: true }).on('pointerdown', () => {
        this.pack = adjust(this.pack, r, d);
        SoundManager.play('select');
        this._render();
      });
    }
    return n;
  }

  // ── 5. Review ───────────────────────────────────────────────────────────

  _renderReview(top) {
    const zone = getZone(this.zoneId);
    const { x, width } = this._bounds;
    const left = x + 40;
    const bag = GameState.inventory || [];
    this.pack = clampPlan(bag, this.pack, rationPackCap(GameState.party));
    const plan = this._plan();
    const row = (label, value, y, color = '#e8e8e8') => {
      this._text(left, y, label, { fontSize: '14px', color: '#ffdd88' });
      return this._text(left + 130, y, value, { fontSize: '14px', color, wordWrap: { width: width - 210 } });
    };
    let ty = top;
    ty = row('Region', `${zone.name} (danger ${zone.danger ?? 1})`, ty).y + 26;
    const p = row('Hunt Plan', getItemComputedData(plan).name, ty, RARITY_COLORS[plan.rarity] || RARITY_COLORS.common);
    ty = p.y + p.height + 8;
    ty = row('Party', (GameState.party || []).map(c => c.name).join(', '), ty).y + 26;
    ty = row('Supplies', `${this._departSupplies()} (camp issue ${CAMP_ISSUE} + ${this.pack.rations} Rations)`, ty).y + 26;
    const packed = describePlan(bag, { ...this.pack, rations: 0 });
    const pk = row('Packed', packed.length ? packed.join(', ') : 'Nothing else.', ty, packed.length ? '#e8e8e8' : '#999999');
    ty = pk.y + pk.height + 14;
    this._text(left, ty, `At risk: everything packed. ${DEATH_RULE_TEXT[zoneDeathRule(zone)]}`, { fontSize: '13px', color: '#c9a36a', wordWrap: { width: width - 80 } });
    ty += 30;
    // Gentle reminders: warnings, never blocks.
    const remind = reminders(bag, this.pack);
    if (remind.length) {
      this._text(left, ty, remind.map(l => `!  ${l}`).join('\n'), { fontSize: '13px', color: '#e8b070', lineSpacing: 4 });
      const back = this._text(left, ty + remind.length * 20 + 6, 'Back to Pack', { fontSize: '13px', color: '#ffdd88', fontStyle: 'bold' });
      back.setInteractive({ useHandCursor: true }).on('pointerdown', () => this._go(4));
    }
  }

  /**
   * Open the co-op lobby as a HUNT lobby, carrying this departure: region,
   * plan and Rations as chosen here. The lobby spends them (takeDeparture)
   * only when the host starts the hunt, so backing out costs nothing.
   */
  _departWithFriends() {
    if (!GameState.party?.length) return;
    SoundManager.play('select');
    const plan = this._plan();
    const zone = getZone(this.zoneId);
    const huntDeparture = {
      zoneId: this.zoneId,
      plan,
      pack: clampPlan(GameState.inventory || [], this.pack, rationPackCap(GameState.party)),
      rationsToPack: this.pack.rations,
      label: `${zone?.name || this.zoneId}: ${getItemComputedData(plan).name}`,
    };
    this._remember();
    this.scene.stop();
    window.sceneManager.loadScene('CoopLobbyScene', 'Opening the lobby…', { huntDeparture });
  }

  /**
   * All eight party stats at departure, and which hunter provides each
   * best-of stat (PARTY_STATS: "where party stats are shown"). Built from the
   * real partyStats with the zone and the plan; the weather is not known until
   * the party leaves, so it is not in these numbers.
   */
  _renderPartyStats(left, top, w, zone, plan) {
    const planMods = plan.instanceMods?.misc || {};
    const st = partyStats(GameState.party, huntMods(zone.modifiers, {}, planMods));
    const f = (n) => (Math.round(n * 10) / 10).toString();
    const by = (k) => (st.providers[k] ? ` (${st.providers[k]})` : '');
    const rows = [
      [`Perception ${f(st.perception)}${by('perception')}`, 'what you can make out; ambushes'],
      [`Endurance ${f(st.ratings.endurance)}`, `supplies per move ${st.supplyEfficiencyPercent >= 0 ? '-' : '+'}${f(Math.abs(st.supplyEfficiencyPercent))}%`],
      [`Speed ${f(st.speed)}`, `time per move -${f(st.travelTimePercent)}%; outrunning packs`],
      [`Cooking ${f(st.cooking)}${by('cooking')}`, 'meal quality at camp'],
      [`Fishing ${f(st.ratings.fishing)}${by('fishing')}`, `catch +${f(st.fishYieldPercent)}%`],
      [`Foraging ${f(st.ratings.foraging)}${by('foraging')}`, `forage +${f(st.forageYieldPercent)}%`],
      [`Item Rarity ${f(st.itemRarity)}`, 'rarer finds, stronger beasts'],
      [`Party Initiative ${f(st.partyInitiative)}`, 'which side acts first'],
    ];
    this._text(left, top, `Party stats (${st.size} hunters; weather not included)`, { fontSize: '14px', color: '#ffdd88', fontStyle: 'bold' });
    const colW = w / 2;
    rows.forEach(([head, note], i) => {
      const cx = left + (i % 2) * colW, cy = top + 24 + Math.floor(i / 2) * 26;
      this._text(cx, cy, head, { fontSize: '13px', color: '#e8e8e8' });
      this._text(cx, cy + 13, note, { fontSize: '10px', color: '#9a9a9a' });
    });
  }

  /** Close this screen and open the map scene on the hunt just started (or found). */
  _handOverToMap() {
    launchMapHunt(this);
    this.scene.stop();
  }

  _rationsInBag() {
    return countInList(GameState.inventory, 'rations');
  }

  /** Supplies the hunt would start with: the free issue plus what is packed. */
  _departSupplies() {
    return CAMP_ISSUE + (this.pack?.rations || 0) * (Items.rations?.supply ?? 1);
  }

  _adjustRations(delta) {
    const most = Math.min(rationPackCap(GameState.party), this._rationsInBag());
    this.pack = { ...this.pack, rations: Phaser.Math.Clamp((this.pack.rations || 0) + delta, 0, most) };
    SoundManager.play('select');
    this._render();
  }

  /**
   * The region's Omen meter and its bosses (chunk 14b-3; Omens.js): the meter,
   * the tribe's first offer when a questline has just ended, and a claim once
   * the meter is full. One row from `left` to `right` at `y`. Returns the
   * row's height, 0 (nothing drawn) for a region without bosses.
   */
  _renderOmens(left, y, right, zone) {
    // The meter, the tribe's offer and boss claims live at the lodge now
    // (Tribe HQ > Regions, LodgeRegionsOverlay; owner 2026-09-29, batch 4b
    // chunk 6). Here, one line says so, and whether something waits there.
    const bosses = bossesIn(zone.id, ProgressionManager);
    if (!bosses.length) return 0;
    const waiting = offersReady(ProgressionManager, zone.id).length > 0 || omenMeter(zone.id, ProgressionManager).ready > 0;
    this._text(left, y + 4, waiting
      ? 'Something waits for you at your lodge: Tribe HQ > Regions.'
      : 'This region\'s omens and bosses: Tribe HQ > Regions, at your lodge.',
      { fontSize: '14px', color: waiting ? '#c59bff' : '#999999' });
    return 26;
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
    // Every new hunt is a hunt on the hex map (chunk 8c). The Advance loop
    // only lives on in old saves.
    this._remember();
    const { plan, supplies, bring } = takeDeparture({ plan: this._plan(), pack: this.pack });
    HuntManager.startMap(this.zoneId, { plan, supplies, bring });
    this.pack = emptyPlan();
    this.huntPlanInstance = null;

    // One write for the rations, the plan and the new hunt, so a reload can
    // never refund either while keeping the hunt, or the other way round.
    GameState.save('autosave');
    this._handOverToMap();
  }

  /** Remember this region and pack for next time (chunk 15f). Counts only. */
  _remember() {
    (GameState.flags ||= {}).lastHunt = { zoneId: this.zoneId, pack: rememberPlan(this.pack) };
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

  /** A pending fight gets the small low-key preview. The Advance loop has no events any more (chunk 11a). */
  _investigate() {
    const pending = HuntManager.getState().pendingEncounter;
    if (pending?.kind !== 'encounter') return;
    this.scene.pause();
    this.scene.launch('HuntEncounterOverlay', { encounter: pending });
    this.scene.bringToTop('HuntEncounterOverlay');
  }

  _returnToCamp() {
    SoundManager.play('select');
    const summary = HuntManager.getState();
    // A clean exit: the pack is banked into the camp bag.
    const pack = HuntManager.exit();
    GameState.restorePartyToFull();
    GameState.save('autosave');
    this.huntPlanInstance = null;
    this.step = 1;
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
    wakeTown(this);
    this.scene.stop();
  }
}
