import { describe, expect, it } from 'vitest';
import {
    bestRanks, boundsMeet, defaultAscending, directionText, favoriteStart, favoritesList, groupFocus, groupRecords, growBounds,
    inFocus, orderGroups, routeBounds, sortRecords, startFocus,
} from '../favoritesList';

const M_LAT = 1 / 111320;
const BOONE = { lat: 36.2, lng: -81.6 };
const CHARLOTTE = { lat: 35.2, lng: -80.8 };

// A route from `at`: a little loop there (n makes it its own route).
let seq = 0;
function route(at, n = 0, props = {}) {
    const d = 0.01 + n * 0.001;
    seq += 1;
    return {
        id: `r${seq}`,
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[at.lng, at.lat], [at.lng + d, at.lat], [at.lng + d, at.lat + d], [at.lng, at.lat]] },
        properties: { total_miles: 5 + n, total_climb_ft: 100 * n, ...props },
    };
}
const fav = (key, at, { setId = null, setName = null, createdAt = 0, n = 0, props = {}, start = at } = {}) => ({
    key, path: route(at, n, props), pathSetId: setId, setName, start, createdAt,
});

describe('where a favorite starts, and its route\'s box', () => {
    it('the start it was saved with, else its route\'s first point', () => {
        expect(favoriteStart(fav('a', BOONE))).toEqual(BOONE);
        expect(favoriteStart(fav('a', BOONE, { start: null }))).toEqual({ lat: BOONE.lat, lng: BOONE.lng });
        expect(favoriteStart({ path: { geometry: { coordinates: [] } } })).toBe(null);
    });

    it('bounds meet, and grow', () => {
        const b = routeBounds(route(BOONE, 0));
        expect(b.south).toBeCloseTo(BOONE.lat);
        expect(b.north).toBeCloseTo(BOONE.lat + 0.01);
        expect(boundsMeet(b, routeBounds(route(CHARLOTTE)))).toBe(false);
        const view = { south: 36.22, west: -81.6, north: 36.3, east: -81.5 }; // just north of the route
        expect(boundsMeet(b, view)).toBe(false);
        expect(boundsMeet(b, growBounds(view, 0.25))).toBe(true);
    });
});

describe('sorting favorites', () => {
    const a = fav('a', BOONE, { createdAt: 1, n: 3 });
    const b = fav('b', BOONE, { createdAt: 3, n: 1 });
    const c = fav('c', BOONE, { createdAt: 2, n: 2 });

    it('Date favorited: newest first by default, oldest first reversed', () => {
        expect(defaultAscending('favorited')).toBe(false);
        expect(sortRecords([a, b, c], 'favorited', false).map((r) => r.key)).toEqual(['b', 'c', 'a']);
        expect(sortRecords([a, b, c], 'favorited', true).map((r) => r.key)).toEqual(['a', 'c', 'b']);
        expect(directionText('favorited', false)).toBe('Newest first');
    });

    it('Best: the place in its set\'s found order; a favorite whose set is gone last', () => {
        const ranks = new Map([['a', 0], ['c', 4]]);
        expect(sortRecords([b, c, a], 'found', true, ranks).map((r) => r.key)).toEqual(['a', 'c', 'b']);
        expect(sortRecords([b, c, a], 'found', false, ranks).map((r) => r.key)).toEqual(['c', 'a', 'b']);
    });

    it('a measure: low to high, reversed high to low', () => {
        expect(sortRecords([a, b, c], 'total_miles', true).map((r) => r.key)).toEqual(['b', 'c', 'a']);
        expect(sortRecords([a, b, c], 'total_miles', false).map((r) => r.key)).toEqual(['a', 'c', 'b']);
    });

    it('ranks come from the sets\' routes', () => {
        const x = fav('kx', BOONE, { setId: 's1' });
        const y = fav('ky', BOONE, { setId: 'gone' });
        const sets = { s1: { paths: [{ k: 'other' }, { k: 'kx' }] } };
        const ranks = bestRanks([x, y], sets, (p) => p.k);
        expect(ranks.get('kx')).toBe(1);
        expect(ranks.has('ky')).toBe(false);
    });
});

describe('grouping favorites', () => {
    const gens = [
        { id: 's1', name: 'Boone', markerPosition: BOONE, createdAt: 1 },
        { id: 's2', name: 'Boone 2', markerPosition: { lat: BOONE.lat + 5 * M_LAT, lng: BOONE.lng }, createdAt: 2 },
    ];
    const one = fav('1', BOONE, { setId: 's1', setName: 'Boone', createdAt: 1 });
    const two = fav('2', BOONE, { setId: 's2', setName: 'Boone 2', createdAt: 2, n: 1 });
    const gone = fav('3', CHARLOTTE, { setId: 'old', setName: 'Dilworth', createdAt: 3 });

    it('by set: one group per set, a deleted one by its saved name (Plan here, no Open)', () => {
        const groups = groupRecords([one, two, gone], 'set', gens);
        expect(groups.map((g) => [g.title, g.setId, g.gone])).toEqual([['Boone', 's1', false], ['Boone 2', 's2', false], ['Dilworth', null, true]]);
        expect(groups[2].position).toEqual(CHARLOTTE);
    });

    it('by start: the sets of one place together', () => {
        const groups = groupRecords([one, two, gone], 'start', gens);
        expect(groups.map((g) => g.records.map((r) => r.key))).toEqual([['1', '2'], ['3']]);
        expect(groups[0].setIds).toEqual(['s2', 's1']);
        expect(groups[1].setId).toBe(null);
    });

    it('by start: Open opens the favorite\'s own set; its set deleted, another at that start, else none (its saved name)', () => {
        const gens1 = [{ id: 'g2', name: 'Boone 2', markerPosition: BOONE, createdAt: 2 }];
        const [here] = groupRecords([fav('a', BOONE, { setId: 'gone', setName: 'Boone' })], 'start', gens1);
        expect(here).toMatchObject({ setId: 'g2', title: 'Boone 2' });
        const [away] = groupRecords([fav('b', CHARLOTTE, { setId: 'gone', setName: 'Dilworth' })], 'start', gens1);
        expect(away).toMatchObject({ setId: null, title: 'Dilworth' });
        const [own] = groupRecords([fav('c', BOONE, { setId: 's1' })], 'start', gens);
        expect(own.setId).toBe('s1');
    });

    it('by start: a favorite saved without a start starts where its route does', () => {
        const groups = groupRecords([fav('x', BOONE, { start: null }), fav('y', BOONE)], 'start', gens);
        expect(groups.map((g) => g.records.map((r) => r.key))).toEqual([['x', 'y']]);
    });

    it('none: one list', () => {
        expect(groupRecords([one, two, gone], 'none', gens).map((g) => g.records.length)).toEqual([3]);
        expect(groupRecords([], 'none', gens)).toEqual([]);
    });

    it('groups near the view first (newest first), then the rest (newest first)', () => {
        const groups = groupRecords([one, two, gone], 'set', gens);
        const nearBoone = { south: 36.19, west: -81.61, north: 36.25, east: -81.55 };
        expect(orderGroups(groups, nearBoone).map((g) => [g.title, g.near])).toEqual([['Boone 2', true], ['Boone', true], ['Dilworth', false]]);
        expect(orderGroups(groups, null).map((g) => g.title)).toEqual(['Dilworth', 'Boone 2', 'Boone']);
    });
});

describe('groups in the sort\'s order, near the view first', () => {
    const gens = [
        { id: 'a', name: 'A', markerPosition: BOONE, createdAt: 1 },
        { id: 'b', name: 'B', markerPosition: BOONE, createdAt: 2 },
        { id: 'c', name: 'C', markerPosition: CHARLOTTE, createdAt: 3 },
    ];
    // miles (5 + n): A 6 and 14, B 20, C 5 and 17; favorited: A 6 and 2, B 1, C 3 and 4
    const records = [
        fav('a-short', BOONE, { setId: 'a', createdAt: 6, n: 1 }),
        fav('a-long', BOONE, { setId: 'a', createdAt: 2, n: 9 }),
        fav('b-only', BOONE, { setId: 'b', createdAt: 1, n: 15 }),
        fav('c-longest', CHARLOTTE, { setId: 'c', createdAt: 3, n: 12 }),
        fav('c-shortest', CHARLOTTE, { setId: 'c', createdAt: 4, n: 0 }),
    ];
    const titles = (opts) => favoritesList(records, { generations: gens, grouping: 'set', ...opts }).groups.map((g) => g.title);

    it('by Length: the group with the shortest route first; reversed, the longest first', () => {
        expect(titles({ sortBy: 'total_miles', ascending: true })).toEqual(['C', 'A', 'B']); // 5, 6, 20
        expect(titles({ sortBy: 'total_miles', ascending: false })).toEqual(['B', 'C', 'A']); // 20, 17, 14
        const list = favoritesList(records, { generations: gens, grouping: 'set', sortBy: 'total_miles', ascending: false });
        expect(list.groups[1].records.map((r) => r.key)).toEqual(['c-longest', 'c-shortest']);
    });

    it('by Date favorited: the newest favorite first; reversed, the oldest first', () => {
        expect(titles({ sortBy: 'favorited', ascending: false })).toEqual(['A', 'C', 'B']); // 6, 4, 1
        expect(titles({ sortBy: 'favorited', ascending: true })).toEqual(['B', 'A', 'C']); // 1, 2, 3
    });

    it('near the view first, each part in the sort\'s order', () => {
        const boone = { south: 36.19, west: -81.61, north: 36.25, east: -81.55 };
        expect(titles({ sortBy: 'total_miles', ascending: false, orderView: boone })).toEqual(['B', 'A', 'C']);
        expect(titles({ sortBy: 'total_miles', ascending: true, orderView: boone })).toEqual(['A', 'B', 'C']);
    });
});

describe('focus: one group\'s or one start\'s favorites', () => {
    const a = fav('a', BOONE, { setId: 's1' });
    const b = fav('b', CHARLOTTE, { setId: 's2' });
    const c = fav('c', { lat: BOONE.lat + 5 * M_LAT, lng: BOONE.lng }, { setId: 's3' });

    it('a group: only its favorites', () => {
        const focus = groupFocus({ key: 'set:s1', records: [a] });
        expect([a, b, c].filter((r) => inFocus(r, focus)).map((r) => r.key)).toEqual(['a']);
        expect(focus.id).toBe('group:set:s1');
    });

    it('a start: every favorite that starts there (a few metres apart count)', () => {
        const focus = startFocus(BOONE);
        expect([a, b, c].filter((r) => inFocus(r, focus)).map((r) => r.key)).toEqual(['a', 'c']);
    });

    it('no focus: every one', () => {
        expect([a, b, c].every((r) => inFocus(r, null))).toBe(true);
        expect(groupFocus(null)).toBe(null);
        expect(startFocus(null)).toBe(null);
    });
});

describe('the whole list', () => {
    const gens = [{ id: 's1', name: 'Boone', markerPosition: BOONE, createdAt: 1 }];
    const records = [
        fav('short', BOONE, { setId: 's1', createdAt: 1, n: 0 }),
        fav('long', BOONE, { setId: 's1', createdAt: 2, n: 9 }),
        fav('city', CHARLOTTE, { setId: 'gone', setName: 'Dilworth', createdAt: 3, n: 2 }),
    ];

    it('filters by a measure; the sliders span every favorite', () => {
        const list = favoritesList(records, { generations: gens, filters: [{ key: 'total_miles', range: [null, 8] }] });
        expect(list.paths.length).toBe(2);
        expect(list.shown).toBe(2);
        expect(list.bounds.total_miles).toMatchObject({ min: 5, max: 14 });
    });

    it('in map view: only favorites whose route is in the view', () => {
        const view = { south: 35.1, west: -80.9, north: 35.3, east: -80.7 };
        const list = favoritesList(records, { generations: gens, inView: view });
        expect(list.paths.map((p) => records.find((r) => r.path === p).key)).toEqual(['city']);
    });

    it('the arrows\' order is the list\'s: groups in order, each sorted', () => {
        const view = { south: 36.19, west: -81.61, north: 36.25, east: -81.55 }; // Boone in view
        const list = favoritesList(records, { generations: gens, grouping: 'set', sortBy: 'favorited', ascending: false, orderView: view });
        expect(list.groups.map((g) => g.title)).toEqual(['Boone', 'Dilworth']);
        expect(list.paths.map((p) => records.find((r) => r.path === p).key)).toEqual(['long', 'short', 'city']);
        const flat = favoritesList(records, { generations: gens, grouping: 'none', sortBy: 'total_miles', ascending: true, orderView: view });
        expect(flat.paths.map((p) => records.find((r) => r.path === p).key)).toEqual(['short', 'city', 'long']);
    });
});
