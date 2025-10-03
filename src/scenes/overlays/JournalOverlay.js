import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { JOURNAL_CATEGORIES } from '../../../data/journal/manifest.js';
import { JOURNAL_ENTRIES } from '../../../data/journal/entries.seed.js';
import JournalTree from '../../ui/JournalTree.js';
import JournalContent from '../../ui/JournalContent.js';
import JournalIndex from '../../systems/JournalIndex.js';
import { JournalState } from '../../systems/JournalState.js';
import { FONTS } from '../../ui/styles.js';

const LEFT_WIDTH = 280;
const TOP_BAR_HEIGHT = 70;
const BOTTOM_BAR_HEIGHT = 56;
const TAB_HEIGHT = 28;

function wrap(value, min, max) {
    const range = max - min;
    if (range <= 0) return min;
    const mod = (value - min) % range;
    const normalized = mod < 0 ? mod + range : mod;
    return normalized + min;
}

function readDarkMode() {
    try {
        if (typeof localStorage === 'undefined') return true;
        const stored = localStorage.getItem('ui.theme');
        if (!stored) return true;
        return stored === 'dark';
    } catch (err) {
        return true;
    }
}

class JournalOverlayView extends Phaser.GameObjects.Container {
    constructor(scene, bounds, { onClose } = {}) {
        super(scene, bounds.x, bounds.y);
        this.setSize(bounds.width, bounds.height);
        this.onClose = onClose;

        this.categories = JOURNAL_CATEGORIES.filter(cat => cat.id !== 'index');
        this.virtualIndexCategory = JOURNAL_CATEGORIES.find(cat => cat.id === 'index');

        this.index = new JournalIndex(JOURNAL_ENTRIES);
        this.entries = [...JOURNAL_ENTRIES];
        this.indexEntries = [];

        this.currentCategory = this.categories[0]?.id || 'lore';
        this.currentEntryId = null;
        this.tagFilter = [];
        this.searchQuery = '';

        this.darkMode = readDarkMode();

        this.unseenSet = new Set(
            this.entries
                .filter(entry => JournalState.isUnlockedEntry(entry))
                .map(entry => entry.id)
                .filter(id => !JournalState.seenEntries.has(id))
        );

        this._buildUI(bounds);
        this._bindStateEvents();
        this._bindInput();

        scene.add.existing(this);
    }

    _buildUI(bounds) {
        const { scene } = this;

        this.background = scene.add.rectangle(0, 0, bounds.width, bounds.height, this.darkMode ? 0x171717 : 0xf3ede0, 0.92)
            .setOrigin(0);

        // Top bar
        this.topBar = scene.add.rectangle(0, 0, bounds.width, TOP_BAR_HEIGHT, this.darkMode ? 0x1a1a1a : 0xeeeeee, 0.9)
            .setOrigin(0);
        this.breadcrumbText = scene.add.text(20, 18, 'Journal', {
            ...FONTS.body,
            fontSize: '18px',
            color: this.darkMode ? '#f8f8f8' : '#222222'
        }).setOrigin(0, 0);

        this.tabContainer = scene.add.container(20, TOP_BAR_HEIGHT - TAB_HEIGHT);
        this._buildTabs();

        this.searchDom = scene.add.dom(bounds.width - 240, TOP_BAR_HEIGHT / 2).createFromHTML(`
      <input type="text" placeholder="Search journal" style="width:200px;padding:6px 10px;border-radius:6px;border:1px solid #666;background:${this.darkMode ? '#1f1f1f' : '#ffffff'};color:${this.darkMode ? '#f8f8f8' : '#1a1a1a'};">
    `);
        this.searchDom.setOrigin(0, 0.5);
        this.searchDom.addListener('input');
        this.searchDom.on('input', (event) => {
            const value = event.target.value;
            this.searchQuery = value;
            this._applySearch(value);
        });
        const searchNode = this.searchDom.node;
        if (searchNode) {
            this._searchKeyHandler = (event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                    const entries = this._getVisibleEntries();
                    const first = entries[0];
                    if (first) {
                        this.openEntry(first.id);
                        event.preventDefault();
                    }
                } else if (event.key === 'Escape') {
                    if (this.searchQuery) {
                        this.searchQuery = '';
                        if (this.searchDom?.node) {
                            this.searchDom.node.value = '';
                        }
                        this._applySearch('');
                        event.preventDefault();
                    }
                    searchNode.blur();
                }
            };
            searchNode.addEventListener('keydown', this._searchKeyHandler);
        }
        // Left tree
        this.tree = new JournalTree(scene, 20, TOP_BAR_HEIGHT + 12, LEFT_WIDTH - 40, bounds.height - TOP_BAR_HEIGHT - BOTTOM_BAR_HEIGHT - 24, {
            onSelect: (entryId) => this.openEntry(entryId)
        });

        // Right content area
        const contentX = LEFT_WIDTH + 20;
        const contentWidth = bounds.width - contentX - 20;
        const contentHeight = bounds.height - TOP_BAR_HEIGHT - BOTTOM_BAR_HEIGHT - 24;
        this.content = new JournalContent(scene, contentX, TOP_BAR_HEIGHT + 12, contentWidth, contentHeight, {
            onNavigate: (entryId) => this.openEntry(entryId)
        });

        // Bottom bar
        this.bottomBar = scene.add.rectangle(0, bounds.height - BOTTOM_BAR_HEIGHT, bounds.width, BOTTOM_BAR_HEIGHT, this.darkMode ? 0x1a1a1a : 0xeeeeee, 0.9)
            .setOrigin(0);
        this.bottomText = scene.add.text(20, bounds.height - BOTTOM_BAR_HEIGHT + 16, '', {
            ...FONTS.body,
            fontSize: '16px',
            color: this.darkMode ? '#dddddd' : '#222222'
        }).setOrigin(0, 0);
        this.bottomText.setText('Select an entry to browse.');
        this.prevButton = this._createBottomButton(bounds.width - 220, bounds.height - BOTTOM_BAR_HEIGHT / 2, '◀ Prev', () => this._stepEntry(-1));
        this.nextButton = this._createBottomButton(bounds.width - 120, bounds.height - BOTTOM_BAR_HEIGHT / 2, 'Next ▶', () => this._stepEntry(1));
        this.pinButton = this._createBottomButton(bounds.width - 320, bounds.height - BOTTOM_BAR_HEIGHT / 2, '⭐ Pin', () => this._togglePin());

        this.add([
            this.background,
            this.topBar,
            this.breadcrumbText,
            this.tabContainer,
            this.searchDom,
            this.tree,
            this.content,
            this.bottomBar,
            this.bottomText,
            this.prevButton,
            this.nextButton,
            this.pinButton
        ]);
    }

    _createBottomButton(x, y, label, handler) {
        const btn = this.scene.add.text(x, y, label, {
            ...FONTS.button,
            fontSize: '16px',
            color: '#ffffff',
            backgroundColor: '#3a3a3a',
            padding: { x: 12, y: 6 }
        }).setOrigin(0.5);
        btn.setInteractive({ useHandCursor: true });
        btn.on('pointerdown', handler);
        btn.on('pointerover', () => btn.setStyle({ backgroundColor: '#505050' }));
        btn.on('pointerout', () => btn.setStyle({ backgroundColor: '#3a3a3a' }));
        return btn;
    }

    _buildTabs() {
        this.tabContainer.removeAll(true);
        const tabs = this.virtualIndexCategory
            ? [...this.categories, this.virtualIndexCategory]
            : [...this.categories];
        let cursorX = 0;
        this.tabButtons = new Map();
        for (const tab of tabs) {
            const label = this.scene.add.text(12, TAB_HEIGHT / 2, tab.label, {
                ...FONTS.button,
                fontSize: '16px',
                color: this.currentCategory === tab.id ? '#ffddaa' : '#bbbbbb'
            }).setOrigin(0, 0.5);

            const width = label.width + 24;
            const container = this.scene.add.container(cursorX, 0);
            const bg = this.scene.add.rectangle(0, TAB_HEIGHT / 2, width, TAB_HEIGHT, 0x000000, 0.25)
                .setOrigin(0, 0.5)
                .setStrokeStyle(1, 0x444444, 0.4);
            const hit = this.scene.add.zone(width / 2, TAB_HEIGHT / 2, width, TAB_HEIGHT)
                .setOrigin(0.5)
                .setInteractive({ useHandCursor: true });

            hit.on('pointerdown', () => this.showCategory(tab.id));
            hit.on('pointerover', () => {
                if (this.currentCategory === tab.id) return;
                bg.setFillStyle(0x222222, 0.4);
            });
            hit.on('pointerout', () => {
                if (this.currentCategory === tab.id) return;
                bg.setFillStyle(0x000000, 0.25);
            });

            container.add([bg, label, hit]);
            this.tabContainer.add(container);
            this.tabButtons.set(tab.id, { label, bg });
            cursorX += width + 12;
        }
    }

    _bindStateEvents() {
        this.unsubSeen = JournalState.on('journal:seen', ({ entryId }) => {
            this.unseenSet.delete(entryId);
            this._refreshTree();
            this._updateBottom();
        });
        this.unsubUnlocks = JournalState.on('journal:new-unlocks', ({ entryIds }) => {
            for (const id of entryIds) {
                if (!JournalState.seenEntries.has(id)) {
                    this.unseenSet.add(id);
                }
            }
            this._refreshTree();
            this._updateBottom();
        });
    }

    _bindInput() {
        const keyboard = this.scene.input?.keyboard;
        if (!keyboard) return;

        const skipIfTyping = (fn) => () => {
            if (this._isSearchFocused()) return;
            fn();
        };

        const onPrevTab = skipIfTyping(() => this._cycleCategory(-1));
        const onNextTab = skipIfTyping(() => this._cycleCategory(1));
        const onPrevEntry = skipIfTyping(() => this._stepEntry(-1));
        const onNextEntry = skipIfTyping(() => this._stepEntry(1));
        const onClose = () => {
            if (this._isSearchFocused()) {
                this.searchDom?.node?.blur?.();
            }
            this.close();
        };

        keyboard.on('keydown-Q', onPrevTab, this);
        keyboard.on('keydown-E', onNextTab, this);
        keyboard.on('keydown-LEFT', onPrevEntry, this);
        keyboard.on('keydown-RIGHT', onNextEntry, this);
        keyboard.on('keydown-UP', onPrevEntry, this);
        keyboard.on('keydown-DOWN', onNextEntry, this);
        keyboard.on('keydown-ESC', onClose, this);
        keyboard.on('keydown-B', onClose, this);

        this.inputCleanup = () => {
            keyboard.off('keydown-Q', onPrevTab, this);
            keyboard.off('keydown-E', onNextTab, this);
            keyboard.off('keydown-LEFT', onPrevEntry, this);
            keyboard.off('keydown-RIGHT', onNextEntry, this);
            keyboard.off('keydown-UP', onPrevEntry, this);
            keyboard.off('keydown-DOWN', onNextEntry, this);
            keyboard.off('keydown-ESC', onClose, this);
            keyboard.off('keydown-B', onClose, this);
        };
    }

    _isSearchFocused() {
        const node = this.searchDom?.node;
        if (!node || typeof document === 'undefined') return false;
        return document.activeElement === node;
    }

    destroy(fromScene) {
        this.unsubSeen?.();
        this.unsubUnlocks?.();
        this.inputCleanup?.();
        if (this._searchKeyHandler) {
            this.searchDom?.node?.removeEventListener('keydown', this._searchKeyHandler);
            this._searchKeyHandler = null;
        }
        this.searchDom?.removeListener?.('input');
        super.destroy(fromScene);
    }

    open(entryId = null) {
        this._refreshTree();
        if (entryId) {
            this.openEntry(entryId);
        } else {
            const firstEntry = this._getVisibleEntries()[0];
            if (firstEntry) this.openEntry(firstEntry.id);
        }
    }

    close() {
        this.onClose?.();
    }

    showCategory(categoryId) {
        if (categoryId === 'index') {
            this.currentCategory = 'index';
            this._highlightTabs();
            if (this.searchQuery) {
                this._applySearch(this.searchQuery);
            } else {
                this._renderIndexCategory([]);
            }
            return;
        }
        if (this.currentCategory === categoryId) return;
        this.currentCategory = categoryId;
        this._highlightTabs();
        this._refreshTree();
        const entries = this._getVisibleEntries();
        if (entries.length) {
            this.openEntry(entries[0].id);
        } else {
            this.content.setEntry(null);
        }
    }

    _highlightTabs() {
        this.tabButtons?.forEach(({ label, bg }, id) => {
            const active = this.currentCategory === id;
            label.setStyle({ color: active ? '#ffddaa' : '#bbbbbb' });
            bg.setFillStyle(active ? 0x38301f : 0x000000, active ? 0.6 : 0.25);
            bg.setStrokeStyle(1, active ? 0xffddaa : 0x444444, active ? 0.8 : 0.4);
        });
        const categoryList = [...this.categories];
        if (this.virtualIndexCategory) categoryList.push(this.virtualIndexCategory);
        const activeEntry = this.currentEntryId
            ? this.entries.find(entry => entry.id === this.currentEntryId)
            : null;
        const activeCategoryId = activeEntry?.category || this.currentCategory;
        const activeCategory = categoryList.find(cat => cat?.id === activeCategoryId) || null;
        let breadcrumb = activeCategory?.label || (this.currentCategory || 'Journal');
        if (this.currentCategory === 'index' && !activeEntry) {
            breadcrumb = activeCategory?.label || 'Index';
        }
        if (activeEntry) {
            const categoryLabel = activeCategory?.label || activeEntry.category;
            breadcrumb = `${categoryLabel} › ${activeEntry.title}`;
        }
        this.breadcrumbText.setText(`Journal › ${breadcrumb}`);
    }

    _cycleCategory(direction) {
        const tabs = [...this.categories, this.virtualIndexCategory].filter(Boolean);
        if (!tabs.length) return;
        let index = tabs.findIndex(tab => tab.id === this.currentCategory);
        if (index === -1) index = 0;
        const next = wrap(index + direction, 0, tabs.length);
        this.showCategory(tabs[next].id);
    }

    openEntry(entryId) {
        if (!entryId) return;
        const entry = this.entries.find(e => e.id === entryId);
        if (!entry) return;
        if (!JournalState.isUnlockedEntry(entry)) return;

        const wasIndex = this.currentCategory === 'index';
        this.currentCategory = entry.category;
        this.currentEntryId = entry.id;
        if (wasIndex) {
            this.showCategory(entry.category);
        }
        JournalState.markSeen(entryId);
        this.content.setEntry(entry);
        this._highlightTabs();
        this._refreshTree();
        this._updateBottom();
    }

    markSeen(entryId) {
        JournalState.markSeen(entryId);
    }

    applyFilter({ tags = [] } = {}) {
        this.tagFilter = tags;
        this._refreshTree();
    }

    _applySearch(query) {
        if (!query) {
            if (this.currentCategory === 'index') {
                this._renderIndexCategory([]);
            } else {
                this._refreshTree();
            }
            this.indexEntries = [];
            return [];
        }
        const results = this.index.search(query);
        if (this.currentCategory !== 'index') {
            this.showCategory('index');
        }
        this._renderIndexCategory(results);
        return results;
    }

    _renderIndexCategory(results) {
        const entries = results.map(result => {
            const entry = this.entries.find(e => e.id === result.entryId);
            return entry ? { ...entry, excerpt: result.snippet } : null;
        }).filter(Boolean);
        this.indexEntries = entries;
        this.tree.setData({
            categories: [this.virtualIndexCategory],
            entries: entries.map(e => ({ ...e, category: 'index' })),
            activeEntryId: this.currentEntryId,
            unseen: this.unseenSet
        });
        this._updateBottom();
        const resultLabel = this.searchQuery
            ? (results.length === 1 ? '1 search result' : `${results.length} search results`)
            : 'Type to search the archive';
        this.bottomText.setText(resultLabel);
    }

    search(query) {
        return this._applySearch(query);
    }

    _getVisibleEntries() {
        if (this.currentCategory === 'index') {
            return [...this.indexEntries];
        }
        const entries = this.entries.filter(entry => {
            if (this.currentCategory && entry.category !== this.currentCategory) return false;
            if (!JournalState.isUnlockedEntry(entry)) return false;
            if (this.tagFilter.length && !this.tagFilter.every(tag => entry.tags?.includes(tag))) return false;
            return true;
        });
        return entries.sort((a, b) => (a.sort - b.sort) || a.title.localeCompare(b.title));
    }

    _refreshTree() {
        if (this.currentCategory === 'index') return;
        const categories = [...this.categories];
        const visibleEntries = this.entries.filter(entry => JournalState.isUnlockedEntry(entry));
        const filtered = visibleEntries.filter(entry => {
            if (this.currentCategory && entry.category !== this.currentCategory) return false;
            if (this.tagFilter.length && !this.tagFilter.every(tag => entry.tags?.includes(tag))) return false;
            return true;
        });

        this.tree.setData({
            categories,
            entries: filtered,
            activeEntryId: this.currentEntryId,
            unseen: this.unseenSet
        });

        if (!filtered.length) {
            this.content.setEntry(null);
            this.bottomText.setText('No entries unlocked yet.');
            return;
        }

        this._updateBottom();
    }

    _updateBottom() {
        const entries = this._getVisibleEntries();
        const index = entries.findIndex(e => e.id === this.currentEntryId);
        const prev = index > 0 ? entries[index - 1] : null;
        const next = index >= 0 && index < entries.length - 1 ? entries[index + 1] : null;
        if (prev) {
            this.prevButton.setAlpha(1);
            this.prevButton.setInteractive({ useHandCursor: true });
        } else {
            this.prevButton.setAlpha(0.4);
            this.prevButton.disableInteractive();
        }
        if (next) {
            this.nextButton.setAlpha(1);
            this.nextButton.setInteractive({ useHandCursor: true });
        } else {
            this.nextButton.setAlpha(0.4);
            this.nextButton.disableInteractive();
        }
        const unseenCount = this.unseenSet.size;
        this.bottomText.setText(`${entries.length} entries • ${unseenCount} new`);
    }

    _stepEntry(direction) {
        const entries = this._getVisibleEntries();
        const index = entries.findIndex(e => e.id === this.currentEntryId);
        if (index === -1) return;
        const target = entries[index + direction];
        if (target) this.openEntry(target.id);
    }

    _togglePin() {
        // Placeholder hook for future pinning support
        this.bottomText.setText(`${this.bottomText.text} • Pinning coming soon`);
    }
}

export default class JournalOverlay extends Phaser.Scene {
    constructor() {
        super({ key: 'JournalOverlay' });
    }

    create(data) {
        const frame = createOverlayFrame(this, {
            title: 'Journal',
            onClose: () => this._close()
        });

        this.overlay = new JournalOverlayView(this, frame.bounds, {
            onClose: () => this._close()
        });
        frame.content.add(this.overlay);

        this.overlay.open(data?.entryId ?? null);
    }

    _close() {
        this.overlay?.destroy();
        this.scene.stop();
    }
}