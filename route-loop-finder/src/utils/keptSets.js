/**
 * Kept sets: the favorites of deleted generations. A favorite keeps its own
 * copy of the route, its set's name and its start (hooks/useFavorites), so
 * when its set is deleted it is not lost. Each is listed at its start in a
 * set named "Favorites from deleted sets", one per start, which is like any
 * other set there: a pin (its own when no other set starts there), a chip in
 * all routes from there, a row under that start in Your loops.
 * - Other sets still start there: id `kept:at:<the oldest of them>`, at that
 *   set's start.
 * - None: id `kept:@<lat>,<lng>`, at the start the favorites were saved with
 *   (`place`: the deleted set's name without its number, for Your loops).
 * A favorite with no start at all (none saved, no line) goes in one set with
 * no pin (KEPT_ID). Nothing is stored for them: they are made from the
 * favorites whose set is gone, so one disappears when its last favorite is
 * unfavorited (or Undo brings its set back). Pure, for tests.
 */
import { sameStart } from './pathSetGroups';

export const KEPT_ID = 'kept:deleted';
export const KEPT_AT = 'kept:at:';
export const KEPT_NAME = 'Favorites from deleted sets';

/** Is this generation id a kept set's? */
export function isKeptId(id) {
    return typeof id === 'string' && id.startsWith('kept:');
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
    if (saved) return { lat: saved.lat, lng: saved.lng };
    const first = record?.path?.geometry?.coordinates?.[0];
    return Array.isArray(first) && Number.isFinite(first[0]) && Number.isFinite(first[1])
        ? { lat: first[1], lng: first[0] }
        : null;
}

/** "Dilworth, Charlotte" for "Dilworth, Charlotte 2". */
function placeOf(name) {
    return name ? String(name).replace(/\s+#?\d+$/, '') : null;
}

function keptSet(records, markerPosition) {
    return {
        name: KEPT_NAME,
        place: placeOf(records.find((r) => r.setName)?.setName) || null,
        markerPosition,
        paths: records.map((r) => r.path),
        createdAt: records[records.length - 1].createdAt || 0,
        settings: {},
        selections: [],
        isComplete: true,
        resumable: false,
        kept: true,
    };
}

/**
 * id -> kept set (shaped like a generation: { name, place, markerPosition,
 * paths, createdAt, kept: true, ... }) for the favorites (key -> record)
 * whose set is not in pathSets (a favorite saved without a set too), newest
 * favorited first; {} when there are none. A favorite is listed even when
 * another set found its route too: it is where a deleted set's favorites
 * are always found.
 */
export function keptSets(favorites, pathSets) {
    const records = (favorites ? [...favorites.values()] : [])
        .filter((r) => r?.path && !(r.pathSetId && pathSets?.[r.pathSetId]))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (!records.length) return {};
    // the sets that still exist, oldest first (a start's kept set is named after its oldest)
    const live = Object.entries(pathSets || {})
        .filter(([, set]) => !set.kept && validPoint(set.markerPosition))
        .sort(([, a], [, b]) => (a.createdAt || 0) - (b.createdAt || 0));
    const groups = new Map(); // id -> { position, records }
    const rest = [];
    // Oldest favorited first, so a start's id and place stay put as favorites are added there.
    [...records].reverse().forEach((r) => {
        const start = favoriteStart(r);
        if (!start) {
            rest.push(r);
            return;
        }
        const host = live.find(([, set]) => sameStart(set.markerPosition, start));
        let id;
        let position;
        if (host) {
            id = `${KEPT_AT}${host[0]}`;
            position = host[1].markerPosition;
        } else {
            const near = [...groups.entries()].find(([gid, g]) => !gid.startsWith(KEPT_AT) && sameStart(g.position, start));
            id = near ? near[0] : `kept:@${start.lat.toFixed(5)},${start.lng.toFixed(5)}`;
            position = near ? near[1].position : start;
        }
        if (!groups.has(id)) groups.set(id, { position: { lat: position.lat, lng: position.lng }, records: [] });
        groups.get(id).records.push(r);
    });
    const out = {};
    const newestFirst = (list) => list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    groups.forEach(({ position, records: list }, id) => {
        out[id] = keptSet(newestFirst(list), position);
    });
    if (rest.length) out[KEPT_ID] = keptSet(newestFirst(rest), null);
    return out;
}
