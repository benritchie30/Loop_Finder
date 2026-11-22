import { useCallback, useRef } from 'react';
import {
    ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, ChevronLeft, ChevronRight, Download, LocateFixed, MapPin, Plus, Star,
} from 'lucide-react';
import RangeFilter from './RangeFilter';
import RouteCard from './RouteCard';
import ToolsBar from './ToolsBar';
import { FILTER_METRICS, getFilterMetric } from '../../utils/pathFiltering';
import { FAVORITE_SORTS, GROUPINGS, directionText } from '../../utils/favoritesList';
import { useCardList } from '../../hooks/useCardList';
import './GenerationPanel.css';

/**
 * The Favorites page (a page of the panel, opened from the plan): every
 * favorite, from every set. Top to bottom: header (back, count); the route
 * through / avoid tools (they filter favorites); Sort (Date favorited, Best,
 * the route measures) and its direction, Group (by set, by start, none), the
 * measure filters and "In map view"; the favorites in their groups (groups
 * near the map's view first), ‹ › above them. A group's header folds it and
 * opens its set (favorites only) or, its set deleted, plans there. With the
 * favorites of several sets in a group (by start, none), each card names its
 * set; a click on the name opens it. A card or a group's header under the
 * pointer puts its group (its start, with no groups) in focus: the map shows
 * only its faint routes and its start's pin is orange (hooks/useFavoritesView).
 * A header is lit while its start's pin is under the pointer.
 */
function FavoritesPage({
    view, // hooks/useFavoritesView
    headerActions = null,
    toolsProps,
    onBack,
    onSelect, // (route id): select it (and bring it into view)
    isFavorite,
    onToggleFavorite, // (route)
    onDownloadGpx, // (route)
    onOpenGroup, // (group)
    onPlanHere, // (group)
    onOpenSet, // (route): its set by itself, favorites only, on this route
    setNameOf, // (route) => the name of the set it is from
}) {
    const {
        groups, paths, current, total, painted, shown, sortBy, ascending, chooseSort, flipSort, grouping, setGrouping,
        inView, setInView, routeFilters, filterBounds, setFilterRange, addRouteFilter, removeRouteFilter, clearFilters,
        collapsed, toggleGroup, setHoveredId, stepId, setHoverGroup, groupLit,
    } = view;
    const currentId = current?.id ?? null;
    const { listRef, selectedRef, selectCard, hoverCard: previewCard, leaveList } = useCardList({
        paths, currentId, onSelectPath: onSelect, onHoverPath: setHoveredId, onReselect: onSelect, // (brings it back into view)
        orderKey: `${sortBy}|${ascending}|${grouping}`,
    });
    const actions = useRef({});
    actions.current = { onToggleFavorite, onDownloadGpx, onOpenSet };
    const toggleCard = useCallback((path) => actions.current.onToggleFavorite?.(path), []);
    const gpxCard = useCallback((path) => actions.current.onDownloadGpx?.(path), []);
    const openSetCard = useCallback((path) => actions.current.onOpenSet?.(path), []);
    // A card under the pointer: its route previewed (and its group in focus); no header is.
    const hoverCard = useCallback((id, e) => {
        setHoverGroup(null);
        previewCard(id, e);
    }, [previewCard, setHoverGroup]);

    const index = currentId ? paths.findIndex((p) => p.id === currentId) : -1;
    const currentFav = !!current && !!isFavorite && isFavorite(current);
    const activeKeys = new Set(routeFilters.map((f) => f.key));
    const addable = FILTER_METRICS.filter((m) => !activeKeys.has(m.key));
    const filtersOn = routeFilters.some((f) => f.range[0] != null || f.range[1] != null);
    const namesOnCards = grouping !== 'set';
    const step = (delta) => {
        const id = stepId(delta);
        if (id) onSelect(id);
    };

    let empty = null;
    if (!total) {
        empty = 'No favorites yet. Open a set and press S (or a card\u2019s star) on a route you like.';
    } else if (!painted) {
        empty = 'No favorite goes through your painted roads and areas.';
    } else if (!paths.length) {
        empty = (
            <>
                <span>{inView ? 'No favorite in the map\u2019s view matches.' : 'No favorite matches your filters.'}</span>
                {filtersOn && <button type="button" className="link-btn" onClick={clearFilters}>Clear filters</button>}
                {inView && <button type="button" className="link-btn" onClick={() => setInView(false)}>Show every favorite</button>}
            </>
        );
    }

    let number = 0;
    return (
        <div className="gen-panel fav-page">
            <div className="gen-panel__header">
                <button type="button" className="icon-btn" onClick={onBack} title="Back to the plan (Backspace)" aria-label="Back">
                    <ChevronLeft size={18} />
                </button>
                <div className="gen-panel__title">
                    <span className="gen-panel__name gen-panel__name--fixed">
                        <Star size={14} className="fav-page__star" fill="currentColor" /> Favorites
                    </span>
                    <div className="gen-panel__sub">
                        {total} {total === 1 ? 'favorite' : 'favorites'}
                        {shown !== total && ` · ${shown} shown`}
                    </div>
                </div>
                {headerActions}
            </div>

            <div className="panel-section">
                <ToolsBar {...toolsProps} mode="input" />
            </div>

            <div className="panel-section gen-controls">
                <div className="sort-row">
                    <label className="section-label" htmlFor="fav-sort">Sort</label>
                    <select id="fav-sort" className="select" value={sortBy} onChange={(e) => chooseSort(e.target.value)}>
                        {FAVORITE_SORTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <button
                        type="button"
                        className="icon-btn icon-btn--boxed"
                        onClick={flipSort}
                        title={`${directionText(sortBy, ascending)}. Click to reverse.`}
                        aria-label={`Reverse the order (now ${directionText(sortBy, ascending).toLowerCase()})`}
                    >
                        {ascending ? <ArrowUpNarrowWide size={16} /> : <ArrowDownWideNarrow size={16} />}
                    </button>
                </div>
                <div className="sort-row">
                    <span className="section-label">Group</span>
                    <div className="segmented segmented--small fav-page__grouping" role="group" aria-label="Group favorites">
                        {GROUPINGS.map((g) => (
                            <button
                                key={g.id}
                                type="button"
                                className={grouping === g.id ? 'is-active' : ''}
                                onClick={() => setGrouping(g.id)}
                                aria-pressed={grouping === g.id}
                                title={g.hint}
                            >
                                {g.label}
                            </button>
                        ))}
                    </div>
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
                            onRemove={filter.key === 'total_miles' ? null : () => removeRouteFilter(filter.key)}
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
                        <button type="button" className="link-btn" onClick={clearFilters}>Clear filters</button>
                    )}
                    <button
                        type="button"
                        className={`fav-toggle fav-page__in-view ${inView ? 'is-on' : ''}`}
                        onClick={() => setInView(!inView)}
                        aria-pressed={inView}
                        title={inView ? 'Show every favorite' : 'Show only the favorites in the map\u2019s view (as you left it)'}
                    >
                        <LocateFixed size={12} />
                        <span>In map view</span>
                    </button>
                </div>
            </div>

            <div className="gen-routes">
                <div className="route-nav">
                    <button
                        type="button"
                        className="icon-btn icon-btn--boxed"
                        onClick={() => step(-1)}
                        disabled={!paths.length || index === 0}
                        title="Previous favorite (← or ↑)"
                        aria-label="Previous favorite"
                    >
                        <ChevronLeft size={16} />
                    </button>
                    <span className="route-nav__label" aria-live="polite">
                        {paths.length
                            ? (index >= 0 ? `Favorite ${index + 1} of ${paths.length}` : `${paths.length} ${paths.length === 1 ? 'favorite' : 'favorites'}`)
                            : 'No favorites'}
                        {current && (
                            <button
                                type="button"
                                className={`route-nav__star ${currentFav ? 'is-on' : ''}`}
                                onClick={() => onToggleFavorite(current)}
                                title={currentFav ? 'Unfavorite (S)' : 'Favorite again (S)'}
                                aria-label={currentFav ? 'Unfavorite this route' : 'Favorite this route again'}
                                aria-pressed={currentFav}
                            >
                                <Star size={15} fill={currentFav ? 'currentColor' : 'none'} />
                            </button>
                        )}
                        {current && onDownloadGpx && (
                            <button
                                type="button"
                                className="route-nav__star route-nav__gpx"
                                onClick={() => onDownloadGpx(current)}
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
                        onClick={() => step(1)}
                        disabled={!paths.length || index >= paths.length - 1}
                        title="Next favorite (→ or ↓)"
                        aria-label="Next favorite"
                    >
                        <ChevronRight size={16} />
                    </button>
                </div>
                <div
                    className="route-list fav-page__list"
                    role="listbox"
                    aria-label="Favorites"
                    ref={listRef}
                    onMouseLeave={() => {
                        leaveList();
                        setHoverGroup(null);
                    }}
                >
                    {groups.map((group) => {
                        const folded = collapsed.has(group.key);
                        const first = number;
                        number += group.records.length;
                        return (
                            <section key={group.key} className="fav-group" data-group={group.key}>
                                {grouping !== 'none' && (
                                    <div
                                        className={`fav-group__head ${groupLit(group) ? 'is-lit' : ''}`}
                                        onMouseEnter={() => setHoverGroup(group.key)}
                                        onMouseLeave={() => setHoverGroup(null)}
                                    >
                                        <button
                                            type="button"
                                            className={`fav-group__fold ${folded ? 'is-folded' : ''}`}
                                            onClick={() => toggleGroup(group.key)}
                                            aria-expanded={!folded}
                                            title={folded ? 'Show its favorites' : 'Fold it'}
                                            aria-label={`${folded ? 'Unfold' : 'Fold'} ${group.title}`}
                                        >
                                            <ChevronDown size={14} />
                                        </button>
                                        <span className="fav-group__title" title={group.title}>{group.title}</span>
                                        {group.gone && <span className="fav-group__gone" title="Its set was deleted">deleted</span>}
                                        <span className="fav-group__count">{group.records.length}</span>
                                        {group.setId ? (
                                            <button
                                                type="button"
                                                className="link-btn fav-group__action"
                                                onClick={() => onOpenGroup?.(group)}
                                                title={grouping === 'start' && group.setIds.length > 1
                                                    ? 'Open all routes from here, showing their favorites'
                                                    : 'Open this set, showing its favorites'}
                                            >
                                                Open <ChevronRight size={12} />
                                            </button>
                                        ) : group.position && (
                                            <button
                                                type="button"
                                                className="link-btn fav-group__action"
                                                onClick={() => onPlanHere?.(group)}
                                                title="Its set was deleted: put the start pin here"
                                            >
                                                <MapPin size={12} /> Plan here
                                            </button>
                                        )}
                                    </div>
                                )}
                                {!folded && group.records.map((record, i) => {
                                    const { path } = record;
                                    return (
                                        <RouteCard
                                            key={record.key}
                                            ref={path.id === currentId ? selectedRef : undefined}
                                            path={path}
                                            number={first + i + 1}
                                            selected={path.id === currentId}
                                            onSelect={selectCard}
                                            onHover={hoverCard}
                                            favorite={isFavorite ? isFavorite(path) : true}
                                            onToggleFavorite={toggleCard}
                                            onDownloadGpx={gpxCard}
                                            fromName={namesOnCards ? setNameOf?.(path) || null : null}
                                            onOpenSet={namesOnCards ? openSetCard : undefined}
                                        />
                                    );
                                })}
                            </section>
                        );
                    })}
                    {empty && <div className="gen-empty">{empty}</div>}
                </div>
            </div>
        </div>
    );
}

export default FavoritesPage;
