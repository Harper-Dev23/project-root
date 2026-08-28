import { createOverlayFrame } from '../../ui/OverlayFrame.js';
import { JOURNAL_CATEGORIES } from '../../../data/journal/manifest.js';
import { JOURNAL_ENTRIES as SEEDS } from '../../../data/journal/entries.seed.js';
import JournalTree from '../../ui/JournalTree.js';
import JournalContent from '../../ui/JournalContent.js';
import { JournalIndex } from '../../systems/JournalIndex.js';
import { JournalState } from '../../systems/JournalState.js';
import { readAllMarkdown } from '../../systems/MarkdownLoader.js';
import ProgressionManager from '../../systems/ProgressionManager.js';
import { FONTS } from '../../ui/styles.js';
import { setupSceneCursor } from '../../ui/cursor.js';

const LEFT_WIDTH = 280;
const TOP_BAR_HEIGHT = 70;
const BOTTOM_BAR_HEIGHT = 56;
const TAB_HEIGHT = 28;

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

function normaliseSubtab(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || 'General';
}

function getEntrySlug(entry) {
    if (!entry) return '';
    if (typeof entry.slug === 'string' && entry.slug.trim()) return entry.slug.trim();
    if (typeof entry.id === 'string' && entry.id.includes('/')) {
        return entry.id.split('/').pop();
    }
    return entry.id || '';
}

class JournalOverlayView extends Phaser.GameObjects.Container {
    constructor(scene, bounds, { onClose, depth } = {}) {
        super(scene, bounds.x, bounds.y);
        this.setSize(bounds.width, bounds.height);
        this.onClose = onClose;
        this.baseDepth = typeof depth === 'number' ? depth : 0;

        this.categories = JOURNAL_CATEGORIES.filter(cat => cat.id !== 'index');
        this.virtualIndexCategory = JOURNAL_CATEGORIES.find(cat => cat.id === 'index');

        this.index = new JournalIndex([]);
        this._entries = [];
        this.indexEntries = [];
        this._dataReady = false;
        this._pendingOpenRequest = undefined;

        const storedCategory = JournalState.getLastCategory?.();
        this.currentCategory = this._resolveCategory(storedCategory);
        this.currentSubtab = JournalState.getLastSubtab?.(this.currentCategory) || null;
        this.currentEntryId = null;
        this.tagFilter = [];
        this.searchQuery = '';

        this.darkMode = readDarkMode();

        this.unseenSet = new Set();

        this._domElements = [];
        this._syncDomAnchors = this._syncDomAnchors.bind(this);

        this._buildUI(bounds);
        this._bindStateEvents();
        this._bindInput();

        scene.add.existing(this);
        scene.events.on('postupdate', this._syncDomAnchors, this);
        this._bootPromise = this._bootJournalData();
    }

    async _bootJournalData() {
        try {
            const mdEntries = await readAllMarkdown('data/journal/md');
            const entries = [...SEEDS, ...mdEntries];
            JournalState.init(entries);
            this.index.setEntries(entries);
            this._entries = entries;
        } catch (err) {
            console.error('Failed to load journal markdown entries', err);
            const fallbackEntries = [...SEEDS];
            JournalState.init(fallbackEntries);
            this.index.setEntries(fallbackEntries);
            this._entries = fallbackEntries;
        }

        this._dataReady = true;
        this._computeUnseenSet();

        const pending = this._pendingOpenRequest;
        this._pendingOpenRequest = undefined;
        if (pending) {
            this.open(pending);
            return;
        }

        if (this.searchQuery) {
            this._applySearch(this.searchQuery);
            return;
        }

        this._restoreLastViewed();
    }

    _buildUI(bounds) {
        const { scene } = this;

        // Not interactive — it has no click handlers, and TownScene's own
        // input is already disabled separately (see create() below), so
        // there's nothing behind it that needs blocking. It was previously
        // interactive with a deprioritized priorityID as a defensive
        // click-catcher, but a full-panel interactive zone with no actual
        // purpose is just a needless candidate for hit-test interference
        // with the tabs/tree above it.
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

        // Width was 200px, right up against bounds.width-40 — the close
        // button's own left edge sits around bounds.right-38, leaving only
        // a couple pixels of clearance. DOM elements always render above
        // the canvas regardless of Phaser depth (see _buildTabs' own
        // comment on this same constraint), so at that gap the search box
        // could win the stacking fight and swallow clicks meant for close.
        // Shrunk to 160px (anchor unchanged, so the tab row's own width
        // budget below is unaffected) for a real ~40px margin instead.
        this.searchDom = scene.add.dom(bounds.width - 240, TOP_BAR_HEIGHT / 2).createFromHTML(`
      <input type="text" placeholder="Search journal" style="width:160px;padding:6px 10px;border-radius:6px;border:1px solid #666;background:${this.darkMode ? '#1f1f1f' : '#ffffff'};color:${this.darkMode ? '#f8f8f8' : '#1a1a1a'};">
    `);
        this.searchDom.setOrigin(0, 0.5);
        this.searchDom.setDepth(this.baseDepth + 1);
        this.searchDom.addListener('input');
        this.searchDom.on('input', (event) => {
            const value = event.target.value;
            this.searchQuery = value;
            this._applySearch(value);
        });
        const searchNode = this.searchDom.node;
        if (searchNode) {
            searchNode.style.width = '160px';
            searchNode.style.height = '32px';
            searchNode.style.position = 'absolute';
            searchNode.style.display = 'flex';
            searchNode.style.alignItems = 'center';
            searchNode.style.justifyContent = 'flex-end';
            searchNode.style.background = 'transparent';
            searchNode.style.pointerEvents = 'auto';
            const input = searchNode.querySelector('input');
            if (input) {
                input.style.width = '100%';
                input.style.boxSizing = 'border-box';
            }
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
        this._domElements.push(this.searchDom);

        // Left tree
        this.tree = new JournalTree(scene, 20, TOP_BAR_HEIGHT + 12, LEFT_WIDTH - 40, bounds.height - TOP_BAR_HEIGHT - BOTTOM_BAR_HEIGHT - 24, {
            onSelect: (entryId) => this.openEntry(entryId),
            onSubtabSelect: (subtab) => this._onSubtabSelected(subtab)
        });

        // Right content area
        const contentX = LEFT_WIDTH + 20;
        const contentWidth = bounds.width - contentX - 20;
        const contentHeight = bounds.height - TOP_BAR_HEIGHT - BOTTOM_BAR_HEIGHT - 24;
        this.content = new JournalContent(scene, contentX, TOP_BAR_HEIGHT + 12, contentWidth, contentHeight, {
            onNavigate: (entryId) => this.openEntry(entryId),
            resolveEntryRef: (ref) => this._resolveEntryRef(ref),
            resolveTokens: (key) => this._resolveToken(key),
            domDepth: this.baseDepth + 1
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

        this.add([
            this.background,
            this.topBar,
            this.breadcrumbText,
            this.tabContainer,
            this.tree,
            this.content,
            this.bottomBar,
            this.bottomText,
            this.prevButton,
            this.nextButton
        ]);

        this._syncDomAnchors();
    }

    /** A stored subtab is only valid if some entry in this category actually
     * uses it — clears the stale persisted value otherwise. Shared by
     * _restoreLastViewed and _refreshTree so they can't disagree. */
    _validSubtabFor(category, subtab, baseEntries) {
        if (!subtab) return null;
        const entries = baseEntries || this._getCategoryEntries(category);
        const valid = entries.some(entry => normaliseSubtab(entry.subtab) === subtab);
        if (!valid) {
            JournalState.setLastSubtab(category, null);
            return null;
        }
        return subtab;
    }

    _restoreLastViewed() {
        const category = this._resolveCategory(JournalState.getLastCategory?.());
        this.currentCategory = category;
        const baseEntries = this._getCategoryEntries(category);
        const storedSubtab = JournalState.getLastSubtab?.(category) || null;
        this.currentSubtab = this._validSubtabFor(category, storedSubtab, baseEntries);
        this._highlightTabs();
        this._refreshTree();
        const storedSlug = JournalState.getLastSlug?.(category);
        if (storedSlug) {
            const match = this._findEntryBySlug(category, storedSlug);
            if (match) {
                this.openEntry(match.id);
                return;
            }
        }
        const visible = this._getVisibleEntries();
        if (visible.length) {
            this.openEntry(visible[0].id);
        } else {
            this.content.setEntry(null);
            this.bottomText.setText('No entries unlocked yet.');
        }
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
                .setStrokeStyle(1, 0x444444, 0.4)
                .setInteractive({ useHandCursor: true });

            // pointerdown only — was ALSO bound to pointerup, firing
            // showCategory (and its _refreshTree/_highlightTabs/
            // setLastCategory chain) twice per click. Every other
            // clickable element in this overlay (filter chips, entry
            // rows) already only binds pointerdown.
            const activate = () => this.showCategory(tab.id);
            bg.on('pointerdown', activate);
            bg.on('pointerover', () => {
                if (this.currentCategory === tab.id) return;
                bg.setFillStyle(0x222222, 0.4);
            });
            bg.on('pointerout', () => {
                if (this.currentCategory === tab.id) return;
                bg.setFillStyle(0x000000, 0.25);
            });

            container.add([bg, label]);
            this.tabContainer.add(container);
            this.tabButtons.set(tab.id, { label, bg });
            cursorX += width + 12;
        }

        // Shrink the whole row to fit before the search box if there are
        // enough categories to overflow it. The search box is a real DOM
        // <input> (see _buildUI) — DOM elements always render above the
        // canvas regardless of Phaser depth, so a tab rendered underneath
        // it would be unclickable rather than just visually cramped.
        this.tabContainer.setScale(1);
        const maxTabRowWidth = Math.max(200, this.width - 240 - 20 - 10);
        if (cursorX > maxTabRowWidth) {
            this.tabContainer.setScale(maxTabRowWidth / cursorX);
        }
    }

    _computeUnseenSet() {
        const unseen = new Set();
        for (const entry of this._entries) {
            if (!JournalState.isUnlockedEntry(entry)) continue;
            if (!JournalState.seenEntries.has(entry.id)) {
                unseen.add(entry.id);
            }
        }
        this.unseenSet = unseen;
    }

    _bindStateEvents() {
        this.unsubSeen = JournalState.on('journal:seen', () => {
            this._computeUnseenSet();
            this._refreshTree();
            this._updateBottom();
        });
        this.unsubUnlocks = JournalState.on('journal:new-unlocks', () => {
            this._computeUnseenSet();
            this._refreshTree();
            this._updateBottom();
        });
    }

    // Only Esc/B close the Journal — Q/E category-cycling and the
    // all-four-arrow-keys "step entry" scheme were dropped. They never
    // covered subtab navigation anyway, and every other overlay in this
    // game is mouse/click-only, so this just matches that convention
    // instead of maintaining a second, partial keyboard scheme.
    _bindInput() {
        const keyboard = this.scene.input?.keyboard;
        if (!keyboard) return;

        // Note: while the search <input> is focused, its own keydown handler
        // (see _buildUI's _searchKeyHandler) calls stopPropagation() on
        // every key — Escape there just clears/blurs the search box and
        // never reaches this scene-level listener at all, so onClose only
        // ever fires from a real "close the Journal" press. That's the
        // correct behavior (Escape-while-searching shouldn't also close the
        // whole overlay), it just means _isSearchFocused() has nothing left
        // to do here — kept as a no-op guard removed rather than dead code.
        const onClose = () => this.close();

        keyboard.on('keydown-ESC', onClose, this);
        keyboard.on('keydown-B', onClose, this);

        this.inputCleanup = () => {
            keyboard.off('keydown-ESC', onClose, this);
            keyboard.off('keydown-B', onClose, this);
        };
    }

    _onSubtabSelected(subtab) {
        if (!this._dataReady) return;
        if (this.currentCategory === 'index') return;
        const resolved = subtab ? normaliseSubtab(subtab) : null;
        if (this.currentSubtab === resolved) return;
        this.currentSubtab = resolved;
        JournalState.setLastSubtab(this.currentCategory, resolved);
        this._refreshTree();
        const visible = this._getVisibleEntries();
        if (!visible.length) {
            this.content.setEntry(null);
            this.bottomText.setText('No entries in this sub-section yet.');
            return;
        }
        if (!visible.some(entry => entry.id === this.currentEntryId)) {
            this.openEntry(visible[0].id);
        } else {
            this._updateBottom();
        }
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
        this._domElements.forEach(el => el?.destroy?.());
        this.scene?.events?.off('postupdate', this._syncDomAnchors, this);
        super.destroy(fromScene);
    }

    _syncDomAnchors() {
        if (!this.scene || !this.searchDom) return;
        let worldLeft = this.x;
        let worldTop = this.y;
        const matrix = this.getWorldTransformMatrix?.();
        if (matrix) {
            worldLeft = matrix.tx;
            worldTop = matrix.ty;
        }
        this.searchDom.setPosition(worldLeft + this.width - 240, worldTop + TOP_BAR_HEIGHT / 2);
        this.content?.forceDomSync?.();
    }


    open(target = null) {
        const request = typeof target === 'string' || typeof target === 'number'
            ? { entryId: String(target) }
            : (target || {});

        if (!this._dataReady) {
            this._pendingOpenRequest = request;
            return;
        }

        this._computeUnseenSet();

        let entry = null;
        if (request.entryId) {
            entry = this._entries.find(e => e.id === request.entryId);
        } else if (request.slug) {
            entry = this._findEntryBySlug(request.category, request.slug) || this._findEntryBySlug(null, request.slug);
        }

        if (entry) {
            if (request.subtab !== undefined) {
                const forcedSubtab = request.subtab === null ? null : normaliseSubtab(request.subtab);
                this.currentSubtab = forcedSubtab;
                JournalState.setLastSubtab(entry.category, forcedSubtab);
            }
            this.openEntry(entry.id);
            return;
        }

        let targetCategory = request.category ? this._resolveCategory(request.category) : this.currentCategory;
        if (!targetCategory || targetCategory === 'index') {
            targetCategory = this._resolveCategory(null);
        }
        this.currentCategory = targetCategory;
        JournalState.setLastCategory(targetCategory);

        if (request.subtab !== undefined) {
            this.currentSubtab = request.subtab === null ? null : normaliseSubtab(request.subtab);
            JournalState.setLastSubtab(this.currentCategory, this.currentSubtab);
        } else {
            this.currentSubtab = JournalState.getLastSubtab?.(this.currentCategory) || null;
        }

        this._highlightTabs();
        this._refreshTree();

        const visibleEntries = this._getVisibleEntries();
        if (visibleEntries.length) {
            this.openEntry(visibleEntries[0].id);
        } else {
            this.content.setEntry(null);
            this.bottomText.setText('No entries unlocked yet.');
        }
    }

    close() {
        this.onClose?.();
    }

    showCategory(categoryId, { preserveEntry = false } = {}) {
        if (!this._dataReady) {
            // Same queuing mechanism open()/openEntry() use — previously this
            // mutated currentCategory directly instead, so a tab clicked
            // before the markdown finished loading was silently discarded
            // once _bootJournalData() finished and fell back to whatever
            // category was last persisted, ignoring the click entirely.
            this._pendingOpenRequest = { category: categoryId };
            return;
        }
        if (categoryId === 'index') {
            this.currentCategory = 'index';
            this.currentSubtab = null;
            this._highlightTabs();
            if (this.searchQuery) {
                this._applySearch(this.searchQuery);
            } else {
                this._renderIndexCategory([]);
            }
            return;
        }
        const resolved = this._resolveCategory(categoryId);
        const changed = this.currentCategory !== resolved;
        if (!changed && !preserveEntry) {
            return;
        }
        this.currentCategory = resolved;
        if (changed) {
            const storedSubtab = JournalState.getLastSubtab?.(resolved) || null;
            this.currentSubtab = storedSubtab;
            JournalState.setLastCategory(resolved);
        }
        this._highlightTabs();
        this._refreshTree();
        if (!preserveEntry) {
            const entries = this._getVisibleEntries();
            if (entries.length) {
                this.openEntry(entries[0].id);
            } else {
                this.content.setEntry(null);
            }
        } else {
            this._updateBottom();
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
            ? this._entries.find(entry => entry.id === this.currentEntryId)
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

    /**
     * Resolves a [[wikilink]] target to a real entry.
     *
     * Vault notes link by human title, so this accepts (in priority order)
     * an exact entry id, a slug, or a case-insensitive title match — with a
     * final pass that ignores a leading "The " so "[[Frozen Steppes]]"
     * still finds "The Frozen Steppes". Returns null when nothing matches,
     * which the reader renders as an inert grey link.
     */
    _resolveEntryRef(ref) {
        if (!ref || !Array.isArray(this._entries)) return null;
        const raw = String(ref).trim();
        const lower = raw.toLowerCase();
        const stripThe = (s) => s.replace(/^the\s+/i, '').trim().toLowerCase();

        const visible = this._entries.filter(e => JournalState.isUnlockedEntry(e));
        return visible.find(e => e.id === raw)
            || visible.find(e => (e.slug || '').toLowerCase() === lower)
            || visible.find(e => (e.title || '').toLowerCase() === lower)
            || visible.find(e => stripThe(e.title || '') === stripThe(raw))
            || null;
    }

    /**
     * Live values an entry can embed as {{token}}. Returns undefined for an
     * unknown key, which leaves the raw token visible rather than silently
     * blanking it — a broken token should be obvious, not invisible.
     */
    _resolveToken(key) {
        const d = ProgressionManager.getWorldDate?.() || {};
        switch (key) {
            case 'worldDate':    return d.label;
            case 'dayNumber':    return d.dayNumber;
            case 'nights':       return d.nights;
            case 'days':         return d.days;
            case 'huntTickets':  return ProgressionManager.huntTickets;
            case 'tribeTickets': return ProgressionManager.tribeTickets;
            case 'huntPoints':   return ProgressionManager.huntPoints;
            default:             return undefined;
        }
    }

    openEntry(entryId) {
        if (!entryId) return;
        if (!this._dataReady) {
            this._pendingOpenRequest = { entryId };
            return;
        }

        const entry = this._entries.find(e => e.id === entryId);
        if (!entry) return;
        if (!JournalState.isUnlockedEntry(entry)) return;

        const entryCategory = entry.category;
        const entrySubtab = normaliseSubtab(entry.subtab);
        const categoryChanged = this.currentCategory !== entryCategory || this.currentCategory === 'index';

        if (categoryChanged) {
            this.currentCategory = entryCategory;
            const storedSubtab = JournalState.getLastSubtab?.(entryCategory);
            this.currentSubtab = storedSubtab !== undefined && storedSubtab !== null ? storedSubtab : null;
            const matchesCurrent = !this.currentSubtab || this.currentSubtab === entrySubtab;
            if (!matchesCurrent) {
                this.currentSubtab = entrySubtab;
            }
            JournalState.setLastCategory(entryCategory);
        } else {
            const matchesCurrent = !this.currentSubtab || this.currentSubtab === entrySubtab;
            if (!matchesCurrent) {
                this.currentSubtab = entrySubtab;
            }
        }

        this.currentEntryId = entry.id;

        JournalState.markSeen(entryId);
        const slugToPersist = entry.slug || getEntrySlug(entry);
        if (slugToPersist) {
            JournalState.setLastSlug(entryCategory, slugToPersist);
        }
        JournalState.setLastSubtab(entryCategory, this.currentSubtab);

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
        if (!this._dataReady) {
            this.indexEntries = [];
            return [];
        }
        if (!query) {
            this.indexEntries = [];
            // Clearing the search restores whichever category/subtab was
            // active before the search started, instead of leaving the
            // player stranded on the empty synthetic 'index' tab.
            if (this.currentCategory === 'index') {
                if (this._preSearchCategory) {
                    this.currentCategory = this._preSearchCategory;
                    this.currentSubtab = this._preSearchSubtab;
                    this._preSearchCategory = null;
                    this._preSearchSubtab = null;
                    this._highlightTabs();
                    this._refreshTree();
                } else {
                    // No prior tab on record (shouldn't normally happen —
                    // search always records one before switching to index)
                    this._renderIndexCategory([]);
                }
            } else {
                this._refreshTree();
            }
            return [];
        }
        if (this.currentCategory !== 'index') {
            this._preSearchCategory = this.currentCategory;
            this._preSearchSubtab = this.currentSubtab;
            this.showCategory('index');
        }
        const results = this.index.search(query);
        this._renderIndexCategory(results);
        return results;
    }

    _renderIndexCategory(results) {
        const entries = results.map(result => {
            const entry = this._entries.find(e => e.id === result.entryId);
            return entry ? { ...entry, excerpt: result.snippet } : null;
        }).filter(Boolean);
        this.indexEntries = entries;
        this.tree.setData({
            categories: [this.virtualIndexCategory],
            entries: entries.map(e => ({ ...e, category: 'index' })),
            activeEntryId: this.currentEntryId,
            unseen: this.unseenSet,
            activeCategory: 'index',
            activeSubtab: null
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

    _getCategoryEntries(categoryId) {
        if (!this._dataReady) return [];
        return this._entries.filter(entry => {
            if (categoryId && entry.category !== categoryId) return false;
            if (!JournalState.isUnlockedEntry(entry)) return false;
            if (this.tagFilter.length && !this.tagFilter.every(tag => entry.tags?.includes(tag))) return false;
            return true;
        });
    }

    _getVisibleEntries() {
        if (!this._dataReady) {
            return [];
        }
        if (this.currentCategory === 'index') {
            return [...this.indexEntries];
        }
        const base = this._getCategoryEntries(this.currentCategory);
        const filtered = this.currentSubtab
            ? base.filter(entry => normaliseSubtab(entry.subtab) === this.currentSubtab)
            : base;
        return filtered.sort((a, b) => this._sortEntries(a, b));
    }

    _sortEntries(a, b) {
        const orderA = Number.isFinite(a.order) ? a.order : Number.isFinite(a.sort) ? a.sort : 999;
        const orderB = Number.isFinite(b.order) ? b.order : Number.isFinite(b.sort) ? b.sort : 999;
        if (orderA !== orderB) return orderA - orderB;
        return (a.title || '').localeCompare(b.title || '');
    }

    _resolveCategory(categoryId) {
        const pool = [...this.categories];
        if (this.virtualIndexCategory) {
            pool.push(this.virtualIndexCategory);
        }
        const match = pool.find(cat => cat?.id === categoryId && cat.id !== 'index');
        if (match) return match.id;
        return this.categories[0]?.id || 'lore';
    }

    _findEntryBySlug(category, slug) {
        if (!slug) return null;
        const target = String(slug).toLowerCase();
        return this._entries.find(entry => {
            if (category && entry.category !== category) return false;
            const slugValue = (entry.slug || getEntrySlug(entry) || '').toLowerCase();
            if (slugValue && slugValue === target) return true;
            return entry.id === slug;
        }) || null;
    }

    _refreshTree() {
        if (!this._dataReady) return;
        if (this.currentCategory === 'index') return;
        const categories = [...this.categories];
        const baseEntries = this._getCategoryEntries(this.currentCategory).sort((a, b) => this._sortEntries(a, b));

        const activeSubtab = this._validSubtabFor(this.currentCategory, this.currentSubtab, baseEntries);
        this.currentSubtab = activeSubtab;

        this.tree.setData({
            categories,
            entries: baseEntries,
            activeEntryId: this.currentEntryId,
            unseen: this.unseenSet,
            activeCategory: this.currentCategory,
            activeSubtab
        });

        if (!baseEntries.length) {
            this.content.setEntry(null);
            this.bottomText.setText('No entries unlocked yet.');
            return;
        }

        const visible = activeSubtab
            ? baseEntries.filter(entry => normaliseSubtab(entry.subtab) === activeSubtab)
            : baseEntries;

        if (!visible.length) {
            this.content.setEntry(null);
            this.bottomText.setText('No entries in this sub-section yet.');
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

}

export default class JournalOverlay extends Phaser.Scene {
    constructor() {
        super({ key: 'JournalOverlay' });
    }

    create(data) {
        setupSceneCursor(this);
        const town = this.scene.get('TownScene');
        if (town?.input) town.input.enabled = false;

        const frame = createOverlayFrame(this, {
            title: 'Journal',
            fullscreen: true,
            onClose: () => this._close(),
        });

        this.overlay = new JournalOverlayView(this, frame.bounds, {
            onClose: () => this._close(),
            depth: frame.depth
        });
        frame.content.add(this.overlay);

        this.overlay.open(data || null);
    }

    _close() {
        const town = this.scene.get('TownScene');
        if (town?.input) town.input.enabled = true;
        this.overlay?.destroy();
        this.scene.stop();
    }
}



