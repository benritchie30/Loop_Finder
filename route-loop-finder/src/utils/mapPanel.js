/**
 * The control panel floats over the right side of the map. Map moves that
 * should land in the part the panel leaves free (MapFocus, a pin's menu) ask
 * how much of the map it covers.
 */

/** Pixels of the map's right side the panel floats over (0 when it covers most of a narrow window). */
export function coveredRight(map) {
    const panel = document.querySelector('.control-panel');
    if (!panel || !map) return 0;
    const box = map.getContainer().getBoundingClientRect();
    const covered = Math.max(0, box.right - panel.getBoundingClientRect().left);
    return covered > map.getSize().x * 0.6 ? 0 : covered;
}
