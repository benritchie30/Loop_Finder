import { useMemo } from 'react';
import CanvasLines from './CanvasLines';
import { ROAD_COLORS } from '../../utils/roadColors';
import { useMapDark } from '../../utils/theme';

// On a dark map the roads are light lines.
const DARK = { base: '#5d6b7e', baseOverTiles: '#e2e8f0' };

/**
 * The graph's roads, drawn on a canvas (CanvasLines: tens of thousands of
 * segments are too many for SVG, and for Leaflet's own canvas on every zoom).
 * Offline the roads are the basemap; over tiles they are faint, so it is
 * clear which roads the search can use. The Road tool's hover highlight is a
 * plain Leaflet layer owned by DrawingHandler.
 */
function RoadsLayer({ index, offline, show }) {
    const dark = useMapDark();
    const roads = useMemo(() => (index ? { lines: index.edges.map((e) => e.pts) } : null), [index]);
    const groups = useMemo(() => (roads && roads.lines.length && (show || offline) ? [{
        style: {
            color: offline
                ? (dark ? DARK.base : ROAD_COLORS.base)
                : (dark ? DARK.baseOverTiles : ROAD_COLORS.baseOverTiles),
            weight: offline ? 1.5 : 1.2,
            opacity: offline ? 0.9 : 0.22,
        },
        items: [roads],
    }] : []), [roads, show, offline, dark]);

    return <CanvasLines groups={groups} live={false} />;
}

export default RoadsLayer;
