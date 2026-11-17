import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

/**
 * Wheel zoom that glides (in place of Leaflet's, which jumps a step per
 * notch and animates each step separately). Every wheel event moves a goal
 * zoom by an amount proportional to how far the wheel turned, so a small
 * turn zooms a little and a long fast one zooms a lot; each frame the map
 * moves part of the way to the goal, keeping the place under the pointer
 * still. The map rests on whatever zoom it reaches (no snapping).
 */

const ZOOM_PER_PX = 1 / 480; // one mouse-wheel notch (about 100 px) is about a fifth of a level
const PINCH_ZOOM_PER_PX = 1 / 100; // trackpad pinch (wheel with ctrl): small deltas
const MAX_STEP = 1; // levels one wheel event can add to the goal
const EASE_MS = 90; // time constant of the glide: larger is smoother and slower
const DONE = 0.002; // levels from the goal at which the glide has arrived
const IDLE_MS = 160; // the gesture ends this long after the last wheel event

function SmoothWheelZoom() {
    const map = useMap();

    useEffect(() => {
        map.scrollWheelZoom.disable();
        const container = map.getContainer();
        let frame = null;
        let goal = 0;
        let anchor = null; // the place under the pointer: it stays there
        let pointer = null; // container point of the pointer
        let lastWheel = 0;
        let lastFrame = 0;
        let moved = false;
        let own = null; // the view this last set: anything else moving the map ends the gesture

        const limits = () => {
            const min = map.getMinZoom();
            const max = map.getMaxZoom();
            return [Number.isFinite(min) ? min : 0, Number.isFinite(max) ? max : 22];
        };

        const finish = () => {
            if (frame != null) cancelAnimationFrame(frame);
            frame = null;
            own = null;
            if (moved) {
                moved = false;
                map._moveEnd(true);
            }
        };

        const tick = (now) => {
            frame = null;
            // A drag, a search fly-to, the zoom buttons: they have the map now.
            if (own && (map.getZoom() !== own.zoom || !map.getCenter().equals(own.center))) {
                finish();
                return;
            }
            const zoom = map.getZoom();
            const dt = Math.min(64, now - lastFrame);
            lastFrame = now;
            const gap = goal - zoom;
            if (Math.abs(gap) < DONE) {
                if (now - lastWheel > IDLE_MS) {
                    finish();
                    return;
                }
                frame = requestAnimationFrame(tick);
                return;
            }
            const next = Math.abs(gap) < DONE * 2 ? goal : zoom + gap * (1 - Math.exp(-dt / EASE_MS));
            const offset = pointer.subtract(map.getSize().divideBy(2));
            const centre = map.unproject(map.project(anchor, next).subtract(offset), next);
            if (!moved) {
                map._moveStart(true, false);
                moved = true;
            }
            map._move(centre, next);
            own = { zoom: map.getZoom(), center: map.getCenter() };
            frame = requestAnimationFrame(tick);
        };

        const onWheel = (e) => {
            e.preventDefault();
            let px = e.deltaY;
            if (e.deltaMode === 1) px *= 40; // lines
            else if (e.deltaMode === 2) px *= 800; // pages
            if (!px) return;
            const [min, max] = limits();
            if (frame == null) {
                map._stop(); // a fly-to or pan animation in progress
                goal = map.getZoom();
                lastFrame = performance.now();
                own = null;
            }
            const step = -px * (e.ctrlKey ? PINCH_ZOOM_PER_PX : ZOOM_PER_PX);
            goal = Math.min(max, Math.max(min, goal + Math.max(-MAX_STEP, Math.min(MAX_STEP, step))));
            pointer = map.mouseEventToContainerPoint(e);
            anchor = map.containerPointToLatLng(pointer);
            lastWheel = performance.now();
            if (frame == null) frame = requestAnimationFrame(tick);
        };

        container.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            container.removeEventListener('wheel', onWheel);
            finish();
            map.scrollWheelZoom.enable();
        };
    }, [map]);

    return null;
}

export default SmoothWheelZoom;
