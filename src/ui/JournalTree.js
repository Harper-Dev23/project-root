import { COLORS, FONTS } from './styles.js';

const CATEGORY_LABEL_STYLE = {
    ...FONTS.button,
    fontSize: '18px',
    color: '#cccccc'
};

const ENTRY_STYLE = {
    ...FONTS.body,
    fontSize: '16px',
    color: '#f0f0f0'
};

const ENTRY_HEIGHT = 32;

export default class JournalTree extends Phaser.GameObjects.Container {
    constructor(scene, x, y, width, height, { onSelect } = {}) {
        super(scene, x, y);
        this.setSize(width, height);
        this.panelWidth = width;
        this.panelHeight = height;
        this.onSelect = onSelect;

        this.background = scene.add.rectangle(0, 0, width, height, COLORS.panel, 0.85)
            .setOrigin(0)
            .setStrokeStyle(1, COLORS.border);

        this.scrollArea = scene.add.container(0, 0);
        this.scrollMaskGfx = scene.add.graphics({ x: 0, y: 0 });
        this.scrollMaskGfx.fillStyle(0xffffff);
        this.scrollMaskGfx.fillRect(0, 0, width, height);
        const mask = this.scrollMaskGfx.createGeometryMask();
        this.scrollArea.setMask(mask);

        this.add([this.background, this.scrollArea]);

        this.setInteractive(new Phaser.Geom.Rectangle(0, 0, width, height), Phaser.Geom.Rectangle.Contains);
        this.on('wheel', (pointer, dx, dy) => {
            this.scrollBy(dy);
        });

        this.entries = [];
        this.categoryOrder = [];
        this.activeEntryId = null;
        this.unseen = new Set();

        scene.add.existing(this);
    }

    destroy(fromScene) {
        this.scrollMaskGfx?.destroy();
        super.destroy(fromScene);
    }

    scrollBy(delta) {
        const contentHeight = this.scrollArea.list?.length ? this.scrollArea.getBounds().height : 0;
        const maxScroll = Math.max(0, contentHeight - this.panelHeight + 16);
        this.scrollArea.y = Phaser.Math.Clamp(this.scrollArea.y - delta, -maxScroll, 0);
    }

    setData({ categories = [], entries = [], activeEntryId = null, unseen = new Set() }) {
        this.entries = entries;
        this.categoryOrder = categories;
        this.activeEntryId = activeEntryId;
        this.unseen = unseen instanceof Set ? unseen : new Set(unseen);
        this._render();
    }

    _render() {
        this.scrollArea.removeAll(true);
        let cursorY = 12;

        if (!this.entries.length) {
            const empty = this.scene.add.text(20, cursorY, 'No entries available.', {
                ...FONTS.body,
                fontSize: '16px',
                color: '#999999'
            }).setOrigin(0, 0);
            this.scrollArea.add(empty);
            return;
        }

        for (const category of this.categoryOrder) {
            const inCategory = this.entries.filter(e => e.category === category.id);
            if (!inCategory.length) continue;

            const header = this.scene.add.text(16, cursorY, category.label, CATEGORY_LABEL_STYLE)
                .setOrigin(0, 0)
                .setAlpha(0.8);
            this.scrollArea.add(header);
            cursorY += 28;

            const sorted = [...inCategory].sort((a, b) => (a.sort - b.sort) || a.title.localeCompare(b.title));
            for (const entry of sorted) {
                const row = this._createEntryRow(entry, cursorY);
                this.scrollArea.add(row);
                cursorY += ENTRY_HEIGHT;
            }

            cursorY += 12;
        }
    }

    _createEntryRow(entry, y) {
        const container = this.scene.add.container(0, y);

        const bg = this.scene.add.rectangle(this.panelWidth / 2, ENTRY_HEIGHT / 2, this.panelWidth - 20, ENTRY_HEIGHT - 4, 0x000000, 0.15)
            .setOrigin(0.5);

        const text = this.scene.add.text(20, 6, entry.title, ENTRY_STYLE)
            .setOrigin(0, 0);

        const icon = entry.icon
            ? this.scene.add.text(4, 6, entry.icon, { ...ENTRY_STYLE, fontSize: '14px', color: '#ffaa55' }).setOrigin(0, 0)
            : null;

        const isNew = this.unseen.has(entry.id);
        const badge = isNew
            ? this.scene.add.text(this.panelWidth - 60, 6, 'NEW', { ...FONTS.muted, color: '#6FE3B6' }).setOrigin(0, 0)
            : null;

        if (this.activeEntryId === entry.id) {
            bg.setFillStyle(0x2a2a2a, 0.9);
        }

        const hitArea = this.scene.add.zone((this.panelWidth - 20) / 2 + 10, ENTRY_HEIGHT / 2, this.panelWidth - 20, ENTRY_HEIGHT)
            .setOrigin(0.5)
            .setInteractive({ useHandCursor: true });

        hitArea.on('pointerover', () => bg.setFillStyle(0x333333, 0.9));
        hitArea.on('pointerout', () => {
            if (this.activeEntryId === entry.id) {
                bg.setFillStyle(0x2a2a2a, 0.9);
            } else {
                bg.setFillStyle(0x000000, 0.15);
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
}