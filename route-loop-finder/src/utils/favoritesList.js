/**
 * The Favorites page's list: every favorite (a record of hooks/useFavorites:
 * { key, path, pathSetId, setName, start, createdAt }), sorted, grouped and
 * filtered. Pure, for tests.
 *
 * - Sort: Date favorited (newest first by default), Best (the route's place in
 *   its set's found order; one whose set is gone comes last), or a route
 *   measure (Length, Climb rate, ...). Routes without the value come last.
 * - Group: by set (one group per generation, a deleted one too, by the name
 *   it was saved with), by start (every set that starts at one place,
 *   utils/pathSetGroups.SAME_START_M), or none (one list).
 * - Group order: the groups near the map's view first (a favorite of theirs
 *   within the view grown by NEAR_PAD of its size on each side: just off
 *   screen counts), then the rest; within each, by their top card in the
 *   sort (sorted by Length, the group with the shortest route first, or the
 *   longest reversed; by Date favorited, the newest favorite first), so the
 *   whole list reads in one order.
 * - "In map view": only favorites whose route is in the view.
 * - Focus (inFocus): the map's faint routes can show only one group's
 *   favorites, or one start's.
 */
import { groupByStart, sameStart, setsAtStart } from './pathSetGroups';
import { FILTER_METRICS, filterByMetrics, metricBounds, sortPaths } from './pathFiltering';

export const NEAR_PAD = 0.25;

const METRIC_SORTS = ['total_miles', 'climb_rate', 'total_climb_ft', 'difficulty', 'loop_ratio', 'unpaved_share', 'discomfort'];
export const FAVORITE_SORTS = [
    { id: 'favorited', label: 'Date favorited' },
    { id: 'found', label: 'Best' },
    ...METRIC_SORTS.map((key) => ({ id: key, label: FILTER_METRICS.find((m) => m.key === key).label })),
];
export const GROUPINGS = [
    { id: 'set', label: 'By set', hint: 'One group per set the favorites were found in' },
    { id: 'start', label: 'By start', hint: 'Every set that starts at one place together' },
    { id: 'none', label: 'None', hint: 'One list, sorted together' },
];

/** The way a sort runs first: newest first for Date favorited, else low to high (best first). */
export function defaultAscending(sortBy) {
    return sortBy !== 'favorited';
}

/** The direction button's words. */
export function directionText(sortBy, ascending) {
    if (sortBy === 'favorited') return ascending ? 'Oldest first' : 'Newest first';
    if (sortBy === 'found') return ascending ? 'Best first' : 'Best last';
    return ascending ? 'Low to high' : 'High to low';
}

function validPoint(p) {
    return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? p : null;
}

/**
 * Where a favorite starts: the start it was saved with, else its route's
 * first point (a loop begins and ends at its start); null without either.
 */
export function favoriteStart(record) {
    const saved = validPoint(record?.start);
    if (saved) return saved;
    const first = record?.path?.geometry?.coordinates?.[0];
    return Array.isArray(first) && Number.isFinite(first[0]) && Number.isFinite(first[1])
        ? { lat: first[1], lng: first[0] }
        : null;
}

const boundsCache = new WeakMap();

/** A route's { south, west, north, east }, or null. Remembered per route object. */
export function routeBounds(path) {
    if (!path || typeof path !== 'object') return null;
    if (boundsCache.has(path)) return boundsCache.get(path);
    let out = null;
    (path.geometry?.coordinates || []).forEach((c) => {
        const [lng, lat] = c || [];
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        if (!out) out = { south: lat, west: lng, north: lat, east: lng };
        else {
            out.south = Math.min(out.south, lat);
            out.north = Math.max(out.north, lat);
            out.west = Math.min(out.west, lng);
            out.east = Math.max(out.east, lng);
        }
    });
    boundsCache.set(path, out);
    return out;
}

/** Do two bounds overlap? */
export function boundsMeet(a, b) {
    return !!a && !!b && a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

/** Bounds grown by `pad` of their size on each side. */
export function growBounds(b, pad) {
    if (!b) return null;
    const dLat = (b.north - b.south) * pad;
    const dLng = (b.east - b.west) * pad;
    return { south: b.south - dLat, west: b.west - dLng, north: b.north + dLat, east: b.east + dLng };
}

/**
 * Each favorite's rank for Best: its route's place in its set's found order
 * (0 first). pathSets: id -> { paths }; keyOf: a route's key (utils/routeIdentity).
 * Returns Map(record key -> rank); a favorite whose set is gone (or no longer
 * has it) has none.
 */
export function bestRanks(records, pathSets, keyOf) {
    const ranks = new Map();
    const bySet = new Map();
    (records || []).forEach((r) => {
        if (!r?.pathSetId || !pathSets?.[r.pathSetId]) return;
        if (!bySet.has(r.pathSetId)) bySet.set(r.pathSetId, []);
        bySet.get(r.pathSetId).push(r);
    });
    bySet.forEach((list, setId) => {
        const wanted = new Map(list.map((r) => [r.key, r]));
        (pathSets[setId].paths || []).some((p, i) => {
            const key = keyOf(p);
            if (wanted.has(key)) {
                ranks.set(key, i);
                wanted.delete(key);
            }
            return wanted.size === 0;
        });
    });
    return ranks;
}

/** Records in the order of `sortBy` (ranks: bestRanks). The way it runs: `ascending`. */
export function sortRecords(records, sortBy, ascending, ranks = new Map()) {
    const list = [...(records || [])];
    const newestFirst = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
    if (sortBy === 'favorited') {
        return list.sort((a, b) => (ascending ? -newestFirst(a, b) : newestFirst(a, b)));
    }
    if (sortBy === 'found') {
        return list.sort((a, b) => {
            const ra = ranks.get(a.key);
            const rb = ranks.get(b.key);
            if (ra == null || rb == null) return (ra == null) - (rb == null) || newestFirst(a, b);
            return (ascending ? ra - rb : rb - ra) || newestFirst(a, b);
        });
    }
    const byPath = new Map(list.map((r) => [r.path, r]));
    return sortPaths(list.map((r) => r.path), sortBy, ascending).map((p) => byPath.get(p));
}

const newestOf = (records) => records.reduce((n, r) => Math.max(n, r.createdAt || 0), 0);

/**
 * Groups of records: [{ key, title, position, setId, setIds, gone, records }].
 * setId: the set the group's Open opens (null: none left; Plan here instead);
 * setIds: every set of the group (by start: all that start there); gone: the
 * group's set was deleted (by set).
 */
export function groupRecords(records, grouping, generations) {
    const list = records || [];
    const gens = generations || [];
    const byId = new Map(gens.map((g) => [g.id, g]));
    if (grouping === 'none') {
        return list.length ? [{ key: 'all', title: null, position: null, setId: null, setIds: [], gone: false, records: list }] : [];
    }
    if (grouping === 'start') {
        const located = list.filter((r) => favoriteStart(r));
        const groups = groupByStart(located.map((r) => ({ id: r.key, position: favoriteStart(r), record: r })))
            .map((g) => {
                const records = g.items.map((i) => i.record);
                const here = setsAtStart(gens, g.position); // newest first
                const own = records.map((r) => byId.get(r.pathSetId)).find(Boolean);
                const open = own || here[0] || null;
                const saved = records.find((r) => r.setName)?.setName;
                return {
                    key: `start:${g.key}`,
                    title: open?.name || saved || 'Favorites',
                    position: g.position,
                    setId: open?.id ?? null,
                    setIds: here.map((s) => s.id),
                    gone: false,
                    records,
                };
            });
        const loose = list.filter((r) => !favoriteStart(r));
        if (loose.length) groups.push({ key: 'start:none', title: 'Favorites', position: null, setId: null, setIds: [], gone: false, records: loose });
        return groups;
    }
    // by set: a deleted set is a group too (the name it was saved with)
    const groups = new Map();
    list.forEach((r) => {
        const key = r.pathSetId ? `set:${r.pathSetId}` : `start:${favoriteStart(r) ? `${favoriteStart(r).lat.toFixed(5)},${favoriteStart(r).lng.toFixed(5)}` : 'none'}`;
        if (!groups.has(key)) {
            const gen = r.pathSetId ? byId.get(r.pathSetId) : null;
            groups.set(key, {
                key,
                title: gen?.name || r.setName || 'Favorites',
                position: gen?.markerPosition || favoriteStart(r),
                setId: gen?.id ?? null,
                setIds: gen ? [gen.id] : [],
                gone: !gen,
                records: [],
            });
        }
        groups.get(key).records.push(r);
    });
    return [...groups.values()];
}

/**
 * Groups near `nearView` first (a favorite whose route meets it), then the
 * rest; within each, by their top card: its place in the sorted list
 * (`place`: Map(record key -> index); without it, the newest favorite
 * first). Marks each group `near`.
 */
export function orderGroups(groups, nearView, place = null) {
    const top = (g) => (place
        ? Math.min(...g.records.map((r) => place.get(r.key) ?? Infinity))
        : -newestOf(g.records));
    return (groups || [])
        .map((g) => ({ ...g, near: !!nearView && g.records.some((r) => boundsMeet(routeBounds(r.path), nearView)), top: top(g) }))
        .sort((a, b) => (b.near - a.near) || (a.top - b.top) || String(a.title).localeCompare(String(b.title)));
}

/** A focus on one group's favorites: { id, keys }. */
export function groupFocus(group) {
    return group ? { id: `group:${group.key}`, keys: new Set(group.records.map((r) => r.key)) } : null;
}

/** A focus on the favorites that start at `position`: { id, position }. */
export function startFocus(position) {
    return position ? { id: `start:${position.lat.toFixed(6)},${position.lng.toFixed(6)}`, position } : null;
}

/** Is the favorite in the focus (no focus: every one is)? */
export function inFocus(record, focus) {
    if (!focus) return true;
    if (focus.keys) return focus.keys.has(record.key);
    if (focus.position) return sameStart(favoriteStart(record), focus.position);
    return true;
}

/**
 * The whole list: records -> { groups (ordered, each sorted), paths (in list
 * order, the arrows' order), bounds (slider ends of every filter, from every
 * record), shown (how many pass) }.
 * options: { generations, grouping, sortBy, ascending, ranks, filters
 * (metric ranges), inView (bounds or null: only favorites in it), orderView
 * (bounds or null: groups near it first) }.
 */
export function favoritesList(records, {
    generations = [], grouping = 'set', sortBy = 'favorited', ascending = false, ranks = new Map(),
    filters = [], inView = null, orderView = null,
} = {}) {
    const all = records || [];
    const bounds = {};
    FILTER_METRICS.forEach((metric) => {
        bounds[metric.key] = metricBounds(all.map((r) => r.path), metric);
    });
    const passing = new Set(filterByMetrics(all.map((r) => r.path), filters));
    let shown = all.filter((r) => passing.has(r.path));
    if (inView) shown = shown.filter((r) => boundsMeet(routeBounds(r.path), inView));
    const sorted = sortRecords(shown, sortBy, ascending, ranks);
    const grouped = groupRecords(sorted, grouping, generations); // (grouping keeps the sorted order inside groups)
    const place = new Map(sorted.map((r, i) => [r.key, i]));
    const groups = grouping === 'none' ? grouped : orderGroups(grouped, orderView ? growBounds(orderView, NEAR_PAD) : null, place);
    return {
        groups,
        paths: groups.flatMap((g) => g.records.map((r) => r.path)),
        bounds,
        shown: shown.length,
    };
}
