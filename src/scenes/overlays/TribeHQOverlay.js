// src/scenes/overlays/TribeHQOverlay.js
// Tribe HQ screen: shows party list with expandable accordion for gear/stash management.
// Non-player, non-leader parties can be equipped (from player inventory) and
// accumulate stash items from their simulated hunts (transferable for 1 Tribe Ticket).

import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createPanel } from '../../ui/GamePanel.js';
import { TRIBE_IDS, TRIBE_DISPLAY } from '../../systems/TribeRelations.js';
import { getPartiesForTribe } from '../../../data/tribeHuntingParties.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import GameState from '../../systems/GameState.js';
import { Items } from '../../../data/items.js';
import { getRarityColor, MENU_THEME } from '../../ui/styles.js';
import {
  SLOT_LABELS, PARTY_STASH_CAP,
  getPartyGear, getPartyGearScore, getHuntPointMultiplier,
  equipPartySlot, unequipPartySlot,
  addToPartyStash, removeFromPartyStash,
} from '../../systems/PartyGearManager.js';

const ROW_H      = 32;
const SLOT_ROW_H = 26;
const STASH_ROW_H= 26;
const ACCORDION_H= 278; // fixed; enough for 4 slot-rows + 4 stash-rows
const PAD        = 8;

function trunc(str, len = 22) {
  return str && str.length > len ? str.slice(0, len - 1) + '…' : (str || '—');
}

function getItemTargetSlot(inst) {
  const base = inst && Items[inst.id];
  if (!base) return null;
  if (base.type === 'weapon') return 'weaponMain';
  if (base.type === 'armor' && base.slot) return base.slot;
  return null;
}

export default class TribeHQOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'TribeHQOverlay' });
  }

  create() {
    const town = this.scene.get('TownScene');
    setupSceneCursor(this);
    if (town?.input) town.input.enabled = false;

    this._tribeId   = ProgressionManager.getTribe();
    this._tribeName = TRIBE_DISPLAY[this._tribeId] || 'Unaffiliated';

    const frame = createOverlayFrame(this, {
      title:   `${this._tribeName} Headquarters`,
      fullscreen: true,
      onClose: () => this._close(),
    });

    this._depth      = frame.depth;
    this._bounds     = frame.bounds;
    this._left       = frame.bounds.x + 40;
    this._panelW     = frame.bounds.width - 80;

    this._expandedId = null;
    this._pickerSlot = null; // slot string when picker is open, null otherwise
    this._listObjs   = [];
    this._staticObjs = [];

    if (!this._tribeId) {
      this.add.text(this._left, frame.bounds.y + 100, "You haven't pledged to a tribe yet.", {
        fontSize: '16px', color: '#cccccc',
      }).setDepth(this._depth);
      return;
    }

    this._buildHeader();
    this._buildPartyList();
    this._buildFooter();
  }

  // ---------------------------------------------------------------------------
  // Static sections (header / footer) — only built once

  _buildHeader() {
    const { _left: l, _bounds: b, _depth: d, _tribeId: tid, _tribeName: tname } = this;
    this._staticObjs.push(
      this.add.text(l, b.y + 64, `Your Hunt Points: ${ProgressionManager.huntPoints}`, {
        fontSize: '16px', color: '#88ddff',
      }).setDepth(d),

      // Elapsed world time, right-aligned opposite the Hunt Points line.
      // Accumulates across every hunt on this save (see
      // ProgressionManager.getWorldDate) — groundwork for a hunt season.
      this.add.text(b.right - 40, b.y + 64,
        `${ProgressionManager.getWorldDate().label}  ·  ${ProgressionManager.getWorldDate().detail}`, {
          fontSize: '14px', color: '#9aa4b4',
        }).setOrigin(1, 0).setDepth(d),

      this.add.text(l, b.y + 88, `${tname} Tribe Total: ${ProgressionManager.getTribeHuntPoints(tid)}`, {
        fontSize: '18px', color: '#ffdd88', fontStyle: 'bold',
      }).setDepth(d),

      this.add.text(l, b.y + 118, 'Hunting Parties', {
        fontSize: '15px', color: MENU_THEME.accentHover, fontStyle: 'bold',
      }).setDepth(d),
    );
  }

  _buildFooter() {
    const { _left: l, _bounds: b, _depth: d } = this;
    const fy = b.bottom - 58;
    this._staticObjs.push(
      this.add.text(l, fy, 'All Tribes (Hunt Points)', {
        fontSize: '13px', color: '#999999',
      }).setDepth(d),

      this.add.text(l, fy + 20,
        TRIBE_IDS.map(id => `${TRIBE_DISPLAY[id]}: ${ProgressionManager.getTribeHuntPoints(id)}`).join('   \xb7   '), {
        fontSize: '13px', color: '#cccccc',
      }).setDepth(d),
    );
  }

  // ---------------------------------------------------------------------------
  // Party list (rebuilt on every accordion toggle / action)

  _buildPartyList() {
    this._listObjs.forEach(o => o?.destroy?.());
    this._listObjs = [];

    const { _left: l, _bounds: b, _depth: d, _tribeId: tid, _panelW: pw } = this;
    const parties = getPartiesForTribe(tid);
    let curY = b.y + 142;

    parties.forEach(party => {
      const clickable = !party.isPlayerSlot && !party.isLeaderParty;
      const expanded  = this._expandedId === party.id;

      // Row background
      const bg = createPanel(this, l, curY, pw, ROW_H - 2, 'slot').setDepth(d);
      this._listObjs.push(bg);

      // Name
      const nameLabel = party.isPlayerSlot ? 'Your Hunting Party'
        : party.isLeaderParty ? `${party.name} [Leader]`
        : party.name;
      const nameColor = party.isPlayerSlot ? '#88ff88'
        : party.isLeaderParty ? '#ffdd88' : '#d0d0d0';

      this._listObjs.push(
        this.add.text(l + 14, curY + (ROW_H - 2) / 2, nameLabel, {
          fontSize: '13px', color: nameColor,
        }).setOrigin(0, 0.5).setDepth(d + 1),

        this.add.text(l + 300, curY + (ROW_H - 2) / 2, '★'.repeat(party.tier), {
          fontSize: '12px', color: '#ccaa44',
        }).setOrigin(0, 0.5).setDepth(d + 1),

        this.add.text(l + pw - 110, curY + (ROW_H - 2) / 2,
          `${ProgressionManager.getPartyPoints(tid, party.id)} pts`, {
          fontSize: '12px', color: '#88ddff',
        }).setOrigin(0, 0.5).setDepth(d + 1),
      );

      if (clickable) {
        const gs   = getPartyGearScore(tid, party.id);
        const mult = getHuntPointMultiplier(tid, party.id);
        this._listObjs.push(
          this.add.text(l + 420, curY + (ROW_H - 2) / 2,
            `GS ${gs}  \xd7${mult.toFixed(2)}`, { fontSize: '11px', color: '#888888' }
          ).setOrigin(0, 0.5).setDepth(d + 1),

          this.add.text(l + pw - 16, curY + (ROW_H - 2) / 2,
            expanded ? '▲' : '▼', { fontSize: '11px', color: '#888888' }
          ).setOrigin(1, 0.5).setDepth(d + 1),
        );

        const zone = this.add.zone(l + pw / 2, curY + (ROW_H - 2) / 2, pw, ROW_H - 2)
          .setInteractive({ useHandCursor: true }).setDepth(d + 2);
        this._listObjs.push(zone);
        zone.on('pointerdown', () => {
          const wasOpen = this._expandedId === party.id;
          this._expandedId = wasOpen ? null : party.id;
          this._pickerSlot = null;
          this._buildPartyList();
        });
        zone.on('pointerover', () => bg.setAlpha(0.75));
        zone.on('pointerout',  () => bg.setAlpha(1));
      }

      curY += ROW_H;

      if (expanded) {
        curY = this._buildAccordion(curY, party.id);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Accordion: equipment grid + stash (or picker)

  _buildAccordion(startY, partyId) {
    const { _left: l, _depth: d, _tribeId: tid, _panelW: pw } = this;
    let y = startY;

    const accordBg = this.add.rectangle(l, y, pw, ACCORDION_H, 0x0d0d1e, 0.88)
      .setOrigin(0, 0).setDepth(d);
    this._listObjs.push(accordBg);

    // Equipment header row
    const gs   = getPartyGearScore(tid, partyId);
    const mult = getHuntPointMultiplier(tid, partyId);
    this._listObjs.push(
      this.add.text(l + PAD, y + PAD, 'Equipment', {
        fontSize: '12px', color: '#aaaaaa', fontStyle: 'bold',
      }).setDepth(d + 1),

      this.add.text(l + pw - PAD, y + PAD,
        `Gear Score: ${gs}   \xd7${mult.toFixed(2)} pts/day`, {
        fontSize: '11px', color: '#666666',
      }).setOrigin(1, 0).setDepth(d + 1),
    );
    y += PAD + 18;

    // Equipment grid: 2 columns, 4 rows
    const gear  = getPartyGear(tid, partyId);
    const colW  = Math.floor(pw / 2) - PAD;
    const pairs = [
      ['weaponMain', 'head'],
      ['chest',      'legs'],
      ['gloves',     'boots'],
      ['ring',       'amulet'],
    ];
    for (const [slotA, slotB] of pairs) {
      this._buildSlotRow(l + PAD,          y, colW, d, tid, partyId, slotA, gear.equipment[slotA] ?? null);
      this._buildSlotRow(l + PAD + colW + PAD, y, colW, d, tid, partyId, slotB, gear.equipment[slotB] ?? null);
      y += SLOT_ROW_H;
    }

    y += PAD;

    // Stash or picker
    if (this._pickerSlot) {
      y = this._buildPicker(y, partyId, this._pickerSlot);
    } else {
      y = this._buildStash(y, partyId, gear.stash || []);
    }

    return startY + ACCORDION_H;
  }

  // ---------------------------------------------------------------------------

  _buildSlotRow(x, y, width, d, tid, partyId, slot, equipped) {
    const label = SLOT_LABELS[slot] || slot;
    this._listObjs.push(
      this.add.text(x, y + SLOT_ROW_H / 2, label + ':', {
        fontSize: '11px', color: '#666666',
      }).setOrigin(0, 0.5).setDepth(d + 1),
    );

    if (equipped) {
      const base = Items[equipped.id];
      const col  = getRarityColor(equipped.rarity);
      this._listObjs.push(
        this.add.text(x + 58, y + SLOT_ROW_H / 2,
          trunc(equipped.displayName || base?.name || equipped.id, 16), {
          fontSize: '11px', color: col,
        }).setOrigin(0, 0.5).setDepth(d + 1),
      );

      const rmBtn = this.add.text(x + width - 2, y + SLOT_ROW_H / 2, '[✕]', {
        fontSize: '11px', color: '#ff6666',
      }).setOrigin(1, 0.5).setDepth(d + 2).setInteractive({ useHandCursor: true });
      rmBtn.on('pointerover', () => rmBtn.setColor('#ff9999'));
      rmBtn.on('pointerout',  () => rmBtn.setColor('#ff6666'));
      rmBtn.on('pointerdown', () => {
        const removed = unequipPartySlot(tid, partyId, slot);
        if (removed) GameState.inventory = [...(GameState.inventory || []), removed];
        this._pickerSlot = null;
        this._buildPartyList();
      });
      this._listObjs.push(rmBtn);
    } else {
      this._listObjs.push(
        this.add.text(x + 58, y + SLOT_ROW_H / 2, '—', {
          fontSize: '11px', color: '#333333',
        }).setOrigin(0, 0.5).setDepth(d + 1),
      );

      const addBtn = this.add.text(x + width - 2, y + SLOT_ROW_H / 2, '[+]', {
        fontSize: '11px', color: '#5599ff',
      }).setOrigin(1, 0.5).setDepth(d + 2).setInteractive({ useHandCursor: true });
      addBtn.on('pointerover', () => addBtn.setColor('#88bbff'));
      addBtn.on('pointerout',  () => addBtn.setColor('#5599ff'));
      addBtn.on('pointerdown', () => {
        const toggle = this._pickerSlot === slot;
        this._pickerSlot = toggle ? null : slot;
        this._buildPartyList();
      });
      this._listObjs.push(addBtn);
    }
  }

  // ---------------------------------------------------------------------------

  _buildPicker(startY, partyId, slot) {
    const { _left: l, _depth: d, _tribeId: tid, _panelW: pw } = this;
    let y = startY;

    const slotName   = SLOT_LABELS[slot] || slot;
    const compatible = (GameState.inventory || []).filter(inst => {
      const base = Items[inst.id];
      if (!base) return false;
      return slot === 'weaponMain' ? base.type === 'weapon' : base.type === 'armor' && base.slot === slot;
    });

    this._listObjs.push(
      this.add.text(l + PAD, y, `Equip ${slotName} from inventory:`, {
        fontSize: '12px', color: '#88bbff', fontStyle: 'bold',
      }).setDepth(d + 1),
    );
    y += 18;

    if (compatible.length === 0) {
      this._listObjs.push(
        this.add.text(l + PAD, y + SLOT_ROW_H / 2, 'No compatible items in inventory.', {
          fontSize: '11px', color: '#444444',
        }).setOrigin(0, 0.5).setDepth(d + 1),
      );
      y += SLOT_ROW_H;
    } else {
      compatible.slice(0, 4).forEach(inst => {
        const base = Items[inst.id];
        this._listObjs.push(
          this.add.text(l + PAD, y + STASH_ROW_H / 2,
            trunc(inst.displayName || base?.name || inst.id, 28), {
            fontSize: '11px', color: getRarityColor(inst.rarity),
          }).setOrigin(0, 0.5).setDepth(d + 1),
        );

        const selBtn = this.add.text(l + pw - PAD, y + STASH_ROW_H / 2, '[Equip]', {
          fontSize: '11px', color: '#aaffaa',
        }).setOrigin(1, 0.5).setDepth(d + 2).setInteractive({ useHandCursor: true });
        selBtn.on('pointerover', () => selBtn.setColor('#ccffcc'));
        selBtn.on('pointerout',  () => selBtn.setColor('#aaffaa'));
        selBtn.on('pointerdown', () => {
          GameState.inventory = (GameState.inventory || []).filter(i => i.instanceId !== inst.instanceId);
          const prev = equipPartySlot(tid, partyId, slot, inst);
          if (prev) GameState.inventory = [...(GameState.inventory || []), prev];
          this._pickerSlot = null;
          this._buildPartyList();
        });
        this._listObjs.push(selBtn);
        y += STASH_ROW_H;
      });
    }

    const cancelBtn = this.add.text(l + PAD, y + STASH_ROW_H / 2, '[Cancel]', {
      fontSize: '11px', color: '#777777',
    }).setOrigin(0, 0.5).setDepth(d + 2).setInteractive({ useHandCursor: true });
    cancelBtn.on('pointerover', () => cancelBtn.setColor('#aaaaaa'));
    cancelBtn.on('pointerout',  () => cancelBtn.setColor('#777777'));
    cancelBtn.on('pointerdown', () => { this._pickerSlot = null; this._buildPartyList(); });
    this._listObjs.push(cancelBtn);
    y += STASH_ROW_H;

    return y;
  }

  // ---------------------------------------------------------------------------

  _buildStash(startY, partyId, stash) {
    const { _left: l, _depth: d, _tribeId: tid, _panelW: pw } = this;
    let y = startY;
    const tickets = ProgressionManager.tribeTickets;

    this._listObjs.push(
      this.add.text(l + PAD, y,
        `Stash (${stash.length}/${PARTY_STASH_CAP})   —   Tribe Tickets: ${tickets}`, {
        fontSize: '12px', color: '#888888', fontStyle: 'bold',
      }).setDepth(d + 1),
    );
    y += 18;

    if (stash.length === 0) {
      this._listObjs.push(
        this.add.text(l + PAD, y + STASH_ROW_H / 2, 'Nothing found yet.', {
          fontSize: '11px', color: '#3a3a3a',
        }).setOrigin(0, 0.5).setDepth(d + 1),
      );
      y += STASH_ROW_H;
      return y;
    }

    stash.slice(0, 4).forEach(inst => {
      const base       = Items[inst.id];
      const col        = getRarityColor(inst.rarity);
      const targetSlot = getItemTargetSlot(inst);

      this._listObjs.push(
        this.add.text(l + PAD, y + STASH_ROW_H / 2,
          trunc(inst.displayName || base?.name || inst.id, 22), {
          fontSize: '11px', color: col,
        }).setOrigin(0, 0.5).setDepth(d + 1),
      );

      // [Equip] — free, moves to party's own gear slot
      if (targetSlot) {
        const eBtn = this.add.text(l + pw - 90, y + STASH_ROW_H / 2, '[Equip]', {
          fontSize: '11px', color: '#aaffaa',
        }).setOrigin(1, 0.5).setDepth(d + 2).setInteractive({ useHandCursor: true });
        eBtn.on('pointerover', () => eBtn.setColor('#ccffcc'));
        eBtn.on('pointerout',  () => eBtn.setColor('#aaffaa'));
        eBtn.on('pointerdown', () => {
          const removed = removeFromPartyStash(tid, partyId, inst.instanceId);
          if (removed) {
            const prev = equipPartySlot(tid, partyId, targetSlot, removed);
            if (prev) {
              const reStashed = addToPartyStash(tid, partyId, prev);
              if (!reStashed) GameState.inventory = [...(GameState.inventory || []), prev];
            }
          }
          this._buildPartyList();
        });
        this._listObjs.push(eBtn);
      }

      // [Take ①] — costs 1 tribe ticket, moves to player global inventory
      const ticketColor = tickets >= 1 ? '#ffcc44' : '#555555';
      const takeBtn = this.add.text(l + pw - PAD, y + STASH_ROW_H / 2, '[Take ①]', {
        fontSize: '11px', color: ticketColor,
      }).setOrigin(1, 0.5).setDepth(d + 2).setInteractive({ useHandCursor: true });

      if (tickets >= 1) {
        takeBtn.on('pointerover', () => takeBtn.setColor('#ffeeaa'));
        takeBtn.on('pointerout',  () => takeBtn.setColor('#ffcc44'));
        takeBtn.on('pointerdown', () => {
          if (ProgressionManager.tribeTickets < 1) return;
          const removed = removeFromPartyStash(tid, partyId, inst.instanceId);
          if (removed) {
            ProgressionManager.tribeTickets -= 1;
            GameState.inventory = [...(GameState.inventory || []), removed];
          }
          this._buildPartyList();
        });
      }
      this._listObjs.push(takeBtn);
      y += STASH_ROW_H;
    });

    if (stash.length > 4) {
      this._listObjs.push(
        this.add.text(l + PAD, y, `+${stash.length - 4} more items in stash`, {
          fontSize: '10px', color: '#444444',
        }).setDepth(d + 1),
      );
    }

    return y;
  }

  // ---------------------------------------------------------------------------

  _close() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
