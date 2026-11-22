import { describe, expect, it } from 'vitest';
import { chosenSet, groupByStart, lengthRange, newestFirst, sameStart, setsAtStart, SAME_START_M } from '../pathSetGroups';
import { startGroups } from '../pathSetGroups';

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

describe('Your loops by start (startGroups)', () => {
    const at = (lat, lng) => ({ lat, lng });
    const box = (lat, lng) => ({ south: lat - 0.05, west: lng - 0.05, north: lat + 0.05, east: lng + 0.05 });
    const gens = [
        { id: 'a', name: 'Dilworth, Charlotte', markerPosition: at(35.2, -80.85), createdAt: 1, bounds: box(35.2, -80.85) },
        { id: 'b', name: 'Dilworth, Charlotte 2', markerPosition: at(35.2, -80.85), createdAt: 5, bounds: box(35.2, -80.85) },
        { id: 'c', name: 'Boone', markerPosition: at(36.2, -81.7), createdAt: 3, bounds: box(36.2, -81.7) },
        { id: 'kept:deleted', name: 'Favorites from deleted sets', markerPosition: null, createdAt: 9, kept: true },
    ];

    it('one group per start, named after its first set, sets newest first, the kept set last', () => {
        const groups = startGroups(gens);
        expect(groups.map((g) => g.name)).toEqual(['Dilworth, Charlotte', 'Boone', 'Favorites from deleted sets']);
        expect(groups[0].sets.map((s) => s.id)).toEqual(['b', 'a']);
        expect(groups[0].key).toBe('a');
        expect(groups[2].kept).toBe(true);
    });

    it('a start\'s kept set is listed after its sets, the group still named after its oldest set', () => {
        const withKept = [...gens, {
            id: 'kept:at:a', name: 'Favorites from deleted sets', markerPosition: at(35.2, -80.85), createdAt: 0, kept: true,
        }];
        const groups = startGroups(withKept);
        expect(groups[0].name).toBe('Dilworth, Charlotte');
        expect(groups[0].key).toBe('a');
        expect(groups[0].sets.map((s) => s.id)).toEqual(['b', 'a', 'kept:at:a']);
    });

    it('the starts with a route in the view come first', () => {
        const groups = startGroups(gens, box(36.2, -81.7));
        expect(groups.map((g) => [g.name, g.near])).toEqual([
            ['Boone', true], ['Dilworth, Charlotte', false], ['Favorites from deleted sets', false],
        ]);
    });
});
