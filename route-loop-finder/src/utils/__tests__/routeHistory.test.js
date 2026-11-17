import { describe, expect, it } from 'vitest';
import { emptyHistory, HISTORY_LIMIT, recordVisit, stepHistory } from '../routeHistory';

const visit = (...ids) => ids.reduce((h, id) => recordVisit(h, id), emptyHistory());

/** Step and return [history, id] (id null: nothing that way). */
function step(history, dir, canShow, currentId) {
    const current = currentId === undefined ? history.entries[history.index] : currentId;
    const next = stepHistory(history, dir, canShow, current);
    return next ? [next.history, next.id] : [history, null];
}

describe('route history ([ and ])', () => {
    it('records the routes shown, in order', () => {
        const h = visit('a', 'b', 'c');
        expect(h.entries).toEqual(['a', 'b', 'c']);
        expect(h.index).toBe(2);
    });

    it('keeps the same route twice in a row once, and ignores nothing shown', () => {
        expect(visit('a', 'a', 'b', 'b').entries).toEqual(['a', 'b']);
        expect(visit('a', null, 'b').entries).toEqual(['a', 'b']);
    });

    it('back goes to the route shown before, forward comes back', () => {
        let h = visit('a', 'b', 'c');
        let id;
        [h, id] = step(h, -1);
        expect(id).toBe('b');
        [h, id] = step(h, -1);
        expect(id).toBe('a');
        [h, id] = step(h, -1);
        expect(id).toBeNull(); // nothing before the first
        [h, id] = step(h, 1);
        expect(id).toBe('b');
        [h, id] = step(h, 1);
        expect(id).toBe('c');
        [h, id] = step(h, 1);
        expect(id).toBeNull(); // nothing after the last
    });

    it('like undo: showing another route after going back drops the ones ahead', () => {
        let h = visit('a', 'b', 'c');
        [h] = step(h, -1); // at b
        [h] = step(h, -1); // at a
        h = recordVisit(h, 'd');
        expect(h.entries).toEqual(['a', 'd']);
        expect(step(h, 1)[1]).toBeNull();
        expect(step(h, -1)[1]).toBe('a');
    });

    it('a route seen again later is a new entry', () => {
        let h = visit('a', 'b', 'a');
        let id;
        [h, id] = step(h, -1);
        expect(id).toBe('b');
        [h, id] = step(h, -1);
        expect(id).toBe('a');
    });

    it('skips routes that are hidden now, both ways', () => {
        const hidden = new Set(['b', 'c']);
        const canShow = (id) => !hidden.has(id);
        let h = visit('a', 'b', 'c', 'd');
        let id;
        [h, id] = step(h, -1, canShow);
        expect(id).toBe('a');
        [h, id] = step(h, 1, canShow);
        expect(id).toBe('d');
        hidden.add('a');
        expect(step(h, -1, canShow)[1]).toBeNull(); // every earlier one is hidden
    });

    it('skips an entry that is the route shown now (a hidden one between)', () => {
        const canShow = (id) => id !== 'b';
        const h = visit('a', 'b', 'a');
        expect(step(h, -1, canShow)[1]).toBeNull();
    });

    it('with nothing shown (or the last route hidden), back shows the last route viewed', () => {
        const h = visit('a', 'b');
        expect(step(h, -1, undefined, null)[1]).toBe('b');
        expect(step(h, -1, (id) => id !== 'b', 'x')[1]).toBe('a');
    });

    it('keeps only the last 100 routes', () => {
        let h = emptyHistory();
        for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = recordVisit(h, `r${i}`);
        expect(HISTORY_LIMIT).toBe(100);
        expect(h.entries.length).toBe(100);
        expect(h.entries[0]).toBe('r20');
        expect(h.index).toBe(99);
        let id;
        for (let i = 0; i < 99; i++) [h, id] = step(h, -1);
        expect(id).toBe('r20');
        expect(step(h, -1)[1]).toBeNull();
    });

    it('an empty history goes nowhere', () => {
        expect(stepHistory(emptyHistory(), -1)).toBeNull();
        expect(stepHistory(emptyHistory(), 1)).toBeNull();
    });
});
