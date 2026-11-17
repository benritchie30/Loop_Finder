import { useState } from 'react';
import { Monitor, Moon, Settings2, Sun } from 'lucide-react';
import { setDarkTiles, setUiStyle, switchTheme, useTheme } from '../../utils/theme';

function ToggleRow({ label, checked, onChange, disabled = false, title }) {
    return (
        <label className={`view-option ${disabled ? 'is-disabled' : ''}`} title={title}>
            <span>{label}</span>
            <span className="view-option__switch">
                <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
                <span />
            </span>
        </label>
    );
}

function SliderRow({ label, valueLabel, children }) {
    return (
        <div className="view-option view-option--stack">
            <div className="view-option__meta">
                <span>{label}</span>
                <span>{valueLabel}</span>
            </div>
            {children}
        </div>
    );
}

const APPEARANCES = [
    { id: 'system', label: 'Auto', icon: Monitor, title: 'Follow this device' },
    { id: 'light', label: 'Light', icon: Sun, title: 'Light' },
    { id: 'dark', label: 'Dark', icon: Moon, title: 'Dark' },
];

// Theme colours that work in both appearances (any hue: the slider).
const HUES = [215, 245, 275, 330, 10, 160, 190];

/** Appearance and map display options behind a small gear button (top right of the panel). */
function ViewOptions({ options, setOption }) {
    const [open, setOpen] = useState(false);
    const { preference, theme, darkTiles, uiStyle } = useTheme();
    return (
        <div className="view-menu">
            <button
                type="button"
                className="icon-btn"
                onClick={() => setOpen((o) => !o)}
                title="Appearance and map display options"
                aria-label="Map display options"
                aria-expanded={open}
            >
                <Settings2 size={16} />
            </button>
            {open && (
                <div className="view-menu__panel view-options" onMouseLeave={() => setOpen(false)}>
                    <span className="view-options__title">Appearance</span>
                    <div className="segmented segmented--small" role="group" aria-label="Appearance">
                        {APPEARANCES.map(({ id, label, icon, title }) => {
                            const Icon = icon;
                            return (
                                <button
                                    key={id}
                                    type="button"
                                    className={preference === id ? 'is-active' : ''}
                                    onClick={(e) => switchTheme(id, { x: e.clientX, y: e.clientY })}
                                    aria-pressed={preference === id}
                                    title={title}
                                >
                                    <Icon size={12} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                    <div className="view-option view-option--stack">
                        <div className="view-option__meta">
                            <span>Style</span>
                            <span>{uiStyle === 'classic' ? 'plain and simple' : 'glass and glow'}</span>
                        </div>
                        <div className="segmented segmented--small" role="group" aria-label="Style">
                            {[['classic', 'Classic'], ['modern', 'Modern']].map(([id, label]) => (
                                <button
                                    key={id}
                                    type="button"
                                    className={uiStyle === id ? 'is-active' : ''}
                                    onClick={() => setUiStyle(id)}
                                    aria-pressed={uiStyle === id}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <ToggleRow
                        label="Dark map tiles"
                        checked={darkTiles}
                        onChange={setDarkTiles}
                        disabled={theme !== 'dark'}
                        title="In the dark appearance, dim the map to match (not satellite)"
                    />
                    <SliderRow label="Theme colour" valueLabel={`${options.primaryColor}°`}>
                        <div className="hue-swatches" role="group" aria-label="Theme colour presets">
                            {HUES.map((hue) => (
                                <button
                                    key={hue}
                                    type="button"
                                    className={`hue-swatch ${Number(options.primaryColor) === hue ? 'is-active' : ''}`}
                                    style={{ '--swatch': hue }}
                                    onClick={() => setOption('primaryColor', String(hue))}
                                    aria-label={`Theme colour ${hue}°`}
                                    aria-pressed={Number(options.primaryColor) === hue}
                                />
                            ))}
                        </div>
                        <input
                            className="hue-slider"
                            type="range" min="0" max="360"
                            value={options.primaryColor}
                            onChange={(e) => setOption('primaryColor', String(e.target.value))}
                            aria-label="Theme colour"
                        />
                    </SliderRow>

                    <span className="view-options__title">On the map</span>
                    <ToggleRow label="Direction arrows" checked={options.showArrows} onChange={(v) => setOption('showArrows', v)} />
                    <ToggleRow label="Other routes, faint" checked={options.showPathPreview} onChange={(v) => setOption('showPathPreview', v)} />
                    <SliderRow label="Faint routes opacity" valueLabel={`${Math.round(options.pathPreviewOpacity * 100)}%`}>
                        <input
                            type="range" min="0.1" max="1" step="0.1"
                            value={options.pathPreviewOpacity}
                            onChange={(e) => setOption('pathPreviewOpacity', parseFloat(e.target.value))}
                            aria-label="Faint routes opacity"
                        />
                    </SliderRow>
                    <ToggleRow label="Painted roads & areas" checked={options.showSelections} onChange={(v) => setOption('showSelections', v)} />
                    <ToggleRow label="Search boundary" checked={options.showBoundary} onChange={(v) => setOption('showBoundary', v)} />
                    <ToggleRow label="Road network" checked={options.showGraphRoads} onChange={(v) => setOption('showGraphRoads', v)} />
                    <ToggleRow label="Route centres" checked={options.showCentroids} onChange={(v) => setOption('showCentroids', v)} />
                </div>
            )}
        </div>
    );
}

export default ViewOptions;
