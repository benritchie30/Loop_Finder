import { Marker } from 'react-leaflet';
import L from 'leaflet';
import { useEffect, useMemo, useRef } from 'react';

// Create custom marker icons using SVG for cleaner rendering. `count` adds a
// badge (a generation's route count). `highlight` is the pin of the
// generation under the pointer in "Your loops": bigger and orange.
const createMarkerIcon = (color, count) => {
    // Colours come from the theme (MapView.css: .custom-marker-icon--pending / --active / --highlight).
    const kind = ['pending', 'active', 'inactive', 'highlight'].includes(color) ? color : 'inactive';
    const big = color === 'highlight';
    const [w, h] = big ? [32, 48] : [24, 36];

    const svgIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="${w}" height="${h}">
      <path class="pin__body" stroke-width="1.5" d="M12 0.750C5.800 0.750 0.750 5.800 0.750 12c0 6.900 11.250 22.700 11.250 22.700S23.250 18.900 23.250 12C23.250 5.800 18.200 0.750 12 0.750z"/>
      <circle class="pin__dot" cx="12" cy="12" r="4.200"/>
    </svg>
  `;

    const badge = count != null
        ? `<span class="marker-badge marker-badge--${color}">${count}</span>`
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
    children = null, // e.g. a Popup (a menu of the generations at this pin)
}) {
    const icon = useMemo(() => createMarkerIcon(color, count), [color, count]);
    // Leaflet sets the title (tooltip) only when the marker is made; keep it current
    // (a pin's route count grows, another generation joins it).
    const markerRef = useRef(null);
    useEffect(() => {
        const el = markerRef.current?.getElement();
        if (!el) return;
        if (title) el.setAttribute('title', title);
        else el.removeAttribute('title');
    }, [title, icon]);

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
    }), [onClick, onDragEnd]);

    return (
        <Marker
            ref={markerRef}
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
