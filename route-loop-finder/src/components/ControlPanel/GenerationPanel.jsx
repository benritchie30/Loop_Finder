import { useCallback, useRef, useState } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronLeft, ChevronRight, ChevronUp, Download, MoreHorizontal, Plus, Star, Trash2 } from 'lucide-react';
import DualRange from './DualRange';
import RangeFilter from './RangeFilter';
import RouteCard from './RouteCard';
import ToolsBar from './ToolsBar';
import { FILTER_METRICS, getFilterMetric } from '../../utils/pathFiltering';
import { PINNED_FILTERS, SORT_OPTIONS } from '../../hooks/usePathSets';
import { ROAD_PREFERENCES } from '../../utils/roadWeights';
import { SURFACE_PREFERENCES, surfacePreference } from '../../utils/surface';
import { roadsLabel, settingsRows } from '../../utils/generationSettings';
import ComparePanel from './ComparePanel';
import { useCardList } from '../../hooks/useCardList';
import {
    displayToMiles,
    distanceUnit,
    lengthSliderRange,
    roundLength,
    useUnits,
} from '../../utils/units';
import './GenerationPanel.css';

function roadsShort(preference) {
    if (preference === 'custom') return 'Custom';
    return ROAD_PREFERENCES.find((x) => x.id === (preference || 'balanced'))?.label || 'Balanced';
}

/** Which way the list runs, in words, for the direction button. */
function directionLabel(sortBy, ascending) {
    if (sortBy === 'found') return ascending ? 'Best first' : 'Best last';
    if (sortBy === 'similar') return ascending ? 'From the shortest' : 'From the longest';
    return ascending ? 'Low to high' : 'High to low';
}

/**
 * An open generation. Top to bottom: header; route through / avoid tools;
 * sort and filters; the route cards (their own scroll area, the selected card
 * kept in the middle, arrows above); More routes at the bottom.
 */
function GenerationPanel({
    generation,
    paths,
    totalCount,
    currentPath,
    onSelectPath,
    onHoverPath,
    onPrev,
    onNext,
    sortBy,
    sortAscending,
    onSort,
    onFlipSort,
    routeFilters,
    filterBounds,
    setFilterRange,
    addRouteFilter,
    removeRouteFilter,
    onClearFilters,
    isGenerating,
    statusText,
    onStop,
    onBack,
    onRename,
    onDelete,
    onNewSearchHere,
    more,
    onMoreChange,
    onMoreRoutes,
    toolsProps,
    headerActions = null,
    isFavorite = null, // (route) => boolean
    onToggleFavorite, // (route)
    onDownloadGpx, // (route): save it as a GPX file
    favoritesOnly = false,
    onFavoritesOnly, // (on)
    favoriteCount = 0, // favorite routes in this generation
    compareProps = null, // dev (LOOP_DEV=1): { candidates, compare, onStart, onView, onSwap, onEnd }
    compareGroupOf = null, // (route) => 'a' | 'b' | 'shared' | null, comparing
    // All routes from here: { sets (newest first), targetId, onTarget(id), setOf(route), onOpenSet(route) }.
    // No rename, delete or settings used; each card names its set (a click opens it by itself);
    // More routes adds to the set chosen in its options.
    combined = null,
}) {
    const units = useUnits();
    const settings = generation.settings || {};
    const unit = distanceUnit(units);
    const [sliderMin, sliderMax] = lengthSliderRange(units);

    // More routes: length and roads for the next batches (App keeps them, so M uses them too).
    const setMore = (update) => onMoreChange(update(more));
    const low = roundLength(more.min_path_len, units);
    const high = roundLength(more.max_path_len, units);
    const [moreOpen, setMoreOpen] = useState(false);

    const [menuOpen, setMenuOpen] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [editing, setEditing] = useState(false);
    const [draftName, setDraftName] = useState(generation.name);

    // The cards' list (hooks/useCardList): the selected card kept in view, a
    // card under the pointer previewed on the map, one card per wheel notch.
    // The cards' handlers keep one identity, so a card renders again only when
    // something it shows changes: a new route streaming in leaves the others alone.
    const currentId = currentPath?.id;
    const { listRef, selectedRef, selectCard, hoverCard, leaveList } = useCardList({
        paths, currentId, onSelectPath, onHoverPath, orderKey: `${sortBy}|${sortAscending}`,
    });
    const cardActions = useRef({});
    cardActions.current = { onToggleFavorite, onDownloadGpx, onOpenSet: combined?.onOpenSet };
    const toggleFavoriteCard = useCallback((path) => cardActions.current.onToggleFavorite?.(path), []);
    const downloadGpxCard = useCallback((path) => cardActions.current.onDownloadGpx?.(path), []);
    const openSetCard = useCallback((path) => cardActions.current.onOpenSet?.(path), []);
    const target = combined ? combined.sets.find((s) => s.id === combined.targetId) || null : null;

    const activeKeys = new Set(routeFilters.map((f) => f.key));
    const addable = FILTER_METRICS.filter((m) => !activeKeys.has(m.key));
    const filtersOn = routeFilters.some((f) => f.range[0] != null || f.range[1] != null);
    const selectionCount = toolsProps.drawnSelections.length;
    const index = currentPath ? paths.findIndex((p) => p.id === currentPath.id) : -1;
    const currentFav = !!currentPath && !!isFavorite && isFavorite(currentPath);

    const commitName = () => {
        setEditing(false);
        if (draftName.trim() && draftName.trim() !== generation.name) onRename(draftName);
        else setDraftName(generation.name);
    };

    const compare = compareProps?.compare || null;
    let empty = null;
    if (paths.length === 0) {
        if (compare && compare.view !== 'all' && compare.counts.all > 0) {
            const label = { a: 'only in A', b: 'only in B', shared: 'in both A and B' }[compare.view];
            empty = (
                <div className="gen-empty">
                    <span>No routes {label}{compare.counts.all !== compare.totals.all ? ' match your filters' : ''}.</span>
                    <button type="button" className="link-btn" onClick={() => compareProps.onView('all')}>Show all</button>
                </div>
            );
        } else if (favoritesOnly) {
            empty = (
                <div className="gen-empty">
                    <span>
                        {favoriteCount > 0
                            ? 'None of the favorites match your filters.'
                            : 'No favorites here yet. Press S or a card\'s star to add the route you are on.'}
                    </span>
                    <button type="button" className="link-btn" onClick={() => onFavoritesOnly?.(false)}>Show every route</button>
                </div>
            );
        } else if (totalCount > 0) {
            empty = (
                <div className="gen-empty">
                    <span>
                        No routes match your filters
                        {selectionCount > 0 ? ' and painted roads and areas' : ''}.
                    </span>
                    {filtersOn && (
                        <button type="button" className="link-btn" onClick={onClearFilters}>Clear filters</button>
                    )}
                    {selectionCount > 0 && !isGenerating && (
                        <button type="button" className="link-btn" onClick={() => onMoreRoutes(more)}>Find more routes that fit (M)</button>
                    )}
                </div>
            );
        } else if (isGenerating) {
            empty = <div className="gen-empty">{statusText || 'Finding routes…'}</div>;
        } else {
            empty = <div className="gen-empty">{generation.lastNote || 'No routes in this generation.'}</div>;
        }
    }

    return (
        <div className="gen-panel">
            <div className="gen-panel__header">
                <button type="button" className="icon-btn" onClick={onBack} title="Back to your loops (Backspace)" aria-label="Back">
                    <ChevronLeft size={18} />
                </button>
                <div className="gen-panel__title">
                    {editing ? (
                        <input
                            className="gen-panel__name-input"
                            value={draftName}
                            autoFocus
                            onChange={(e) => setDraftName(e.target.value)}
                            onBlur={commitName}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') commitName();
                                if (e.key === 'Escape') {
                                    setDraftName(generation.name);
                                    setEditing(false);
                                }
                            }}
                            aria-label="Generation name"
                        />
                    ) : combined ? (
                        <span className="gen-panel__name gen-panel__name--fixed" title={combined.sets.map((s) => s.name).join(', ')}>
                            {generation.name}
                        </span>
                    ) : (
                        <button type="button" className="gen-panel__name" onClick={() => setEditing(true)} title={`${generation.name} (click to rename)`}>
                            {generation.name}
                        </button>
                    )}
                    <div className="gen-panel__sub">
                        {totalCount} {totalCount === 1 ? 'route' : 'routes'}
                        {paths.length !== totalCount && ` · ${paths.length} shown`}
                        {' · '}{combined ? `${combined.sets.length} sets` : roadsLabel(settings)}
                    </div>
                </div>
                {headerActions}
                <div className="gen-menu">
                    <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setMenuOpen((o) => !o)}
                        aria-label="More"
                        aria-expanded={menuOpen}
                    >
                        <MoreHorizontal size={18} />
                    </button>
                    {menuOpen && (
                        <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
                            {!combined && <button type="button" onClick={() => { setMenuOpen(false); setEditing(true); }}>Rename</button>}
                            <button type="button" onClick={() => { setMenuOpen(false); onNewSearchHere(); }} title="Back to the plan with this start and settings, for a new set (or pick this one there to add to it)">Plan again from here</button>
                            {!combined && (
                                <button type="button" onClick={() => { setMenuOpen(false); setShowSettings((v) => !v); }}>
                                    {showSettings ? 'Hide settings used' : 'Settings used'}
                                </button>
                            )}
                            {!combined && (
                                <button type="button" className="is-danger" onClick={() => { setMenuOpen(false); onDelete(); }}>
                                    <Trash2 size={14} /> Delete
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {showSettings && !combined && (
                <div className="gen-settings">
                    {settingsRows(generation, units).map(([k, v]) => (
                        <div key={k} className="gen-settings__row"><span>{k}</span><span>{v}</span></div>
                    ))}
                </div>
            )}

            {compareProps && <ComparePanel generation={generation} {...compareProps} />}

            <div className="panel-section">
                <ToolsBar {...toolsProps} mode="display" />
            </div>

            <div className="panel-section gen-controls">
                <div className="sort-row">
                    <label className="section-label" htmlFor="sort-by">Sort</label>
                    <select
                        id="sort-by"
                        className="select"
                        value={sortBy}
                        onChange={(e) => onSort(e.target.value)}
                    >
                        {SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <button
                        type="button"
                        className="icon-btn icon-btn--boxed"
                        onClick={onFlipSort}
                        title={`${directionLabel(sortBy, sortAscending)}. Click to reverse (shows the new first route).`}
                        aria-label={`Reverse the order (now ${directionLabel(sortBy, sortAscending).toLowerCase()})`}
                    >
                        {sortAscending ? <ArrowUpNarrowWide size={16} /> : <ArrowDownWideNarrow size={16} />}
                    </button>
                </div>

                {routeFilters.map((filter) => {
                    const metric = getFilterMetric(filter.key);
                    if (!metric) return null;
                    return (
                        <RangeFilter
                            key={filter.key}
                            metric={metric}
                            bounds={filterBounds?.[filter.key]}
                            range={filter.range}
                            onChange={(range) => setFilterRange(filter.key, range)}
                            onRemove={PINNED_FILTERS.includes(filter.key) ? null : () => removeRouteFilter(filter.key)}
                        />
                    );
                })}

                <div className="filters-foot">
                    {addable.length > 0 && (
                        <label className="add-filter" title="Add a filter">
                            <Plus size={12} />
                            <span>Filter</span>
                            <select
                                value=""
                                onChange={(e) => { if (e.target.value) addRouteFilter(e.target.value); }}
                                aria-label="Add a filter"
                            >
                                <option value="">Add a filter…</option>
                                {addable.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                            </select>
                        </label>
                    )}
                    {filtersOn && (
                        <button type="button" className="link-btn" onClick={onClearFilters}>Clear filters</button>
                    )}
                    {onFavoritesOnly && (
                        <button
                            type="button"
                            className={`fav-toggle ${favoritesOnly ? 'is-on' : ''}`}
                            onClick={() => onFavoritesOnly(!favoritesOnly)}
                            aria-pressed={favoritesOnly}
                            title={favoritesOnly ? 'Show every route' : 'Show only the favorite routes'}
                        >
                            <Star size={12} fill={favoritesOnly ? 'currentColor' : 'none'} />
                            <span>Favorites</span>
                            <span className="fav-toggle__count">{favoriteCount}</span>
                        </button>
                    )}
                </div>
            </div>

            <div className="gen-routes">
                <div className="route-nav">
                    <button
                        type="button"
                        className="icon-btn icon-btn--boxed"
                        onClick={onPrev}
                        disabled={index <= 0}
                        title="Previous route (← or ↑)"
                        aria-label="Previous route"
                    >
                        <ChevronLeft size={16} />
                    </button>
                    <span className="route-nav__label" aria-live="polite">
                        {paths.length ? `${favoritesOnly ? 'Favorite' : 'Route'} ${index + 1} of ${paths.length}` : 'No routes'}
                        {onToggleFavorite && currentPath && (
                            <button
                                type="button"
                                className={`route-nav__star ${currentFav ? 'is-on' : ''}`}
                                onClick={() => onToggleFavorite(currentPath)}
                                title={currentFav ? 'Unfavorite this route (S)' : 'Favorite this route (S)'}
                                aria-label={currentFav ? 'Unfavorite this route' : 'Favorite this route'}
                                aria-pressed={currentFav}
                            >
                                <Star size={15} fill={currentFav ? 'currentColor' : 'none'} />
                            </button>
                        )}
                        {onDownloadGpx && currentPath && (
                            <button
                                type="button"
                                className="route-nav__star route-nav__gpx"
                                onClick={() => onDownloadGpx(currentPath)}
                                title="Download this route as GPX, for Ride with GPS, Strava, Garmin…"
                                aria-label="Download this route as GPX"
                            >
                                <Download size={15} />
                            </button>
                        )}
                    </span>
                    <button
                        type="button"
                        className="icon-btn icon-btn--boxed"
                        onClick={onNext}
                        disabled={index < 0 || index >= paths.length - 1}
                        title="Next route (→ or ↓)"
                        aria-label="Next route"
                    >
                        <ChevronRight size={16} />
                    </button>
                </div>
                <div className="route-list" role="listbox" aria-label="Routes" ref={listRef} onMouseLeave={leaveList}>
                    {paths.map((path, i) => {
                        const from = combined ? combined.setOf(path) : null;
                        return (
                            <RouteCard
                                key={path.id}
                                ref={path.id === currentId ? selectedRef : undefined}
                                path={path}
                                number={i + 1}
                                selected={path.id === currentId}
                                onSelect={selectCard}
                                onHover={hoverCard}
                                favorite={!!isFavorite && isFavorite(path)}
                                onToggleFavorite={onToggleFavorite ? toggleFavoriteCard : undefined}
                                onDownloadGpx={onDownloadGpx ? downloadGpxCard : undefined}
                                group={compareGroupOf ? compareGroupOf(path) : null}
                                fromName={from?.name || null}
                                fromAlso={from?.also.length ? from.also.map((n) => `“${n}”`).join(' and ') : null}
                                fromAlsoCount={from?.also.length || 0}
                                onOpenSet={combined ? openSetCard : undefined}
                            />
                        );
                    })}
                    {empty}
                </div>
            </div>

            <div className="gen-more">
                {moreOpen && (
                    <div className="gen-more__options">
                        {combined && (
                            <label className="gen-more__target">
                                <span className="section-label">Add to</span>
                                <select
                                    className="select"
                                    value={combined.targetId || ''}
                                    onChange={(e) => combined.onTarget(e.target.value)}
                                    aria-label="Set more routes go to"
                                >
                                    {combined.sets.map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.name} ({s.pathCount} {s.pathCount === 1 ? 'route' : 'routes'})
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        <div className="field-row">
                            <span className="section-label">Length</span>
                            <span className="field-value">{low === high ? `${low} ${unit}` : `${low}–${high} ${unit}`}</span>
                        </div>
                        <DualRange
                            min={sliderMin}
                            max={sliderMax}
                            low={low}
                            high={high}
                            onChange={(lo, hi) => setMore((m) => ({
                                ...m,
                                min_path_len: Number(displayToMiles(lo, units).toFixed(3)),
                                max_path_len: Number(displayToMiles(hi, units).toFixed(3)),
                            }))}
                            label="route length"
                            format={(v) => `${v} ${unit}`}
                        />
                        <div className="segmented segmented--small" role="group" aria-label="Roads for more routes">
                            {ROAD_PREFERENCES.map((p) => (
                                <button
                                    key={p.id}
                                    type="button"
                                    className={more.road_preference === p.id ? 'is-active' : ''}
                                    onClick={() => setMore((m) => ({ ...m, road_preference: p.id }))}
                                    title={p.hint}
                                >
                                    {p.label}
                                </button>
                            ))}
                            {more.road_preference === 'custom' && (
                                <button type="button" className="is-active" title="Custom road weights">Custom</button>
                            )}
                        </div>
                        <div className="segmented segmented--small" role="group" aria-label="Surface for more routes">
                            {SURFACE_PREFERENCES.map((p) => (
                                <button
                                    key={p.id}
                                    type="button"
                                    className={surfacePreference(more.surface_preference) === p.id ? 'is-active' : ''}
                                    onClick={() => setMore((m) => ({ ...m, surface_preference: p.id }))}
                                    title={p.hint}
                                >
                                    {p.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                <div className="gen-more__row">
                    {isGenerating ? (
                        <div className="busy">
                            <span className="busy__dot" />
                            <span className="busy__text">{statusText || `Finding routes… ${totalCount}`}</span>
                            <button type="button" className="link-btn" onClick={onStop} title="Stop (Esc)">Stop</button>
                        </div>
                    ) : (
                        <button
                            type="button"
                            className="btn-primary gen-more__go"
                            onClick={() => onMoreRoutes(more)}
                            title={target
                                ? `Find more routes for “${target.name}” with these settings, through your green roads and areas (M)`
                                : 'Find more routes with these settings, through your green roads and areas (M)'}
                        >
                            More routes
                        </button>
                    )}
                    <button
                        type="button"
                        className={`gen-more__settings ${moreOpen ? 'is-open' : ''}`}
                        onClick={() => setMoreOpen((o) => !o)}
                        aria-expanded={moreOpen}
                        title={target
                            ? `The set more routes go to (“${target.name}”), and their length, roads and surface`
                            : 'Length, roads and surface for more routes'}
                    >
                        <span>
                            {low === high ? `${low}` : `${low}–${high}`} {unit} · {roadsShort(more.road_preference)}
                            {surfacePreference(more.surface_preference) !== 'allow'
                                && ` · ${SURFACE_PREFERENCES.find((p) => p.id === surfacePreference(more.surface_preference)).chip}`}
                        </span>
                        {target && <span className="gen-more__to">→ {target.name}</span>}
                        <ChevronUp size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}

export default GenerationPanel;
