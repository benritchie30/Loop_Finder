import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Pane, ZoomControl, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './MapView.css';

import PanInteractions from './PanInteractions';
import RoadTool from './RoadTool';
import RouteHover from './RouteHover';
import DrawingHandler from './DrawingHandler';
import SelectionLayer from './SelectionLayer';
import PathMarker from './PathMarker';
import SetPins from './SetPins';
import MenuDismiss from './MenuDismiss';
import MapFocus from './MapFocus';
import { BoundaryEditLayer, BoundaryOutline, ReachOutline } from './BoundaryLayers';
import PathRenderer from './PathRenderer';
import MapTileSwitcher from './MapTileSwitcher';
import { DEFAULT_MAP_STYLE, MAP_STYLES } from './mapStyles';
import RoadsLayer from './RoadsLayer';
import OfflineBasemap from './OfflineBasemap';
import { coverageGroups, nearestGroup, tileBounds, tileKey, tilesForStart } from '../../utils/mapTiles';
import { boundaryBounds } from '../../utils/boundary';
import SearchBox from './SearchBox';
import SmoothWheelZoom from './SmoothWheelZoom';
import QuickActions from './QuickActions';
import { MapDarkContext, useTheme } from '../../utils/theme';
import { EXPOSE_STATE } from '../../utils/devHooks';

/** Hands the Leaflet map to MapView (search flies it, search ranks results near its centre). */
function MapRef({ mapRef }) {
    const map = useMap();
    useEffect(() => {
        mapRef.current = map;
        // Dev server (utils/devHooks) only: the browser checks and the UI benchmark place the pointer with it.
        if (EXPOSE_STATE) window.__loopMap = map;
    }, [map, mapRef]);
    return null;
}

/** Reports the map's view ({ south, west, north, east }) when it stops moving (and at once). */
function ViewReporter({ onChange }) {
    const map = useMap();
    useEffect(() => {
        if (!onChange) return undefined;
        const report = () => {
            const b = map.getBounds();
            onChange({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
        };
        report();
        map.on('moveend', report);
        return () => map.off('moveend', report);
    }, [map, onChange]);
    return null;
}

/**
 * Where the arrow keys step through routes (the route view), the map leaves
 * them to the app, even after a click gave the map the keyboard focus: Leaflet would pan with them and stop the key
 * there. + / - still zoom. Elsewhere the arrows pan the map as usual.
 */
function ArrowKeys({ stepRoutes }) {
    const map = useMap();
    useEffect(() => {
        const keyboard = map.keyboard;
        if (!stepRoutes || !keyboard) return undefined;
        // Leaflet 1.9 (Map.Keyboard): _panKeys are the keys it pans with.
        if (keyboard._panKeys && typeof keyboard._panKeys === 'object') {
            const panKeys = keyboard._panKeys;
            keyboard._panKeys = {};
            return () => { keyboard._panKeys = panKeys; };
        }
        // Another Leaflet: no keyboard handling on the map while stepping.
        const wasOn = keyboard.enabled();
        keyboard.disable();
        return () => { if (wasOn) keyboard.enable(); };
    }, [map, stepRoutes]);
    return null;
}

const DEFAULT_CENTER = [35.626288, -82.551141]; // Default to Asheville area
const DEFAULT_ZOOM = 13;

/**
 * Main map view component - renders the Leaflet map and all map-based UI.
 */
function MapView({
    mode, // 'input' or 'display'
    activeTool, // 'circle' | 'box' | 'freeform' | 'road' | null (pan)
    isExcludeMode, // boolean
    wsStatus,
    pendingMarker,
    pathSetMarkers,
    activePathSetId,
    currentPath,
    filteredPaths,
    drawnSelections,
    onMapClick,
    onMarkerClick,
    onNewSetAt, // a pin's menu: New set from here ({ lat, lng })
    onShowAllAt, // a pin's menu (two or more sets): all routes from here ({ lat, lng })
    onSelection,
    onExcludeArea,
    onRemoveSelection,
    draftingRef,
    showArrows,
    showCentroids,
    primaryColor,
    showPathPreview,
    pathPreviewOpacity,
    isGenerating,
    generatingPathCount,
    generatingStatus = null, // map download / build text while a generation waits for its map
    onStopGeneration,
    reachMiles = null, // the plan's max route miles (offline: which tiles the start needs)
    reachArea = null, // the automatic search area to outline: { lat, lng, miles } (max / 2 around the start)
    notice: externalNotice = null, // { text, id } from App (snaps, batch notes)
    roadIndex = null, // utils/graphRoads index of the roads of the pin's / generation's area
    onNeedGraphEdges, // ask App to fetch them (once per area)
    showGraphRoads = true, // faint roads over tiles (offline they are always drawn)
    showSelections = true, // painted roads and areas in pan mode (a tool always shows them)
    onToggleEdges, // Road tool: (edges, { type, kind, label })
    onPinMove, // the start pin was dragged: ({ lat, lng })
    hoveredPathId = null, // route card under the pointer
    compareGroupOf = null, // dev compare: (route) => 'a' | 'b' | 'shared' | null
    onSelectPath, // a faint route was clicked
    onPlaceSelected, // search or "use my location": ({ lat, lng, name, bounds })
    mapCoverage = null, // { deg, tiles: [[row, col], ...] } downloaded map tiles (MAP_INFO)
    tileRoads = {}, // "row_col" -> roads of that tile, for the offline basemap
    onNeedTileRoads, // (tiles) ask the server for their roads
    hoveredSetId = null, // generation under the pointer in "Your loops": previewed like its pin under the pointer
    favoritesOnly = false, // only the starts with favorites have pins (with their favorite counts)
    pinPreviewKey = null, // the pin under the pointer (SetPins): the other pins are hidden
    onPinPreview, // SetPins: ({ key, ids } | null, fromKey)
    previewPaths = null, // the routes of the pin (or set) under the pointer, drawn faint while planning
    isFavoriteKey = null, // (route key) => is it a favorite (a pin counts its start's favorites)
    onViewChange, // ({ south, west, north, east }) when the map stops (Your loops: the starts in view first)
    strongPreview = false, // a set chip under the pointer: its routes' faint lines drawn strong
    previewSetIds = null, // the sets previewed while planning (the lit pin counts theirs)
    addingToName = null, // Find loops adds to this generation (it starts where the pin is)
    centreOn = null, // { lat, lng, n }: centre the map there (beside the panel)
    showBounds = null, // { bounds, n }: bring a route into view
    boundaryShapes = null, // a custom search boundary to outline (grey, dotted)
    boundaryEdit = null, // the boundary being edited: { shapes, tool, add, change, draftingRef } (drawn with handles)
    isFavorite = null, // (route) => is it a favorite (drawn in the favorite colour)
    favoriteHue = 35, // the favorite colour's hue (the theme's complement)
    arrowKeysStepRoutes = false, // the arrow keys step through routes here: the map does not pan with them
}) {
    const mapRef = useRef(null);
    const getCenter = useCallback(() => {
        const c = mapRef.current?.getCenter();
        return c ? { lat: c.lat, lng: c.lng } : null;
    }, []);
    const handlePlace = useCallback((place) => {
        const map = mapRef.current;
        if (map) {
            if (place.bounds) {
                map.flyToBounds(place.bounds, { maxZoom: 14, duration: 0.8 });
            } else {
                map.flyTo([place.lat, place.lng], Math.max(map.getZoom(), 13), { duration: 0.8 });
            }
        }
        onPlaceSelected?.(place);
    }, [onPlaceSelected]);
    const [activeStyle, setActiveStyle] = useState(() => {
        try {
            const saved = localStorage.getItem('mapStyle');
            return saved in MAP_STYLES ? saved : DEFAULT_MAP_STYLE; // a removed style falls back
        } catch {
            return DEFAULT_MAP_STYLE;
        }
    });

    const handleStyleChange = (newStyle) => {
        setActiveStyle(newStyle);
        try {
            localStorage.setItem('mapStyle', newStyle);
        } catch {
            console.warn('Failed to save map style');
        }
    };

    const getSavedPosition = () => {
        try {
            const saved = localStorage.getItem('lastMapPosition');
            if (saved) {
                const { center, zoom } = JSON.parse(saved);
                return { center, zoom };
            }
        } catch {
            console.warn('Failed to load saved map position');
        }
        return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
    };

    const { center, zoom } = getSavedPosition();
    const [notice, setNotice] = useState('');
    const noticeTimer = useRef(null);
    useEffect(() => () => clearTimeout(noticeTimer.current), []);

    const showNotice = useCallback((text, ms = 1600) => {
        setNotice(text);
        clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNotice(''), ms);
    }, []);
    const onSnapMiss = useCallback(() => showNotice('No road here'), [showNotice]);
    // Road tool: the excluded area under the pointer shows its roads.
    const [revealedAreaId, setRevealedAreaId] = useState(null);
    const roadToolOn = activeTool === 'road' && !!roadIndex;
    useEffect(() => {
        if (!roadToolOn) setRevealedAreaId(null);
    }, [roadToolOn]);
    const offline = !MAP_STYLES[activeStyle]?.url;
    // Dark appearance: internet tiles are dimmed (unless that is turned off, and never
    // satellite imagery); the road network basemap is drawn dark. `mapDark`: the map
    // under the routes is dark, so they are drawn in light colours.
    const { theme, darkTiles } = useTheme();
    const satellite = activeStyle === 'satellite';
    const dimTiles = theme === 'dark' && darkTiles && !offline && !satellite;
    const mapDark = satellite || (theme === 'dark' && (offline || darkTiles));
    // Hidden painted roads and areas still filter routes; they show again
    // while a tool is active. Hidden, a double-click cannot remove them.
    const selectionsShown = showSelections || !!activeTool;
    // Roads are needed for the offline basemap and for the Road tool / pins.
    useEffect(() => {
        if (!roadIndex) onNeedGraphEdges?.();
    }, [roadIndex, onNeedGraphEdges]);

    // No internet: after a few failed tiles, fall back to the offline basemap once
    // per session (the layers button switches back).
    const tileErrors = useRef(0);
    const autoSwitched = useRef(false);
    const handleTileError = () => {
        tileErrors.current += 1;
        if (tileErrors.current >= 4 && !autoSwitched.current) {
            autoSwitched.current = true;
            handleStyleChange('offline');
            showNotice('Map tiles are not reachable; showing the road network instead', 4000);
        }
    };

    useEffect(() => {
        if (externalNotice?.text) showNotice(externalNotice.text, 3200);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [externalNotice?.id]);

    // Offline: a start whose search area reaches past the downloaded tiles
    // would wait for downloads that cannot happen.
    const missingTiles = useMemo(() => {
        if (!offline || mode !== 'input' || !pendingMarker || !(reachMiles > 0) || !mapCoverage?.tiles) return 0;
        const have = new Set(mapCoverage.tiles.map(([r, c]) => tileKey(r, c)));
        // With a boundary, only the tiles it overlaps are needed.
        const b = boundaryBounds({ shapes: boundaryShapes });
        const needed = ([r, c]) => {
            if (!b) return true;
            const [[s, w], [n, e]] = tileBounds([r, c], mapCoverage.deg);
            return s <= b.north && n >= b.south && w <= b.east && e >= b.west;
        };
        return tilesForStart(pendingMarker.lat, pendingMarker.lng, reachMiles, mapCoverage.deg)
            .filter(needed)
            .filter(([r, c]) => !have.has(tileKey(r, c))).length;
    }, [offline, mode, pendingMarker, reachMiles, mapCoverage, boundaryShapes]);

    // What the active tool does, at the top of the map (the panel stays short).
    const getHintText = () => {
        if (notice) return notice;
        if (missingTiles > 0 && !activeTool) {
            return `This start needs ${missingTiles} map ${missingTiles === 1 ? 'tile' : 'tiles'} that ${missingTiles === 1 ? 'is' : 'are'} not downloaded. `
                + 'Without internet, drop the pin further inside the light area or shorten the route.';
        }
        const avoid = isExcludeMode;
        if (activeTool === 'road') {
            return avoid
                ? 'Click a road to avoid it (red) · Ctrl-click: the whole road · click a painted road to clear it'
                : 'Click a road to route through it (green) · Ctrl-click: the whole road · Shift: avoid · click a painted road to clear it';
        }
        if (activeTool === 'circle' || activeTool === 'box' || activeTool === 'freeform') {
            const how = { circle: 'Drag from the centre', box: 'Drag a rectangle', freeform: 'Drag around an area' }[activeTool];
            return avoid
                ? `${how} to avoid the roads in it (red) · Esc cancels`
                : `${how} that routes must pass through (green) · Shift: avoid · Esc cancels`;
        }
        if (boundaryEdit) {
            if (boundaryEdit.tool) {
                const how = { circle: 'Drag from the centre', box: 'Drag a rectangle', freeform: 'Drag around the area' }[boundaryEdit.tool];
                return `${how} to add it to the boundary · Esc cancels`;
            }
            return boundaryEdit.shapes.length
                ? 'Drag the white handles to adjust · add shapes: C circle, B box, F freeform · Enter: use it · Esc: cancel'
                : 'Add a shape: C circle, B box, F freeform · Esc: cancel';
        }
        if (mode === 'input' && pendingMarker) {
            return addingToName
                ? `Press Enter to add loops to “${addingToName}” (drag the pin to move it)`
                : 'Press Enter to find loops from here (drag the pin to move it)';
        }
        return null;
    };

    const hintText = getHintText();

    // Offline: is any downloaded map data in view? If not, offer to go there.
    const [coverageInView, setCoverageInView] = useState(true);
    const groups = useMemo(
        () => (mapCoverage?.tiles?.length ? coverageGroups(mapCoverage.tiles, mapCoverage.deg) : []),
        [mapCoverage],
    );
    const goToMapData = () => {
        const map = mapRef.current;
        if (!map || !groups.length) return;
        const c = map.getCenter();
        const group = nearestGroup(groups, c.lat, c.lng);
        map.flyToBounds(group.bounds, { maxZoom: 12, duration: 0.8, paddingTopLeft: [40, 40], paddingBottomRight: [400, 40] });
    };

    const [showStatus, setShowStatus] = useState(true);
    useEffect(() => {
        setShowStatus(true);
        if (wsStatus !== 'connected') return;
        const timer = setTimeout(() => setShowStatus(false), 5000);
        return () => clearTimeout(timer);
    }, [wsStatus]);
    const isConnected = wsStatus === 'connected';

    return (
        <MapDarkContext.Provider value={mapDark}>
        <div className={`map-view ${offline ? 'map-view--offline' : ''} ${mapDark ? 'map-view--dark' : ''} ${dimTiles ? 'map-view--dim-tiles' : ''}`}>
            {/* Connection status */}
            {showStatus && (
                <div className="map-view__status">
                    <div className={`map-view__status-dot map-view__status-dot--${isConnected ? 'connected' : 'disconnected'}`} />
                    <span>{isConnected ? 'Connected' : 'Server disconnected'}</span>
                </div>
            )}

            {isGenerating && (
                <div className="map-view__generating">
                    <div className="map-view__status-dot map-view__status-dot--connecting" />
                    <span>
                        {generatingStatus
                            || `Generating... ${generatingPathCount} ${generatingPathCount === 1 ? 'route' : 'routes'}`}
                    </span>
                    <button
                        className="map-view__stop-btn"
                        onClick={onStopGeneration}
                        title="Stop generating (Esc)"
                    >
                        Stop
                    </button>
                </div>
            )}

            <SearchBox getCenter={getCenter} onSelect={handlePlace} />

            {offline && !coverageInView && groups.length > 0 && (
                <button type="button" className="map-view__goto-data" onClick={goToMapData}>
                    No downloaded map data here · <strong>Go to the nearest</strong>
                </button>
            )}

            {/* Tile Switcher */}
            <MapTileSwitcher
                currentStyle={activeStyle}
                onStyleChange={handleStyleChange}
            />

            <QuickActions />

            {/* Instruction hint */}
            <div className={`map-view__hint ${hintText ? 'map-view__hint--visible' : ''} ${isGenerating ? 'map-view__hint--low' : ''}`}>
                {hintText}
            </div>

            <MapContainer
                center={center}
                zoom={zoom}
                style={{ height: '100%', width: '100%' }}
                zoomControl={false}
                // The wheel glides to any zoom (SmoothWheelZoom), so the map does not
                // snap to whole levels; the + / - buttons still move one level.
                zoomSnap={0}
                scrollWheelZoom={false}
            >
                <MapRef mapRef={mapRef} />
                <ArrowKeys stepRoutes={arrowKeysStepRoutes} />
                <SmoothWheelZoom />
                <ZoomControl position="topleft" />
                {/* Panes for Z-Index Management */}
                <Pane name="basemap" style={{ zIndex: 250 }} />
                <Pane name="backgroundPaths" style={{ zIndex: 400 }} />
                {/* The bold route's outline: over the faint routes, under the route itself */}
                <Pane name="routeCasing" style={{ zIndex: 440 }} />
                <Pane name="activePath" style={{ zIndex: 450 }} />
                <Pane name="tools" style={{ zIndex: 500 }} />

                {/* Dynamic Tile Layer. The offline style has no tiles: the graph's own roads are the basemap. */}
                {!offline && (
                    <TileLayer
                        key={activeStyle} // Force re-render when style changes
                        url={MAP_STYLES[activeStyle].url}
                        attribution={MAP_STYLES[activeStyle].attribution}
                        eventHandlers={{ tileerror: handleTileError }}
                    />
                )}
                {offline && (
                    <OfflineBasemap
                        coverage={mapCoverage}
                        tileRoads={tileRoads}
                        onNeedTiles={onNeedTileRoads}
                        onCoverageInView={setCoverageInView}
                    />
                )}
                <RoadsLayer
                    index={roadIndex}
                    offline={offline}
                    show={showGraphRoads && (mode === 'input' || mode === 'display')}
                />

                {/* Pan mode: click shows a route (or moves the start), double-click removes */}
                <PanInteractions
                    enabled={!activeTool && !boundaryEdit}
                    mode={mode}
                    paths={mode === 'display' ? filteredPaths : null}
                    currentPathId={(mode === 'display' ? currentPath?.id : null) ?? null}
                    selections={selectionsShown ? drawnSelections : null}
                    onSelectPath={mode === 'display' ? onSelectPath : null}
                    onMoveStart={onMapClick}
                    onRemoveSelection={onRemoveSelection}
                />

                {selectionsShown && (
                    <SelectionLayer
                        selections={drawnSelections || []}
                        roadIndex={roadIndex}
                        revealedAreaId={revealedAreaId}
                    />
                )}

                {/* The boundary being edited: its shapes with handles; its tool adds shapes. */}
                {boundaryEdit && <BoundaryEditLayer shapes={boundaryEdit.shapes} onChange={boundaryEdit.change} />}
                {boundaryEdit && (
                    <DrawingHandler
                        activeTool={boundaryEdit.tool}
                        isExcludeMode={false}
                        onSelection={boundaryEdit.add}
                        draftingRef={boundaryEdit.draftingRef}
                        drawStyle={{ color: mapDark ? '#cbd5e1' : '#334155', weight: 2, opacity: 0.95, dashArray: '6 5', fillColor: '#64748b', fillOpacity: 0.08 }}
                    />
                )}
                {!boundaryEdit && boundaryShapes && <BoundaryOutline shapes={boundaryShapes} />}

                <DrawingHandler
                    activeTool={activeTool}
                    isExcludeMode={isExcludeMode}
                    onSelection={onSelection}
                    onExcludeArea={onExcludeArea}
                    onSnapMiss={onSnapMiss}
                    draftingRef={draftingRef}
                    roadIndex={roadIndex}
                />
                {roadToolOn && (
                    <RoadTool
                        roadIndex={roadIndex}
                        selections={drawnSelections}
                        isExcludeMode={isExcludeMode}
                        onToggleEdges={onToggleEdges}
                        onSnapMiss={onSnapMiss}
                        onRevealArea={setRevealedAreaId}
                    />
                )}

                {/* Pending marker (blue) - shown while user is picking a spot (hidden while a pin's routes are previewed) */}
                {pendingMarker && mode === 'input' && !pinPreviewKey && !(previewPaths?.length > 0) && (
                    <PathMarker
                        position={pendingMarker}
                        color="pending"
                        title="Start (drag to move)"
                        zIndexOffset={1000}
                        draggable
                        onDragEnd={onPinMove}
                    />
                )}
                {/* The automatic search area (max / 2 around the start), when no custom boundary replaces it */}
                {reachArea && !pinPreviewKey && !(previewPaths?.length > 0) && <ReachOutline lat={reachArea.lat} lng={reachArea.lng} miles={reachArea.miles} />}

                {/* Every set's pin (one per start): hover previews, click opens, right-click for its menu. */}
                <SetPins
                    markers={pathSetMarkers}
                    mode={mode}
                    activePathSetId={activePathSetId}
                    hoveredSetId={hoveredSetId}
                    favoritesOnly={favoritesOnly}
                    previewKey={pinPreviewKey}
                    isFavoriteKey={isFavoriteKey}
                    previewIds={previewSetIds}
                    onPreview={onPinPreview}
                    onOpen={onMarkerClick}
                    onNewSet={onNewSetAt}
                    onShowAll={onShowAllAt}
                />
                {/* A pin's menu closes at a click anywhere else (on the map that click does nothing more) */}
                <MenuDismiss />
                <MapFocus centre={centreOn} show={showBounds} />
                <ViewReporter onChange={onViewChange} />

                {/* A pin (or set) under the pointer while planning: its routes, faint */}
                {mode === 'input' && previewPaths?.length > 0 && (
                    <PathRenderer
                        currentPath={null}
                        filteredPaths={previewPaths}
                        backgroundPane="backgroundPaths"
                        activePane="activePath"
                        casingPane="routeCasing"
                        showArrows={false}
                        showCentroids={false}
                        primaryColor={primaryColor}
                        showPathPreview
                        pathPreviewOpacity={Math.max(0.9, pathPreviewOpacity)} // no bold route here: stronger than the usual faint ones
                        isFavorite={isFavorite}
                        favoriteHue={favoriteHue}
                    />
                )}

                {/* Path rendering */}
                {mode === 'display' && activePathSetId && (
                    <PathRenderer
                        currentPath={currentPath}
                        filteredPaths={filteredPaths}
                        backgroundPane="backgroundPaths"
                        activePane="activePath"
                        casingPane="routeCasing"
                        showArrows={showArrows}
                        showCentroids={showCentroids}
                        primaryColor={primaryColor}
                        showPathPreview={showPathPreview}
                        pathPreviewOpacity={strongPreview ? Math.max(0.9, pathPreviewOpacity) : pathPreviewOpacity}
                        hoveredPathId={hoveredPathId}
                        isFavorite={isFavorite}
                        favoriteHue={favoriteHue}
                        groupOf={compareGroupOf}
                    />
                )}
                {mode === 'display' && activePathSetId && (
                    <RouteHover
                        profile={currentPath?.properties?.elevation_profile}
                        enabled={!activeTool}
                        color={`hsl(${primaryColor}, 85%, 55%)`}
                        pane="activePath"
                    />
                )}

            </MapContainer>
        </div>
        </MapDarkContext.Provider>
    );
}

export default MapView;

