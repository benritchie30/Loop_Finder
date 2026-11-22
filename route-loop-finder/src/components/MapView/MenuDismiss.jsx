import { useEffect } from 'react';
import { useMap } from 'react-leaflet';

const CLICK_SLOP_PX = 5; // a press that moves further is a drag (panning the map), not a click

/** Is `el` a generation pin (one with a menu)? The start pin has none. */
function isSetPin(el) {
    const pin = el?.closest?.('.leaflet-marker-icon.custom-marker-icon');
    return !!pin && !pin.classList.contains('custom-marker-icon--pending');
}

/**
 * A pin's menu (a Leaflet popup) closes at any click outside it:
 * - on the map: the click only closes the menu. It does not move the start
 *   pin, show a route or paint a road (it is stopped before Leaflet sees it);
 * - anywhere else (the panel, the map's buttons, the search box, the
 *   elevation chart): the menu closes and the click does what it does;
 * - on a generation pin, Leaflet's own: the same pin closes its menu,
 *   another one opens its own instead.
 * Dragging the map (panning) leaves it open, as does the wheel. Esc closes
 * it and does nothing else.
 */
function MenuDismiss() {
    const map = useMap();

    useEffect(() => {
        const container = map.getContainer();
        const mapPane = map.getPane('mapPane'); // tiles, routes, pins, popups (not the map's buttons)
        let popup = null;
        let down = null; // where the last press began

        const onMap = (target) => target === container || mapPane.contains(target);

        const onPointerDown = (e) => {
            down = { x: e.clientX, y: e.clientY };
        };
        const onClick = (e) => {
            const el = popup?.getElement();
            if (!popup || !el) return;
            const { target } = e;
            if (el.contains(target) || isSetPin(target)) return;
            const moved = !!down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX;
            if (moved && onMap(target)) return; // the end of a drag of the map
            map.closePopup();
            if (onMap(target)) {
                e.stopPropagation();
                e.preventDefault();
            }
        };
        const onKeyDown = (e) => {
            if (!popup || e.key !== 'Escape') return;
            map.closePopup();
            e.stopImmediatePropagation();
            e.preventDefault();
        };

        const listen = (on) => {
            const method = on ? 'addEventListener' : 'removeEventListener';
            document[method]('pointerdown', onPointerDown, true);
            document[method]('click', onClick, true);
            window[method]('keydown', onKeyDown, true);
        };
        const onOpen = (e) => {
            if (!popup) listen(true);
            popup = e.popup;
            down = null;
        };
        const onClose = (e) => {
            if (e.popup !== popup) return;
            popup = null;
            listen(false);
        };

        map.on('popupopen', onOpen);
        map.on('popupclose', onClose);
        return () => {
            map.off('popupopen', onOpen);
            map.off('popupclose', onClose);
            if (popup) listen(false);
        };
    }, [map]);

    return null;
}

export default MenuDismiss;
