/**
 * The routes you have viewed, to go back and forward through them ([ and ]),
 * like undo and redo: going back and then showing another route drops the
 * ones ahead. A history is { entries: [route ids, oldest first], index }
 * where entries[index] is the route shown (when one is).
 */

export const HISTORY_LIMIT = 100;

export function emptyHistory() {
    return { entries: [], index: -1 };
}

/**
 * The history after `id` was shown (not by stepping through the history).
 * The routes ahead of the current one are dropped; the same route twice in
 * a row is kept once; only the last `limit` routes are kept.
 */
export function recordVisit(history, id, limit = HISTORY_LIMIT) {
    if (id == null) return history;
    const { entries, index } = history;
    if (entries[index] === id) return history;
    const kept = [...entries.slice(0, index + 1), id];
    const trimmed = kept.length > limit ? kept.slice(kept.length - limit) : kept;
    return { entries: trimmed, index: trimmed.length - 1 };
}

/**
 * One step back (dir -1) or forward (1): the nearest route that way that can
 * be shown (`canShow(id)`: still listed, not hidden by a filter) and is not
 * the one shown now (`currentId`). When nothing is shown, or the history's
 * current route is not the one shown (it was hidden), back starts at that
 * route. Returns { history, id } or null (nothing that way).
 */
export function stepHistory(history, dir, canShow = () => true, currentId = null) {
    const { entries, index } = history;
    if (!entries.length || (dir !== 1 && dir !== -1)) return null;
    let i = index + dir;
    if (dir < 0 && index >= 0 && entries[index] !== currentId) i = index;
    for (; i >= 0 && i < entries.length; i += dir) {
        const id = entries[i];
        if (id !== currentId && canShow(id)) return { history: { entries, index: i }, id };
    }
    return null;
}
