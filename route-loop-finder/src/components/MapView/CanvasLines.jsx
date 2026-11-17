import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { routeLatLngs } from '../../utils/surface';

/**
 * Many lines on one canvas: the faint routes of a generation (a hundred or
 * more routes of a thousand points each) and the graph's roads (tens of
 * thousands of pieces). As Leaflet layers every zoom projected each point
 * again (and SVG rebuilt each line), which stalled the map. Here the points
 * of an item are projected once (world pixels at zoom 0, kept for as long as
 * the item object lives); a redraw only scales them, so it costs a few
 * milliseconds and the canvas is redrawn on every frame of a wheel zoom
 * (SmoothWheelZoom): the lines stay sharp and in step with the map.
 * The canvas takes no pointer events: routes and roads are hovered and
 * clicked map-wide (RouteHover, PanInteractions, RoadTool).
 *
 * groups: [{ style: { color, weight, opacity }, items: [item, ...] }]. An
 * item is a route (GeoJSON feature) or { lines: [[[lat, lng], ...], ...] }.
 * Each item is one stroke, so items that overlap add up (darker), as
 * separate lines do.
 */

const MIN_STEP_PX = 1; // points closer than this to the last drawn one are skipped

// item -> { parts: [Float64Array of x, y, ...], boxes: Float64Array (4 per part), minX, minY, maxX, maxY }
const worldCache = new WeakMap();

function worldOf(item, crs) {
    const cached = worldCache.get(item);
    if (cached) return cached;
    let lines = item.lines || routeLatLngs(item);
    if (lines.length && typeof lines[0][0] === 'number') lines = [lines]; // a LineString is one part
    lines = lines.filter((line) => line.length > 1);
    const out = {
        parts: [], boxes: new Float64Array(lines.length * 4),
        minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    };
    lines.forEach((line, n) => {
        const xy = new Float64Array(line.length * 2);
        let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < line.length; i++) {
            const p = crs.latLngToPoint(L.latLng(line[i][0], line[i][1]), 0);
            xy[i * 2] = p.x;
            xy[i * 2 + 1] = p.y;
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        out.parts.push(xy);
        out.boxes.set([minX, minY, maxX, maxY], n * 4);
        out.minX = Math.min(out.minX, minX);
        out.minY = Math.min(out.minY, minY);
        out.maxX = Math.max(out.maxX, maxX);
        out.maxY = Math.max(out.maxY, maxY);
    });
    worldCache.set(item, out);
    return out;
}

// L.Renderer places the canvas (with padding around the view) and scales it
// during an animated zoom; this sizes and paints it.
const LinesCanvas = L.Renderer.extend({
    _initContainer() {
        this._container = document.createElement('canvas');
        this._container.style.pointerEvents = 'none';
        this._ctx = this._container.getContext('2d');
    },

    _destroyContainer() {
        L.Util.cancelAnimFrame(this._frame);
        this._frame = null;
        L.DomUtil.remove(this._container);
        this._container = null;
        this._ctx = null;
    },

    _updatePaths() {},

    setGroups(groups) {
        this._groups = groups || [];
        if (!this._map || this._frame) return;
        this._frame = L.Util.requestAnimFrame(() => {
            this._frame = null;
            if (this._map) this._draw();
        });
    },

    // A zoom that is not Leaflet's own animation (the wheel's glide, a pinch)
    // changes the view frame by frame: redraw, rather than stretch the old picture.
    // With `live` off (a whole road network is too much to paint every frame)
    // the old picture is stretched until the zoom ends, as Leaflet's layers do.
    _onZoom() {
        if (this._map._animatingZoom || !this.options.live) L.Renderer.prototype._onZoom.call(this);
        else this._update();
    },

    _update() {
        if (this._map._animatingZoom && this._bounds) return;
        L.Renderer.prototype._update.call(this);
        const size = this._bounds.getSize();
        const ratio = L.Browser.retina ? 2 : 1;
        const canvas = this._container;
        L.DomUtil.setPosition(canvas, this._bounds.min);
        if (canvas.width !== ratio * size.x || canvas.height !== ratio * size.y) {
            canvas.width = ratio * size.x;
            canvas.height = ratio * size.y;
            canvas.style.width = `${size.x}px`;
            canvas.style.height = `${size.y}px`;
        }
        this._ratio = ratio;
        this._draw();
    },

    _draw() {
        const ctx = this._ctx;
        const map = this._map;
        const bounds = this._bounds;
        if (!ctx || !map || !bounds) return;
        const ratio = this._ratio || 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this._container.width, this._container.height);
        if (!this._groups?.length) return;

        // Zoom-0 world pixels -> canvas pixels: scale, then shift.
        const crs = map.options.crs;
        const k = crs.scale(map.getZoom()) / crs.scale(0);
        const origin = map.getPixelOrigin();
        const dx = -origin.x - bounds.min.x;
        const dy = -origin.y - bounds.min.y;
        const size = bounds.getSize();
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        this._groups.forEach(({ style, items }) => {
            const weight = style.weight || 2;
            // The canvas, in world pixels (with room for the line's width).
            const left = (-weight - dx) / k;
            const right = (size.x + weight - dx) / k;
            const top = (-weight - dy) / k;
            const bottom = (size.y + weight - dy) / k;
            ctx.strokeStyle = style.color;
            ctx.lineWidth = weight;
            ctx.globalAlpha = style.opacity ?? 1;
            items.forEach((item) => {
                const world = worldOf(item, crs);
                if (world.maxX < left || world.minX > right || world.maxY < top || world.minY > bottom) return;
                const { parts, boxes } = world;
                ctx.beginPath();
                for (let n = 0; n < parts.length; n++) {
                    const b = n * 4;
                    if (boxes[b + 2] < left || boxes[b] > right || boxes[b + 3] < top || boxes[b + 1] > bottom) continue;
                    const xy = parts[n];
                    let lastX = xy[0] * k + dx;
                    let lastY = xy[1] * k + dy;
                    ctx.moveTo(lastX, lastY);
                    const end = xy.length - 2;
                    for (let i = 2; i <= end; i += 2) {
                        const x = xy[i] * k + dx;
                        const y = xy[i + 1] * k + dy;
                        if (i < end && Math.abs(x - lastX) < MIN_STEP_PX && Math.abs(y - lastY) < MIN_STEP_PX) continue;
                        ctx.lineTo(x, y);
                        lastX = x;
                        lastY = y;
                    }
                }
                ctx.stroke();
            });
        });
        ctx.globalAlpha = 1;
    },
});

function CanvasLines({ groups, pane = 'overlayPane', padding = 0.5, live = true }) {
    const map = useMap();
    const layerRef = useRef(null);

    useEffect(() => {
        const layer = new LinesCanvas({ pane, padding, live });
        layer.addTo(map);
        layerRef.current = layer;
        return () => {
            layer.remove();
            layerRef.current = null;
        };
    }, [map, pane, padding, live]);

    useEffect(() => {
        layerRef.current?.setGroups(groups);
    }, [groups, map, pane, padding, live]);

    return null;
}

export default CanvasLines;
