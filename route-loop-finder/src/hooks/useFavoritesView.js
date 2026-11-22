import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filterByRouteSelections } from '../utils/routeSelections';
import { OPEN_RANGE, sanitizeRouteFilters } from '../utils/pathFiltering';
import {
    FAVORITE_SORTS, GROUPINGS, bestRanks, defaultAscending, favoriteStart, favoritesList, groupFocus, inFocus, startFocus,
} from '../utils/favoritesList';
import { sameStart } from '../utils/pathSetGroups';
import { routeKey } from '../utils/routeIdentity';

const PREFS_KEY = 'favoritesPage';
const PINNED = ['total_miles'];

function readPrefs() {
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
    } catch {
        saved = {};
    }
    const sortBy = FAVORITE_SORTS.some((s) => s.id === saved.sortBy) ? saved.sortBy : 'favorited';
    return {
        sortBy,
        ascending: typeof saved.ascending === 'boolean' ? saved.ascending : defaultAscending(sortBy),
        grouping: GROUPINGS.some((g) => g.id === saved.grouping) ? saved.grouping : 'set',
        inView: saved.inView === true,
        // Filters shown (their limits start open each time)
        filterKeys: [...PINNED, ...sanitizeRouteFilters((saved.filterKeys || []).map((key) => ({ key })))
            .map((f) => f.key).filter((k) => !PINNED.includes(k))],
    };
}

/**
 * The Favorites page: every favorite, from every generation, filtered by the
 * painted roads and areas (a favorite must go through every green one and
 * avoid every red one), by the measure sliders and, with "In map view" on,
 * by the map's view; sorted and grouped (utils/favoritesList). The sort,
 * grouping, "In map view" and which filters are shown are kept in the
 * browser. One favorite can be selected (bold, its elevation shown) and one
 * previewed (a card under the pointer); one unfavorited here stays listed
 * until another is selected. Groups can be folded; selecting a favorite of a
 * folded group unfolds it.
 *
 * orderView: the map's view as the user left it ({ south, west, north, east }
 * or null). Groups near it come first and "In map view" keeps the favorites
 * in it. It changes only when the user moves the map, not when the app does
 * (bringing a selected favorite into view), so stepping with the arrows
 * never reorders the list under them.
 *
 * Focus: the map's faint routes (mapPaths, also the only ones a click on the
 * map can pick) are one group's favorites, or one start's: a star pin under
 * the pointer (its start), a group's header under it (the group), a card
 * under it (its group; with no groups, its start), else the selected
 * favorite's; with none of these, every listed favorite. Esc or a click on
 * empty map deselects. `highlight`: the start whose pin is orange (the one in
 * focus, the selected favorite's when nothing is under the pointer).
 */
export function useFavoritesView({ favorites, generations, pathSets, selections, orderView }) {
    const [selectedId, setSelectedId] = useState(null);
    const [hoveredId, setHoveredId] = useState(null);
    const [keptKeys, setKeptKeys] = useState(() => new Map()); // key -> record, unfavorited but still listed
    const [prefs, setPrefs] = useState(readPrefs);
    const [ranges, setRanges] = useState({}); // filter key -> [min, max] (null: open)
    const [collapsed, setCollapsed] = useState(() => new Set()); // group keys
    const [hoverGroup, setHoverGroup] = useState(null); // a group's key: its header under the pointer
    const [hoverStart, setHoverStart] = useState(null); // { lat, lng }: a star pin under the pointer
    // The direction each sort was last used in (this visit only): a sort chosen again runs that way.
    const directions = useRef({});

    useEffect(() => {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    }, [prefs]);

    const records = useMemo(() => {
        const all = new Map(favorites);
        keptKeys.forEach((record, key) => { if (!all.has(key)) all.set(key, record); });
        return [...all.values()];
    }, [favorites, keptKeys]);

    // The favorites that pass the painted roads and areas.
    const passing = useMemo(() => {
        const ok = new Set(filterByRouteSelections(records.map((r) => r.path), selections || []));
        return records.filter((r) => ok.has(r.path));
    }, [records, selections]);

    const ranks = useMemo(() => bestRanks(records, pathSets, routeKey), [records, pathSets]);
    const routeFilters = useMemo(
        () => prefs.filterKeys.map((key) => ({ key, range: ranges[key] || OPEN_RANGE })),
        [prefs.filterKeys, ranges],
    );

    const list = useMemo(() => favoritesList(passing, {
        generations,
        grouping: prefs.grouping,
        sortBy: prefs.sortBy,
        ascending: prefs.ascending,
        ranks,
        filters: routeFilters,
        inView: prefs.inView ? orderView : null,
        orderView,
    }), [passing, generations, prefs, ranks, routeFilters, orderView]);
    // (the sliders' ends span every favorite, not only those the painted roads leave)
    const filterBounds = useMemo(() => favoritesList(records, { generations }).bounds, [records, generations]);

    // The listed routes, in the list's order (the arrows step through it).
    const { paths, groups } = list;
    const current = useMemo(() => paths.find((p) => p.id === selectedId) || null, [paths, selectedId]);
    const recordOf = useCallback((path) => records.find((r) => r.path === path) || null, [records]);
    const groupOf = useCallback((path) => groups.find((g) => g.records.some((r) => r.path === path)) || null, [groups]);

    // Another route selected: the unfavorited ones kept so far go.
    const keptFor = useRef(selectedId);
    useEffect(() => {
        if (keptFor.current === selectedId) return;
        keptFor.current = selectedId;
        setKeptKeys((prev) => (prev.size ? new Map() : prev));
    }, [selectedId]);

    const keepListed = useCallback((record) => {
        if (record?.key) setKeptKeys((prev) => new Map(prev).set(record.key, record));
    }, []);

    /** Select a favorite (null: none); its group unfolds. */
    const select = useCallback((id) => {
        setSelectedId(id);
        if (id == null) return;
        const group = groups.find((g) => g.records.some((r) => r.path.id === id));
        if (group) setCollapsed((prev) => (prev.has(group.key) ? new Set([...prev].filter((k) => k !== group.key)) : prev));
    }, [groups]);

    /** The id of the route `delta` steps from the selected one (the first / last when none is). */
    const stepId = useCallback((delta) => {
        if (!paths.length) return null;
        const i = paths.findIndex((p) => p.id === selectedId);
        const next = i < 0 ? (delta > 0 ? 0 : paths.length - 1) : Math.min(Math.max(i + delta, 0), paths.length - 1);
        return paths[next].id;
    }, [paths, selectedId]);

    // ---- sort, grouping, filters ----
    // A sort runs the way it was last used in (this visit), else the way it
    // reads best (Date favorited: newest first; a measure: low to high); the
    // arrow button reverses it. The selected favorite stays.
    const chooseSort = useCallback((sortBy) => {
        if (!FAVORITE_SORTS.some((s) => s.id === sortBy)) return;
        setPrefs((p) => {
            if (p.sortBy === sortBy) return p;
            directions.current[p.sortBy] = p.ascending;
            return { ...p, sortBy, ascending: directions.current[sortBy] ?? defaultAscending(sortBy) };
        });
    }, []);
    const flipSort = useCallback(() => setPrefs((p) => ({ ...p, ascending: !p.ascending })), []);
    const setGrouping = useCallback((grouping) => {
        if (GROUPINGS.some((g) => g.id === grouping)) setPrefs((p) => ({ ...p, grouping }));
    }, []);
    const setInView = useCallback((on) => setPrefs((p) => ({ ...p, inView: !!on })), []);
    const setFilterRange = useCallback((key, range) => setRanges((r) => ({ ...r, [key]: range })), []);
    const addRouteFilter = useCallback((key) => {
        setPrefs((p) => (p.filterKeys.includes(key) || !sanitizeRouteFilters([{ key }]).length
            ? p
            : { ...p, filterKeys: [...p.filterKeys, key] }));
    }, []);
    const removeRouteFilter = useCallback((key) => {
        if (PINNED.includes(key)) return;
        setPrefs((p) => ({ ...p, filterKeys: p.filterKeys.filter((k) => k !== key) }));
        setRanges((r) => ({ ...r, [key]: OPEN_RANGE }));
    }, []);
    const clearFilters = useCallback(() => setRanges({}), []);
    const toggleGroup = useCallback((key) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    // ---- focus: which favorites the map's faint routes show ----
    const focusOf = useCallback((record) => {
        if (!record) return null;
        if (prefs.grouping === 'none') return startFocus(favoriteStart(record));
        return groupFocus(groups.find((g) => g.records.some((r) => r.key === record.key)));
    }, [prefs.grouping, groups]);
    const hoveredRecord = useMemo(
        () => (hoveredId ? records.find((r) => r.path.id === hoveredId) || null : null),
        [records, hoveredId],
    );
    const selectedRecord = useMemo(() => (current ? records.find((r) => r.path === current) || null : null), [records, current]);
    const headerGroup = hoverGroup ? groups.find((g) => g.key === hoverGroup) || null : null;
    const focus = useMemo(() => {
        if (hoverStart) return startFocus(hoverStart);
        if (headerGroup) return groupFocus(headerGroup);
        if (hoveredRecord) return focusOf(hoveredRecord);
        return focusOf(selectedRecord);
    }, [hoverStart, headerGroup, hoveredRecord, selectedRecord, focusOf]);
    // One list per focus, kept while the list stays the same, so the map's
    // canvas reuses what it drew for a group shown before.
    const focusCache = useRef({ paths: null, byId: new Map() });
    const mapPaths = useMemo(() => {
        if (focusCache.current.paths !== paths) focusCache.current = { paths, byId: new Map() };
        if (!focus) return paths;
        const cache = focusCache.current.byId;
        if (!cache.has(focus.id)) {
            const listed = groups.flatMap((g) => g.records).filter((r) => inFocus(r, focus)).map((r) => r.path);
            cache.set(focus.id, listed);
        }
        return cache.get(focus.id);
    }, [focus, paths, groups]);
    // The orange pin: the start in focus, else the selected favorite's.
    const highlight = useMemo(() => {
        if (hoverStart) return hoverStart;
        if (headerGroup) return headerGroup.position || favoriteStart(headerGroup.records[0]);
        if (hoveredRecord) return favoriteStart(hoveredRecord);
        return selectedRecord ? favoriteStart(selectedRecord) : null;
    }, [hoverStart, headerGroup, hoveredRecord, selectedRecord]);
    /** Is a group's header lit (its start's pin under the pointer)? */
    const groupLit = useCallback((group) => !!hoverStart && group.records.some((r) => sameStart(favoriteStart(r), hoverStart)), [hoverStart]);

    return {
        groups,
        paths,
        mapPaths, // the faint routes on the map (the focus's, else every listed one)
        focus, // { id, keys | position } or null
        highlight, // { lat, lng }: the orange pin, or null
        setHoverGroup,
        setHoverStart,
        groupLit,
        current,
        selectedId: current ? selectedId : null,
        hoveredId,
        select,
        setHoveredId,
        stepId,
        recordOf,
        groupOf,
        keepListed,
        total: favorites.size,
        painted: passing.length, // after the painted roads and areas only
        shown: list.shown,
        sortBy: prefs.sortBy,
        ascending: prefs.ascending,
        chooseSort,
        flipSort,
        grouping: prefs.grouping,
        setGrouping,
        inView: prefs.inView,
        setInView,
        routeFilters,
        filterBounds,
        setFilterRange,
        addRouteFilter,
        removeRouteFilter,
        clearFilters,
        collapsed,
        toggleGroup,
    };
}
