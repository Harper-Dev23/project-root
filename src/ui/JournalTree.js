import { COLORS, FONTS } from './styles.js';

const ENTRY_HEIGHT = 32;
const FILTER_OFFSET = 56;
const CHIP_HEIGHT = 26;
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

        this.scrollArea = scene.add.container(0, 0);
        this.listContainer = scene.add.container(0, FILTER_OFFSET);
        this.scrollArea.add(this.listContainer);

        this.scrollMaskGfx = scene.make.graphics({ x: 0, y: 0, add: false });
        this.scrollMaskGfx.fillStyle(0xffffff);
        this.scrollMaskGfx.fillRect(0, FILTER_OFFSET, width, height - FILTER_OFFSET);
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

        this.setInteractive(new Phaser.Geom.Rectangle(0, 0, width, height), Phaser.Geom.Rectangle.Contains);
        this.on('wheel', (_, __, dy) => {
            this.scrollBy(dy);
        });

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
        this.scrollArea?.clearMask?.();
        this.scrollMask?.destroy();
        this.scrollMaskGfx?.destroy();
        super.destroy(fromScene);
    }

    scrollBy(delta) {
        const visibleHeight = this.panelHeight - FILTER_OFFSET;
        const maxScroll = Math.max(0, this._contentHeight - visibleHeight);
        this.scrollArea.y = Phaser.Math.Clamp(this.scrollArea.y - delta, -maxScroll, 0);
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
        if (showFilters) {
            this._renderFilterBar();
        }

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
    }

    _renderFilterBar() {
        const chips = ['All', ...this.subtabs];
        let cursorX = 0;
        for (const label of chips) {
            const isAll = label === 'All';
            const value = isAll ? null : label;
            const active = isAll ? !this.activeSubtab : this.activeSubtab === label;
            const chip = this._createFilterChip(label, value, active);
            chip.setPosition(cursorX, 0);
            cursorX += chip.width + CHIP_GAP_X;
            this.filterBar.add(chip);
        }
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

        const text = this.scene.add.text(28, ENTRY_HEIGHT / 2, entry.title, {
            ...FONTS.body,
            fontSize: '16px',
            color: '#f0f0f0'
        }).setOrigin(0, 0.5);

        const glyph = getIconGlyph(entry.icon);
        const icon = glyph
            ? this.scene.add.text(12, ENTRY_HEIGHT / 2, glyph, { ...FONTS.body, fontSize: '14px', color: '#ffbe78' }).setOrigin(0.5)
            : null;

        const isNew = this.unseen.has(entry.id);
        const badge = isNew
            ? this.scene.add.text(this.panelWidth - 24, ENTRY_HEIGHT / 2, 'NEW', { ...FONTS.muted, color: '#6FE3B6' }).setOrigin(1, 0.5)
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

        return container;
    }

    _clampScroll() {
        const visibleHeight = this.panelHeight - FILTER_OFFSET;
        const maxScroll = Math.max(0, this._contentHeight - visibleHeight);
        this.scrollArea.y = Phaser.Math.Clamp(this.scrollArea.y, -maxScroll, 0);
    }
}
