import { useMemo } from 'react';
import { Popup } from 'react-leaflet';
import { Layers, Plus } from 'lucide-react';
import PathMarker from './PathMarker';
import { groupByStart, newestFirst } from '../../utils/pathSetGroups';
import { MENU_EDGE_PX, usePinMenu } from './usePinMenu';
import { whenText } from '../../utils/dates';
import { distanceUnit, milesToDisplay, useUnits } from '../../utils/units';

/** "20 routes · 12.1–27.9 mi · Mar 3" for a generation in a pin's menu. */
function metaText(item, units) {
    const parts = [`${item.pathCount} ${item.pathCount === 1 ? 'route' : 'routes'}`];
    if (item.lengthRange) {
        const [lo, hi] = item.lengthRange.map((miles) => milesToDisplay(miles, units).toFixed(1));
        parts.push(`${lo === hi ? lo : `${lo}–${hi}`} ${distanceUnit(units)}`);
    }
    const when = whenText(item.createdAt);
    if (when) parts.push(when);
    return parts.join(' · ');
}

/**
 * A pin's menu: the generations that start there (newest first; past a
 * handful the list scrolls in its own box, and the wheel there scrolls it
 * instead of zooming the map), open one; Show all routes from here (two or
 * more sets: their routes as one list); or New set from here (the plan,
 * with the start pin there and New set chosen).
 */
function SetMenu({ items, position, activeId, onOpen, onNewSet, onShowAll }) {
    const units = useUnits();
    const { popupRef, act } = usePinMenu();
    const sorted = useMemo(() => newestFirst(items), [items]);
    const count = sorted.length;
    return (
        <Popup
            ref={popupRef}
            className="set-menu"
            closeButton={false}
            closeOnEscapeKey={false} // MenuDismiss closes it on Esc (Leaflet's own would swallow every later Esc on the map)
            autoPan
            autoPanPadding={[MENU_EDGE_PX, MENU_EDGE_PX]}
        >
            <div className="set-menu__title">{count === 1 ? '1 set starts here' : `${count} sets start here`}</div>
            <ul className={`set-menu__list ${count > 5 ? 'is-long' : ''}`} aria-label="Sets that start here">
                {sorted.map((item) => (
                    <li key={item.id}>
                        <button
                            type="button"
                            className={`set-menu__item ${item.id === activeId ? 'is-active' : ''}`}
                            onClick={() => act(() => onOpen?.(item.id))}
                            title={item.id === activeId ? `${item.name} (open)` : `Open ${item.name}`}
                        >
                            <span className="set-menu__name">{item.name}</span>
                            <span className="set-menu__meta">{metaText(item, units)}</span>
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
                            onClick={() => act(() => onShowAll({ lat: position.lat, lng: position.lng }))}
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
                            onClick={() => act(() => onNewSet({ lat: position.lat, lng: position.lng }))}
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
 * Every generation's pin, one per start (generations that start at the same
 * place share it; its badge counts all their routes). Clicking a pin opens
 * its menu: the generations there to open, Show all routes from here (two or
 * more), and New set from here. The pin of the generation under the pointer
 * in "Your loops" (hoveredSetId) is highlighted.
 */
function SetPins({ markers, mode, activePathSetId, hoveredSetId = null, onOpen, onNewSet, onShowAll }) {
    const groups = useMemo(() => groupByStart(markers), [markers]);
    const hovered = hoveredSetId ? groups.find((g) => g.items.some((i) => i.id === hoveredSetId)) : null;

    return groups.map((group) => {
        const { items } = group;
        const active = mode === 'display' && items.some((i) => i.id === activePathSetId);
        const highlight = group === hovered;
        const count = items.reduce((sum, i) => sum + (i.pathCount || 0), 0);
        const single = items.length === 1;
        const title = single
            ? `${items[0].name} (${count} ${count === 1 ? 'route' : 'routes'})`
            : `${items.length} sets start here: ${items.map((i) => i.name).join(', ')}`;
        return (
            <PathMarker
                key={group.key}
                position={group.position}
                color={highlight ? 'highlight' : active ? 'active' : 'inactive'}
                title={title}
                zIndexOffset={highlight ? 800 : active ? 500 : 0}
                count={count}
            >
                <SetMenu
                    items={items}
                    position={group.position}
                    activeId={mode === 'display' ? activePathSetId : null}
                    onOpen={onOpen}
                    onNewSet={onNewSet}
                    onShowAll={onShowAll}
                />
            </PathMarker>
        );
    });
}

export default SetPins;
