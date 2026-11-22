/**
 * "All routes from here": the routes of every generation that starts at one
 * place, as one list. Best (the found order) takes turns between the sets,
 * newest set first: every set's first route, then every set's second, and so
 * on, so the best of each comes up front. A route found by more than one set
 * (the same roads, utils/routeIdentity) is listed once, as the set where it
 * comes first; the others are remembered (alsoIn).
 */
import { routeKey } from './routeIdentity';
import { newestFirst } from './pathSetGroups';

/**
 * sets: [{ id, name, createdAt, paths }]. Returns
 * { paths, ownerOf: Map(route id -> set id), alsoIn: Map(route id -> [set id]), setIds (newest first) }.
 */
/** A chip under the pointer meaning All (every set's routes), for the map preview. */
export const ALL_SETS = '*all*';

export function combineSets(sets) {
    const ordered = newestFirst((sets || []).filter((s) => s && s.id != null));
    const paths = [];
    const ownerOf = new Map();
    const alsoIn = new Map();
    const firstByKey = new Map(); // route key -> the listed route's id
    const longest = ordered.reduce((n, s) => Math.max(n, (s.paths || []).length), 0);
    for (let rank = 0; rank < longest; rank++) {
        ordered.forEach((set) => {
            const path = (set.paths || [])[rank];
            if (!path) return;
            const key = routeKey(path) ?? `id:${path.id}`; // a route without a line is never a repeat
            const listed = firstByKey.get(key);
            if (listed != null) {
                const others = alsoIn.get(listed);
                if (!others.includes(set.id) && ownerOf.get(listed) !== set.id) others.push(set.id);
                return;
            }
            firstByKey.set(key, path.id);
            paths.push(path);
            ownerOf.set(path.id, set.id);
            alsoIn.set(path.id, []);
        });
    }
    return { paths, ownerOf, alsoIn, setIds: ordered.map((s) => s.id) };
}
