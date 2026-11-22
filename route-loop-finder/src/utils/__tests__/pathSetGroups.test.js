import { describe, expect, it } from 'vitest';
import { chosenSet, groupByStart, lengthRange, newestFirst, sameStart, setsAtStart, SAME_START_M } from '../pathSetGroups';

const M_LAT = 1 / 111320;
const A = { lat: 35.2, lng: -80.8 };
const north = (p, m) => ({ lat: p.lat + m * M_LAT, lng: p.lng });

describe('sets that share a start', () => {
    it('the same start allows a few metres', () => {
        expect(sameStart(A, north(A, SAME_START_M - 2))).toBe(true);
        expect(sameStart(A, north(A, SAME_START_M + 2))).toBe(false);
        expect(sameStart(A, null)).toBe(false);
    });

    it('one pin per start, with every set of it', () => {
        const groups = groupByStart([
            { id: 'a', position: A },
            { id: 'b', position: north(A, 500) },
            { id: 'c', position: north(A, 5) },
            { id: 'd', position: null },
        ]);
        expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a', 'c'], ['b']]);
        expect(groups[0].position).toBe(A);
        expect(groups[0].key).toBe('a');
    });

    it('sets at a start, newest first; none for no start', () => {
        const gens = [
            { id: 'old', markerPosition: A, createdAt: 1 },
            { id: 'far', markerPosition: north(A, 300), createdAt: 3 },
            { id: 'new', markerPosition: north(A, 3), createdAt: 2 },
        ];
        expect(setsAtStart(gens, A).map((g) => g.id)).toEqual(['new', 'old']);
        expect(setsAtStart(gens, null)).toEqual([]);
    });
});

describe('length range of a set', () => {
    it('shortest and longest route', () => {
        const paths = [7.2, 14.9, 9.1].map((m) => ({ properties: { total_miles: m } }));
        expect(lengthRange(paths)).toEqual([7.2, 14.9]);
        expect(lengthRange([])).toBeNull();
        expect(lengthRange([{ properties: {} }])).toBeNull();
    });
});

describe('the pin menu and the plan\'s start choice', () => {
    it('a pin\'s menu lists its sets newest first, without reordering the pin\'s own list', () => {
        const items = [{ id: 'a', createdAt: 1 }, { id: 'c', createdAt: 3 }, { id: 'b', createdAt: 2 }, { id: 'x' }];
        expect(newestFirst(items).map((i) => i.id)).toEqual(['c', 'b', 'a', 'x']);
        expect(items.map((i) => i.id)).toEqual(['a', 'c', 'b', 'x']);
        expect(newestFirst(null)).toEqual([]);
    });

    const here = [{ id: 'new' }, { id: 'old' }];
    const pin = { lat: A.lat, lng: A.lng };

    it('a pin placed by hand on a start with sets makes a new set', () => {
        expect(chosenSet(here, null, pin)).toBe(null);
    });

    it('a set picked for this pin (or by Plan again from here) is added to', () => {
        expect(chosenSet(here, { pin: { ...pin }, id: 'old' }, pin)).toBe('old');
    });

    it('New set picked, the pin moved since, or the set gone: a new set', () => {
        expect(chosenSet(here, { pin, id: null }, pin)).toBe(null);
        expect(chosenSet(here, { pin: north(A, 5), id: 'old' }, pin)).toBe(null);
        expect(chosenSet(here, { pin, id: 'deleted' }, pin)).toBe(null);
        expect(chosenSet(here, { pin, id: 'old' }, null)).toBe(null);
    });
});
