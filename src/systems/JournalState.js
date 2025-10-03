
const STORAGE_KEY = 'game.journalState';

function loadState() {
    try {
        if (typeof localStorage === 'undefined') {
            return { unlocks: [], seenEntries: [] };
        }

        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { unlocks: [], seenEntries: [] };
        const parsed = JSON.parse(raw);
        return {
            unlocks: Array.isArray(parsed?.unlocks) ? parsed.unlocks : [],
            seenEntries: Array.isArray(parsed?.seenEntries) ? parsed.seenEntries : []
        };
    } catch (err) {
        console.warn('Failed to load journal state:', err);
        return { unlocks: [], seenEntries: [] };
    }
}

function persist(unlocks, seenEntries) {
    try {
        if (typeof localStorage === 'undefined') return;
        const payload = JSON.stringify({ unlocks: [...unlocks], seenEntries: [...seenEntries] });
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
    _entries: [],
    on,
    init(entries) {
        this._entries = Array.isArray(entries) ? entries : [];
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
        persist(this.unlocks, this.seenEntries);

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
            persist(this.unlocks, this.seenEntries);
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
            persist(this.unlocks, this.seenEntries);
            emit('journal:seen-reset', { entryIds });
        }
    },
    reset() {
        this.unlocks.clear();
        this.seenEntries.clear();
        persist(this.unlocks, this.seenEntries);
        emit('journal:reset');
    }

};

export default JournalState;
