/**
 * Dev compare (LOOP_DEV=1): two generations from the same start, A (the open
 * one) and B. A route is "the same" in both when it has the same routeKey
 * (same roads in the same order, either way round), so each route of either
 * set is A only, B only, or shared.
 */
import { routeKey } from './routeIdentity';

export const COMPARE_VIEWS = [
    { id: 'all', label: 'All' },
    { id: 'a', label: 'A only' },
    { id: 'shared', label: 'Shared' },
    { id: 'b', label: 'B only' },
];

/** Hue of each group, on the map, the switch and the route cards. */
export const COMPARE_HUES = { a: 212, b: 28, shared: 280 };

/** Badge text of each group. */
export const GROUP_BADGE = { a: 'A', b: 'B', shared: 'A+B' };

/**
 * The union of both sets and which group each route is in.
 * Returns { paths, groupOf: Map(id -> 'a'|'b'|'shared'), aTotal, bTotal }.
 * Shared routes appear once (A's copy). A route without a line is never shared.
 */
export function compareSets(aPaths, bPaths) {
    const bKeys = new Set();
    (bPaths || []).forEach((p) => {
        const key = routeKey(p);
        if (key) bKeys.add(key);
    });
    const aKeys = new Set();
    const groupOf = new Map();
    const paths = [];
    (aPaths || []).forEach((p) => {
        const key = routeKey(p);
        if (key) aKeys.add(key);
        groupOf.set(p.id, key && bKeys.has(key) ? 'shared' : 'a');
        paths.push(p);
    });
    const seenB = new Set();
    (bPaths || []).forEach((p) => {
        const key = routeKey(p);
        if (key && (aKeys.has(key) || seenB.has(key))) return;
        if (key) seenB.add(key);
        groupOf.set(p.id, 'b');
        paths.push(p);
    });
    return { paths, groupOf, aTotal: (aPaths || []).length, bTotal: (bPaths || []).length };
}

/** How many of `paths` are in each group: { all, a, shared, b }. */
export function countGroups(paths, groupOf) {
    const counts = { all: 0, a: 0, shared: 0, b: 0 };
    (paths || []).forEach((p) => {
        const g = groupOf.get(p.id);
        if (!g) return;
        counts.all += 1;
        counts[g] += 1;
    });
    return counts;
}

/** Is a route of `group` listed in `view`? */
export function inView(group, view) {
    return view === 'all' || group === view;
}

/** The view after A and B swap places. */
export function swappedView(view) {
    if (view === 'a') return 'b';
    if (view === 'b') return 'a';
    return view;
}

/**
 * Settings rows ([label, value]) that differ between A and B:
 * [{ label, a, b }]. The start is left out (the same start, give or take a few metres).
 */
export function settingsDiff(rowsA, rowsB, skip = ['Start']) {
    const a = new Map(rowsA);
    const b = new Map(rowsB);
    const labels = [...new Set([...a.keys(), ...b.keys()])].filter((l) => !skip.includes(l));
    return labels
        .filter((label) => a.get(label) !== b.get(label))
        .map((label) => ({ label, a: a.get(label) ?? '—', b: b.get(label) ?? '—' }));
}
