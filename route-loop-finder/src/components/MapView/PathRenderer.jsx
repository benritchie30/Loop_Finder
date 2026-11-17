import { GeoJSON, CircleMarker, Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import DirectionArrows from './DirectionArrows';
import CanvasLines from './CanvasLines';
import { surfacePieces } from '../../utils/surface';
import { COMPARE_HUES } from '../../utils/compareSets';
import { useMapDark, useTheme } from '../../utils/theme';

/**
 * The bold route with its unpaved stretches dashed: paved pieces as the
 * usual solid line; unpaved ones as short dashes of the same colour over a
 * pale line (so the dashes read on any background and the route stays whole).
 */
function SurfaceLine({ pieces, style, pane }) {
    const dark = useMapDark();
    const weight = style.weight || 4;
    const under = useMemo(() => ({
        color: dark ? '#0b1017' : '#ffffff', weight: weight + 2, opacity: 0.75, lineCap: 'round', lineJoin: 'round',
    }), [weight, dark]);
    const dashes = useMemo(() => ({
        color: style.color, opacity: 1, weight, lineCap: 'butt', lineJoin: 'round',
        dashArray: `${weight * 2} ${Math.round(weight * 1.5)}`, // 8 on, 6 off at the bold weight
    }), [style.color, weight]);
    return (
        <>
            {pieces.paved.length > 0 && (
                <Polyline positions={pieces.paved} pathOptions={style} pane={pane} interactive={false} />
            )}
            <Polyline positions={pieces.unpaved} pathOptions={under} pane={pane} interactive={false} />
            <Polyline positions={pieces.unpaved} pathOptions={dashes} pane={pane} interactive={false} />
        </>
    );
}

/**
 * Renders paths on the map. Nothing here takes pointer events: hovering and
 * clicking routes is done map-wide with a reach (RouteHover, PanInteractions).
 * - Active path: bold dark line (always on top)
 * - Filtered paths: subtle translucent preview
 * - Direction arrows: small rotated arrows along the active path
 * - Centroid: small dot (for spatial sort testing)
 * - Route card under the pointer (hoveredPathId): shown in place of the
 *   active path, with its arrows and centroid; the active path drops to a
 *   faint line like the others until the pointer leaves the card.
 * - Favorite routes (isFavorite) are drawn in the favorite colour (the
 *   theme's complement, favoriteHue) when bold or previewed; faint, they
 *   look like every other route.
 * - The bold route's unpaved stretches are dashed (SurfaceLine); faint
 *   routes stay plain.
 * - Dev compare (groupOf): every route in its group's colour (A only, B
 *   only, shared), faint or bold; the group colour wins over the favorite one.
 *
 * - The bold route has a casing (an outline that contrasts with the map:
 *   black on a light map, white with a soft glow on a dark one), drawn in
 *   its own pane under the route, so it stands clear of the faint routes it
 *   crosses on any basemap. The faint routes are a muted theme colour, so
 *   full colour means "the route shown"; each has a thin halo in the map's
 *   own tone (white on a light map, dark on a dark one), which lifts it off
 *   roads and terrain of a similar colour.
 * - Direction arrows are white chevrons with a dark outline.
 * - The Classic style (Display options > Style) draws the routes as they
 *   were before the casing: the bold route a plain dark line (bright on a
 *   dark map) with no casing, and the larger glowing arrows in the theme
 *   colour. The faint routes keep their stronger tone and halo.
 *
 * Render order ensures the shown path is always visible above others.
 */
const FAINT_HALO_EXTRA_PX = 2.5; // a faint route's halo shows 1.25 px on each side
const CASING_EXTRA_PX = 5; // the casing shows 2.5 px on each side of the route

function PathRenderer({
    currentPath,
    filteredPaths,
    backgroundPane = 'overlayPane',
    activePane = 'overlayPane',
    casingPane = null, // pane of the bold route's casing (under activePane); null: no casing
    showArrows = true,
    showCentroids = false,
    primaryColor = 215,
    showPathPreview = true,
    pathPreviewOpacity = 0.4,
    hoveredPathId = null, // a route card under the pointer: shown instead of the active path
    isFavorite = null, // (route) => boolean
    favoriteHue = 35,
    groupOf = null, // dev compare: (route) => 'a' | 'b' | 'shared' | null
}) {
    const hoveredPath = hoveredPathId && hoveredPathId !== currentPath?.id
        ? filteredPaths?.find((p) => p.id === hoveredPathId) || null
        : null;
    // The one route drawn bold: the hovered card's, else the selected one.
    const shownPath = hoveredPath || currentPath;
    // On a dark map (the dark appearance, satellite) the routes are bright
    // lines; on a light one the bold route is dark for contrast.
    const dark = useMapDark();
    const classic = useTheme().uiStyle === 'classic';
    // One of four looks: [classic light, classic dark, modern light, modern dark].
    const pick = (looks) => looks[(classic ? 0 : 2) + (dark ? 1 : 0)];
    const hsl = (hue, [s, l]) => `hsl(${hue}, ${s}%, ${l}%)`;
    const hoverStyle = useMemo(() => ({
        weight: 5,
        color: hsl(primaryColor, pick([[75, 55], [100, 76], [95, 60], [100, 64]])),
        opacity: classic ? (dark ? 0.95 : 0.9) : 1,
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [primaryColor, dark, classic]);
    // Faint routes: the theme colour, muted, and well away from the map's own
    // tone (dark on a light map, light on a dark one).
    const inactiveStyle = useMemo(() => ({
        weight: 2.25,
        // Classic: a little nearer the middle, since its bold route has no casing to set it apart.
        color: hsl(primaryColor, pick([[45, 44], [45, 78], [45, 36], [45, 76]])),
        opacity: pathPreviewOpacity
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [primaryColor, pathPreviewOpacity, dark, classic]);

    // Style for the currently selected path — bold, using theme color
    const activeStyle = useMemo(() => ({
        weight: classic && !dark ? 4 : 4.5,
        // Modern, inside the casing: saturated and mid-toned, so it reads against black and
        // against white. Classic, no casing: dark on a light map, bright on a dark one.
        color: hsl(primaryColor, pick([[65, 30], [95, 66], [85, 48], [92, 52]])),
        opacity: classic ? (dark ? 0.95 : 0.85) : 1
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [primaryColor, dark, classic]);

    // Favorites: the bold and preview styles in the favorite colour.
    const favorite = (path) => !!isFavorite && !!path && isFavorite(path);
    const favHoverStyle = useMemo(() => ({
        ...hoverStyle,
        color: hsl(favoriteHue, pick([[85, 50], [100, 70], [100, 58], [100, 58]])),
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [hoverStyle, favoriteHue, dark, classic]);
    const favActiveStyle = useMemo(() => ({
        ...activeStyle,
        color: hsl(favoriteHue, pick([[80, 42], [96, 60], [92, 46], [95, 48]])),
        opacity: classic ? 0.95 : 1,
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [activeStyle, favoriteHue, dark, classic]);

    // Dev compare: faint, bold and hover styles per group.
    const groupStyles = useMemo(() => {
        const out = {};
        Object.entries(COMPARE_HUES).forEach(([group, h]) => {
            out[group] = {
                inactive: { weight: 2.5, color: `hsl(${h}, 75%, ${dark ? 62 : 50}%)`, opacity: Math.max(pathPreviewOpacity, 0.55) },
                active: { weight: 4, color: hsl(h, pick([[75, 35], [90, 64], [85, 42], [85, 50]])), opacity: classic ? 0.95 : 1 },
                hover: { weight: 5, color: hsl(h, pick([[85, 50], [85, 72], [90, 54], [90, 60]])), opacity: classic ? 0.95 : 1 },
            };
        });
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathPreviewOpacity, dark, classic]);
    const groupStyle = (path, kind) => {
        const group = groupOf && path ? groupOf(path) : null;
        return group ? groupStyles[group][kind] : null;
    };

    // The centroid dot: a pale or dark tint of the theme colour, against the map.
    const centroidColor = dark ? `hsl(${primaryColor}, 100%, 92%)` : `hsl(${primaryColor}, 70%, 14%)`;
    // Classic arrows: the theme colour, brightened (nearly white on a dark map).
    const classicArrowColor = dark ? `hsl(${primaryColor}, 100%, 94%)` : `hsl(${primaryColor}, 85%, 60%)`;

    // Every route gets a unique id when it arrives (usePathSets.addPathToSet).
    const getPathKey = (path, index, prefix) => `${prefix}-${path?.id ?? 'route'}-${index}`;

    const shownPieces = useMemo(() => surfacePieces(shownPath), [shownPath]);
    const shownStyle = groupStyle(shownPath, hoveredPath ? 'hover' : 'active') || (hoveredPath
        ? (favorite(shownPath) ? favHoverStyle : hoverStyle)
        : (favorite(shownPath) ? favActiveStyle : activeStyle));
    const shownGroup = groupOf && shownPath ? groupOf(shownPath) || '' : '';
    const shownWeight = shownStyle.weight || 4;
    const casingStyle = useMemo(() => ({
        color: dark ? '#ffffff' : '#0a0d12',
        weight: shownWeight + CASING_EXTRA_PX,
        opacity: dark ? 1 : 0.92,
        lineCap: 'round',
        lineJoin: 'round',
    }), [dark, shownWeight]);

    // The faint routes, by style (one canvas draws them all: CanvasLines).
    const previewGroups = useMemo(() => {
        if (!showPathPreview || !filteredPaths?.length) return [];
        const byStyle = new Map();
        filteredPaths.forEach((path) => {
            if (path === shownPath || (path.id && path.id === shownPath?.id)) return;
            const group = groupOf ? groupOf(path) : null;
            const style = (group && groupStyles[group]?.inactive) || inactiveStyle;
            if (!byStyle.has(style)) byStyle.set(style, []);
            byStyle.get(style).push(path);
        });
        const groups = [...byStyle].map(([style, items]) => ({ style, items }));
        // Under them all, their halos (so no halo covers another route's line).
        const halos = groups.map(({ style, items }) => ({
            style: {
                color: dark ? '#05080d' : '#ffffff',
                weight: style.weight + FAINT_HALO_EXTRA_PX,
                opacity: Math.min(1, style.opacity * 1.3),
            },
            items,
        }));
        return [...halos, ...groups];
    }, [showPathPreview, filteredPaths, shownPath, groupOf, groupStyles, inactiveStyle, dark]);

    return (
        <>
            {/* All filtered paths — translucent preview, bottom layer (the active
                path too while a card preview replaces it) */}
            <CanvasLines groups={previewGroups} pane={backgroundPane} />

            {/* Its casing, in a pane of its own under the route */}
            {shownPath && casingPane && !classic && (
                <GeoJSON
                    key={getPathKey(shownPath, 0, `casing-${dark ? 'dark' : 'light'}-${shownWeight}`)}
                    data={shownPath}
                    style={casingStyle}
                    pane={casingPane}
                    interactive={false}
                />
            )}

            {/* The shown path: a route card's preview, else the active path (unpaved stretches dashed) */}
            {shownPath && shownPieces && (
                <SurfaceLine
                    key={getPathKey(shownPath, 0, `surface-${hoveredPath ? 'hover' : 'active'}${favorite(shownPath) ? '-fav' : ''}${shownGroup}`)}
                    pieces={shownPieces}
                    style={shownStyle}
                    pane={activePane}
                />
            )}
            {shownPath && !shownPieces && (
                <GeoJSON
                    key={getPathKey(shownPath, 0, `${hoveredPath ? 'hover' : 'active'}${favorite(shownPath) ? '-fav' : ''}${shownGroup}`)}
                    data={shownPath}
                    style={shownStyle}
                    pane={activePane}
                    interactive={false}
                />
            )}

            {/* Direction arrows along the shown path */}
            {showArrows && shownPath?.properties?.elevation_profile?.length > 1 && (
                <DirectionArrows
                    key={shownPath.id}
                    elevationProfile={shownPath.properties.elevation_profile}
                    plainColor={classic ? classicArrowColor : null}
                />
            )}

            {/* Centroid marker (for spatial sort verification) */}
            {showCentroids && shownPath?.properties?.centroid && (
                <CircleMarker
                    center={shownPath.properties.centroid}
                    radius={4}
                    pathOptions={{
                        color: centroidColor,
                        fillColor: centroidColor,
                        fillOpacity: 0.8,
                        weight: 1
                    }}
                    interactive={false}
                />
            )}

        </>
    );
}

export default PathRenderer;
