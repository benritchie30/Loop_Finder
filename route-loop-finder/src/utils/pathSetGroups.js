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
