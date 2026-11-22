import { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { Activity } from 'lucide-react';
import './App.css';

import { MapView } from './components/MapView';
import { ControlPanel } from './components/ControlPanel';
import ElevationProfileWindow from './components/ElevationProfileWindow';
import { useWebSocket } from './hooks/useWebSocket';
import { useAppMode } from './hooks/useAppMode';
import { usePathSets, suggestGenerationName } from './hooks/usePathSets';
import { useFavorites } from './hooks/useFavorites';
import { applyPaint } from './utils/paintRoads';
import { normalizeRoadWeights } from './utils/roadWeights';
import { buildRoadIndex } from './utils/graphRoads';
import { mapProgressText, nextProgress } from './utils/mapProgress';
import { MAX_ROUTE_MILES, UnitsContext, readUnits } from './utils/units';
import { placeNameAt } from './utils/geocode';
import { chosenSet, sameStart, setsAtStart } from './utils/pathSetGroups';
import { routeKey } from './utils/routeIdentity';
import { isKeptId } from './utils/keptSets';
import { ALL_SETS } from './utils/combinedSets';
import { downloadRouteGpx } from './utils/gpx';
import { surfacePreference } from './utils/surface';
import { automaticArea, boundaryBounds, boundaryContains, boundaryKey, boundaryPayload, cleanShapes, simplifyOutline } from './utils/boundary';
import { useBoundaries } from './hooks/useBoundaries';
import { useRouteHistory } from './hooks/useRouteHistory';
import { EXPOSE_STATE } from './utils/devHooks';

/** What the server needs from a selection (geometry for roads is re-derived from node pairs). */
function selectionPayload(selection) {
  return {
    id: selection.id,
    type: selection.type,
    shape: selection.shape,
    lat: selection.lat,
    lng: selection.lng,
    radiusM: selection.radiusM,
    north: selection.north,
    south: selection.south,
    east: selection.east,
    west: selection.west,
    coordinates: selection.coordinates,
    edges: selection.edges,
  };
}

/** Selections to send: an excluded area whose roads were all turned back on constrains nothing. */
function selectionsPayload(selections) {
  return (selections || [])
    .filter((s) => s.shape !== 'edges' || (s.edges || []).length > 0)
    .map(selectionPayload);
}

const DEFAULT_ALGORITHM_OPTION = { id: 'tree_full', label: 'Full loops', resumable: true };
// Bumped when the default search changes: settings saved under the old default move to the new one once.
const SEARCH_DEFAULT_VERSION = 2;
const OLD_DEFAULT_ALGORITHM = 'tree_guided';
// Every strategy the server has (dev ones only listed with LOOP_DEV=1).
const AREA_SWEEP_IDS = ['tree_full', 'tree_full_deep', 'tree_guided', 'tree_loops', 'tree_cover', 'tree_triangles', 'tree_triangles8', 'tree_full_slow', 'loop_atlas'];
// Saved settings of search options that were removed.
const REMOVED_SETTINGS = ['sim_ceiling', 'deduplication', 'cap_k', 'debug_snapshots', 'snapshot_every'];
// Route length the slider allows, in miles (up to the server's limit).
const LENGTH_LIMITS_MI = [0.6, MAX_ROUTE_MILES];
const UNDO_MS = 7000;
const EDGE_SETS_KEPT = 4; // road layers of recent areas kept in the browser
const TILE_ROADS_KEPT = 80; // offline basemap: roads of this many map tiles kept in the browser

const SETTING_DEFAULTS = {
  min_path_len: 15,
  max_path_len: 30,
  loop_ratio: 0.5,
  num_paths: 50, // First batch (Advanced); settings already saved keep theirs
  routes_per_pin: 20, // More routes batch
  more_algorithm: DEFAULT_ALGORITHM_OPTION.id,
  algorithm: DEFAULT_ALGORITHM_OPTION.id,
  search_default: SEARCH_DEFAULT_VERSION,
  min_dist_m: 50,
  explore_weight: null,
  detour_weight: null,
  reuse_weight: null,
  road_preference: 'balanced', // quiet | balanced | any | custom (road_weights)
  road_weights: null,
  surface_preference: 'allow', // paved | allow | gravel (utils/surface.js)
  rural_scale: true,
  boundary: null, // custom search boundary { id, name, shapes } (utils/boundary.js); null: automatic
  auto_more_routes: false, // a new green road or include area on an open generation asks for more routes
};

// Preferences saved and edited with the search settings (Advanced) that are
// not part of a search: never sent to the server, never stored with a
// generation, and "Plan again from here" leaves them as they are.
const APP_ONLY_SETTINGS = ['auto_more_routes'];

/** A copy of the plan's settings for a search (and for the generation to keep). */
function searchSettingsOf(settings) {
  const copy = structuredClone(settings);
  APP_ONLY_SETTINGS.forEach((key) => { delete copy[key]; });
  return copy;
}

function readSettings() {
  try {
    const saved = localStorage.getItem('generatorSettings');
    if (!saved) return { ...SETTING_DEFAULTS };
    const parsed = JSON.parse(saved);
    REMOVED_SETTINGS.forEach((key) => { delete parsed[key]; });
    if (parsed.search_default !== SEARCH_DEFAULT_VERSION) {
      if (parsed.algorithm === OLD_DEFAULT_ALGORITHM) parsed.algorithm = DEFAULT_ALGORITHM_OPTION.id;
      if (parsed.more_algorithm === OLD_DEFAULT_ALGORITHM) parsed.more_algorithm = DEFAULT_ALGORITHM_OPTION.id;
      parsed.search_default = SEARCH_DEFAULT_VERSION;
    }
    if (!AREA_SWEEP_IDS.includes(parsed.algorithm)) parsed.algorithm = DEFAULT_ALGORITHM_OPTION.id;
    if (!AREA_SWEEP_IDS.includes(parsed.more_algorithm)) parsed.more_algorithm = parsed.algorithm;
    // Old road presets: the built-in table is Balanced; anything tuned stays as custom weights.
    if (!parsed.road_preference) {
      const preset = parsed.road_weight_preset;
      parsed.road_preference = !preset || preset === 'current' ? 'balanced' : 'custom';
    }
    delete parsed.road_weight_preset;
    parsed.road_weights = parsed.road_preference === 'custom' ? normalizeRoadWeights(parsed.road_weights) : null;
    if (typeof parsed.rural_scale !== 'boolean') parsed.rural_scale = true;
    if (typeof parsed.auto_more_routes !== 'boolean') parsed.auto_more_routes = false;
    parsed.surface_preference = surfacePreference(parsed.surface_preference);
    parsed.boundary = parsed.boundary && cleanShapes(parsed.boundary.shapes).length
      ? { ...parsed.boundary, shapes: cleanShapes(parsed.boundary.shapes) }
      : null;
    const clamp = (v, d) => Math.min(LENGTH_LIMITS_MI[1], Math.max(LENGTH_LIMITS_MI[0], Number(v) || d));
    const lo = clamp(parsed.min_path_len, SETTING_DEFAULTS.min_path_len);
    const hi = clamp(parsed.max_path_len, SETTING_DEFAULTS.max_path_len);
    parsed.min_path_len = Math.min(lo, hi);
    parsed.max_path_len = Math.max(lo, hi);
    return { ...SETTING_DEFAULTS, ...parsed };
  } catch {
    return { ...SETTING_DEFAULTS };
  }
}

const VIEW_OPTION_DEFAULTS = {
  showArrows: true,
  showCentroids: false,
  primaryColor: '215',
  showPathPreview: true,
  pathPreviewOpacity: 0.5,
  showGraphRoads: true,
  showSelections: true, // painted roads and areas on the map (always while a tool is active)
  showBoundary: true, // an open generation's custom search boundary (grey, dotted)
};

function readViewOptions() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('viewOptions') || '{}') || {};
  } catch {
    saved = {};
  }
  const opacity = Number(saved.pathPreviewOpacity);
  const hue = Number(saved.primaryColor ?? localStorage.getItem('primaryColor') ?? VIEW_OPTION_DEFAULTS.primaryColor);
  const flag = (key) => (typeof saved[key] === 'boolean' ? saved[key] : VIEW_OPTION_DEFAULTS[key]);
  return {
    showArrows: flag('showArrows'),
    showCentroids: flag('showCentroids'),
    showPathPreview: flag('showPathPreview'),
    showGraphRoads: flag('showGraphRoads'),
    showSelections: flag('showSelections'),
    showBoundary: flag('showBoundary'),
    pathPreviewOpacity: Number.isFinite(opacity)
      ? Math.min(1, Math.max(0.1, opacity))
      : VIEW_OPTION_DEFAULTS.pathPreviewOpacity,
    primaryColor: Number.isFinite(hue)
      ? String(Math.min(360, Math.max(0, Math.round(hue))))
      : VIEW_OPTION_DEFAULTS.primaryColor,
  };
}

/** Same pin? Prefetch messages carry the pin they were asked for. */
function samePin(a, b) {
  return !!a && !!b && Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
}

/** A prefetch message for the pin's current request (its max and boundary: `token`)? */
function forPinArea(area, message) {
  return samePin(area, message) && (message.token == null || message.token === area.token);
}

/** The search settings a request carries (custom road weights only when Roads is Custom). */
function requestSettings(settings) {
  return {
    ...settings,
    road_weights: settings.road_preference === 'custom' ? settings.road_weights : null,
  };
}

/** The favorite colour's hue: the theme colour's complement. */
function favoriteHueOf(primaryHue) {
  return (Math.round(Number(primaryHue) || 0) + 180) % 360;
}

function App() {
  const { status: wsStatus, sendMessage, subscribe } = useWebSocket();
  const { favorites, isFavorite, toggleFavorite, removeFavorites } = useFavorites();

  const {
    pathSets,
    activePathSetId,
    activePathSet,
    currentPath,
    filteredPaths,
    totalPathsCount,
    allPaths,
    chosenTotal,
    combined,
    generations,
    routeFilters,
    filterBounds,
    sortBy,
    sortAscending,
    drawnSelections,
    pathSetMarkers,
    hoveredPathId,
    createPathSet,
    addPathToSet,
    completePathSet,
    resumePathSet,
    expirePathSetSession,
    selectPathSet,
    renamePathSet,
    updatePathSetSettings,
    deletePathSet,
    restorePathSet,
    addDrawnSelection,
    toggleEdges,
    clearDrawnSelections,
    replaceSelections,
    undoLastSelection,
    removeSelection,
    updateSelection,
    setFilterRange,
    addRouteFilter,
    removeRouteFilter,
    resetFilterRanges,
    chooseSort,
    flipSort,
    selectPath,
    setHoveredPathId,
    nextPath,
    prevPath,
    reverseCurrentPathProfile,
    showCombined,
    setCombinedTarget,
    chooseCombinedSet,
    favoritesOnly,
    showFavoritesOnly,
    keepListed,
    compare,
    compareGroupOf,
    startCompare,
    setCompareView,
    swapCompare,
    endCompare,
  } = usePathSets({ favorites });

  const { mode, setMode, pendingMarker, setMarkerPosition, placeMarker, clearPendingMarker } = useAppMode();
  const pendingMarkerRef = useRef(pendingMarker); // the pin now (server messages compare against it)
  pendingMarkerRef.current = pendingMarker;
  // The plan's choice in "Loops from here": { pin, id } (id null: a new set),
  // for that pin only (utils/pathSetGroups.chosenSet). It follows the pin when
  // the server snaps it onto the road.
  const [startChoice, setStartChoice] = useState(null);

  // Tools: null is pan.
  const [activeTool, setActiveTool] = useState(null);
  const [isExcludeMode, setIsExcludeMode] = useState(false);
  const [isElevationMinimized, setIsElevationMinimized] = useState(false);
  const draftingRef = useRef(null);
  const boundaryDraftingRef = useRef(null); // a shape being dragged in the boundary editor (Esc cancels it)
  const pendingGenerations = useRef([]);

  // ---- map display options ----
  const [viewOptions, setViewOptions] = useState(readViewOptions);
  const setViewOption = useCallback((key, value) => {
    setViewOptions((prev) => ({ ...prev, [key]: value }));
  }, []);
  const { showArrows, showCentroids, primaryColor, showPathPreview, pathPreviewOpacity, showGraphRoads, showSelections,
    showBoundary } = viewOptions;
  useEffect(() => {
    localStorage.setItem('viewOptions', JSON.stringify(viewOptions));
    localStorage.setItem('primaryColor', viewOptions.primaryColor);
  }, [viewOptions]);
  useEffect(() => {
    const root = document.documentElement;
    // Every colour token derives from these two hues (index.css), in the light and the dark theme.
    root.style.setProperty('--hue', String(primaryColor));
    root.style.setProperty('--fav-hue', String(favoriteHueOf(primaryColor)));
  }, [primaryColor]);

  // ---- settings, units ----
  const [genSettings, setGenSettings] = useState(readSettings);
  useEffect(() => {
    localStorage.setItem('generatorSettings', JSON.stringify(genSettings));
  }, [genSettings]);
  const [units, setUnitsState] = useState(readUnits);
  const setUnits = useCallback((value) => {
    setUnitsState(value);
    localStorage.setItem('units', value);
  }, []);

  // The server sends the real list (only Full loops unless it runs with LOOP_DEV=1).
  const [algorithms, setAlgorithms] = useState([DEFAULT_ALGORITHM_OPTION]);
  // The server runs with LOOP_DEV=1: dev tools (compare two generations) are shown.
  const [devMode, setDevMode] = useState(false);
  const pickAlgorithm = useCallback(
    (id) => (algorithms.some((item) => item.id === id) ? id : algorithms[0].id),
    [algorithms],
  );

  // Short map notice (pin snapped / rejected, batch notes). A new id re-shows the same text.
  const [notice, setNotice] = useState(null);
  const showNotice = useCallback((text) => {
    if (text) setNotice({ text, id: Date.now() });
  }, []);

  // ---- map areas ----
  // The server downloads map data and builds a search graph per start pin and
  // generation ("area"). pinArea follows the pin being placed (PREFETCH_AREA);
  // each generation's area comes with AREA_READY {pathSetId}.
  const [pinArea, setPinArea] = useState(null); // { lat, lng, status, done, total, mb, areaId, error }
  const [areaOfPathSet, setAreaOfPathSet] = useState({}); // pathSetId -> areaId
  const [genMapStatus, setGenMapStatus] = useState({}); // pathSetId -> { phase, done, total, mb }
  const [edgeSets, setEdgeSets] = useState({}); // areaId -> road lines
  const edgesRequested = useRef(new Set());
  const openRequested = useRef(new Set());

  // Offline basemap: which map tiles are downloaded (MAP_INFO) and their roads (TILE_ROADS).
  const [mapCoverage, setMapCoverage] = useState(null); // { deg, tiles }
  const [tileRoads, setTileRoads] = useState({}); // "row_col" -> lines
  const tilesRequested = useRef(new Set());

  // Area ids belong to one server run: forget them whenever the connection drops.
  const [connection, setConnection] = useState(0);
  useEffect(() => {
    if (wsStatus !== 'connected') return;
    setConnection((n) => n + 1);
    setAreaOfPathSet({});
    edgesRequested.current = new Set();
    openRequested.current = new Set();
    tilesRequested.current = new Set();
  }, [wsStatus]);

  const requestTileRoads = useCallback((tiles) => {
    const wanted = tiles.filter(([r, c]) => !tilesRequested.current.has(`${r}_${c}`));
    if (!wanted.length) return;
    if (sendMessage('GET_TILE_ROADS', { tiles: wanted })) {
      wanted.forEach(([r, c]) => tilesRequested.current.add(`${r}_${c}`));
    }
  }, [sendMessage]);

  const wantedAreaId = mode === 'display'
    ? (activePathSetId ? areaOfPathSet[activePathSetId] || null : null)
    : (pendingMarker && samePin(pinArea, pendingMarker) && pinArea?.status === 'ready' ? pinArea.areaId : null);
  const requestGraphEdges = useCallback(() => {
    if (!wantedAreaId || edgeSets[wantedAreaId] || edgesRequested.current.has(wantedAreaId)) return;
    if (sendMessage('GET_GRAPH_EDGES', { areaId: wantedAreaId })) edgesRequested.current.add(wantedAreaId);
  }, [wantedAreaId, edgeSets, sendMessage]);
  useEffect(() => {
    if (wsStatus === 'connected') requestGraphEdges();
  }, [wsStatus, requestGraphEdges]);
  const wantedLines = wantedAreaId ? edgeSets[wantedAreaId] : null;
  const roadIndex = useMemo(() => (wantedLines?.length ? buildRoadIndex(wantedLines) : null), [wantedLines]);

  // ---- generations ----
  const activeGeneration = generations.find((g) => g.id === activePathSetId) || null;
  const generatingPathSetId = Object.keys(pathSets).find((id) => !pathSets[id].isComplete) || null;
  const isGenerating = generatingPathSetId !== null;
  const generatingPathCount = isGenerating ? pathSets[generatingPathSetId].paths.length : 0;
  const activeIsGenerating = !!activePathSet && !activePathSet.isComplete;
  const canContinue = mode === 'display' && !!activeGeneration && activeGeneration.resumable;

  /** What the server needs to recreate a generation it no longer holds. */
  const rebuildFor = useCallback((id) => {
    const set = pathSets[id];
    if (!set?.markerPosition) return null;
    return {
      lat: set.markerPosition.lat,
      lng: set.markerPosition.lng,
      settings: requestSettings(set.settings || {}),
      centroids: set.paths.map((p) => p.properties?.centroid).filter(Boolean),
      batches: set.batches || 0,
    };
  }, [pathSets]);

  // An open generation whose area this server run has not sent yet (reload,
  // restart): ask for it, so roads can be painted and More routes is quick.
  useEffect(() => {
    if (wsStatus !== 'connected' || mode !== 'display' || !activePathSetId) return;
    if (areaOfPathSet[activePathSetId] || openRequested.current.has(activePathSetId)) return;
    if (activeIsGenerating) return; // its own messages bring the area
    if (isKeptId(activePathSetId)) return; // favorites from deleted sets: no area of their own
    const rebuild = rebuildFor(activePathSetId);
    if (sendMessage('OPEN_GENERATION', { pathSetId: activePathSetId, rebuild })) {
      openRequested.current.add(activePathSetId);
    }
  }, [wsStatus, mode, activePathSetId, areaOfPathSet, activeIsGenerating, rebuildFor, sendMessage, connection]);

  const handleStopGeneration = useCallback(() => {
    sendMessage('STOP_GENERATION', {});
  }, [sendMessage]);

  // The server can't send GENERATION_COMPLETE after the socket drops.
  useEffect(() => {
    if (wsStatus === 'connected') return;
    Object.keys(pathSets).forEach((id) => {
      if (!pathSets[id].isComplete) completePathSet(id);
    });
  }, [wsStatus, pathSets, completePathSet]);

  const clearGenStatus = useCallback((id) => {
    setGenMapStatus((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // ---- server messages ----
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      switch (message.type) {
        case 'PATHSET_CREATED':
          createPathSet(message.pathSetId, message.markerPosition, pendingGenerations.current.shift() || null);
          // A new set's routes are shown, not only its favorites (it has none yet).
          showFavoritesOnly(false);
          // The generation's pin takes the start pin's place.
          clearPendingMarker();
          setMode('display');
          break;

        case 'PATH_RECEIVED':
          addPathToSet(message.pathSetId, message.path);
          break;

        case 'GENERATION_COMPLETE':
          completePathSet(message.pathSetId, { resumable: message.resumable, note: message.note });
          clearGenStatus(message.pathSetId);
          if (message.note) showNotice(message.note);
          else if (message.added === 0 && !message.stopped) showNotice('No new routes found');
          break;

        case 'GENERATION_RESUMED':
          resumePathSet(message.pathSetId);
          break;

        // Pins snapped onto roads by the server; selections that hit no road are dropped.
        case 'CONSTRAINTS_RESOLVED':
          (message.results || []).forEach((result) => {
            if (result.ok) {
              const patch = { pending: false };
              if (result.lat != null && result.lng != null) {
                patch.lat = result.lat;
                patch.lng = result.lng;
              }
              updateSelection(result.id, patch);
            } else {
              removeSelection(result.id);
              showNotice(result.error || 'No road here');
            }
          });
          break;

        case 'GENERATION_ERROR':
          if (message.code === 'SESSION_EXPIRED' && message.pathSetId) expirePathSetSession(message.pathSetId);
          showNotice(message.error || 'Generation failed');
          break;

        case 'MAP_PROGRESS':
          if (message.pathSetId) {
            setGenMapStatus((prev) => ({
              ...prev,
              [message.pathSetId]: nextProgress(prev[message.pathSetId], message),
            }));
          } else if (message.scope === 'prefetch') {
            setPinArea((prev) => (forPinArea(prev, message) ? nextProgress(prev, message, { status: message.phase }) : prev));
          }
          break;

        case 'AREA_READY':
          if (message.pathSetId) {
            setAreaOfPathSet((prev) => ({ ...prev, [message.pathSetId]: message.areaId }));
            clearGenStatus(message.pathSetId);
          } else {
            // The start pin moves onto the start the server found (the nearest
            // road that loops can start from), so it shows where routes begin.
            // Asked again from there, the server answers from the same area.
            const { start } = message;
            const current = message.token == null || message.token === prefetchTokenRef.current;
            const snap = current && samePin(pendingMarkerRef.current, message) && start
              && Number.isFinite(start.lat) && Number.isFinite(start.lng) && !samePin(start, message);
            setPinArea((prev) => (forPinArea(prev, message)
              ? {
                ...prev,
                status: 'ready',
                areaId: message.areaId,
                error: null,
                ...(snap ? { lat: start.lat, lng: start.lng } : {}),
              }
              : prev));
            if (snap) {
              placeMarker({ lat: start.lat, lng: start.lng });
              // A set picked in "Loops from here" before the snap stays picked.
              setStartChoice((prev) => (prev && samePin(prev.pin, message)
                ? { ...prev, pin: { lat: start.lat, lng: start.lng } }
                : prev));
            }
          }
          break;

        case 'MAP_ERROR':
          setPinArea((prev) => (forPinArea(prev, message) ? { ...prev, status: 'error', error: message.error } : prev));
          break;

        case 'GRAPH_EDGES':
          if (!message.areaId || !(message.lines || []).length) break;
          setEdgeSets((prev) => {
            const kept = Object.keys(prev).filter((id) => id !== message.areaId).slice(-(EDGE_SETS_KEPT - 1));
            const next = {};
            kept.forEach((id) => { next[id] = prev[id]; });
            next[message.areaId] = message.lines;
            return next;
          });
          break;

        case 'ALGORITHMS_LIST':
          if (Array.isArray(message.algorithms) && message.algorithms.length > 0) setAlgorithms(message.algorithms);
          setDevMode(!!message.dev);
          break;

        case 'MAP_INFO':
          if (Array.isArray(message.coverage)) {
            setMapCoverage({ deg: message.tileDeg || 0.1, tiles: message.coverage });
          }
          break;

        case 'TILE_ROADS': {
          if (!Array.isArray(message.tile)) break;
          const key = `${message.tile[0]}_${message.tile[1]}`;
          setTileRoads((prev) => {
            const keys = Object.keys(prev).filter((k) => k !== key);
            const keep = keys.slice(-(TILE_ROADS_KEPT - 1));
            // Tiles dropped from the cache may be asked for again.
            keys.slice(0, keys.length - keep.length).forEach((k) => tilesRequested.current.delete(k));
            const next = {};
            keep.forEach((k) => { next[k] = prev[k]; });
            next[key] = message.lines || [];
            return next;
          });
          break;
        }

        default:
          console.log('[App] Unknown message type:', message.type);
      }
    });
    return unsubscribe;
  }, [subscribe, createPathSet, addPathToSet, completePathSet, resumePathSet, expirePathSetSession,
    updateSelection, removeSelection, showNotice, setMode, clearPendingMarker, placeMarker, clearGenStatus, showFavoritesOnly]);

  // ---- start pin ----
  // A start pin placed by hand (a click, a drag, a search) drops any earlier
  // choice in "Loops from here" (startChoice): Find loops makes a new set
  // unless one is picked for it. (The server snaps a pin onto the road, so a
  // pin placed by hand near a set's start can land on the very point an
  // earlier choice was made for.)
  const handleMapClick = useCallback((position) => {
    setStartChoice(null);
    setMarkerPosition(position);
  }, [setMarkerPosition]);

  // A short place name for the start pin: from the search result, else looked
  // up (Photon reverse geocoding) a moment after the pin stops moving.
  const [pinPlace, setPinPlace] = useState(null); // { lat, lng, name }
  const pinName = pendingMarker && samePin(pinPlace, pendingMarker) ? pinPlace.name : null;
  useEffect(() => {
    if (!pendingMarker || samePin(pinPlace, pendingMarker)) return undefined;
    const { lat, lng } = pendingMarker;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const name = await placeNameAt(lat, lng, controller.signal);
        setPinPlace({ lat, lng, name });
      } catch {
        // Offline or blocked: generations fall back to coordinates.
      }
    }, 700);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [pendingMarker, pinPlace]);

  // Placing or moving the start pin (or changing the max distance) downloads
  // that area's map in the background and builds its roads, so generating
  // can start at once. The server cancels queued downloads for an old pin.
  // With a custom boundary the area is the roads inside it; the request's
  // token (max and boundary) tells its answers from an earlier request's.
  const prefetchMax = Number(genSettings.max_path_len) || 0;
  const planBoundary = boundaryPayload(genSettings.boundary);
  const prefetchToken = `${prefetchMax}|${boundaryKey(genSettings.boundary) || 'auto'}`;
  const prefetchTokenRef = useRef(prefetchToken);
  prefetchTokenRef.current = prefetchToken;
  useEffect(() => {
    if (mode !== 'input' || !pendingMarker || wsStatus !== 'connected' || prefetchMax <= 0) return undefined;
    const { lat, lng } = pendingMarker;
    const timer = setTimeout(() => {
      setPinArea((prev) => (samePin(prev, pendingMarker) && prev.token === prefetchToken && prev.status !== 'error'
        ? prev
        : { lat, lng, max: prefetchMax, token: prefetchToken, status: 'checking' }));
      sendMessage('PREFETCH_AREA', { lat, lng, max_path_len: prefetchMax, boundary: planBoundary, token: prefetchToken });
    }, 400);
    return () => clearTimeout(timer);
    // planBoundary goes with its token
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pendingMarker, prefetchMax, prefetchToken, wsStatus, sendMessage, connection]);

  // Search result or "use my location": start from there.
  const handlePlaceSelected = useCallback((place) => {
    const position = { lat: place.lat, lng: place.lng };
    setActiveTool(null);
    selectPathSet(null);
    setMode('input');
    setStartChoice(null);
    placeMarker(position);
    if (place.name) setPinPlace({ ...position, name: place.name });
  }, [setMode, placeMarker, selectPathSet]);

  // Length and roads for the open generation's next batches (the More routes slider).
  const [moreSettings, setMoreSettings] = useState(null);

  const planSelections = drawnSelections;

  // Generations that start where the pin is: Find loops can add to one of
  // them instead of making another one. A new set unless one is picked in
  // "Loops from here" (or by "Plan again from here"), even when the pin was
  // placed by hand on their start. startChoice: { pin, id } (id null: a new set).
  const setsHere = useMemo(
    () => (mode === 'input' && pendingMarker ? setsAtStart(generations, pendingMarker).filter((g) => !g.kept) : []),
    [mode, pendingMarker, generations],
  );
  // Dev compare: the other generations from the open one's start, newest first.
  const compareCandidates = useMemo(
    () => (devMode && mode === 'display' && activeGeneration && (!combined || combined.chosenSetId)
      ? setsAtStart(generations, activeGeneration.markerPosition).filter((g) => g.id !== activeGeneration.id && !g.kept)
      : []),
    [devMode, mode, activeGeneration, generations, combined],
  );
  const compareProps = devMode && activeGeneration && !activeGeneration.kept && (!combined || combined.chosenSetId) ? {
    candidates: compareCandidates,
    compare,
    onStart: startCompare,
    onView: setCompareView,
    onSwap: swapCompare,
    onEnd: endCompare,
  } : null;
  const addToId = chosenSet(setsHere, startChoice, pendingMarker);
  const chooseStart = useCallback((id) => {
    if (pendingMarker) setStartChoice({ pin: pendingMarker, id });
  }, [pendingMarker]);

  // Find loops from the plan into an existing generation: it opens, takes the
  // plan's settings (length, roads, Advanced) and painted roads and areas,
  // and the server adds a first-sized batch to it (never repeating a route).
  const addToGeneration = useCallback((id) => {
    const set = pathSets[id];
    if (!set || !set.resumable) return false;
    const settings = { ...searchSettingsOf(genSettings), algorithm: pickAlgorithm(genSettings.algorithm) };
    const selections = [...(set.selections || []),
      ...planSelections.filter((sel) => !(set.selections || []).some((x) => x.id === sel.id))];
    const sent = sendMessage('CONTINUE_GENERATION', {
      pathSetId: id,
      selections: selectionsPayload(selections),
      num_paths: Math.max(1, Math.round(Number(settings.num_paths) || SETTING_DEFAULTS.num_paths)),
      algorithm: settings.algorithm,
      settings: requestSettings(settings),
      rebuild: rebuildFor(id), // its old settings: the server applies the new ones after
    });
    if (!sent) return false;
    setActiveTool(null);
    showFavoritesOnly(false); // (the new routes are shown, not only favorites)
    // At a start with other sets: all routes from there, this set's chip chosen (with its painted roads and the plan's).
    const at = set.markerPosition;
    if (at && Object.entries(pathSets).some(([other, x]) => other !== id && sameStart(x.markerPosition, at))) {
      showCombined(at, { chosenId: id });
      replaceSelections(selections);
    } else {
      selectPathSet(id, planSelections);
    }
    updatePathSetSettings(id, settings);
    setMoreSettings(null);
    clearPendingMarker();
    setMode('display');
    return true;
  }, [pathSets, genSettings, pickAlgorithm, planSelections, sendMessage, rebuildFor, selectPathSet, showCombined, replaceSelections,
    updatePathSetSettings, clearPendingMarker, setMode, showFavoritesOnly]);

  const startGeneration = useCallback(() => {
    if (mode !== 'input' || !pendingMarker) return;
    if (addToId && addToGeneration(addToId)) return;
    const algorithmId = pickAlgorithm(genSettings.algorithm);
    // Named after the place ("Dilworth, Charlotte"); another one from there gets " #2", " #3"...
    // At a start that has sets, its place is theirs (the oldest's name, without its number).
    const oldestHere = setsHere.length ? setsHere[setsHere.length - 1] : null;
    const place = (oldestHere ? oldestHere.name.replace(/\s+#?\d+$/, '') : null)
      || pinName || `${pendingMarker.lat.toFixed(3)}, ${pendingMarker.lng.toFixed(3)}`;
    const name = suggestGenerationName(place, pathSets);
    const settings = { ...searchSettingsOf(genSettings), algorithm: algorithmId };
    // Roads and areas painted before generating constrain the first search too.
    const sent = sendMessage('START_GENERATION', {
      lat: pendingMarker.lat,
      lng: pendingMarker.lng,
      ...requestSettings(settings),
      selections: selectionsPayload(planSelections),
    });
    if (!sent) return;
    pendingGenerations.current.push({ name, settings, selections: planSelections });
    localStorage.setItem('lastMapPosition', JSON.stringify({ center: [pendingMarker.lat, pendingMarker.lng], zoom: 13 }));
  }, [mode, pendingMarker, addToId, addToGeneration, genSettings, pathSets, sendMessage, planSelections,
    pickAlgorithm, pinName, setsHere]);

  // A generation under the pointer in "Your loops": its pin is highlighted.
  // Map moves asked for by the panel: centreOn { lat, lng, n } (a generation
  // opened from a list), showBounds { bounds, n } (a boundary chosen). n makes a repeat act.
  // A row (its set's id) or a start's header ([its sets' ids]) under the pointer in "Your loops".
  const [hoveredSetId, setHoveredSetId] = useState(null);
  // The map's view (MapView reports it when the map stops): Your loops lists the starts in it first.
  const [mapView, setMapView] = useState(null);
  // A pin under the pointer (or a set in its menu): { key (the pin), ids
  // (its sets) }, their routes previewed on the map and the other pins hidden.
  const [pinPreview, setPinPreview] = useState(null);
  // (next, fromKey): a pin's preview ends only if it is still that pin's.
  const handlePinPreview = useCallback((next, fromKey = null) => {
    setPinPreview((prev) => {
      if (next) return next;
      if (fromKey && prev && prev.key !== fromKey) return prev;
      return null;
    });
  }, []);
  const [centreOn, setCentreOn] = useState(null);
  const [showBounds, setShowBounds] = useState(null);
  const centreMapOn = useCallback((position) => {
    if (position) setCentreOn((prev) => ({ lat: position.lat, lng: position.lng, n: (prev?.n || 0) + 1 }));
  }, []);

  const toolRoadIndex = roadIndex;

  // ---- search boundaries ----
  // The plan uses the automatic area (every road within reach of the start)
  // or a saved custom boundary (genSettings.boundary, a copy; generations keep
  // the one they were made with in their settings). boundaryDraft: the one
  // being drawn or edited ({ id (null: new), name, shapes, tool }), shown as
  // its own page over the panel; the map draws it with handles.
  const { boundaries, saveBoundary, deleteBoundary } = useBoundaries();
  const [boundaryDraft, setBoundaryDraft] = useState(null);
  const editingBoundary = mode === 'input' && !!boundaryDraft;
  const showBoundaryOnMap = useCallback((boundary) => {
    const b = boundaryBounds(boundary);
    if (b) setShowBounds((prev) => ({ bounds: [[b.south, b.west], [b.north, b.east]], n: (prev?.n || 0) + 1 }));
  }, []);
  const chooseBoundary = useCallback((id) => {
    const chosen = id ? boundaries.find((b) => b.id === id) || null : null;
    setGenSettings((prev) => ({ ...prev, boundary: chosen }));
    if (chosen) showBoundaryOnMap(chosen);
  }, [boundaries, showBoundaryOnMap]);
  const newBoundary = useCallback(() => {
    setActiveTool(null);
    setBoundaryDraft({ id: null, name: '', shapes: [], tool: 'box' });
  }, []);
  const editBoundary = useCallback(() => {
    const b = genSettings.boundary;
    if (!b) return;
    setActiveTool(null);
    setBoundaryDraft({ id: b.id, name: b.name, shapes: cleanShapes(b.shapes), tool: null });
    showBoundaryOnMap(b);
  }, [genSettings.boundary, showBoundaryOnMap]);
  const boundaryEdit = useMemo(() => ({
    // A drawn shape joins the boundary (a freehand outline is simplified to a
    // few points to drag); the tool goes back to none, so its handles show.
    add: (selection) => {
      const [shape] = cleanShapes([selection.shape === 'freeform'
        ? { ...selection, coordinates: simplifyOutline(selection.coordinates) }
        : selection]);
      if (shape) setBoundaryDraft((d) => (d ? { ...d, shapes: [...d.shapes, shape], tool: null } : d));
    },
    change: (index, shape) => setBoundaryDraft((d) => (d
      ? { ...d, shapes: d.shapes.map((s, i) => (i === index ? shape : s)) }
      : d)),
    remove: (index) => setBoundaryDraft((d) => (d ? { ...d, shapes: d.shapes.filter((_, i) => i !== index) } : d)),
    setTool: (tool) => setBoundaryDraft((d) => (d ? { ...d, tool: d.tool === tool ? null : tool } : d)),
    setName: (name) => setBoundaryDraft((d) => (d ? { ...d, name } : d)),
  }), []);
  const saveBoundaryDraft = useCallback(() => {
    if (!boundaryDraft) return;
    const saved = saveBoundary(boundaryDraft);
    if (!saved) return;
    setGenSettings((prev) => ({ ...prev, boundary: saved }));
    setBoundaryDraft(null);
  }, [boundaryDraft, saveBoundary]);
  const cancelBoundaryDraft = useCallback(() => setBoundaryDraft(null), []);
  const deleteBoundaryDraft = useCallback(() => {
    if (!boundaryDraft?.id) return;
    deleteBoundary(boundaryDraft.id);
    setGenSettings((prev) => (prev.boundary?.id === boundaryDraft.id ? { ...prev, boundary: null } : prev));
    setBoundaryDraft(null);
  }, [boundaryDraft, deleteBoundary]);

  // ---- open generation ----
  // Open a generation. { routeKey } shows the route with that key
  // (utils/routeIdentity) when it has it. Favorites only stays as it is.
  // A set whose start has other sets opens as all routes from there with its
  // chip chosen (only its routes; the other sets one click away).
  const openGeneration = useCallback((id, options = {}) => {
    setActiveTool(null);
    setBoundaryDraft(null);
    setHoveredSetId(null);
    setPinPreview(null);
    const at = pathSets[id]?.markerPosition;
    const shared = at && Object.entries(pathSets).some(([other, set]) => other !== id && sameStart(set.markerPosition, at));
    if (shared) {
      showCombined(at, { chosenId: id, routeKey: options.routeKey });
      setMode('display');
      return;
    }
    selectPathSet(id);
    if (options.routeKey) {
      const route = (pathSets[id]?.paths || []).find((p) => routeKey(p) === options.routeKey);
      if (route) selectPath(route.id);
    }
    setMode('display');
  }, [selectPathSet, showCombined, pathSets, selectPath, setMode]);

  // The generation a listed route is from: the open one, or in all routes
  // from here the set it is listed as.
  const ownerOf = useCallback((path) => {
    const id = path && combined ? combined.ownerOf(path.id) : null;
    return (id && generations.find((g) => g.id === id)) || activeGeneration;
  }, [combined, generations, activeGeneration]);

  // Favorite (or unfavorite) a route of the open generation. In favorites
  // only, an unfavorited route stays listed until another one is selected.
  const toggleRouteFavorite = useCallback((path) => {
    if (!path) return;
    const owner = ownerOf(path);
    const source = owner ? { id: owner.id, name: owner.name, markerPosition: owner.markerPosition } : null;
    const now = toggleFavorite(path, source);
    if (now === false && favoritesOnly) keepListed(path.id);
  }, [ownerOf, toggleFavorite, favoritesOnly, keepListed]);
  // GPX download of a route (utils/gpx.js), named after its generation and,
  // in a generation's list, its place there.
  const exportGpx = useCallback((path, { setName = null, number = null } = {}) => {
    if (!path) return;
    if (!downloadRouteGpx(path, { setName, number, units })) showNotice('This route has no line to export.');
  }, [units, showNotice]);
  const exportRouteGpx = useCallback((path) => {
    const i = filteredPaths.findIndex((p) => p.id === path?.id);
    exportGpx(path, { setName: ownerOf(path)?.name, number: i >= 0 ? i + 1 : null });
  }, [exportGpx, filteredPaths, ownerOf]);
  const favoriteCount = useMemo(
    () => (allPaths || []).filter((p) => isFavorite(p)).length,
    [allPaths, isFavorite],
  );

  const openGenerationFromList = useCallback((id, options) => {
    openGeneration(id, options);
    centreMapOn(pathSets[id]?.markerPosition);
  }, [openGeneration, centreMapOn, pathSets]);

  // Bring the routes of these sets into view, when they are not (the map
  // never zooms in for them; MapFocus).
  const showSetsOnMap = useCallback((ids) => {
    let [s, w, n, e] = [90, 180, -90, -180];
    ids.forEach((id) => (pathSets[id]?.paths || []).forEach((p) => {
      (p.geometry?.coordinates || []).forEach(([lng, lat]) => {
        s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
      });
    }));
    if (s > n) return;
    setShowBounds((prev) => ({ bounds: [[s, w], [n, e]], n: (prev?.n || 0) + 1 }));
  }, [pathSets]);
  // A pin's set, opened by a click (a start with one set) or from its menu.
  const openFromPin = useCallback((id) => {
    openGeneration(id);
    showSetsOnMap([id]);
  }, [openGeneration, showSetsOnMap]);
  // "New set from here" in a pin's menu: the plan, with the start pin on that
  // start and New set chosen; the plan keeps its own settings, and nothing
  // is searched until Find loops.
  const newSetFromPin = useCallback((position) => {
    if (!position) return;
    const pin = { lat: position.lat, lng: position.lng };
    setActiveTool(null);
    setBoundaryDraft(null);
    setHoveredSetId(null);
    selectPathSet(null);
    setMode('input');
    placeMarker(pin);
    setStartChoice({ pin, id: null });
  }, [selectPathSet, setMode, placeMarker]);
  // All routes from here (a click on a pin of two or more sets, or "Show all
  // routes from here" in its menu): their routes as one list; More routes
  // adds to the newest (or the one chosen). options: { routeKey }.
  const openCombined = useCallback((position, options = {}) => {
    if (!position) return;
    setActiveTool(null);
    setBoundaryDraft(null);
    setHoveredSetId(null);
    setPinPreview(null);
    showCombined(position, options);
    setMode('display');
    showSetsOnMap(generations.filter((g) => sameStart(g.markerPosition, position)).map((g) => g.id));
  }, [showCombined, setMode, showSetsOnMap, generations]);
  // Your loops: a start's name opens all its sets (all routes from there; one set by itself).
  const openGroupFromList = useCallback((group) => {
    if (group.kept || group.sets.length === 1 || !group.position) {
      openGenerationFromList(group.sets[0].id);
      return;
    }
    openCombined(group.position);
    centreMapOn(group.position);
  }, [openGenerationFromList, openCombined, centreMapOn]);

  const closeGeneration = useCallback(() => {
    setActiveTool(null);
    selectPathSet(null);
    setMode('input');
  }, [selectPathSet, setMode]);

  // "Plan again from here": the plan takes the generation's start and
  // settings, with New set chosen (Find loops starts another generation);
  // the generation is listed under "Loops from here" to pick and add to.
  const newSearchFromGeneration = useCallback(() => {
    if (!activeGeneration) return;
    const s = activeGeneration.settings || {};
    setGenSettings((prev) => ({
      ...prev,
      ...Object.fromEntries(Object.entries(s).filter(([k]) => k in SETTING_DEFAULTS && !APP_ONLY_SETTINGS.includes(k))),
    }));
    const start = activeGeneration.markerPosition;
    closeGeneration();
    if (start) {
      const pin = { lat: start.lat, lng: start.lng };
      placeMarker(pin);
      setStartChoice({ pin, id: null });
    }
  }, [activeGeneration, closeGeneration, placeMarker]);

  // Delete with undo.
  const [undo, setUndo] = useState(null); // { removed, name }
  const undoTimer = useRef(null);
  // The kept set (favorites from deleted sets): Remove unfavorites them, for good, after asking.
  // A generation with favorites: they stay, in the kept set ("… favorites kept").
  const handleDeleteGeneration = useCallback((id) => {
    const set = pathSets[id];
    if (set?.kept) {
      const n = set.paths.length;
      const ok = window.confirm(n === 1
        ? 'Remove the favorite from deleted sets? It is unfavorited and cannot be brought back.'
        : `Remove all ${n} favorites from deleted sets? They are unfavorited and cannot be brought back.`);
      if (!ok) return;
      removeFavorites(set.paths);
      if (id === activePathSetId) {
        setActiveTool(null);
        selectPathSet(null);
        setMode('input');
      }
      return;
    }
    const name = set?.name;
    // Its favorites (saved with it) go to the kept set, "Favorites from deleted sets".
    const keptCount = [...favorites.values()].filter((r) => r.pathSetId === id).length;
    const removed = deletePathSet(id);
    if (!removed) return;
    // (in all routes from a start with other sets left, they stay listed)
    if (id === activePathSetId && !(combined && removed.stays)) {
      setActiveTool(null);
      selectPathSet(null);
      setMode('input');
    }
    clearTimeout(undoTimer.current);
    setUndo({ removed, name, keptCount });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  }, [pathSets, favorites, deletePathSet, removeFavorites, selectPathSet, activePathSetId, setMode, combined]);

  // The open set went away (a kept set's last favorite unfavorited): back to the plan.
  useEffect(() => {
    if (mode === 'display' && activePathSetId && !pathSets[activePathSetId] && !combined) {
      setActiveTool(null);
      selectPathSet(null);
      setMode('input');
    }
  }, [mode, activePathSetId, pathSets, combined, selectPathSet, setMode]);
  const handleUndoDelete = useCallback(() => {
    if (!undo) return;
    restorePathSet(undo.removed);
    clearTimeout(undoTimer.current);
    setUndo(null);
  }, [undo, restorePathSet]);
  useEffect(() => () => clearTimeout(undoTimer.current), []);

  // ---- more routes ----
  const moreFor = useCallback((id) => {
    const s = pathSets[id]?.settings || {};
    return {
      min_path_len: s.min_path_len ?? SETTING_DEFAULTS.min_path_len,
      max_path_len: s.max_path_len ?? SETTING_DEFAULTS.max_path_len,
      road_preference: s.road_preference || 'balanced',
      surface_preference: surfacePreference(s.surface_preference),
    };
  }, [pathSets]);
  const currentMore = moreSettings?.id === activePathSetId ? moreSettings.value : (activePathSetId ? moreFor(activePathSetId) : null);
  const setCurrentMore = useCallback((value) => {
    setMoreSettings({ id: activePathSetId, value });
  }, [activePathSetId]);

  // More routes for the open generation: through every include selection
  // (pins, green roads, areas), avoiding every red road, with the More
  // routes length / roads. Routes already in the generation never repeat.
  const requestMoreRoutes = useCallback((selections, more = currentMore) => {
    if (!canContinue || !activePathSetId) return false;
    const set = pathSets[activePathSetId];
    const settings = { ...(set?.settings || {}), ...(more || {}) };
    const sent = sendMessage('CONTINUE_GENERATION', {
      pathSetId: activePathSetId,
      selections: selectionsPayload(selections),
      num_paths: Math.max(1, Math.round(Number(settings.routes_per_pin ?? genSettings.routes_per_pin)
        || SETTING_DEFAULTS.routes_per_pin)),
      algorithm: pickAlgorithm(settings.more_algorithm || settings.algorithm),
      settings: requestSettings(settings),
      rebuild: rebuildFor(activePathSetId),
    });
    if (sent && more) updatePathSetSettings(activePathSetId, more);
    return sent;
  }, [canContinue, activePathSetId, pathSets, sendMessage, genSettings.routes_per_pin, pickAlgorithm,
    rebuildFor, updatePathSetSettings, currentMore]);

  const handleMoreRoutes = useCallback((more) => {
    if (!canContinue || activeIsGenerating) return;
    if (more) setCurrentMore(more);
    requestMoreRoutes(drawnSelections, more || currentMore);
  }, [canContinue, activeIsGenerating, requestMoreRoutes, drawnSelections, currentMore, setCurrentMore]);

  // Advanced "Find more routes when I add a road or area to include" (off by
  // default): a new include on an open generation then asks for routes at
  // once. Off, it only filters the routes there are; More routes (M) asks.
  const autoMoreRoutes = genSettings.auto_more_routes === true;

  const handleSelection = useCallback((selection) => {
    addDrawnSelection(selection);
    setActiveTool(null);
    // An include area on an open generation (with the option on) also asks
    // for routes through it (and through every earlier include, avoiding every exclude).
    if (canContinue && autoMoreRoutes && selection.type === 'include') requestMoreRoutes([...drawnSelections, selection]);
  }, [addDrawnSelection, canContinue, autoMoreRoutes, requestMoreRoutes, drawnSelections]);

  // Road tool: paint edges (or a whole road) green / red. Green on an open
  // generation asks for routes through it when the option is on (else it
  // only filters, like red).
  const handleToggleEdges = useCallback((edges, options) => {
    toggleEdges(edges, options);
    if (!canContinue) return;
    const next = applyPaint(drawnSelections, edges, options);
    const greenCount = (list) => list.filter((s) => s.shape === 'edges' && s.type === 'include').length;
    if (options.type === 'include' && greenCount(next) > greenCount(drawnSelections)) {
      if (autoMoreRoutes) requestMoreRoutes(next);
    } else if (activeIsGenerating && next.length < drawnSelections.length) {
      handleStopGeneration(); // a constraint came off; the batch was built for it
    }
  }, [toggleEdges, canContinue, autoMoreRoutes, drawnSelections, requestMoreRoutes, activeIsGenerating,
    handleStopGeneration]);

  // A drawn excluded area: its roads turn red (only filters, like red roads).
  // Like an include area, drawing one is a single gesture: back to pan after.
  const handleExcludeArea = useCallback((edges, outline) => {
    handleToggleEdges(edges, { type: 'exclude', kind: 'area', label: 'area', outline });
    setActiveTool(null);
  }, [handleToggleEdges]);

  // Removing a constraint stops a batch that was built to cross it.
  const handleRemoveSelection = useCallback((id) => {
    removeSelection(id);
    if (canContinue && activeIsGenerating) handleStopGeneration();
  }, [removeSelection, canContinue, activeIsGenerating, handleStopGeneration]);

  const handleUndoSelection = useCallback(() => {
    undoLastSelection();
    if (canContinue && activeIsGenerating && drawnSelections.length > 0) handleStopGeneration();
  }, [undoLastSelection, canContinue, activeIsGenerating, drawnSelections.length, handleStopGeneration]);

  // ---- back / forward through the routes viewed ([ and ]) ----
  // The route view: a new history each time a generation opens. Hidden routes
  // (filters, painted roads, favorites only) are skipped.
  const stepRouteHistory = useRouteHistory(
    mode === 'display' ? currentPath?.id ?? null : null,
    mode === 'display' ? combined?.key ?? activePathSetId : null,
  );

  // ---- keyboard ----
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = e.target?.tagName;
      // Enter on a closed dropdown with focus would open it again (the
      // browser's default): it acts like Enter anywhere else instead (in
      // the plan it starts the generation; in the route view it does nothing).
      // An open dropdown takes its own keys, so picking with Enter still works.
      if (e.key === 'Enter' && tag === 'SELECT') e.preventDefault();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) {
        if (!(e.key === 'Enter' && (tag === 'INPUT' || tag === 'SELECT'))) return;
      }
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      // [ back, ] forward through the routes viewed. Ctrl+Alt is AltGr, which
      // types the brackets on some keyboards; Cmd / Ctrl + [ stay the browser's.
      const historyDir = !e.metaKey && !(e.ctrlKey && !e.altKey)
        ? { '[': -1, ']': 1 }[e.key] || 0
        : 0;

      // The boundary editor: Enter uses it, Esc cancels a shape being dragged,
      // else the editor; C / B / F add a shape, K stops adding, Z removes the last.
      if (editingBoundary) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveBoundaryDraft();
        } else if (e.key === 'Escape') {
          if (!boundaryDraftingRef.current?.()) cancelBoundaryDraft();
        } else if (plain && tag !== 'INPUT') {
          const tool = { c: 'circle', b: 'box', f: 'freeform' }[e.key.toLowerCase()];
          if (tool) boundaryEdit.setTool(tool);
          if (e.key === 'k' || e.key === 'K') setBoundaryDraft((d) => (d ? { ...d, tool: null } : d));
          if ((e.key === 'z' || e.key === 'Z') && boundaryDraft?.shapes.length) {
            boundaryEdit.remove(boundaryDraft.shapes.length - 1);
          }
        }
        return;
      }

      if (e.key === 'Enter' && mode === 'input') startGeneration();
      // V: Favorites only on / off (the pins, Your loops and the lists), anywhere.
      if (plain && !e.shiftKey && (e.key === 'v' || e.key === 'V')) showFavoritesOnly(!favoritesOnly);

      if (mode === 'display') {
        if (e.key === 'Escape') {
          if (draftingRef.current?.()) return;
          if (activeTool) {
            setActiveTool(null);
            return;
          }
          // Esc steps back: a search stops first, then the set (or start) closes.
          if (isGenerating) handleStopGeneration();
          else closeGeneration();
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          closeGeneration();
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          nextPath();
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          prevPath();
        }
        if (historyDir) {
          e.preventDefault();
          stepRouteHistory(historyDir, (id) => filteredPaths.some((p) => p.id === id), selectPath);
        }
        if (plain && (e.key === 'e' || e.key === 'E')) setIsElevationMinimized((prev) => !prev);
        if (plain && (e.key === 'm' || e.key === 'M')) handleMoreRoutes();
        if (plain && (e.key === 's' || e.key === 'S')) toggleRouteFavorite(currentPath);
      }

      // Tools: in the route view, and before generating (Plan card, Advanced).
      if (plain) {
        // Esc while planning: a shape being drawn, else the tool, else the start pin goes.
        if (mode === 'input' && e.key === 'Escape') {
          if (draftingRef.current?.()) return;
          if (activeTool) setActiveTool(null);
          else if (pendingMarker) {
            clearPendingMarker();
            setStartChoice(null);
          }
        }
        const toolKeys = { c: 'circle', b: 'box', f: 'freeform', r: 'road' };
        const tool = toolKeys[e.key.toLowerCase()];
        if (tool) setActiveTool(activeTool === tool ? null : tool);
        if (e.key === 'k' || e.key === 'K') setActiveTool(null);
        if (e.key === 'z' || e.key === 'Z') handleUndoSelection();
        if (e.key === 'd' || e.key === 'D') setIsExcludeMode((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, startGeneration, closeGeneration, handleUndoSelection, handleMoreRoutes, nextPath, prevPath,
    activeTool, isGenerating, handleStopGeneration, toggleRouteFavorite, currentPath, editingBoundary, boundaryDraft, boundaryEdit, saveBoundaryDraft,
    cancelBoundaryDraft, stepRouteHistory, filteredPaths, selectPath, pendingMarker, clearPendingMarker,
    favoritesOnly, showFavoritesOnly]);

  const toolsProps = {
    activeTool,
    setActiveTool,
    isExcludeMode,
    setIsExcludeMode,
    onUndo: handleUndoSelection,
    roadIndexReady: !!toolRoadIndex,
    drawnSelections,
    onClearSelections: clearDrawnSelections,
    selectionsHidden: !showSelections && !activeTool,
  };

  const activeStatus = activePathSetId ? mapProgressText(genMapStatus[activePathSetId]) : null;

  // Dev server (or a VITE_EXPOSE_STATE build) only: state the browser checks and the UI benchmark read (utils/devHooks).
  useEffect(() => {
    if (!EXPOSE_STATE) return;
    window.__routeKey = routeKey;
    window.__pathSets = pathSets; // every generation's routes (the checks compare all routes from here with them)
    window.__loopState = {
      mode,
      pendingMarker,
      activeTool,
      isExcludeMode,
      selections: drawnSelections,
      currentPath,
      paths: filteredPaths,
      totalCount: totalPathsCount,
      isGenerating,
      sortBy,
      sortAscending,
      hoveredPathId,
      activePathSetId,
      combinedKey: combined?.key ?? null, // all routes from here
      combinedSets: combined?.setIds || [],
      favoritesOnly,
      favoriteCount: favorites.size,
      favoriteKeys: [...favorites.keys()],
      roadToolReady: !!toolRoadIndex,
      boundary: genSettings.boundary,
      boundaryDraft,
      boundaries,
      setBoundary: activePathSet?.settings?.boundary || null,
      currentFavorite: !!currentPath && isFavorite(currentPath),
      generations: generations.map(({ id, name, pathCount, markerPosition }) => ({ id, name, pathCount, markerPosition })),
      mapCoverage, // { deg, tiles }: the downloaded map tiles (MAP_INFO)
    };
  }, [mode, pendingMarker, activeTool, isExcludeMode, drawnSelections, currentPath, filteredPaths, totalPathsCount,
    isGenerating, sortBy, sortAscending, hoveredPathId, activePathSetId, generations, favoritesOnly, favorites,
    isFavorite, toolRoadIndex, genSettings.boundary, boundaryDraft,
    boundaries, activePathSet, mapCoverage, combined, pathSets]);

  // The automatic search area drawn on the map (grey dotted, like a custom
  // boundary): the plan's, around the start pin and following the length
  // slider, or an open generation's, around its pin and following the More
  // routes length (what the next search will cover). A custom boundary
  // replaces it, and so does the boundary editor; an open generation shows it
  // only while the Search boundary option is on.
  const reachArea = useMemo(() => automaticArea(mode, {
    marker: pendingMarker,
    miles: genSettings.max_path_len,
    boundary: genSettings.boundary,
    editing: editingBoundary,
  }, {
    start: activePathSet?.markerPosition,
    miles: currentMore?.max_path_len ?? activePathSet?.settings?.max_path_len,
    boundary: activePathSet?.settings?.boundary,
    show: showBoundary,
  }), [mode, editingBoundary, genSettings.boundary, genSettings.max_path_len,
    pendingMarker, showBoundary, activePathSet, currentMore]);

  // The route view's panel: the open generation, or all routes from here
  // (its own id, so choosing the set More routes adds to keeps the panel).
  // With a set's chip chosen, the panel's header is that set's (name, settings, rename, delete).
  const panelGeneration = useMemo(() => {
    if (!activeGeneration || !combined) return activeGeneration;
    const chosen = combined.chosenSetId ? generations.find((g) => g.id === combined.chosenSetId) : null;
    if (chosen) return { ...chosen, id: combined.key };
    const n = combined.chosenSetIds.length;
    return { ...activeGeneration, id: combined.key, name: n > 1 ? `${n} sets from here` : 'All routes from here' };
  }, [activeGeneration, combined, generations]);
  // A set chip under the pointer (all routes from here): the map shows only that set's routes.
  const [chipHoverId, setChipHoverId] = useState(null);
  useEffect(() => { setChipHoverId(null); }, [combined?.key]);
  // (every route of that set, whichever chip is chosen; with Favorites only, its favorites)
  // (All under the pointer: every route from the start)
  const mapPaths = useMemo(() => (combined && chipHoverId
    ? allPaths.filter((p) => (chipHoverId === ALL_SETS || combined.has(p.id, chipHoverId))
      && (!favoritesOnly || favorites.has(routeKey(p))))
    : filteredPaths), [combined, chipHoverId, allPaths, filteredPaths, favoritesOnly, favorites]);
  const mapCurrentPath = mapPaths === filteredPaths || mapPaths.some((p) => p.id === currentPath?.id) ? currentPath : null;
  const combinedProps = useMemo(() => {
    if (!combined) return null;
    const byId = new Map(generations.map((g) => [g.id, g]));
    const found = combined.setIds.map((id) => byId.get(id)).filter(Boolean); // newest first
    const sets = [...found.filter((g) => !g.kept), ...found.filter((g) => g.kept)]; // (a kept set last)
    return {
      sets,
      // The set chips: All, then each set (Favorites only: each set with favorites).
      chips: favoritesOnly ? sets.filter((g) => g.favoriteCount > 0) : sets,
      chosenId: combined.chosenSetId, // the one chosen, when only one is
      chosenIds: combined.chosenSetIds, // every chosen one ([]: All)
      onChoose: chooseCombinedSet, // (id | null, add: Ctrl-click)
      onHoverChip: setChipHoverId,
      targetId: activePathSetId, // More routes adds to this one
      onTarget: setCombinedTarget,
      // The set a route is listed as, and the others that found it too (names).
      // (with a set's chip chosen, that set first when it found the route too)
      setOf: (path) => {
        let ownerId = combined.ownerOf(path.id);
        let also = combined.alsoIn(path.id);
        const chosen = combined.chosenSetIds.includes(ownerId) ? null : combined.chosenSetIds.find((id) => also.includes(id));
        if (chosen) {
          also = [ownerId, ...also.filter((id) => id !== chosen)];
          ownerId = chosen;
        }
        const owner = byId.get(ownerId);
        if (!owner) return null;
        return { id: owner.id, name: owner.name, also: also.map((id) => byId.get(id)?.name).filter(Boolean) };
      },
      // Its set by itself, showing the same route.
      // Its set's chip chosen (only that set's routes), on the same route.
      onOpenSet: (path) => {
        const id = combined.ownerOf(path.id);
        if (id) chooseCombinedSet(id);
      },
    };
  }, [combined, generations, activePathSetId, setCombinedTarget, chooseCombinedSet, favoritesOnly]);

  // The routes a pin under the pointer previews (or a set in its menu, or a
  // set's row in "Your loops"): its sets' routes, a route two of them found
  // once; with Favorites only, just the favorites. Only while planning.
  const previewIds = mode === 'input' && !editingBoundary
    ? (pinPreview?.ids || (hoveredSetId ? [].concat(hoveredSetId) : null))
    : null;
  const previewIdsKey = previewIds ? previewIds.join('|') : '';
  const previewPaths = useMemo(() => {
    if (!previewIdsKey) return null;
    const seen = new Set();
    const out = [];
    previewIdsKey.split('|').forEach((id) => (pathSets[id]?.paths || []).forEach((p) => {
      const key = routeKey(p) || p.id;
      if (seen.has(key) || (favoritesOnly && !favorites.has(key))) return;
      seen.add(key);
      out.push(p);
    }));
    return out;
  }, [previewIdsKey, pathSets, favoritesOnly, favorites]);

  const isFavoriteKey = useCallback((key) => favorites.has(key), [favorites]);

  // The elevation chart: the open generation's route.
  const shownRoute = mode === 'display' ? currentPath : null;
  const shownProfile = shownRoute?.properties?.elevation_profile;

  return (
    <UnitsContext.Provider value={units}>
      <div className="app">
        <MapView
          mode={mode}
          activeTool={activeTool}
          wsStatus={wsStatus}
          pendingMarker={pendingMarker}
          pathSetMarkers={pathSetMarkers}
          activePathSetId={activePathSetId}
          currentPath={mapCurrentPath}
          filteredPaths={mapPaths}
          drawnSelections={drawnSelections}
          onMapClick={handleMapClick}
          onPinMove={handleMapClick}
          onPlaceSelected={handlePlaceSelected}
          mapCoverage={mapCoverage}
          tileRoads={tileRoads}
          onNeedTileRoads={requestTileRoads}
          onMarkerClick={openFromPin}
          onNewSetAt={newSetFromPin}
          onShowAllAt={openCombined}
          onSelection={handleSelection}
          onExcludeArea={handleExcludeArea}
          onRemoveSelection={handleRemoveSelection}
          draftingRef={draftingRef}
          notice={notice}
          roadIndex={toolRoadIndex}
          onNeedGraphEdges={requestGraphEdges}
          showGraphRoads={showGraphRoads}
          showSelections={showSelections}
          onToggleEdges={handleToggleEdges}
          showArrows={showArrows}
          showCentroids={showCentroids}
          primaryColor={primaryColor}
          showPathPreview={showPathPreview}
          pathPreviewOpacity={pathPreviewOpacity}
          isGenerating={isGenerating}
          generatingPathCount={generatingPathCount}
          generatingStatus={generatingPathSetId ? mapProgressText(genMapStatus[generatingPathSetId]) : null}
          onStopGeneration={handleStopGeneration}
          reachMiles={Number(genSettings.max_path_len) || null}
          reachArea={reachArea}
          isExcludeMode={isExcludeMode}
          hoveredPathId={hoveredPathId}
          compareGroupOf={compare ? compareGroupOf : null}
          onSelectPath={selectPath}
          hoveredSetId={mode === 'input' && hoveredSetId ? [].concat(hoveredSetId)[0] : null}
          onViewChange={setMapView}
          strongPreview={!!chipHoverId}
          previewSetIds={previewIds}
          favoritesOnly={favoritesOnly}
          pinPreviewKey={pinPreview?.key ?? null}
          onPinPreview={handlePinPreview}
          previewPaths={previewPaths}
          isFavoriteKey={isFavoriteKey}
          centreOn={centreOn}
          showBounds={showBounds}
          boundaryShapes={mode === 'input'
            ? genSettings.boundary?.shapes || null
            : (showBoundary ? activePathSet?.settings?.boundary?.shapes || null : null)}
          boundaryEdit={editingBoundary ? {
            shapes: boundaryDraft.shapes,
            tool: boundaryDraft.tool,
            add: boundaryEdit.add,
            change: boundaryEdit.change,
            draftingRef: boundaryDraftingRef,
          } : null}
          isFavorite={isFavorite}
          favoriteHue={favoriteHueOf(primaryColor)}
          addingToName={addToId ? setsHere.find((g) => g.id === addToId)?.name || null : null}
          arrowKeysStepRoutes={mode === 'display'}
        />

        <ControlPanel
          mode={mode}
          genSettings={genSettings}
          setGenSettings={setGenSettings}
          units={units}
          setUnits={setUnits}
          pinArea={pendingMarker && samePin(pinArea, pendingMarker) ? pinArea : null}
          pinName={pinName}
          hasStart={!!pendingMarker}
          onGenerate={startGeneration}
          algorithms={algorithms}
          toolsProps={toolsProps}
          generations={generations}
          onOpenGeneration={openGenerationFromList}
          onOpenGroup={openGroupFromList}
          onDeleteGeneration={handleDeleteGeneration}
          activeGeneration={panelGeneration}
          generationProps={{
            paths: filteredPaths,
            totalCount: totalPathsCount,
            chosenTotal,
            currentPath,
            onSelectPath: selectPath,
            onHoverPath: setHoveredPathId,
            onPrev: prevPath,
            onNext: nextPath,
            sortBy,
            sortAscending,
            onSort: chooseSort,
            onFlipSort: flipSort,
            routeFilters,
            filterBounds,
            setFilterRange,
            addRouteFilter,
            removeRouteFilter,
            onClearFilters: resetFilterRanges,
            isGenerating: activeIsGenerating,
            statusText: activeStatus,
            onStop: handleStopGeneration,
            onBack: closeGeneration,
            onRename: (name) => renamePathSet(activePathSetId, name),
            onDelete: () => handleDeleteGeneration(combined?.chosenSetId || activePathSetId),
            onNewSearchHere: newSearchFromGeneration,
            more: currentMore,
            onMoreChange: setCurrentMore,
            onMoreRoutes: handleMoreRoutes,
            isFavorite,
            onToggleFavorite: toggleRouteFavorite,
            onDownloadGpx: exportRouteGpx,
            favoritesOnly,
            onFavoritesOnly: showFavoritesOnly,
            favoriteCount,
            compareProps,
            compareGroupOf: compare ? compareGroupOf : null,
            combined: combinedProps,
          }}
          viewOptions={viewOptions}
          setViewOption={setViewOption}
          setsHere={setsHere}
          addToId={addToId}
          onChooseStart={chooseStart}
          onRenameGeneration={renamePathSet}
          onHoverGeneration={setHoveredSetId}
          mapView={mapView}
          boundaryProps={{
            boundaries,
            selected: genSettings.boundary,
            onChoose: chooseBoundary,
            onNew: newBoundary,
            onEdit: editBoundary,
            // The pin outside the boundary: the start moves to its nearest road inside.
            pinOutside: !!pendingMarker && !!genSettings.boundary
              && !boundaryContains(genSettings.boundary, pendingMarker.lat, pendingMarker.lng),
          }}
          boundaryEditor={editingBoundary ? {
            draft: boundaryDraft,
            ...boundaryEdit,
            onSave: saveBoundaryDraft,
            onCancel: cancelBoundaryDraft,
            onDelete: boundaryDraft.id ? deleteBoundaryDraft : null,
          } : null}
          favoriteCount={favorites.size}
          favoritesOnly={favoritesOnly}
          onFavoritesOnly={showFavoritesOnly}
        />

        {undo && (
          <div className="undo-toast" role="status">
            <span>
              Deleted “{undo.name}”.
              {undo.keptCount > 0 && ` ${undo.keptCount === 1 ? 'Its favorite is' : `Its ${undo.keptCount} favorites are`} kept in “Favorites from deleted sets”.`}
            </span>
            <button type="button" onClick={handleUndoDelete}>Undo</button>
          </div>
        )}

        {shownProfile?.length > 1 && (
          <>
            {isElevationMinimized && (
              <button className="elevation-toggle-btn" onClick={() => setIsElevationMinimized(false)}>
                <Activity size={16} />
                Elevation
              </button>
            )}
            {!isElevationMinimized && (
              <ElevationProfileWindow
                elevationProfile={shownProfile}
                unpaved={shownRoute?.properties?.unpaved}
                onClose={() => setIsElevationMinimized(true)}
                onFlipPath={mode === 'display' ? reverseCurrentPathProfile : undefined}
              />
            )}
          </>
        )}
      </div>
    </UnitsContext.Provider>
  );
}

export default App;
