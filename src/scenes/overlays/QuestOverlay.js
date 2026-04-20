import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { QUEST_LINES, QUEST_CATEGORIES, getStepState, getQuestState } from '../../data/quests.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import { setupSceneCursor } from '../../ui/cursor.js';

// ── Visual constants ──────────────────────────────────────────────────────────

const C = {
  sectionHeader:   '#c8a060',
  questTitle:      '#ffffcc',
  questAvailable:  '#aaccaa',
  questCompleted:  '#666666',
  questPlaceholder:'#7777aa',
  stepActive:      '#ffdd44',
  stepCompleted:   '#555555',
  desc:            '#999999',
  tabActive:       '#ffdd88',
  tabInactive:     '#888888',
  divider:         0x5a4a3a,
  accent:          0xc8a060,
};

const TAB_W = 120;
const TAB_H = 26;
const ROW_H = 22;

// ── Module-level persistent state ─────────────────────────────────────────────
// These survive the overlay being stopped and relaunched within the same session.

// Default: Active section open, Available and Completed collapsed.
const _collapsedSections = new Set(['Available', 'Completed']);

// Which quests the player has expanded (click arrow to see steps).
const _expandedQuests = new Set();

// State keys that have been "seen" by the player. Format:
//   - "questId:stepId"  — quest is active with a specific step active
//   - "questId"         — quest is available but no step is active yet
// Using step ID means a new objective triggers the dot even for a previously-seen quest.
const _seenQuestIds = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the unique state key for a quest in its current state. */
function _questStateKey(q, pm) {
  const activeStep = q.steps.find(s => getStepState(s, pm) === 'active');
  return activeStep ? `${q.id}:${activeStep.id}` : q.id;
}

/** Returns state keys for all active/available quests in a given tab. */
function _liveQuestStateKeys(categoryId) {
  const pm = ProgressionManager;
  const keys = [];
  for (const q of QUEST_LINES) {
    if (q.category !== categoryId) continue;
    const s = getQuestState(q, pm);
    if (s === 'active' || s === 'available') keys.push(_questStateKey(q, pm));
  }
  return keys;
}

/** True if the tab has quests (or objectives) the player hasn't acknowledged yet. */
function _tabHasNew(categoryId) {
  return _liveQuestStateKeys(categoryId).some(k => !_seenQuestIds.has(k));
}

/** Exported: true if ANY tab has unseen quests/objectives (used by UIScene alert dot). */
export function anyQuestTabHasNew() {
  return QUEST_CATEGORIES.some(({ id }) => _tabHasNew(id));
}

// ── Scene ─────────────────────────────────────────────────────────────────────

export default class QuestOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'QuestOverlay' });
  }

  create() {
    const town = this.scene.get('TownScene');
    setupSceneCursor(this);
    if (town?.input) town.input.enabled = false;

    const frame = createOverlayFrame(this, {
      title:   'Quest Log',
      onClose: () => this._close(),
      bgImage: 'menu_parchment_background',
    });

    const { bounds, depth } = frame;
    this._depth  = depth;
    this._bounds = bounds;

    // Content area geometry
    this._contentLeft   = bounds.x + 22;
    this._contentWidth  = bounds.width - 44;
    this._contentTop    = bounds.y + 116;           // below title + tabs
    this._contentVisH   = bounds.bottom - this._contentTop - 12;

    // Scroll state (resets per open, not persisted)
    this._scrollY = 0;

    // Mask for the scrollable content area
    this._maskGfx = this.add.graphics().setVisible(false).setDepth(depth - 1);
    this._maskGfx.fillStyle(0xffffff);
    this._maskGfx.fillRect(bounds.x, this._contentTop, bounds.width, this._contentVisH);
    this._contentMask = this._maskGfx.createGeometryMask();

    // Mouse-wheel scrolling
    this.input.on('wheel', (_ptr, _objs, _dx, dy) => {
      this._scroll(dy * 0.6);
    });

    this._buildTabs();
    this._showTab('main');
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────────

  _buildTabs() {
    const { x, y, width } = this._bounds;
    const depth = this._depth;

    const totalW  = QUEST_CATEGORIES.length * TAB_W;
    const startX  = x + (width - totalW) / 2;
    const tabY    = y + 76;

    this._tabBtns = {};
    this._notifDots = {};

    QUEST_CATEGORIES.forEach(({ id, label }, i) => {
      const cx = startX + i * TAB_W + TAB_W / 2;

      const bg = this.add.rectangle(cx, tabY, TAB_W - 4, TAB_H, 0x1a1a1a)
        .setOrigin(0.5).setDepth(depth)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._showTab(id))
        .on('pointerover',  () => { if (this._activeTab !== id) bg.setFillStyle(0x2a2a2a); })
        .on('pointerout',   () => { if (this._activeTab !== id) bg.setFillStyle(0x1a1a1a); });

      const lbl = this.add.text(cx, tabY, label, { fontSize: '13px', color: C.tabInactive })
        .setOrigin(0.5).setDepth(depth + 1)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this._showTab(id));

      const underline = this.add.rectangle(cx, tabY + TAB_H / 2 + 1, TAB_W - 4, 2, 0xffdd88)
        .setOrigin(0.5, 0).setDepth(depth + 1).setVisible(false);

      // Notification dot — gold circle in top-right corner of tab button
      const dotX = cx + TAB_W / 2 - 8;
      const dotY = tabY - TAB_H / 2 + 6;
      const dot  = this.add.circle(dotX, dotY, 5, 0xffdd44)
        .setDepth(depth + 2)
        .setVisible(_tabHasNew(id));

      this._tabBtns[id]   = { bg, lbl, underline };
      this._notifDots[id] = dot;
    });

    // Divider below tabs
    const divY = y + 76 + TAB_H / 2 + 4;
    const divGfx = this.add.graphics().setDepth(depth);
    divGfx.lineStyle(1, C.divider, 0.7);
    divGfx.beginPath();
    divGfx.moveTo(x + 16, divY);
    divGfx.lineTo(x + width - 16, divY);
    divGfx.strokePath();
  }

  _showTab(id) {
    // Update tab visuals
    for (const [key, btn] of Object.entries(this._tabBtns)) {
      const active = key === id;
      btn.bg.setFillStyle(active ? 0x2d2217 : 0x1a1a1a);
      btn.lbl.setStyle({ color: active ? C.tabActive : C.tabInactive });
      btn.underline.setVisible(active);
    }

    this._activeTab = id;
    this._scrollY   = 0;

    // Mark all quests/objectives on this tab as seen, hide the dot
    for (const key of _liveQuestStateKeys(id)) {
      _seenQuestIds.add(key);
    }
    if (this._notifDots[id]) this._notifDots[id].setVisible(false);

    this._renderContent();
  }

  // ── Content rendering (rebuilt on each toggle/tab change) ─────────────────────

  _renderContent() {
    // Destroy previous render
    this._contentGroup?.destroy(true);

    const pm     = ProgressionManager;
    const quests = QUEST_LINES.filter(q => q.category === this._activeTab);

    // Bucket quests by state
    const active = [], available = [], completed = [];
    for (const q of quests) {
      const s = getQuestState(q, pm);
      if      (s === 'active')                    active.push(q);
      else if (s === 'available' || s === 'placeholder') available.push(q);
      else if (s === 'completed')                 completed.push(q);
      // 'locked' → not shown
    }

    // All content goes into one container; we shift container.y to scroll.
    const container = this.add.container(this._contentLeft, this._contentTop);
    container.setDepth(this._depth);
    container.setMask(this._contentMask);
    this._contentGroup = container;

    let relY = 0;
    const wrapW = this._contentWidth - 48;

    relY = this._renderSection(container, 'Active',    active,    relY, wrapW, pm);
    relY = this._renderSection(container, 'Available', available, relY, wrapW, pm);
    relY = this._renderSection(container, 'Completed', completed, relY, wrapW, pm);

    this._totalH = relY;
    // Clamp scroll after re-render in case content shrank
    this._scrollY = Phaser.Math.Clamp(this._scrollY, 0, this._maxScroll());
    container.y   = this._contentTop - this._scrollY;

    this._syncInteractivity(container);
  }

  _renderSection(container, title, quests, relY, wrapW, pm) {
    const collapsed = _collapsedSections.has(title);
    const arrow     = collapsed ? '▶' : '▼';
    const depth     = this._depth;

    // Section header (interactive)
    const header = this.add.text(0, relY, `${arrow}  ${title}`, {
      fontSize: '16px', color: C.sectionHeader, fontStyle: 'bold',
    }).setDepth(depth).setInteractive({ useHandCursor: true }).on('pointerdown', () => {
      if (collapsed) _collapsedSections.delete(title);
      else           _collapsedSections.add(title);
      this._renderContent();
    });
    container.add(header);
    relY += 28;

    if (!collapsed) {
      if (quests.length === 0) {
        const empty = this.add.text(18, relY, 'Nothing here yet.', {
          fontSize: '13px', color: '#555555',
        }).setDepth(depth);
        container.add(empty);
        relY += 24;
      } else {
        for (const q of quests) {
          relY = this._renderQuest(container, q, relY, wrapW, pm);
        }
      }
    }

    relY += 10; // gap between sections
    return relY;
  }

  _renderQuest(container, quest, relY, wrapW, pm) {
    const state    = getQuestState(quest, pm);
    const expanded = _expandedQuests.has(quest.id);
    const depth    = this._depth;
    const hasSteps = quest.steps.length > 0;

    // ── Quest title row ──
    const titleColor =
      state === 'completed'   ? C.questCompleted :
      state === 'placeholder' ? C.questPlaceholder :
      state === 'available'   ? C.questAvailable :
      C.questTitle;

    const expandArrow = hasSteps ? (expanded ? '▼' : '▶') : '·';
    const titleLabel  = `${expandArrow}  ${quest.title}`;

    const titleTxt = this.add.text(16, relY, titleLabel, {
      fontSize: '15px', color: titleColor, fontStyle: state === 'active' ? 'bold' : 'normal',
    }).setDepth(depth);

    if (hasSteps) {
      titleTxt.setInteractive({ useHandCursor: true }).on('pointerdown', () => {
        if (expanded) _expandedQuests.delete(quest.id);
        else          _expandedQuests.add(quest.id);
        this._renderContent();
      });
    }
    container.add(titleTxt);
    relY += ROW_H + 2;

    // ── Quest description ──
    // Show when available (not yet started), when placeholder, or when expanded
    const showDesc = state === 'available' || state === 'placeholder' || expanded;
    if (showDesc) {
      const prefix = state === 'placeholder' ? '[Coming Soon]  ' : '';
      const descTxt = this.add.text(30, relY,
        prefix + quest.description,
        { fontSize: '12px', color: state === 'placeholder' ? C.questPlaceholder : C.desc,
          wordWrap: { width: wrapW } }
      ).setDepth(depth);
      container.add(descTxt);
      relY += descTxt.height + 6;
    }

    // ── Steps (only when expanded and non-placeholder) ──
    // Upcoming steps are hidden entirely — no spoilers.
    if (expanded && hasSteps) {
      for (const step of quest.steps) {
        const stepState = getStepState(step, pm);
        if (stepState === 'upcoming') continue; // hide future objectives
        relY = this._renderStep(container, step, relY, wrapW, pm);
      }
      relY += 4;
    }

    relY += 6;
    return relY;
  }

  _renderStep(container, step, relY, wrapW, pm) {
    const state = getStepState(step, pm);
    const depth = this._depth;

    const prefix = state === 'completed' ? '✓' : '►';
    const color  = state === 'completed' ? C.stepCompleted : C.stepActive;

    const stepTxt = this.add.text(46, relY, `${prefix}  ${step.label}`, {
      fontSize: '13px', color,
    }).setDepth(depth);
    container.add(stepTxt);
    relY += 20;

    // Show description only for the active step (gives the player direction)
    if (state === 'active') {
      const desc = typeof step.description === 'function' ? step.description(pm) : step.description;
      const descTxt = this.add.text(60, relY, desc, {
        fontSize: '12px', color: '#777777', wordWrap: { width: wrapW - 30 },
      }).setDepth(depth);
      container.add(descTxt);
      relY += descTxt.height + 4;
    }

    return relY;
  }

  // ── Scroll ────────────────────────────────────────────────────────────────────

  _maxScroll() {
    return Math.max(0, this._totalH - this._contentVisH);
  }

  _scroll(delta) {
    this._scrollY = Phaser.Math.Clamp(this._scrollY + delta, 0, this._maxScroll());
    if (this._contentGroup) {
      this._contentGroup.y = this._contentTop - this._scrollY;
      this._syncInteractivity(this._contentGroup);
    }
  }

  // Disable pointer events for items scrolled outside the visible mask region.
  // Without this, invisible-but-interactive items still receive clicks.
  _syncInteractivity(container) {
    const maskTop = this._contentTop;
    const maskBot = this._contentTop + this._contentVisH;

    container.list.forEach(child => {
      if (!child?.input) return; // not interactive — skip
      const worldY = container.y + child.y;
      const h      = child.height || ROW_H;
      const inView = (worldY + h) > maskTop && worldY < maskBot;
      if (inView) child.input.enabled = true;
      else        child.input.enabled = false;
    });
  }

  // ── Close ─────────────────────────────────────────────────────────────────────

  _close() {
    const town = this.scene.get('TownScene');
    if (town?.input) town.input.enabled = true;
    // Refresh the UIScene panel so the alert dot state is recalculated.
    this.scene.get('UIScene')?.refreshUI?.();
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
