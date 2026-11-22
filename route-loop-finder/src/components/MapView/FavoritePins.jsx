import { useMemo } from 'react';
import { Popup } from 'react-leaflet';
import { Layers, Plus, Star } from 'lucide-react';
import PathMarker from './PathMarker';
import { MENU_EDGE_PX, usePinMenu } from './usePinMenu';
import { groupByStart, sameStart, setsAtStart } from '../../utils/pathSetGroups';
import { favoriteStart } from '../../utils/favoritesList';

/** A favorites pin's menu: show them, open a set there (favorites only), all routes from here, a new set. */
function FavoriteMenu({ group, generations, onShow, onOpenSet, onShowAll, onNewSet }) {
    const { popupRef, act } = usePinMenu();
    const { position, records } = group;
    const sets = useMemo(() => setsAtStart(generations, position), [generations, position]); // newest first
    const favoritesIn = (id) => records.filter((r) => r.pathSetId === id).length;
    const n = records.length;
    const at = { lat: position.lat, lng: position.lng };
    return (
        <Popup
            ref={popupRef}
            className="set-menu"
            closeButton={false}
            closeOnEscapeKey={false} // MenuDismiss closes it on Esc (Leaflet's own would swallow every later Esc on the map)
            autoPan
            autoPanPadding={[MENU_EDGE_PX, MENU_EDGE_PX]}
        >
            <div className="set-menu__title">{n === 1 ? '1 favorite starts here' : `${n} favorites start here`}</div>
            <div className="set-menu__actions set-menu__actions--top">
                <button type="button" className="set-menu__action" onClick={() => act(() => onShow?.(group))}>
                    <Star size={14} />
                    <span>Show {n === 1 ? 'this favorite' : 'these favorites'}</span>
                </button>
            </div>
            {sets.length > 0 && (
                <ul className={`set-menu__list ${sets.length > 5 ? 'is-long' : ''}`} aria-label="Sets that start here">
                    {sets.map((set) => {
                        const k = favoritesIn(set.id);
                        return (
                            <li key={set.id}>
                                <button
                                    type="button"
                                    className="set-menu__item"
                                    onClick={() => act(() => onOpenSet?.(set.id, group))}
                                    title={`Open ${set.name}, showing its favorites`}
                                >
                                    <span className="set-menu__name">{set.name}</span>
                                    <span className="set-menu__meta">
                                        {k} {k === 1 ? 'favorite' : 'favorites'} · {set.pathCount} {set.pathCount === 1 ? 'route' : 'routes'}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
            <div className="set-menu__actions">
                {onShowAll && sets.length > 1 && (
                    <button type="button" className="set-menu__action" onClick={() => act(() => onShowAll(at))}>
                        <Layers size={14} />
                        <span>Show all routes from here</span>
                    </button>
                )}
                {onNewSet && (
                    <button
                        type="button"
                        className="set-menu__action"
                        onClick={() => act(() => onNewSet(at))}
                        title={sets.length ? 'Back to the plan with the start here and New set chosen' : 'Its set was deleted: plan here again'}
                    >
                        <Plus size={14} />
                        <span>{sets.length ? 'New set from here' : 'Plan here'}</span>
                    </button>
                )}
            </div>
        </Popup>
    );
}

/**
 * The Favorites page's pins: one per start of the favorites listed (a
 * deleted set's favorites too: their saved start, else their route's first
 * point), in the routes' colour with a star and the number of favorites.
 * The start in focus (highlight: a card or group under the pointer in the
 * list, else the selected favorite's) is bigger and orange. A pin under the
 * pointer puts its start in focus (onHoverStart). Clicking a pin opens its
 * menu (FavoriteMenu).
 */
function FavoritePins({ records, generations, highlight = null, onHoverStart, onShow, onOpenSet, onShowAll, onNewSet }) {
    const groups = useMemo(() => groupByStart((records || [])
        .map((r) => ({ id: r.key, position: favoriteStart(r), record: r }))
        .filter((i) => i.position))
        .map((g) => ({ key: g.key, position: g.position, records: g.items.map((i) => i.record) })), [records]);

    return groups.map((group) => {
        const lit = !!highlight && sameStart(group.position, highlight);
        const n = group.records.length;
        return (
            <PathMarker
                key={group.key}
                position={group.position}
                color={lit ? 'favorite-highlight' : 'favorite'}
                title={`${n} ${n === 1 ? 'favorite starts' : 'favorites start'} here`}
                zIndexOffset={lit ? 800 : 200}
                count={n}
                onHover={onHoverStart ? (on) => onHoverStart(on ? group.position : null) : null}
            >
                <FavoriteMenu
                    group={group}
                    generations={generations}
                    onShow={onShow}
                    onOpenSet={onOpenSet}
                    onShowAll={onShowAll}
                    onNewSet={onNewSet}
                />
            </PathMarker>
        );
    });
}

export default FavoritePins;
