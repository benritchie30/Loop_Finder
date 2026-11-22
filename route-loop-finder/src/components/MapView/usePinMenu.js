import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import { coveredRight } from '../../utils/mapPanel';

export const MENU_EDGE_PX = 12; // a menu that opens near the map's edge moves the map this far clear of it

/**
 * A pin's menu (a Leaflet Popup): returns the popup's ref and `act(fn)`,
 * which closes the menu and does fn. A menu that opens under the panel or
 * off the map's edge moves the map (only as far as it needs) so all of it
 * shows beside the panel.
 */
export function usePinMenu() {
    const map = useMap();
    const popupRef = useRef(null);
    useEffect(() => {
        const onOpen = (e) => {
            if (e.popup !== popupRef.current) return;
            e.popup.options.autoPanPaddingBottomRight = [coveredRight(map) + MENU_EDGE_PX, MENU_EDGE_PX];
        };
        map.on('popupopen', onOpen);
        return () => map.off('popupopen', onOpen);
    }, [map]);
    const act = (fn) => {
        map.closePopup();
        fn();
    };
    return { popupRef, act };
}
