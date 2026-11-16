/**
 * The settings a generation was found with, as [label, value] rows
 * ("Settings used", and the dev compare's settings diff).
 */
import { ROAD_PREFERENCES } from './roadWeights';
import { SURFACE_PREFERENCES, surfacePreference } from './surface';
import { describeSelections } from './routeSelections';
import { formatDistance } from './units';

export function roadsLabel(settings) {
    if (settings.road_preference === 'custom') return 'custom road weights';
    const p = ROAD_PREFERENCES.find((x) => x.id === (settings.road_preference || 'balanced'));
    return `${(p?.label || 'Balanced').toLowerCase()} roads`;
}

/** Surface for the summaries: its label, e.g. "Prefer gravel". */
function surfaceLabel(preference) {
    return SURFACE_PREFERENCES.find((p) => p.id === surfacePreference(preference)).label;
}

/** `allSearches`: list the search even when it is the default (so a diff shows both sides). */
export function settingsRows(generation, units, { allSearches = false } = {}) {
    const s = generation.settings || {};
    const opt = (v, d) => (v == null || v === '' ? `default (${d})` : String(v));
    const rows = [
        ['Route length', `${formatDistance(s.min_path_len, units, 0)} – ${formatDistance(s.max_path_len, units, 0)}`],
        ['Search area', s.boundary?.shapes?.length ? `boundary “${s.boundary.name || 'custom'}”` : 'automatic (within reach)'],
        ['Roads', roadsLabel(s)],
        ['Surface', surfaceLabel(s.surface_preference)],
        ['Loop share', s.loop_ratio == null ? '—' : `at least ${Math.round(Number(s.loop_ratio) * 100)}%`],
        ['Soften busy roads (rural)', s.rural_scale === false ? 'off' : 'on'],
        ['Explore / detour / reuse', `${opt(s.explore_weight, 2)} / ${opt(s.detour_weight, 0.3)} / ${opt(s.reuse_weight, 1)}`],
        ['Same route within', `${s.min_dist_m ?? 50} m`],
    ];
    if (allSearches) rows.push(['Search', s.algorithm || 'tree_guided']);
    else if (s.algorithm && s.algorithm !== 'tree_full') rows.push(['Search', s.algorithm]);
    if (generation.markerPosition) {
        rows.push(['Start', `${generation.markerPosition.lat.toFixed(4)}, ${generation.markerPosition.lng.toFixed(4)}`]);
    }
    const painted = describeSelections(generation.selections || []);
    if (painted) rows.push(['Roads and areas', painted]);
    return rows;
}
