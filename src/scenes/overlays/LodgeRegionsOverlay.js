// src/scenes/overlays/LodgeRegionsOverlay.js
//
// Tribe HQ's Regions screen (owner 2026-09-29, playtest batch 4b chunk 6):
// one card per region the tribe knows of, holding what used to be split
// between the Hunt screen and the lodge header:
//   - the region's Omen meter (Omens.omenMeter), and a claim per unlocked
//     boss once it is full (Omens.claimBossPlan);
//   - its bosses: stirring (not yet named by a questline), the tribe's first
//     free offer when it is ready (Omens.takeFirstOffer), or known;
//   - where its questlines stand (quests.js: every region line whose steps
//     plant sites in it).
// Built for many regions at once; only the Reeds fills it today. Opened from
// Tribe HQ, and Back returns there, like the Lodge Shrine.
import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { setupSceneCursor } from '../../ui/cursor.js';
import { createButton } from '../../ui/Button.js';
import { SoundManager } from '../../systems/SoundManager.js';
import { TRIBE_DISPLAY } from '../../systems/TribeRelations.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import GameState from '../../systems/GameState.js';
import InventorySystem from '../../systems/InventorySystem.js';
import { getItemComputedData } from '../../systems/ItemFactory.js';
import { bossesIn, omenMeter, offersReady, takeFirstOffer, claimBossPlan } from '../../systems/Omens.js';
import { QUEST_LINES, getQuestState, getStepState } from '../../data/quests.js';
import { BOSSES } from '../../../data/bosses.js';
import { getZone } from '../../../data/zones.js';
import { Items } from '../../../data/items.js';

const FONT = 'Georgia, Gelasio, serif';

/** The region ids a questline's steps plant sites in. */
function zonesOfQuest(q) {
  return [...new Set((q.steps || []).map(s => s.huntSite?.zone).filter(Boolean))];
}

/** Regions with anything to show: a boss, or a region questline that is not locked. */
export function lodgeRegions(pm) {
  const ids = new Set(Object.values(BOSSES).map(b => b.zone));
  for (const q of QUEST_LINES) {
    if (q.category !== 'region' || getQuestState(q, pm) === 'locked') continue;
    zonesOfQuest(q).forEach(z => ids.add(z));
  }
  return [...ids].filter(id => getZone(id));
}

export default class LodgeRegionsOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'LodgeRegionsOverlay' });
  }

  create() {
    setupSceneCursor(this);
    this._tribe = ProgressionManager.getTribe();
    const frame = createOverlayFrame(this, {
      title: `${TRIBE_DISPLAY[this._tribe] || 'The'} Lodge: Regions`,
      fullscreen: true,
      onClose: () => this._close(),
    });
    this._depth = frame.depth;
    this._b = frame.bounds;
    this._note = '';
    this._layer = null;
    this._render();
  }

  _close() {
    this.scene.stop();
    this.scene.launch('TribeHQOverlay');
    this.scene.bringToTop('TribeHQOverlay');
  }

  _text(x, y, s, style = {}) {
    const t = this.add.text(x, y, s, { fontSize: '14px', color: '#dddddd', fontFamily: FONT, ...style });
    this._layer.add(t);
    return t;
  }

  _render() {
    if (this._layer) this._layer.destroy(true);
    this._layer = this.add.container(0, 0).setDepth(this._depth + 1);
    const b = this._b;
    const left = b.x + 40, width = b.width - 80;
    let y = b.y + 60;

    this._text(left, y, 'What your tribe knows of each hunting ground: its omens, its bosses, and your work there.', { color: '#9aa4b4' });
    y += 26;
    if (this._note) { this._text(left, y, this._note, { color: '#c59bff' }); y += 24; }

    const regions = lodgeRegions(ProgressionManager);
    if (!regions.length) this._text(left, y + 10, 'Nothing yet. Hunt, and your tribe will learn.', { color: '#888888' });
    for (const zoneId of regions) y = this._renderRegion(zoneId, left, y + 8, width) + 12;
  }

  /** One region's card. Returns the y below it. */
  _renderRegion(zoneId, left, y, width) {
    const zone = getZone(zoneId);
    const pm = ProgressionManager;
    const top = y;
    const g = this.add.graphics();
    this._layer.add(g);
    this._text(left + 14, y + 10, zone.name, { fontSize: '18px', color: '#ffdd88' });
    y += 42;

    // The Omen meter.
    const bosses = bossesIn(zoneId, pm);
    const bag = { push: (inst) => InventorySystem.addGlobalItem(inst, { isNew: true }) };
    const after = (res, what) => {
      if (!res?.ok) return;
      GameState.save('autosave');
      SoundManager.play('select');
      this._note = `${what}: ${getItemComputedData(res.plan)?.name || 'a hunt plan'} is in your camp bag.`;
      this._render();
    };
    if (bosses.length) {
      const meter = omenMeter(zoneId, pm);
      const barW = Math.min(360, width - 300);
      const pct = meter.cap > 0 ? Math.min(1, meter.have / meter.full) : 0;
      const bx = left + 14, by = y + 8;
      const bar = this.add.graphics();
      bar.fillStyle(0x222233, 1).fillRect(bx, by, barW, 14);
      bar.fillStyle(0x8a5cd6, 1).fillRect(bx, by, barW * pct, 14);
      bar.lineStyle(1, 0x555577, 1).strokeRect(bx, by, barW, 14);
      this._layer.add(bar);
      const status = meter.cap === 0
        ? 'Omens gather here once a questline names its boss.'
        : `${meter.have} / ${meter.full}${meter.ready ? `   ·   ${meter.ready} full meter${meter.ready === 1 ? '' : 's'} to spend` : ''}`;
      this._text(bx + barW + 14, y + 6, `Omens: ${status}`, { color: meter.ready ? '#c59bff' : '#bbbbbb' });
      y += 34;

      // Its bosses.
      const offers = offersReady(pm, zoneId);
      for (const boss of bosses) {
        const offer = offers.find(o => o.id === boss.id);
        const state = offer ? "your tribe has its first plan for you" : boss.unlocked ? 'known' : 'stirring';
        this._text(left + 14, y + 4, `${boss.name}: ${state}`, { color: offer ? '#c59bff' : boss.unlocked ? '#dddddd' : '#888888' });
        if (offer) {
          const btn = createButton(this, 0, y + 12, `Take it: ${Items[boss.plan]?.name || 'the plan'}`, () =>
            after(takeFirstOffer(pm, bag, boss.id, (f) => pm.setQuestFlag(f)), 'Your tribe gives it freely'), 'confirm', { fontSize: '14px' });
          btn.x = left + width - btn.getBounds().width / 2 - 14;
          this._layer.add(btn);
        } else if (boss.unlocked && meter.ready > 0) {
          const btn = createButton(this, 0, y + 12, `Claim: ${boss.name}`, () =>
            after(claimBossPlan(pm, bag, boss.id), 'The omens are enough'), 'confirm', { fontSize: '14px' });
          btn.x = left + width - btn.getBounds().width / 2 - 14;
          this._layer.add(btn);
        }
        y += 30;
      }
    }

    // Its questlines.
    const lines = QUEST_LINES.filter(q => q.category === 'region' && zonesOfQuest(q).includes(zoneId) && getQuestState(q, pm) !== 'locked');
    if (lines.length) {
      this._text(left + 14, y + 4, 'Questlines', { fontSize: '13px', color: '#9aa4b4' });
      y += 24;
      for (const q of lines) {
        const steps = q.steps || [];
        const now = steps.find(s => ['active', 'report'].includes(getStepState(s, pm)));
        const done = steps.filter(s => getStepState(s, pm) === 'completed').length;
        const where = now
          ? (getStepState(now, pm) === 'report' ? `${now.label}: report to Elder Varek` : now.label)
          : done === steps.length ? 'complete' : 'waiting';
        this._text(left + 28, y, `${q.title}   (${done} / ${steps.length})   ${where}`, { fontSize: '13px', color: now ? '#dddddd' : '#888888' });
        y += 22;
      }
    }

    y += 10;
    g.lineStyle(1, 0x5a4a3a, 1).strokeRoundedRect(left, top, width, y - top, 6);
    return y;
  }
}
