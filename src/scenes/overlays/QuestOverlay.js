import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { QUEST_LINES, QUEST_CATEGORIES, getStepState, getQuestState } from '../../data/quests.js';
import ProgressionManager from '../../systems/ProgressionManager.js';

// ── Visual constants ──────────────────────────────────────────────────────────

const C = {
  sectionHeader:   '#c8a060',
  questTitle:      '#ffffcc',
  questAvailable:  '#aaccaa',
  questCompleted:  '#666666',
  questPlaceholder:'#7777aa',
  stepActive:      '#ffdd44',
  stepCompleted:   '#555555',
  stepUpcoming:    '#888888',
  desc:            '#999999',
  tabActive:       '#ffdd88',
  tabInactive:     '#888888',
  divider:         0x5a4a3a,
  accent:          0xc8a060,
};

const TAB_W = 120;
const TAB_H = 26;
const ROW_H = 22;

export default class QuestOverlay extends Phaser.Scene {
  constructor() {
    super({ key: 'QuestOverlay' });
  }

  create() {
    const town = this.scene.get('TownScene');
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

    // Scroll state
    this._scrollY = 0;

    // Toggle state — persists across re-renders within the same session
    this._collapsedSections = new Set();  // 'Active' | 'Available' | 'Completed'
    this._expandedQuests    = new Set();  // quest id strings

    // Mask for the scrollable content area (use add.graphics so WebGL transform is correct)
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

      this._tabBtns[id] = { bg, lbl, underline };
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
    this._expandedQuests.clear();   // reset expansions when switching tabs

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
    const collapsed = this._collapsedSections.has(title);
    const arrow     = collapsed ? '▶' : '▼';
    const depth     = this._depth;

    // Section header (interactive)
    const header = this.add.text(0, relY, `${arrow}  ${title}`, {
      fontSize: '16px', color: C.sectionHeader, fontStyle: 'bold',
    }).setDepth(depth).setInteractive({ useHandCursor: true }).on('pointerdown', () => {
      if (collapsed) this._collapsedSections.delete(title);
      else           this._collapsedSections.add(title);
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
    const expanded = this._expandedQuests.has(quest.id);
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
        if (expanded) this._expandedQuests.delete(quest.id);
        else          this._expandedQuests.add(quest.id);
        this._renderContent();
      });
    }
    container.add(titleTxt);
    relY += ROW_H + 2;

    // ── Quest description ──
    // Show description when available (not yet started), or when expanded
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
    if (expanded && hasSteps) {
      for (const step of quest.steps) {
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

    const prefix = state === 'completed' ? '✓' : state === 'active' ? '►' : '·';
    const color  =
      state === 'completed' ? C.stepCompleted :
      state === 'active'    ? C.stepActive    :
      C.stepUpcoming;

    const stepTxt = this.add.text(46, relY, `${prefix}  ${step.label}`, {
      fontSize: '13px', color,
    }).setDepth(depth);
    container.add(stepTxt);
    relY += 20;

    // Show description only for the active step (gives the player direction)
    if (state === 'active') {
      const descTxt = this.add.text(60, relY, step.description, {
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
  // Only touches objects that have an input handler — static text is unaffected.
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
    this.scene.resume('UIScene');
    this.scene.stop();
  }
}
