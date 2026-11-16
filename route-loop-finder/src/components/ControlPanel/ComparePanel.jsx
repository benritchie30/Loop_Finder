import { ArrowLeftRight, GitCompare, X } from 'lucide-react';
import { COMPARE_HUES, COMPARE_VIEWS, settingsDiff } from '../../utils/compareSets';
import { settingsRows } from '../../utils/generationSettings';
import { useUnits } from '../../utils/units';
import './ComparePanel.css';

const hue = (group) => ({ '--group-hue': COMPARE_HUES[group] });

/** What B changed from A, in a few words ("Search: loop_atlas, Roads: quiet roads"). */
function diffSummary(a, b, units) {
    const diff = settingsDiff(settingsRows(a, units, { allSearches: true }), settingsRows(b, units, { allSearches: true }));
    if (!diff.length) return 'same settings';
    return diff.map((d) => `${d.label}: ${d.b}`).join(', ');
}

/**
 * Dev compare (LOOP_DEV=1) of the open generation (A) with another from the
 * same start (B). Idle: pick B. Comparing: a switch for All / A only /
 * Shared / B only with counts (after filters), a bar of the overlap, the
 * totals, and the settings that differ.
 */
function ComparePanel({ generation, candidates, compare, onStart, onView, onSwap, onEnd }) {
    const units = useUnits();

    if (!compare) {
        return (
            <div className="compare compare--idle">
                <span className="compare__tag" title="Shown because the server runs with LOOP_DEV=1">Dev</span>
                <GitCompare size={14} className="compare__icon" />
                {candidates.length ? (
                    <>
                        <select
                            className="select compare__pick"
                            value=""
                            onChange={(e) => { if (e.target.value) onStart(e.target.value); }}
                            aria-label="Compare with another generation from this start"
                        >
                            <option value="">Compare with…</option>
                            {candidates.map((g) => (
                                <option key={g.id} value={g.id}>
                                    {g.name} ({g.pathCount}) · {diffSummary(generation, g, units)}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            className="link-btn"
                            onClick={() => onStart(candidates[0].id)}
                            title={`Compare with ${candidates[0].name}, the newest other generation from this start`}
                        >
                            Latest
                        </button>
                    </>
                ) : (
                    <span className="compare__none">No other generation from this start to compare with.</span>
                )}
            </div>
        );
    }

    const other = candidates.find((g) => g.id === compare.otherId);
    const { counts, totals } = compare;
    const diff = other
        ? settingsDiff(settingsRows(generation, units, { allSearches: true }), settingsRows(other, units, { allSearches: true }))
        : [];
    const barTotal = counts.a + counts.shared + counts.b;

    return (
        <div className="compare">
            <div className="compare__sets">
                <span className="compare__tag" title="Shown because the server runs with LOOP_DEV=1">Dev</span>
                <span className="compare__set" style={hue('a')} title={`A: ${generation.name}`}>
                    <b>A</b> {generation.name}
                </span>
                <button type="button" className="icon-btn icon-btn--small" onClick={onSwap} title="Swap A and B (opens B)" aria-label="Swap A and B">
                    <ArrowLeftRight size={14} />
                </button>
                <span className="compare__set" style={hue('b')} title={`B: ${compare.otherName}`}>
                    <b>B</b> {compare.otherName}
                </span>
                <button type="button" className="icon-btn icon-btn--small" onClick={onEnd} title="Stop comparing" aria-label="Stop comparing">
                    <X size={14} />
                </button>
            </div>

            <div className="compare__switch" role="group" aria-label="Which routes to show">
                {COMPARE_VIEWS.map((v) => (
                    <button
                        key={v.id}
                        type="button"
                        className={`compare__view compare__view--${v.id} ${compare.view === v.id ? 'is-active' : ''}`}
                        style={v.id === 'all' ? undefined : hue(v.id)}
                        onClick={() => onView(v.id)}
                        aria-pressed={compare.view === v.id}
                    >
                        <span>{v.label}</span>
                        <span className="compare__count">{counts[v.id]}</span>
                    </button>
                ))}
            </div>

            {barTotal > 0 && (
                <div className="compare__bar" aria-hidden="true">
                    {['a', 'shared', 'b'].map((g) => counts[g] > 0 && (
                        <button
                            key={g}
                            type="button"
                            tabIndex={-1}
                            className={`compare__seg ${compare.view === g ? 'is-active' : ''}`}
                            style={{ ...hue(g), flexGrow: counts[g] }}
                            onClick={() => onView(compare.view === g ? 'all' : g)}
                            title={`${COMPARE_VIEWS.find((v) => v.id === g).label}: ${counts[g]}`}
                        />
                    ))}
                </div>
            )}

            <div className="compare__summary">
                A found {compare.aTotal} · B found {compare.bTotal} · {totals.shared} in both
                {counts.all !== totals.all && <span className="compare__filtered"> · counts above after filters</span>}
            </div>

            {diff.length > 0 ? (
                <div className="compare__diff">
                    {diff.map((d) => (
                        <div key={d.label} className="compare__diff-row">
                            <span className="compare__diff-label">{d.label}</span>
                            <span style={hue('a')} className="compare__diff-val">{d.a}</span>
                            <span className="compare__diff-arrow">→</span>
                            <span style={hue('b')} className="compare__diff-val">{d.b}</span>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="compare__summary">Same settings: the difference is the search's randomness (or the map).</div>
            )}
        </div>
    );
}

export default ComparePanel;
