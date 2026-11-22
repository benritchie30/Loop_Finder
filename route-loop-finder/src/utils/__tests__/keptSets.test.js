import { describe, expect, it } from 'vitest';
import { KEPT_AT, KEPT_ID, KEPT_NAME, favoriteStart, isKeptId, keptSets } from '../keptSets';

const line = (lng, lat) => ({ geometry: { type: 'LineString', coordinates: [[lng, lat], [lng + 0.01, lat], [lng, lat]] } });
const HERE = { lat: 35.2, lng: -80.8 };
const FAR = { lat: 36.2, lng: -81.7 };
const record = (key, extra) => ({ key, path: line(-80.8, 35.2), createdAt: 1, ...extra });

describe('favoriteStart', () => {
    it('uses the saved start, else the route\'s first point', () => {
        expect(favoriteStart({ start: { lat: 1, lng: 2 } })).toEqual({ lat: 1, lng: 2 });
        expect(favoriteStart({ path: line(-80, 35) })).toEqual({ lat: 35, lng: -80 });
        expect(favoriteStart({})).toBeNull();
    });
});

describe('keptSets', () => {
    it('puts a deleted set\'s favorites at its start: with the other sets there, else on its own', () => {
        const favorites = new Map([
            ['a', record('a', { pathSetId: 'gone', start: HERE, createdAt: 2 })],
            ['b', record('b', { pathSetId: 'gone too', start: HERE, createdAt: 5 })],
            ['c', record('c', { pathSetId: 'gone far', setName: 'Boone 2', start: FAR, createdAt: 3 })],
            ['e', record('e', { pathSetId: 'gone far', start: { lat: FAR.lat + 0.00005, lng: FAR.lng }, createdAt: 4 })],
            ['f', { key: 'f', path: {}, pathSetId: 'gone', createdAt: 6 }], // no start at all
            ['d', record('d', { pathSetId: 'old', start: HERE })],
        ]);
        const pathSets = {
            newer: { markerPosition: HERE, createdAt: 9, paths: [] },
            old: { markerPosition: HERE, createdAt: 1, paths: [] },
        };
        const out = keptSets(favorites, pathSets);
        const farId = 'kept:@36.20000,-81.70000';
        expect(Object.keys(out).sort()).toEqual([`${KEPT_AT}old`, farId, KEPT_ID].sort());

        const here = out[`${KEPT_AT}old`];
        expect(here.name).toBe(KEPT_NAME);
        expect(here.markerPosition).toEqual(HERE);
        expect(here.paths).toEqual([favorites.get('b').path, favorites.get('a').path]); // newest favorited first
        expect(here.kept).toBe(true);
        expect(here.resumable).toBe(false);

        const far = out[farId];
        expect(far.markerPosition).toEqual(FAR);
        expect(far.place).toBe('Boone');
        expect(far.paths).toEqual([favorites.get('e').path, favorites.get('c').path]); // one set for one start

        expect(out[KEPT_ID].markerPosition).toBeNull();
        expect(out[KEPT_ID].paths).toEqual([favorites.get('f').path]);
        expect(isKeptId(KEPT_ID) && isKeptId(`${KEPT_AT}old`) && isKeptId(farId)).toBe(true);
        expect(isKeptId('old')).toBe(false);
    });

    it('lists a deleted set\'s favorite even when another set found its route too', () => {
        const favorites = new Map([['a', record('a', { pathSetId: 'gone', start: HERE })]]);
        const out = keptSets(favorites, { other: { markerPosition: HERE, paths: [favorites.get('a').path] } });
        expect(out[`${KEPT_AT}other`].paths).toEqual([favorites.get('a').path]);
    });

    it('is empty when every favorite\'s set is there, or without favorites', () => {
        const favorites = new Map([['c', record('c', { pathSetId: 'here' })]]);
        expect(keptSets(favorites, { here: { paths: [] } })).toEqual({});
        expect(keptSets(null, {})).toEqual({});
    });
});
