import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { coveredRight } from '../../utils/mapPanel';

/** The app moves the map (not the user): marked until the move ends. */
function appMove(map) {
    map._loopAppMove = true;
    map.once('moveend', () => {
        // (after the move's own moveend listeners have read the mark)
        setTimeout(() => { map._loopAppMove = false; }, 0);
    });
}

/** Centre the map on `position` in the part of it the panel leaves free. */
function panToFreeCentre(map, position) {
    appMove(map);
    const offset = L.point(coveredRight(map) / 2, 0); // the map centre sits this far right of the point
    const zoom = map.getZoom();
    const centre = map.unproject(map.project(position, zoom).add(offset), zoom);
    map.panTo(centre, { animate: true, duration: 0.4 });
}

/**
 * Show `bounds` ([[south, west], [north, east]]) in the part of the map the
 * panel leaves free: nothing happens when they are already in it; else the
 * map moves there, zooming out (never in) as far as they need.
 */
function showInFreeMap(map, bounds) {
    const target = L.latLngBounds(bounds);
    if (!target.isValid()) return;
    const covered = coveredRight(map);
    const size = map.getSize();
    const free = L.latLngBounds(
        map.containerPointToLatLng([0, size.y]),
        map.containerPointToLatLng([size.x - covered, 0]),
    );
    if (free.contains(target)) return;
    appMove(map);
    map.flyToBounds(target, {
        paddingTopLeft: [40, 40],
        paddingBottomRight: [covered + 40, 40],
        maxZoom: map.getZoom(),
        duration: 0.6,
    });
}

/**
 * Map moves asked for by the panel: `centre` ({ lat, lng, n }) centres on a
 * point (a generation opened from a list); `show` ({ bounds, n }) brings
 * routes or a boundary into view. `n` makes a repeat act.
 */
function MapFocus({ centre = null, show = null }) {
    const map = useMap();
    useEffect(() => {
        if (centre) panToFreeCentre(map, centre);
    }, [map, centre]);
    useEffect(() => {
        if (show) showInFreeMap(map, show.bounds);
    }, [map, show]);
    return null;
}

export default MapFocus;
