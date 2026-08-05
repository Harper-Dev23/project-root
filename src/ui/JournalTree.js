import { COLORS, FONTS } from './styles.js';

const ENTRY_HEIGHT = 32;
// Space reserved for exactly ONE chip row (the common case). A category
// with enough subtabs (long labels like "Relics & Consumables" make this
// easy to hit — Lore alone needs 3 rows: All/Armor/False Gods, Overview/
// Prophets, Relics & Consumables/Teasers) wraps onto more rows — found via
// an actual headless-browser click sweep, not just reading the code, that a
// single unwrapped row overflowed well past this panel's own right edge,
// visually colliding with the content pane. See _renderFilterBar's wrapping
// logic and _render's dynamic filterOffset (computed per-category from the
// real row count, not a fixed guess) below.
const FILTER_OFFSET_BASE = 56;
const CHIP_HEIGHT = 26;
const CHIP_ROW_GAP = 6;
const CHIP_PADDING_X = 12;
const CHIP_GAP_X = 8;

const ICON_GLYPHS = {
    'icon-journal': 'dY"-',
    'icon-scroll': 'dY"o',
    'icon-hunt': 'dYZ_',
    'icon-system': '�sT�,?',
    'icon-tribes': 'dY>-',
    'icon-island': 'dY??�,?',
    'icon-favor': 'dYT?',
    'icon-relic': 'dY-?�,?',
    'icon-stats': 'dY"S',
    'icon-weakness': '�?,�,?',
    'icon-swords': '�s"�,?'
};

function getIconGlyph(icon) {
    if (!icon) return null;
    if (ICON_GLYPHS[icon]) return ICON_GLYPHS[icon];
    if (icon.length === 1) return icon;
    return '?';
}

function normaliseSubtab(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || 'General';
}

export default class JournalTree extends Phaser.GameObjects.Container {
    constructor(scene, x, y, width, height, { onSelect, onSubtabSelect } = {}) {
        super(scene, x, y);
        this.setSize(width, height);
        this.panelWidth = width;
        this.panelHeight = height;
        this.onSelect = onSelect;
        this.onSubtabSelect = onSubtabSelect;

        this.background = scene.add.rectangle(0, 0, width, height, COLORS.panel, 0.85)
            .setOrigin(0)
            .setStrokeStyle(1, COLORS.border);

        this.filterBar = scene.add.container(12, 10);

        // Recomputed per-render from the real chip row count (see
        // _renderFilterBar/_render) — starts at the 1-row default so a
        // category with no subtabs (filterBar hidden) uses the normal,
        // maximal list height.
        this.filterOffset = FILTER_OFFSET_BASE;

        this.scrollArea = scene.add.container(0, 0);
        this.listContainer = scene.add.container(0, this.filterOffset);
        this.scrollArea.add(this.listContainer);

        this.scrollMaskGfx = scene.make.graphics({ x: 0, y: 0, add: false });
        this._redrawMask();
        this.scrollMask = this.scrollMaskGfx.createGeometryMask();
        this.scrollArea.setMask(this.scrollMask);

        this._syncMaskPosition = () => {
            const matrix = this.getWorldTransformMatrix?.();
            if (!matrix) return;
            this.scrollMaskGfx.setPosition(matrix.tx, matrix.ty);
        };
        scene.events.on('postupdate', this._syncMaskPosition);
        this._syncMaskPosition();

        this.add([this.background, this.filterBar, this.scrollArea]);

        // Scroll listener lives on the SCENE's global input instead of this
        // container's own 'wheel' event. Each entry row below has an
        // interactive hit zone covering nearly the full row width, and with
        // Phaser's topOnly hit-testing (on by default, never overridden
        // here), the row zone — having no 'wheel' listener of its own —
        // wins the hit test and swallows the event before it can bubble to
        // this container. Checking the pointer against our own world
        // bounds directly (same pattern InventoryOverlay's _onWheel uses)
        // sidesteps the topOnly conflict entirely.
        this._onWheel = (pointer, _gameObjects, _dx, dy) => {
            const matrix = this.getWorldTransformMatrix?.();
            if (!matrix) return;
            const mx = pointer.worldX;
            const my = pointer.worldY;
            if (mx >= matrix.tx && mx <= matrix.tx + this.panelWidth && my >= matrix.ty && my <= matrix.ty + this.panelHeight) {
                this.scrollBy(dy);
            }
        };
        scene.input.on('wheel', this._onWheel);

        this.entries = [];
        this.activeEntryId = null;
        this.unseen = new Set();
        this.activeCategory = null;
        this.activeSubtab = null;
        this.subtabs = [];
        this._contentHeight = 0;

        scene.add.existing(this);
    }

    destroy(fromScene) {
        this.scene?.events?.off('postupdate', this._syncMaskPosition);
        this.scene?.input?.off('wheel', this._onWheel);
        this.scrollArea?.clearMask?.();
        this.scrollMask?.destroy();
        this.scrollMaskGfx?.destroy();
        super.destroy(fromScene);
    }

    // Redraws the scroll mask using this.filterOffset — called once at
    // construction and again any time _render() recomputes filterOffset
    // from the current category's real subtab row count.
    _redrawMask() {
        this.scrollMaskGfx.clear();
        this.scrollMaskGfx.fillStyle(0xffffff);
        this.scrollMaskGfx.fillRect(0, this.filterOffset, this.panelWidth, this.panelHeight - this.filterOffset);
    }

    scrollBy(delta) {
        const visibleHeight = this.panelHeight - this.filterOffset;
        const maxScroll = Math.max(0, this._contentHeight - visibleHeight);
        this.scrollArea.y = Phaser.Math.Clamp(this.scrollArea.y - delta, -maxScroll, 0);
        this._syncRowInteractivity();
    }

    // Geometry masks (scrollMask above) clip RENDERING only, not pointer
    // hit-testing — a row scrolled out of view still has a fully live
    // interactive zone sitting wherever the scroll happens to have left it,
    // which can land on top of the bottom bar or another panel and silently
    // steal its clicks. Same bug (and same fix) as InventoryOverlay's own
    // _syncInteractivity — disable/re-enable each row's hit zone based on
    // whether it's actually inside the visible mask window right now.
    _syncRowInteractivity() {
        const viewTop = this.filterOffset;
        const viewBottom = this.panelHeight;
        for (const row of this.listContainer.list) {
            const hitArea = row?._hitArea;
            if (!hitArea) continue;
            const rowTop = this.scrollArea.y + this.filterOffset + row.y;
            const rowBottom = rowTop + ENTRY_HEIGHT;
            const inView = rowBottom > viewTop && rowTop < viewBottom;
            if (inView) {
                // BUG (found via user report, not caught on first pass): once
                // disableInteractive() runs once, hitArea.input stays a
                // truthy (but disabled) object forever — `!hitArea.input`
                // never becomes true again, so a row that scrolled out of
                // view could never be re-enabled even after scrolling back.
                // That's what made rows "permanently" unclickable after any
                // scroll. Check .enabled specifically instead of truthiness.
                if (!hitArea.input || !hitArea.input.enabled) hitArea.setInteractive({ useHandCursor: true });
            } else if (hitArea.input?.enabled) {
                hitArea.disableInteractive();
            }
        }
    }

    setData({
        categories = [],
        entries = [],
        activeEntryId = null,
        unseen = new Set(),
        activeCategory = null,
        activeSubtab = null
    } = {}) {
        const prevCategory = this.activeCategory;
        const prevSubtab = this.activeSubtab;

        this.categoryOrder = Array.isArray(categories) ? [...categories] : [];
        this.entries = Array.isArray(entries) ? [...entries] : [];
        this.activeEntryId = activeEntryId;
        this.unseen = unseen instanceof Set ? unseen : new Set(unseen);
        this.activeCategory = activeCategory || null;
        this.activeSubtab = activeSubtab || null;

        this._computeSubtabs();

        if (prevCategory !== this.activeCategory || prevSubtab !== this.activeSubtab) {
            this.scrollArea.y = 0;
        }

        this._render();
    }

    _computeSubtabs() {
        if (!Array.isArray(this.entries) || !this.entries.length || !this.activeCategory || this.activeCategory === 'index') {
            this.subtabs = [];
            return;
        }
        const set = new Set();
        for (const entry of this.entries) {
            if (this.activeCategory && entry.category !== this.activeCategory) continue;
            set.add(normaliseSubtab(entry.subtab));
        }
        this.subtabs = Array.from(set).sort((a, b) => a.localeCompare(b));
    }

    _render() {
        this.filterBar.removeAll(true);
        this.listContainer.removeAll(true);

        const showFilters = !!this.activeCategory && this.activeCategory !== 'index';
        this.filterBar.setVisible(showFilters);
        const rowsUsed = showFilters ? this._renderFilterBar() : 0;

        // Reserve exactly as much vertical space as the filter bar's real
        // chip-row count needs this render (see FILTER_OFFSET_BASE comment
        // above) — a fixed guess left categories like "Lore" (3 rows)
        // overlapping the entry list below.
        this.filterOffset = showFilters
            ? FILTER_OFFSET_BASE + (rowsUsed - 1) * (CHIP_HEIGHT + CHIP_ROW_GAP)
            : FILTER_OFFSET_BASE;
        this.listContainer.y = this.filterOffset;
        this._redrawMask();

        const categoryEntries = this.entries.filter(entry => {
            if (this.activeCategory && entry.category !== this.activeCategory) return false;
            return true;
        });

        if (!categoryEntries.length) {
            this._renderEmptyState('No entries available.');
            return;
        }

        const filteredEntries = categoryEntries.filter(entry => {
            if (!this.activeSubtab) return true;
            return normaliseSubtab(entry.subtab) === this.activeSubtab;
        });

        if (!filteredEntries.length) {
            this._renderEmptyState('No entries in this sub-section yet.');
            return;
        }

        const sorted = [...filteredEntries].sort((a, b) => {
            const orderA = Number.isFinite(a.order) ? a.order : Number.isFinite(a.sort) ? a.sort : 999;
            const orderB = Number.isFinite(b.order) ? b.order : Number.isFinite(b.sort) ? b.sort : 999;
            if (orderA !== orderB) return orderA - orderB;
            return (a.title || '').localeCompare(b.title || '');
        });

        let cursorY = 0;
        for (const entry of sorted) {
            const row = this._createEntryRow(entry, cursorY);
            this.listContainer.add(row);
            cursorY += ENTRY_HEIGHT;
        }

        this._contentHeight = cursorY;
        this._clampScroll();
        this._syncRowInteractivity();
    }

    _renderFilterBar() {
        const chips = ['All', ...this.subtabs];
        // Wraps onto a second row instead of running past the panel's own
        // right edge — a category with enough subtabs (long labels like
        // "Relics & Consumables" make this easy to hit) used to overflow a
        // single unwrapped row well into the content pane on the right.
        // Budget matches this panel's own width (see the constructor's
        // `width` param) minus the filterBar's x=12 offset and a small
        // right margin.
        const maxRowWidth = Math.max(80, this.panelWidth - 12 - 12);
        let cursorX = 0;
        let cursorY = 0;
        let rowCount = 1;
        for (const label of chips) {
            const isAll = label === 'All';
            const value = isAll ? null : label;
            const active = isAll ? !this.activeSubtab : this.activeSubtab === label;
            const chip = this._createFilterChip(label, value, active);
            if (cursorX > 0 && cursorX + chip.width > maxRowWidth) {
                cursorX = 0;
                cursorY += CHIP_HEIGHT + CHIP_ROW_GAP;
                rowCount += 1;
            }
            chip.setPosition(cursorX, cursorY);
            cursorX += chip.width + CHIP_GAP_X;
            this.filterBar.add(chip);
        }
        return rowCount;
    }

    _createFilterChip(label, value, active) {
        const container = this.scene.add.container(0, 0);
        const text = this.scene.add.text(CHIP_PADDING_X, CHIP_HEIGHT / 2, label, {
            ...FONTS.button,
            fontSize: '14px',
            color: active ? '#ffddaa' : '#bbbbbb'
        }).setOrigin(0, 0.5);
        const width = text.width + CHIP_PADDING_X * 2;
        const bg = this.scene.add.rectangle(0, CHIP_HEIGHT / 2, width, CHIP_HEIGHT, active ? 0x38301f : 0x000000, active ? 0.65 : 0.35)
            .setOrigin(0, 0.5)
            .setStrokeStyle(1, active ? 0xffddaa : 0x444444, active ? 0.9 : 0.5)
            .setInteractive({ useHandCursor: true });

        bg.on('pointerdown', () => this._handleSubtabSelect(value));
        bg.on('pointerover', () => {
            if (active) return;
            bg.setFillStyle(0x1f1f1f, 0.6);
        });
        bg.on('pointerout', () => {
            if (active) return;
            bg.setFillStyle(0x000000, 0.35);
        });

        container.add([bg, text]);
        container.setSize(width, CHIP_HEIGHT);
        return container;
    }

    _handleSubtabSelect(subtabValue) {
        const normalised = subtabValue || null;
        if (this.activeSubtab === normalised) return;
        this.onSubtabSelect?.(normalised);
    }

    _renderEmptyState(message) {
        const text = this.scene.add.text(20, 12, message, {
            ...FONTS.body,
            fontSize: '16px',
            color: '#999999'
        }).setOrigin(0, 0);
        this.listContainer.add(text);
        this._contentHeight = ENTRY_HEIGHT;
        this._clampScroll();
    }

    _createEntryRow(entry, y) {
        const container = this.scene.add.container(0, y);

        const bg = this.scene.add.rectangle(this.panelWidth / 2, ENTRY_HEIGHT / 2, this.panelWidth - 20, ENTRY_HEIGHT - 4, 0x000000, 0.18)
            .setOrigin(0.5);

        // Badge measured before the title so a long title can be truncated
        // against the space actually left over — long titles (e.g. "Items &
        // Equipment", "The Divine Structure of Behelith") used to render
        // straight through the "NEW" badge with no truncation at all.
        const isNew = this.unseen.has(entry.id);
        const badge = isNew
            ? this.scene.add.text(this.panelWidth - 24, ENTRY_HEIGHT / 2, 'NEW', { ...FONTS.muted, color: '#6FE3B6' }).setOrigin(1, 0.5)
            : null;

        const text = this.scene.add.text(28, ENTRY_HEIGHT / 2, entry.title, {
            ...FONTS.body,
            fontSize: '16px',
            color: '#f0f0f0'
        }).setOrigin(0, 0.5);
        const maxTitleWidth = this.panelWidth - 20 - 28 - (badge ? badge.width + 10 : 10);
        this._truncateRowTitle(text, maxTitleWidth);

        const glyph = getIconGlyph(entry.icon);
        const icon = glyph
            ? this.scene.add.text(12, ENTRY_HEIGHT / 2, glyph, { ...FONTS.body, fontSize: '14px', color: '#ffbe78' }).setOrigin(0.5)
            : null;

        if (this.activeEntryId === entry.id) {
            bg.setFillStyle(0x2a2a2a, 0.9);
        }

        const hitArea = this.scene.add.zone((this.panelWidth - 20) / 2 + 10, ENTRY_HEIGHT / 2, this.panelWidth - 20, ENTRY_HEIGHT)
            .setOrigin(0.5)
            .setInteractive({ useHandCursor: true });

        hitArea.on('pointerover', () => {
            if (this.activeEntryId === entry.id) return;
            bg.setFillStyle(0x333333, 0.9);
        });
        hitArea.on('pointerout', () => {
            if (this.activeEntryId === entry.id) {
                bg.setFillStyle(0x2a2a2a, 0.9);
            } else {
                bg.setFillStyle(0x000000, 0.18);
            }
        });
        hitArea.on('pointerdown', () => {
            this.onSelect?.(entry.id);
        });

        container.add([bg, text, hitArea]);
        if (icon) container.add(icon);
        if (badge) container.add(badge);

        // Stashed so _syncRowInteractivity can find it without searching
        // this container's children every scroll/render.
        container._hitArea = hitArea;

        return container;
    }

    _truncateRowTitle(textObj, maxWidth) {
        if (textObj.width <= maxWidth) return;
        let truncated = textObj.text;
        while (truncated.length > 1 && textObj.width > maxWidth) {
            truncated = truncated.slice(0, -1);
            textObj.setText(truncated + '…');
        }
    }

    _clampScroll() {
        const visibleHeight = this.panelHeight - this.filterOffset;
        const maxScroll = Math.max(0, this._contentHeight - visibleHeight);
        this.scrollArea.y = Phaser.Math.Clamp(this.scrollArea.y, -maxScroll, 0);
    }
}
