import { describe, expect, it } from 'vitest';
import { combineSets } from '../combinedSets';

// A route along a made-up line; `n` picks the line (same n: the same roads).
const route = (id, n, reversed = false) => {
    const coords = [[-81, 36], [-81 + 0.001 * n, 36.001], [-81 + 0.002 * n, 36]];
    return { id, type: 'Feature', geometry: { type: 'LineString', coordinates: reversed ? coords.reverse() : coords }, properties: {} };
};

describe('all routes from one start', () => {
    const older = { id: 'old', name: 'Boone', createdAt: 1, paths: [route('o1', 1), route('o2', 2), route('o3', 3)] };
    const newer = { id: 'new', name: 'Boone 2', createdAt: 2, paths: [route('n1', 11), route('n2', 12)] };

    it('Best takes turns between the sets, newest set first', () => {
        const { paths, setIds } = combineSets([older, newer]);
        expect(paths.map((p) => p.id)).toEqual(['n1', 'o1', 'n2', 'o2', 'o3']);
        expect(setIds).toEqual(['new', 'old']);
    });

    it('every route knows its set', () => {
        const { ownerOf } = combineSets([older, newer]);
        expect(ownerOf.get('n2')).toBe('new');
        expect(ownerOf.get('o3')).toBe('old');
    });

    it('a route both sets found (either way round) is listed once, as the set where it comes first', () => {
        const again = { ...newer, paths: [route('n1', 11), route('n2', 2, true)] }; // n2: o2 ridden the other way
        const { paths, ownerOf, alsoIn } = combineSets([older, again]);
        expect(paths.map((p) => p.id)).toEqual(['n1', 'o1', 'n2', 'o3']);
        expect(ownerOf.get('n2')).toBe('new');
        expect(alsoIn.get('n2')).toEqual(['old']);
        expect(alsoIn.get('o1')).toEqual([]);
    });

    it('a route without a line is never taken for a repeat', () => {
        const bare = (id) => ({ id, type: 'Feature', geometry: null, properties: {} });
        const { paths } = combineSets([{ id: 'a', createdAt: 1, paths: [bare('x')] }, { id: 'b', createdAt: 2, paths: [bare('y')] }]);
        expect(paths.map((p) => p.id)).toEqual(['y', 'x']);
    });

    it('no sets, empty sets', () => {
        expect(combineSets([]).paths).toEqual([]);
        expect(combineSets(null).paths).toEqual([]);
        expect(combineSets([{ id: 'e', createdAt: 1, paths: [] }]).paths).toEqual([]);
    });
});
