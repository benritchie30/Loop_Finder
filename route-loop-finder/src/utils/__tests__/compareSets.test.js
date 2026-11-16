import { describe, expect, it } from 'vitest';
import { compareSets, countGroups, inView, settingsDiff, swappedView } from '../compareSets';

const route = (id, coords) => ({ id, type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
const R1 = [[-80.8, 35.2], [-80.79, 35.2], [-80.79, 35.21], [-80.8, 35.2]];
const R2 = [[-80.8, 35.2], [-80.81, 35.2], [-80.81, 35.21], [-80.8, 35.2]];
const R3 = [[-80.8, 35.2], [-80.8, 35.19], [-80.79, 35.19], [-80.8, 35.2]];

describe('dev compare of two generations', () => {
    it('splits routes into A only, shared and B only', () => {
        const a = [route('a1', R1), route('a2', R2)];
        const b = [route('b1', R2.map((c) => [...c])), route('b2', R3)];
        const { paths, groupOf, aTotal, bTotal } = compareSets(a, b);
        expect(paths.map((p) => p.id)).toEqual(['a1', 'a2', 'b2']); // shared once, A's copy
        expect(groupOf.get('a1')).toBe('a');
        expect(groupOf.get('a2')).toBe('shared');
        expect(groupOf.get('b2')).toBe('b');
        expect([aTotal, bTotal]).toEqual([2, 2]);
        expect(countGroups(paths, groupOf)).toEqual({ all: 3, a: 1, shared: 1, b: 1 });
    });

    it('a route ridden the other way round is shared', () => {
        const { groupOf } = compareSets([route('a1', R1)], [route('b1', [...R1].reverse())]);
        expect(groupOf.get('a1')).toBe('shared');
    });

    it('counts only the routes given (after filters)', () => {
        const { paths, groupOf } = compareSets([route('a1', R1)], [route('b1', R3)]);
        expect(countGroups(paths.slice(1), groupOf)).toEqual({ all: 1, a: 0, shared: 0, b: 1 });
    });

    it('views and swapping', () => {
        expect(inView('shared', 'all')).toBe(true);
        expect(inView('a', 'b')).toBe(false);
        expect(swappedView('a')).toBe('b');
        expect(swappedView('shared')).toBe('shared');
    });

    it('lists only the settings that differ, not the start', () => {
        const diff = settingsDiff(
            [['Roads', 'balanced roads'], ['Search', 'tree_guided'], ['Start', '1, 2']],
            [['Roads', 'balanced roads'], ['Search', 'loop_atlas'], ['Start', '1, 3']],
        );
        expect(diff).toEqual([{ label: 'Search', a: 'tree_guided', b: 'loop_atlas' }]);
    });
});
