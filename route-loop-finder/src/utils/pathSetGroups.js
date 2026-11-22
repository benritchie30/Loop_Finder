/**
 * Generations (path sets) that share a start. Starts snap onto the road, so
 * two searches from the same place share the same point; older generations
 * kept the clicked point, so "the same start" allows a few metres.
 */
import { metersBetween } from './routeSelections';

export const SAME_START_M = 20;

function positionOf(item) {
    const p = item?.position || item?.markerPosition;
    return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? p : null;
}

/** Is `a` the same start as `b` (both { lat, lng })? */
export function sameStart(a, b, withinM = SAME_START_M) {
    return !!a && !!b && metersBetween(a.lat, a.lng, b.lat, b.lng) <= withinM;
}

/**
 * One map pin per start: [{ key, position, items }], `items` in the order
 * given. A pin sits at its first item's start; later items within
 * SAME_START_M of it join it.
 */
export function groupByStart(items, withinM = SAME_START_M) {
    const groups = [];
    (items || []).forEach((item) => {
        const position = positionOf(item);
        if (!position) return;
        const group = groups.find((g) => sameStart(g.position, position, withinM));
        if (group) group.items.push(item);
        else groups.push({ key: item.id, position, items: [item] });
    });
    return groups;
}

/** The generations that start where `position` is, newest first. */
export function setsAtStart(generations, position, withinM = SAME_START_M) {
    if (!position) return [];
    return (generations || [])
        .filter((g) => sameStart(positionOf(g), position, withinM))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** The generations at a pin, for its menu: newest first (a copy). */
export function newestFirst(items) {
    return [...(items || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * The generation Find loops adds to, from the plan's start choice
 * ({ pin, id }: picked in "Loops from here", or by "Plan again from here"):
 * its id while the pin is still where it was chosen and the generation still
 * starts there, else null (a new set). A pin placed by hand on a start that
 * has generations starts a new set unless one is picked.
 */
export function chosenSet(setsHere, choice, pin) {
    if (!choice || choice.id == null || !pin || !choice.pin) return null;
    const samePin = Math.abs(choice.pin.lat - pin.lat) < 1e-9 && Math.abs(choice.pin.lng - pin.lng) < 1e-9;
    if (!samePin) return null;
    return (setsHere || []).some((g) => g.id === choice.id) ? choice.id : null;
}

const boundsCache = new WeakMap();

/**
 * { south, west, north, east } around every route of a list (GeoJSON
 * lines), or null. Remembered per list (a set's routes are a new list when
 * one is added).
 */
export function routesBounds(paths) {
    if (!paths?.length) return null;
    if (boundsCache.has(paths)) return boundsCache.get(paths);
    let [s, w, n, e] = [90, 180, -90, -180];
    paths.forEach((p) => (p?.geometry?.coordinates || []).forEach(([lng, lat]) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
    }));
    const out = s <= n ? { south: s, west: w, north: n, east: e } : null;
    boundsCache.set(paths, out);
    return out;
}

/** Do two { south, west, north, east } boxes overlap? */
export function boundsMeet(a, b) {
    return !!a && !!b && a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

/**
 * "Your loops" by start: [{ key, name, sets (newest first), position, near, kept }].
 * One group per start (SAME_START_M; its key the oldest set's id, its name
 * the oldest set's without a trailing number: "Dilworth, Charlotte" for
 * "Dilworth, Charlotte 2"). Groups with a route in `view` ({ south, west,
 * north, east }) first (near), then the rest, each by its newest set; a
 * start's kept set (favorites from deleted sets) listed after its sets; the
 * kept set with no start last, a group of its own.
 */
export function startGroups(generations, view = null) {
    // (a start's kept set after its sets, so the group is keyed and named by its oldest set)
    const located = (generations || []).filter((g) => positionOf(g))
        .slice().sort((a, b) => (Number(!!a.kept) - Number(!!b.kept)) || ((a.createdAt || 0) - (b.createdAt || 0)));
    const groups = groupByStart(located).map((g) => {
        const sets = [...newestFirst(g.items.filter((i) => !i.kept)), ...g.items.filter((i) => i.kept)];
        const oldest = g.items[0];
        // (a start with only a kept set: the deleted set's place)
        const name = oldest?.kept ? oldest.place || oldest.name : oldest?.name;
        return {
            key: g.key,
            name: (name || 'Loops').replace(/\s+#?\d+$/, ''),
            sets,
            position: oldest?.markerPosition || null, // the pin's start
            near: !!view && sets.some((s) => boundsMeet(s.bounds, view)),
            newest: sets[0]?.createdAt || 0,
            kept: false,
        };
    });
    groups.sort((a, b) => (Number(b.near) - Number(a.near)) || (b.newest - a.newest));
    (generations || []).filter((g) => g.kept && !positionOf(g)).forEach((g) => {
        groups.push({ key: g.id, name: g.name, sets: [g], position: null, near: false, newest: g.createdAt || 0, kept: true });
    });
    return groups;
}

/** [shortest, longest] route length (miles) of a generation's routes, or null. */
export function lengthRange(paths) {
    let lo = Infinity;
    let hi = -Infinity;
    (paths || []).forEach((p) => {
        const miles = p?.properties?.total_miles;
        if (!Number.isFinite(miles)) return;
        lo = Math.min(lo, miles);
        hi = Math.max(hi, miles);
    });
    return lo <= hi ? [lo, hi] : null;
}
