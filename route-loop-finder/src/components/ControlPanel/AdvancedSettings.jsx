import { useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { ROAD_WEIGHT_FIELDS, weightsForPreference } from '../../utils/roadWeights';
import { numberFromText } from '../../utils/numberInput';

/**
 * A number box that lets you type freely. While it has focus its text is
 * never rewritten (clear it, or pass through a value out of range on the
 * way to another), but every keystroke that forms a number updates the
 * setting at once, brought into range, so Enter uses what you typed. On
 * leaving it (click out, Tab, Enter) the box is tidied: empty becomes
 * `empty` (null: stays empty, the server's default shown as placeholder;
 * restoreWhenEmpty: the value it had when you started editing it), and a
 * number out of range the nearest allowed one. Stepping (the arrows on the
 * box, the arrow keys) is tidied at once.
 *
 * The arrows snap to multiples of `step` counted from `inputMin` (the
 * browser's grid), which can sit below `min`: with step 10 and inputMin 0
 * the batch sizes go 10, 20, 30 (down from 10 reaches 0, tidied to 1).
 */
function NumberField({
    label,
    title,
    value,
    placeholder,
    onChange,
    min,
    max,
    step = 1,
    inputMin = min,
    integer = false,
    empty = null,
    restoreWhenEmpty = false,
}) {
    const [draft, setDraft] = useState(null); // the text while editing (null: show the setting)
    const startValue = useRef(value); // the value when editing started (restoreWhenEmpty)
    const shown = value == null ? '' : String(value);

    const valueOf = (text) => numberFromText(text, {
        min, max, integer, empty: restoreWhenEmpty ? startValue.current : empty,
    });
    // Puts the text's value in the setting; returns it.
    const commit = (text) => {
        const v = valueOf(text);
        if (v !== value) onChange(v);
        return v;
    };
    const tidy = (v) => (v == null ? '' : String(v));

    return (
        <label className="setting-item" title={title}>
            <span>{label}</span>
            <input
                type="number"
                value={draft ?? shown}
                placeholder={placeholder}
                min={inputMin}
                max={max}
                step={step}
                onFocus={() => {
                    startValue.current = value;
                    setDraft(shown);
                }}
                onChange={(e) => {
                    const text = e.target.value;
                    const v = commit(text);
                    // Typing (and deleting, pasting) has an inputType; stepping has none.
                    setDraft(e.nativeEvent?.inputType ? text : tidy(v));
                }}
                onBlur={() => {
                    if (draft != null) commit(draft);
                    setDraft(null);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') setDraft(tidy(commit(draft ?? shown)));
                }}
            />
        </label>
    );
}

/**
 * Advanced search settings: a page of its own over the whole panel, opened
 * from the bottom of the plan and closed with Back (or Esc).
 */
function AdvancedSettings({ genSettings, setGenSettings, algorithmOptions = [], onClose }) {
    const set = (patch) => setGenSettings((prev) => ({ ...prev, ...patch }));
    const preference = genSettings.road_preference || 'balanced';
    const weights = weightsForPreference(preference, genSettings.road_weights);
    const optional = (key) => (value) => set({ [key]: value != null && value >= 0 ? value : null });

    return (
        <div className="advanced">
            <div className="advanced__header">
                <button type="button" className="icon-btn" onClick={onClose} aria-label="Back to the plan" title="Back (Esc)">
                    <ChevronLeft size={18} />
                </button>
                <span className="panel-title">Advanced settings</span>
            </div>

            <div className="advanced__body">
                <section className="advanced__section">
                    <div className="field-row">
                        <span className="section-label">Loop share</span>
                        <span className="field-value">at least {Math.round((genSettings.loop_ratio ?? 0.5) * 100)}%</span>
                    </div>
                    <input
                        className="single-slider"
                        type="range"
                        min="0.2"
                        max="0.9"
                        step="0.05"
                        value={genSettings.loop_ratio ?? 0.5}
                        onChange={(e) => set({ loop_ratio: Number(e.target.value) })}
                        aria-label="Loop share"
                    />
                    <p className="hint">Each route is mostly loop; the rest is the same road out and back.</p>
                </section>

                <section className="advanced__section">
                    <span className="section-label">Search</span>
                    <div className="settings-grid">
                        <NumberField
                            label="First batch"
                            title="Routes found when you press Find loops"
                            value={genSettings.num_paths}
                            onChange={(v) => set({ num_paths: v })}
                            min={1}
                            max={200}
                            step={10}
                            inputMin={0}
                            integer
                            empty={50}
                        />
                        <NumberField
                            label="More routes batch"
                            title="Routes found each time you ask for more: More routes (M), or a new green road or area when the option below is on"
                            value={genSettings.routes_per_pin}
                            onChange={(v) => set({ routes_per_pin: v })}
                            min={1}
                            max={100}
                            step={10}
                            inputMin={0}
                            integer
                            empty={20}
                        />
                        <NumberField
                            label="Explore weight"
                            title="How strongly routes are pushed toward areas not shown yet. 0 turns it off."
                            value={genSettings.explore_weight}
                            placeholder="2"
                            onChange={optional('explore_weight')}
                            min={0}
                            max={10}
                            step={0.5}
                        />
                        <NumberField
                            label="Detour cost"
                            title="Turns per mile charged for distance. Higher keeps each side more direct; lower lets it detour onto quieter roads."
                            value={genSettings.detour_weight}
                            placeholder="0.3"
                            onChange={optional('detour_weight')}
                            min={0}
                            max={5}
                            step={0.1}
                        />
                        <NumberField
                            label="Reuse penalty"
                            title="Turns per mile added to roads already used by a route, so later rounds find alternatives."
                            value={genSettings.reuse_weight}
                            placeholder="1"
                            onChange={optional('reuse_weight')}
                            min={0}
                            max={10}
                            step={0.5}
                        />
                        <NumberField
                            label="Same route within (m)"
                            title="Two routes whose centers are closer than this count as the same route"
                            value={genSettings.min_dist_m}
                            placeholder="50"
                            onChange={(v) => set({ min_dist_m: v })}
                            min={10}
                            max={1000}
                            step={10}
                            empty={50}
                        />
                        {algorithmOptions.length > 1 && (
                            <label className="setting-item full-width">
                                <span>Search (LOOP_DEV)</span>
                                <select
                                    value={genSettings.algorithm}
                                    onChange={(e) => set({ algorithm: e.target.value, more_algorithm: e.target.value })}
                                >
                                    {algorithmOptions.map((opt) => (
                                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                                    ))}
                                </select>
                            </label>
                        )}
                    </div>
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={genSettings.auto_more_routes === true}
                            onChange={(e) => set({ auto_more_routes: e.target.checked })}
                        />
                        <span>Find more routes when I add a road or area to include</span>
                    </label>
                    <p className="hint">When off, green roads and areas only filter the routes you have until you press More routes (M).</p>
                </section>

                <section className="advanced__section">
                    <div className="field-row">
                        <span className="section-label">Road weights</span>
                        {preference === 'custom' && (
                            <button type="button" className="link-btn" onClick={() => set({ road_preference: 'balanced' })}>
                                Reset
                            </button>
                        )}
                    </div>
                    <p className="hint">
                        Extra turns charged per mile on each kind of road (0 is free). Editing a number
                        switches Roads to Custom. A bike lane still cuts a costly road.
                    </p>
                    <div className="settings-grid">
                        {ROAD_WEIGHT_FIELDS.map(([key, label]) => (
                            <NumberField
                                key={key}
                                label={label}
                                value={weights[key]}
                                min={0}
                                step={1}
                                restoreWhenEmpty
                                onChange={(v) => {
                                    // Clearing a box puts back the value it had (the Roads
                                    // choice's): that alone does not make Roads Custom.
                                    if (v == null || v === weights[key]) return;
                                    set({ road_preference: 'custom', road_weights: { ...weights, [key]: v } });
                                }}
                            />
                        ))}
                    </div>
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={genSettings.rural_scale !== false}
                            onChange={(e) => set({ rural_scale: e.target.checked })}
                        />
                        <span>Soften busy roads in rural areas (where quiet roads are scarce)</span>
                    </label>
                </section>
            </div>
        </div>
    );
}

export default AdvancedSettings;
