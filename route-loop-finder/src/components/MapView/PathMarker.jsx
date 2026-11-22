import { Marker } from 'react-leaflet';
import L from 'leaflet';
import { useCallback, useEffect, useMemo, useRef } from 'react';

// Create custom marker icons using SVG for cleaner rendering. `count` adds a
// badge (a start's route count, or its favorites with Favorites only).
// Kinds: `pending` (the start pin), `active` (the open start), `inactive`.
const createMarkerIcon = (color, count) => {
    // Colours come from the theme (MapView.css: .custom-marker-icon--pending / --active / --inactive).
    const kinds = ['pending', 'active', 'inactive'];
    const kind = kinds.includes(color) ? color : 'inactive';
    const [w, h] = [24, 36];

    const svgIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="${w}" height="${h}">
      <path class="pin__body" stroke-width="1.5" d="M12 0.750C5.800 0.750 0.750 5.800 0.750 12c0 6.900 11.250 22.700 11.250 22.700S23.250 18.900 23.250 12C23.250 5.800 18.200 0.750 12 0.750z"/>
      <circle class="pin__dot" cx="12" cy="12" r="4.200"/>
    </svg>
  `;

    const badge = count != null
        ? `<span class="marker-badge marker-badge--${kind}">${count}</span>`
        : '';
    return L.divIcon({
        html: `${svgIcon}${badge}`,
        className: `custom-marker-icon custom-marker-icon--${kind}`,
        iconSize: [w, h],
        iconAnchor: [w / 2, h],
        popupAnchor: [0, -h]
    });
};

/**
 * Reusable marker component with configurable colors.
 */
function PathMarker({
    position, color = 'inactive', onClick, title, zIndexOffset = 0, draggable = false, onDragEnd, count = null,
    onHover = null, // (true | false): the pointer came onto the pin, or left it
    menuOnRightClick = false, // its Popup (children) opens on a right-click, not a click
    label = null, // its accessible name (aria-label), when a Tooltip child shows it instead of a title
    children = null, // e.g. a Popup (a menu of the generations at this pin)
}) {
    const icon = useMemo(() => createMarkerIcon(color, count), [color, count]);
    // Leaflet sets the title (tooltip) only when the marker is made; keep it current
    // (a pin's route count grows, another generation joins it).
    const markerRef = useRef(null);
    // A right-click menu: a click must not open the Popup. Leaflet binds the
    // click to the marker's _openPopup when the Popup child attaches (after
    // this ref is set), so the instance's own _openPopup does nothing.
    const setMarker = useCallback((marker) => {
        markerRef.current = marker;
        if (marker && menuOnRightClick) marker._openPopup = () => {};
    }, [menuOnRightClick]);
    useEffect(() => {
        const el = markerRef.current?.getElement();
        if (!el) return;
        if (title) el.setAttribute('title', title);
        else el.removeAttribute('title');
        if (label) el.setAttribute('aria-label', label);
        else el.removeAttribute('aria-label');
    }, [title, label, icon]);

    // Handle both { lat, lng } and [lat, lng] formats
    const markerPosition = Array.isArray(position)
        ? position
        : [position.lat, position.lng];

    const eventHandlers = useMemo(() => ({
        click: (e) => {
            // Never let a marker click fall through to the map (it would move the start pin).
            L.DomEvent.stopPropagation(e);
            if (onClick) onClick(e);
        },
        dragend: (e) => {
            if (onDragEnd) {
                const { lat, lng } = e.target.getLatLng();
                onDragEnd({ lat, lng });
            }
        },
        mouseover: () => onHover?.(true),
        mouseout: () => onHover?.(false),
        contextmenu: (e) => {
            if (!menuOnRightClick) return;
            e.originalEvent?.preventDefault();
            L.DomEvent.stopPropagation(e);
            e.target.closeTooltip(); // (its hover label would sit under the menu)
            e.target.openPopup();
        },
    }), [onClick, onDragEnd, onHover, menuOnRightClick]);

    return (
        <Marker
            ref={setMarker}
            position={markerPosition}
            icon={icon}
            title={title || undefined}
            zIndexOffset={zIndexOffset}
            draggable={draggable}
            eventHandlers={eventHandlers}
        >
            {children}
        </Marker>
    );
}

export default PathMarker;
