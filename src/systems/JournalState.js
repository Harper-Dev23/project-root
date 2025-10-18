
const STORAGE_KEY = 'game.journalState';

function readStringMap(value) {
    if (!value || typeof value !== 'object') return {};
    const result = {};
    for (const [key, val] of Object.entries(value)) {
        if (typeof key !== 'string') continue;
        if (typeof val !== 'string') continue;
        result[key] = val;
    }
    return result;
}

function loadState() {
    try {
        if (typeof localStorage === 'undefined') {
            return { unlocks: [], seenEntries: [], lastCategory: null, lastSubtabByCategory: {}, lastSlugByCategory: {} };
        }

        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return { unlocks: [], seenEntries: [], lastCategory: null, lastSubtabByCategory: {}, lastSlugByCategory: {} };
        }
        const parsed = JSON.parse(raw);
        return {
            unlocks: Array.isArray(parsed?.unlocks) ? parsed.unlocks : [],
            seenEntries: Array.isArray(parsed?.seenEntries) ? parsed.seenEntries : [],
            lastCategory: typeof parsed?.lastCategory === 'string' ? parsed.lastCategory : null,
            lastSubtabByCategory: readStringMap(parsed?.lastSubtabByCategory),
            lastSlugByCategory: readStringMap(parsed?.lastSlugByCategory)
        };
    } catch (err) {
        console.warn('Failed to load journal state:', err);
        return { unlocks: [], seenEntries: [], lastCategory: null, lastSubtabByCategory: {}, lastSlugByCategory: {} };
    }
}

function persistState(state) {
    try {
        if (typeof localStorage === 'undefined') return;
        const payload = JSON.stringify({
            unlocks: Array.from(state.unlocks || []),
            seenEntries: Array.from(state.seenEntries || []),
            lastCategory: state.lastCategory || null,
            lastSubtabByCategory: { ...(state.lastSubtabByCategory || {}) },
            lastSlugByCategory: { ...(state.lastSlugByCategory || {}) }
        });
        localStorage.setItem(STORAGE_KEY, payload);
    } catch (err) {
        console.warn('Failed to persist journal state:', err);
    }
}

function meetsRequirements(entry, unlockSet) {
    const requirements = Array.isArray(entry?.requires) ? entry.requires : [];
    if (requirements.length === 0) return true;
    return requirements.every(flag => unlockSet.has(flag));
}

const listeners = new Map();

function emit(event, payload) {
    const subs = listeners.get(event);
    if (!subs) return;
    for (const handler of [...subs]) {
        try {
            handler(payload);
        } catch (err) {
            console.error('JournalState listener error', err);
        }
    }
}

function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
}

const initialState = loadState();

export const JournalState = {
    unlocks: new Set(initialState.unlocks),
    seenEntries: new Set(initialState.seenEntries),
    lastCategory: initialState.lastCategory || null,
    lastSubtabByCategory: { ...initialState.lastSubtabByCategory },
    lastSlugByCategory: { ...initialState.lastSlugByCategory },
    _entries: [],
    on,
    init(entries) {
        this._entries = Array.isArray(entries) ? entries : [];
    },
    getLastCategory() {
        return this.lastCategory || null;
    },
    setLastCategory(category) {
        const value = (typeof category === 'string' && category.trim()) ? category.trim() : null;
        if (this.lastCategory === value) return;
        this.lastCategory = value;
        persistState(this);
    },
    getLastSubtab(category) {
        if (!category) return null;
        return this.lastSubtabByCategory?.[category] || null;
    },
    setLastSubtab(category, subtab) {
        if (!category) return;
        if (!this.lastSubtabByCategory) this.lastSubtabByCategory = {};
        const existing = this.lastSubtabByCategory[category] || null;
        const value = (typeof subtab === 'string' && subtab.trim()) ? subtab.trim() : null;
        if (value === existing) return;
        if (value) {
            this.lastSubtabByCategory[category] = value;
        } else {
            delete this.lastSubtabByCategory[category];
        }
        persistState(this);
    },
    getLastSlug(category) {
        if (!category) return null;
        return this.lastSlugByCategory?.[category] || null;
    },
    setLastSlug(category, slug) {
        if (!category) return;
        if (!this.lastSlugByCategory) this.lastSlugByCategory = {};
        const existing = this.lastSlugByCategory[category] || null;
        const value = (typeof slug === 'string' && slug.trim()) ? slug.trim() : null;
        if (value === existing) return;
        if (value) {
            this.lastSlugByCategory[category] = value;
        } else {
            delete this.lastSlugByCategory[category];
        }
        persistState(this);
    },
    isUnlockedEntry(entry) {
        if (!entry) return false;
        return meetsRequirements(entry, this.unlocks);
    },
    addUnlock(flag) {
        if (!flag) return false;
        const beforeUnlocks = new Set(this.unlocks);
        if (beforeUnlocks.has(flag)) {
            return false;
        }

        const beforeVisible = new Set(
            this._entries
                .filter(entry => meetsRequirements(entry, beforeUnlocks))
                .map(entry => entry.id)
        );

        this.unlocks.add(flag);
        persistState(this);

        const newlyUnlocked = this._entries
            .filter(entry => this.isUnlockedEntry(entry) && !beforeVisible.has(entry.id))
            .map(entry => entry.id);

        if (newlyUnlocked.length) {
            emit('journal:new-unlocks', { entryIds: newlyUnlocked });
            emit('journal:toast', { message: 'New Journal entry', entryIds: newlyUnlocked });
            return true;
        }

        return false;
    },
    visibleCount() {
        return this._entries.filter(entry => this.isUnlockedEntry(entry)).length;
    },
    markSeen(id) {
        if (!id) return;
        const beforeSize = this.seenEntries.size;
        this.seenEntries.add(id);
        if (this.seenEntries.size !== beforeSize) {
            persistState(this);
            emit('journal:seen', { entryId: id });
        }
    },
    clearSeen(entryIds = []) {
        let changed = false;
        for (const entryId of entryIds) {
            if (this.seenEntries.delete(entryId)) {
                changed = true;
            }
        }
        if (changed) {
            persistState(this);
            emit('journal:seen-reset', { entryIds });
        }
    },
    reset() {
        this.unlocks.clear();
        this.seenEntries.clear();
        this.lastCategory = null;
        this.lastSubtabByCategory = {};
        this.lastSlugByCategory = {};
        persistState(this);
        emit('journal:reset');
    }

};

export default JournalState;
