import { forwardRef, memo } from 'react';
import { Download, Star } from 'lucide-react';
import Sparkline from './Sparkline';
import { formatClimbRate, formatClimb, formatDistance, useUnits } from '../../utils/units';
import { formatUnpaved } from '../../utils/pathFiltering';
import { unpavedShare } from '../../utils/surface';
import { COMPARE_HUES, GROUP_BADGE } from '../../utils/compareSets';

/**
 * All routes from here: the set the route is from, small; a click opens that
 * set by itself (on this route). "+1" when another set found it too (named
 * in the tooltip).
 */
function FromSet({ name, also, alsoCount = 0, onOpen }) {
    const title = `Open “${name}” by itself${also ? ` (also found by ${also})` : ''}`;
    return (
        <button
            type="button"
            className="route-card__from"
            onClick={(e) => {
                e.stopPropagation(); // not a click on the card
                onOpen?.();
            }}
            title={title}
            aria-label={title}
        >
            <span className="route-card__from-name">{name}</span>
            {alsoCount > 0 && <span className="route-card__from-more">+{alsoCount}</span>}
        </button>
    );
}

/** The selected card's details: what the card row does not already say, and its GPX download. */
function Details({ p, units, onDownloadGpx, from = null }) {
    const miles = p.total_miles;
    const rate = miles > 0 && typeof p.total_climb_ft === 'number' ? p.total_climb_ft / miles : null;
    const items = [
        ['Loop', formatDistance(p.loop_miles, units)],
        ['Loop share', p.loop_ratio != null ? `${Math.round(p.loop_ratio * 100)}%` : '—'],
        ['Climb rate', formatClimbRate(rate, units)],
        ['Discomfort', typeof p.discomfort === 'number' ? p.discomfort.toFixed(1) : '—'],
        ['Difficulty', p.difficulty != null ? `${p.difficulty}/10` : '—'],
        ['Unpaved', formatUnpaved(unpavedShare(p))],
    ];
    return (
        <>
            <dl className="route-card__details">
                {items.map(([label, value]) => (
                    <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
            {(onDownloadGpx || from) && (
                <div className="route-card__actions">
                    {from}
                    {onDownloadGpx && (
                        <button
                            type="button"
                            className="link-btn route-card__gpx"
                            onClick={(e) => {
                                e.stopPropagation(); // not a click on the card
                                onDownloadGpx();
                            }}
                            title="Save as a GPX file to import into Ride with GPS, Strava, Garmin…"
                        >
                            <Download size={13} /> GPX
                        </button>
                    )}
                </div>
            )}
        </>
    );
}

/**
 * One route in the list: length, climb, elevation shape, a star (favorite).
 * The selected card opens up with a few more numbers. Pointer moves over it
 * are reported with onHover(id, event); the list decides what is previewed
 * on the map. A favorite is marked in the favorite colour. Memoized: the
 * list keeps its handlers' identities, so only cards that change render.
 */
const RouteCard = memo(forwardRef(function RouteCard({
    path, number, selected, onSelect, onHover, favorite = false, onToggleFavorite, onDownloadGpx,
    group = null, // dev compare: 'a' | 'b' | 'shared'
    fromName = null, // all routes from here: the set it is from
    fromAlso = null, // ...and the other sets that found it (names, for the tooltip)
    fromAlsoCount = 0, // ...how many
    onOpenSet, // (route): open its set by itself
}, ref) {
    const units = useUnits();
    const p = path.properties || {};
    const from = fromName
        ? <FromSet name={fromName} also={fromAlso} alsoCount={fromAlsoCount} onOpen={onOpenSet && (() => onOpenSet(path))} />
        : null;
    return (
        <div
            ref={ref}
            role="option"
            aria-selected={selected}
            tabIndex={-1}
            className={`route-card ${selected ? 'is-selected' : ''} ${favorite ? 'is-favorite' : ''}`}
            data-route-id={path.id}
            data-group={group || undefined}
            style={group ? { '--group-hue': COMPARE_HUES[group] } : undefined}
            onClick={() => onSelect(path.id)}
            onMouseMove={(e) => onHover?.(path.id, e)}
        >
            <div className="route-card__row">
                <span className="route-card__num">{number}</span>
                <span className="route-card__main">
                    <strong>{formatDistance(p.total_miles, units)}</strong>
                    <span className="route-card__climb">↗ {formatClimb(p.total_climb_ft, units)}</span>
                </span>
                {group && (
                    <span className="route-card__group" title={{ a: 'Only in A', b: 'Only in B', shared: 'In both A and B' }[group]}>
                        {GROUP_BADGE[group]}
                    </span>
                )}
                <Sparkline profile={p.elevation_profile} />
                {onToggleFavorite && (
                    <button
                        type="button"
                        className={`route-card__star ${favorite ? 'is-on' : ''}`}
                        onClick={(e) => {
                            e.stopPropagation(); // a star is not a click on the card
                            onToggleFavorite(path);
                        }}
                        title={favorite ? 'Unfavorite' : 'Favorite'}
                        aria-label={favorite ? `Unfavorite route ${number}` : `Favorite route ${number}`}
                        aria-pressed={favorite}
                    >
                        <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
                    </button>
                )}
            </div>
            {!selected && (
                <div className="route-card__meta">
                    {p.loop_ratio != null && <span>loop {Math.round(p.loop_ratio * 100)}%</span>}
                    {unpavedShare(p) != null && <span>{formatUnpaved(unpavedShare(p))} unpaved</span>}
                    {from}
                </div>
            )}
            {selected && <Details p={p} units={units} onDownloadGpx={onDownloadGpx && (() => onDownloadGpx(path))} from={from} />}
        </div>
    );
}));

export default RouteCard;
