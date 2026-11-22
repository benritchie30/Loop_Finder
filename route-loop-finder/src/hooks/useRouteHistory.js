import { useCallback, useEffect, useRef } from 'react';
import { emptyHistory, recordVisit, stepHistory } from '../utils/routeHistory';

/**
 * Back / forward through the routes shown (utils/routeHistory), like undo
 * and redo. Every change of the shown route is recorded (arrow keys, cards,
 * clicks on the map, the first route of a generation, a route hidden by a
 * filter giving way to another), except the ones made by stepping here.
 * A new `resetKey` (another generation opened, or all routes from a start)
 * starts a new history.
 *
 * Returns step(dir, canShow, select): dir -1 back, 1 forward; canShow(id)
 * tells whether a route can be shown now (hidden ones are skipped);
 * select(id) shows it. Returns whether it moved.
 */
export function useRouteHistory(currentId, resetKey) {
    const state = useRef({ key: resetKey, history: emptyHistory() });
    const stepped = useRef(null); // the route a step is showing (not recorded as a visit)
    const current = useRef(currentId);
    current.current = currentId;

    useEffect(() => {
        if (state.current.key !== resetKey) {
            state.current = { key: resetKey, history: emptyHistory() };
            stepped.current = null;
        }
        if (currentId == null) return;
        if (stepped.current === currentId) {
            stepped.current = null; // the step already moved the history here
            return;
        }
        stepped.current = null;
        state.current.history = recordVisit(state.current.history, currentId);
    }, [currentId, resetKey]);

    return useCallback((dir, canShow, select) => {
        const next = stepHistory(state.current.history, dir, canShow, current.current);
        if (!next) return false;
        state.current.history = next.history;
        stepped.current = next.id;
        select(next.id);
        return true;
    }, []);
}
