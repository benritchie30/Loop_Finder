import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { routeLatLngs } from '../../utils/surface';
import { EXPOSE_STATE } from '../../utils/devHooks';

/**
 * Many lines on one canvas: the faint routes of a generation (a hundred or
 * more routes of a thousand points each) and the graph's roads (tens of
 * thousands of pieces). As Leaflet layers every zoom projected each point
 * again (and SVG rebuilt each line), which stalled the map. Here the points
 * of an item are projected once (world pixels at zoom 0, kept for as long as
 * the item object lives); a redraw only scales them.
 * The canvas takes no pointer events: routes and roads are hovered and
 * clicked map-wide (RouteHover, PanInteractions, RoadTool).
 *
 * groups: [{ style: { color, weight, opacity }, items: [item, ...], merge }].
 * An item is a route (GeoJSON feature) or { lines: [[[lat, lng], ...], ...] }.
 * Each item is one stroke, so items that overlap add up (darker), as
 * separate lines do. With `merge`, the items are one shape instead: every
 * piece of road any of them uses, drawn once in a single stroke (routes from
 * one start share most of their roads: 50 routes of 64k points come to
 * about 13k). Overlaps no longer darken, and it paints several times faster.
 *
 * While the map zooms nothing is painted: the last picture is scaled into
 * place on every frame, exactly where the map is (its lines a little thicker
 * or thinner for the moment), as the map tiles are. When the zoom ends the
 * canvas is painted again, sharp. Painting every frame was too slow for a
 * zoom to feel direct on modest hardware.
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

/** A world from flat [x, y, ...] point lists (zoom-0 world pixels). */
function worldFromParts(lists) {
    const out = {
        parts: [], boxes: new Float64Array(lists.length * 4),
        minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    };
    lists.forEach((list, n) => {
        const xy = Float64Array.from(list);
        let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < xy.length; i += 2) {
            if (xy[i] < minX) minX = xy[i];
            if (xy[i] > maxX) maxX = xy[i];
            if (xy[i + 1] < minY) minY = xy[i + 1];
            if (xy[i + 1] > maxY) maxY = xy[i + 1];
        }
        out.parts.push(xy);
        out.boxes.set([minX, minY, maxX, maxY], n * 4);
        out.minX = Math.min(out.minX, minX);
        out.minY = Math.min(out.minY, minY);
        out.maxX = Math.max(out.maxX, maxX);
        out.maxY = Math.max(out.maxY, maxY);
    });
    return out;
}

// item -> per part, a key for each of its segments (the same either way round)
const segmentKeysCache = new WeakMap();

function segmentKeysOf(item, world) {
    const cached = segmentKeysCache.get(item);
    if (cached) return cached;
    const keys = world.parts.map((xy) => {
        const n = xy.length / 2;
        const point = new Array(n);
        for (let i = 0; i < n; i++) point[i] = `${Math.round(xy[i * 2] * 1e7)},${Math.round(xy[i * 2 + 1] * 1e7)}`;
        const segs = new Array(n - 1);
        for (let i = 1; i < n; i++) {
            const a = point[i - 1];
            const b = point[i];
            segs[i - 1] = a < b ? `${a}|${b}` : `${b}|${a}`;
        }
        return segs;
    });
    segmentKeysCache.set(item, keys);
    return keys;
}

// items array -> the merged world (a halo group and its line group share one)
const mergedCache = new WeakMap();

/** Every segment of the items, once: runs of segments not drawn yet become the parts. */
function mergedWorldOf(items, crs) {
    const cached = mergedCache.get(items);
    if (cached) return cached;
    const seen = new Set();
    const chains = [];
    items.forEach((item) => {
        const world = worldOf(item, crs);
        const keys = segmentKeysOf(item, world);
        world.parts.forEach((xy, n) => {
            const segs = keys[n];
            let chain = null;
            for (let i = 1; i <= segs.length; i++) {
                const key = segs[i - 1];
                if (seen.has(key)) {
                    chain = null;
                    continue;
                }
                seen.add(key);
                if (!chain) {
                    chain = [xy[i * 2 - 2], xy[i * 2 - 1]];
                    chains.push(chain);
                }
                chain.push(xy[i * 2], xy[i * 2 + 1]);
            }
        });
    });
    const out = worldFromParts(chains);
    mergedCache.set(items, out);
    return out;
}

/** Add a world's parts that reach the canvas to the current path. */
function traceWorld(ctx, world, k, dx, dy, view) {
    if (world.maxX < view.left || world.minX > view.right || world.maxY < view.top || world.minY > view.bottom) return;
    const { parts, boxes } = world;
    for (let n = 0; n < parts.length; n++) {
        const b = n * 4;
        if (boxes[b + 2] < view.left || boxes[b] > view.right || boxes[b + 3] < view.top || boxes[b + 1] > view.bottom) continue;
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
        // Dev server (utils/devHooks) only: what the canvas draws (colour, number of lines per
        // style, and whether it is the halo under other lines), for the
        // browser checks (backend/tools/check_frontend.py).
        if (EXPOSE_STATE && this._container) {
            this._container.dataset.lines = JSON.stringify(this._groups
                .map((g) => ({ color: g.style?.color ?? null, lines: (g.items || []).length, halo: !!g.halo })));
        }
        if (!this._map || this._frame) return;
        this._frame = L.Util.requestAnimFrame(() => {
            this._frame = null;
            if (this._map) this._draw();
        });
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
        const area = { x0: 0, y0: 0, x1: size.x, y1: size.y };
        this._groups.forEach(({ style, items, merge }) => {
            const weight = style.weight || 2;
            // The painted area, in world pixels (with room for the line's width).
            const view = {
                left: (area.x0 - weight - dx) / k,
                right: (area.x1 + weight - dx) / k,
                top: (area.y0 - weight - dy) / k,
                bottom: (area.y1 + weight - dy) / k,
            };
            ctx.strokeStyle = style.color;
            ctx.lineWidth = weight;
            ctx.globalAlpha = style.opacity ?? 1;
            if (merge) {
                ctx.beginPath();
                traceWorld(ctx, mergedWorldOf(items, crs), k, dx, dy, view);
                ctx.stroke();
                return;
            }
            items.forEach((item) => {
                ctx.beginPath();
                traceWorld(ctx, worldOf(item, crs), k, dx, dy, view);
                ctx.stroke();
            });
        });
        ctx.globalAlpha = 1;
    },
});

function CanvasLines({ groups, pane = 'overlayPane', padding = 0.5 }) {
    const map = useMap();
    const layerRef = useRef(null);

    useEffect(() => {
        const layer = new LinesCanvas({ pane, padding });
        layer.addTo(map);
        layerRef.current = layer;
        return () => {
            layer.remove();
            layerRef.current = null;
        };
    }, [map, pane, padding]);

    useEffect(() => {
        layerRef.current?.setGroups(groups);
    }, [groups, map, pane, padding]);

    return null;
}

export default CanvasLines;
