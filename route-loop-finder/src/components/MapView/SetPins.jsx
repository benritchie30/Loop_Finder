import { useEffect, useMemo, useRef } from 'react';
import { Popup, Tooltip } from 'react-leaflet';
import { Layers, Plus } from 'lucide-react';
import PathMarker from './PathMarker';
import { groupByStart, newestFirst } from '../../utils/pathSetGroups';
import { MENU_EDGE_PX, usePinMenu } from './usePinMenu';
import { whenText } from '../../utils/dates';
import { distanceUnit, milesToDisplay, useUnits } from '../../utils/units';

export const HOVER_DELAY_MS = 120; // a pin previews its routes once the pointer rests on it this long

function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
}

/** "12.1–27.9 mi" for [lo, hi] miles, or null. */
function rangeText(range, units) {
    if (!range) return null;
    const [lo, hi] = range.map((miles) => milesToDisplay(miles, units).toFixed(1));
    return `${lo === hi ? lo : `${lo}–${hi}`} ${distanceUnit(units)}`;
}

/** The shortest and longest route of several sets. */
function rangeOf(sets) {
    const ranges = sets.map((s) => s.lengthRange).filter(Boolean);
    if (!ranges.length) return null;
    return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
}

/** "20 routes · 3★ · 12.1–27.9 mi · Mar 3" for a set in a pin's menu (favorites only: "3 favorites · …"). */
function metaText(item, units, favoritesOnly) {
    const parts = favoritesOnly || item.kept
        ? [plural(item.favoriteCount, 'favorite', 'favorites')]
        : [plural(item.pathCount, 'route', 'routes')];
    if (!favoritesOnly && !item.kept && item.favoriteCount > 0) parts.push(`${item.favoriteCount}★`);
    const range = rangeText(item.lengthRange, units);
    if (range) parts.push(range);
    const when = whenText(item.createdAt);
    if (when) parts.push(when);
    return parts.join(' · ');
}

/**
 * A start's routes and favorites, a route two of its sets found counted
 * once (isFavorite: (key) => boolean).
 */
function countsOf(sets, isFavoriteKey) {
    const keys = new Set();
    sets.forEach((s) => (s.routeKeys || []).forEach((k) => keys.add(k)));
    let favorites = 0;
    if (isFavoriteKey) keys.forEach((k) => { if (isFavoriteKey(k)) favorites += 1; });
    else favorites = sets.reduce((sum, s) => sum + (s.favoriteCount || 0), 0);
    return { routes: keys.size || sets.reduce((sum, s) => sum + (s.pathCount || 0), 0), favorites };
}

/** A pin's label on hover: "3 sets · 47 routes · 5★ · 12–30 mi" (favorites only: "3 sets · 5 favorites · …"). */
function labelText(sets, units, favoritesOnly, counts) {
    const { routes, favorites } = counts;
    const parts = [];
    if (sets.length > 1) parts.push(plural(sets.length, 'set', 'sets'));
    else parts.push(sets[0].name);
    if (favoritesOnly) parts.push(plural(favorites, 'favorite', 'favorites'));
    else {
        parts.push(plural(routes, 'route', 'routes'));
        if (favorites > 0) parts.push(`${favorites}★`);
    }
    const range = rangeText(rangeOf(sets), units);
    if (range) parts.push(range);
    return parts.join(' · ');
}

/**
 * A pin's menu (a right-click): the sets that start there (newest first;
 * past a handful the list scrolls in its own box), open one; a set under
 * the pointer has its routes previewed on the map (onPreviewSet). Show all
 * routes from here (two or more sets: their routes as one list), and New set
 * from here (the plan, with the start pin there and New set chosen).
 */
function SetMenu({ sets, position, activeId, favoritesOnly, onOpen, onNewSet, onShowAll, onPreviewSet }) {
    const units = useUnits();
    const { popupRef, act } = usePinMenu();
    const sorted = useMemo(() => newestFirst(sets), [sets]);
    const count = sorted.length;
    const handlers = useMemo(() => ({ remove: () => onPreviewSet?.(null) }), [onPreviewSet]);
    const at = { lat: position.lat, lng: position.lng };
    return (
        <Popup
            ref={popupRef}
            className="set-menu"
            closeButton={false}
            closeOnEscapeKey={false} // MenuDismiss closes it on Esc (Leaflet's own would swallow every later Esc on the map)
            autoPan
            autoPanPadding={[MENU_EDGE_PX, MENU_EDGE_PX]}
            eventHandlers={handlers}
        >
            <div className="set-menu__title">{count === 1 ? '1 set starts here' : `${count} sets start here`}</div>
            <ul
                className={`set-menu__list ${count > 5 ? 'is-long' : ''}`}
                aria-label="Sets that start here"
                onMouseLeave={() => onPreviewSet?.(null)}
            >
                {sorted.map((item) => (
                    <li key={item.id}>
                        <button
                            type="button"
                            className={`set-menu__item ${item.id === activeId ? 'is-active' : ''}`}
                            onClick={() => act(() => onOpen?.(item.id))}
                            onMouseEnter={() => onPreviewSet?.(item.id)}
                            title={item.id === activeId ? `${item.name} (open)` : `Open ${item.name}`}
                        >
                            <span className="set-menu__name">{item.name}</span>
                            <span className="set-menu__meta">{metaText(item, units, favoritesOnly)}</span>
                        </button>
                    </li>
                ))}
            </ul>
            {(onNewSet || (onShowAll && count > 1)) && (
                <div className="set-menu__actions">
                    {onShowAll && count > 1 && (
                        <button
                            type="button"
                            className="set-menu__action"
                            onClick={() => act(() => onShowAll(at))}
                            title="Every route of these sets as one list (a route two sets found, once)"
                        >
                            <Layers size={14} />
                            <span>Show all routes from here</span>
                        </button>
                    )}
                    {onNewSet && (
                        <button
                            type="button"
                            className="set-menu__action"
                            onClick={() => act(() => onNewSet(at))}
                            title="Back to the plan with the start here and New set chosen (your plan settings stay)"
                        >
                            <Plus size={14} />
                            <span>New set from here</span>
                        </button>
                    )}
                </div>
            )}
        </Popup>
    );
}

/**
 * Every set's pin, one per start (sets that start at the same place share
 * it), all the plain grey pin (the open start's in its own colour). Favorites
 * only (favoritesOnly): only starts with favorites, each counting them; else
 * every start and its route count.
 * - Hover (after HOVER_DELAY_MS): its label shows, its
 *   routes are previewed on the map (onPreview({ key, ids }); null when the
 *   pointer leaves) and every other pin is hidden (previewKey). A set's row
 *   under the pointer in "Your loops" (hoveredSetId) does the same.
 * - Click: opens its routes (onOpen with one set, else onShowAll).
 * - Right-click: its menu (SetMenu).
 * - A set open (mode 'display'): only its start's pin is shown.
 */
function SetPins({
    markers, mode, activePathSetId, favoritesOnly = false, previewKey = null, hoveredSetId = null,
    isFavoriteKey = null, // (route key) => is it a favorite
    previewIds = null, // the sets previewed (a pin, a set in its menu or in Your loops): the lit pin counts only theirs
    onPreview, onOpen, onNewSet, onShowAll,
}) {
    const units = useUnits();
    const groups = useMemo(() => groupByStart(markers)
        .map((g) => ({ ...g, sets: favoritesOnly ? g.items.filter((i) => i.favoriteCount > 0) : g.items }))
        .filter((g) => g.sets.length > 0), [markers, favoritesOnly]);
    const timer = useRef(null);
    useEffect(() => () => clearTimeout(timer.current), []);
    // The browser may never say the pointer left a pin (when its icon is
    // redrawn under the pointer): while a pin previews, any pointer move off
    // the pins (and off a pin's menu) ends its preview.
    useEffect(() => {
        if (!previewKey || !onPreview) return undefined;
        const onMove = (e) => {
            const el = e.target;
            if (el?.closest?.('.leaflet-marker-icon.custom-marker-icon, .set-menu')) return;
            onPreview(null, previewKey);
        };
        document.addEventListener('pointermove', onMove, true);
        return () => document.removeEventListener('pointermove', onMove, true);
    }, [previewKey, onPreview]);
    const browsing = mode === 'input';
    const rowGroup = browsing && hoveredSetId ? groups.find((g) => g.items.some((i) => i.id === hoveredSetId)) : null;
    const litKey = browsing ? (previewKey || rowGroup?.key || null) : null;
    const openGroup = mode === 'display' ? groups.find((g) => g.items.some((i) => i.id === activePathSetId)) : null;

    return groups.map((group) => {
        const { sets, position } = group;
        if (mode === 'display' && group !== openGroup) return null;
        if (litKey && group.key !== litKey) return null;
        const lit = group.key === litKey;
        const counts = countsOf(sets, isFavoriteKey);
        // The lit pin counts the sets previewed (one set in its menu or in Your loops: that set's);
        // an open start's pin has no number.
        const shown = lit && previewIds?.length ? sets.filter((s) => previewIds.includes(s.id)) : sets;
        const shownCounts = shown.length && shown !== sets ? countsOf(shown, isFavoriteKey) : counts;
        const count = group === openGroup ? null : (favoritesOnly ? shownCounts.favorites : shownCounts.routes);
        const label = labelText(sets, units, favoritesOnly, counts);
        const color = group === openGroup ? 'active' : 'inactive';
        const hover = browsing && onPreview ? (on) => {
            clearTimeout(timer.current);
            if (on) {
                timer.current = setTimeout(() => onPreview({ key: group.key, ids: sets.map((s) => s.id) }), HOVER_DELAY_MS);
            } else {
                onPreview(null, group.key);
            }
        } : null;
        const open = () => {
            clearTimeout(timer.current);
            if (sets.length === 1) onOpen?.(sets[0].id);
            else onShowAll?.({ lat: position.lat, lng: position.lng });
        };
        const previewSet = browsing && onPreview
            ? (id) => onPreview(id ? { key: group.key, ids: [id] } : null, group.key)
            : null;
        return (
            <PathMarker
                key={group.key}
                position={position}
                color={color}
                zIndexOffset={lit ? 800 : group === openGroup ? 500 : 0}
                count={count}
                onClick={open}
                onHover={hover}
                menuOnRightClick
                label={label}
            >
                <Tooltip className="pin-label" direction="top" offset={[0, -34]} opacity={1}>
                    {label}
                    <span className="pin-label__hint">Click to open · right-click for more</span>
                </Tooltip>
                <SetMenu
                    sets={sets}
                    position={position}
                    activeId={mode === 'display' ? activePathSetId : null}
                    favoritesOnly={favoritesOnly}
                    onOpen={onOpen}
                    onNewSet={onNewSet}
                    onShowAll={onShowAll}
                    onPreviewSet={previewSet}
                />
            </PathMarker>
        );
    });
}

export default SetPins;
