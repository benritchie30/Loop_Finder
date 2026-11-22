import { useEffect, useState } from 'react';
import { ChevronRight, Maximize2, Minimize2, SlidersHorizontal, Star } from 'lucide-react';
import './ControlPanel.css';

import PlanCard from './PlanCard';
import AdvancedSettings from './AdvancedSettings';
import GenerationsList from './GenerationsList';
import FavoritesPage from './FavoritesPage';
import BoundaryEditor from './BoundaryEditor';
import GenerationPanel from './GenerationPanel';
import ViewOptions from './ViewOptions';

/**
 * The panel on the right, sized to fit the window without scrolling (only
 * lists scroll, inside their own boxes).
 * - No generation open: the plan (start, length, roads, through / avoid,
 *   Find loops), "Your loops" with the Favorites button beside it, and
 *   Advanced settings at the bottom, which opens as a page over the whole panel.
 * - The Favorites page (FavoritesPage): every favorite, over the whole panel.
 * - A generation open: its routes (GenerationPanel).
 */
function ControlPanel({
    mode,
    // plan
    genSettings,
    setGenSettings,
    units,
    setUnits,
    pinArea,
    pinName,
    hasStart,
    onGenerate,
    algorithms,
    toolsProps,
    // saved generations
    generations = [],
    onOpenGeneration,
    onDeleteGeneration,
    // open generation
    activeGeneration,
    generationProps,
    // map display
    viewOptions,
    setViewOption,
    setsHere = [],
    addToId = null,
    onChooseStart,
    onRenameGeneration,
    onHoverGeneration,
    favoritesPage = null, // FavoritesPage's props while the Favorites page is open
    favoriteCount = 0, // every favorite (the plan's Favorites button)
    onOpenFavorites, // open the Favorites page
    boundaryProps = null, // the plan's search area: PlanCard's boundary props
    boundaryEditor = null, // a boundary being drawn or edited: BoundaryEditor's props (its own page)
}) {
    const [minimized, setMinimized] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const showGeneration = mode === 'display' && activeGeneration;
    const title = showGeneration ? activeGeneration.name : favoritesPage ? 'Favorites' : 'Plan a loop';

    // A generation opening (even one started from the Advanced page, with
    // Enter) closes Advanced: going back from it shows the plan.
    useEffect(() => {
        if (showGeneration) setAdvancedOpen(false);
    }, [showGeneration]);

    // Esc closes the Advanced page.
    useEffect(() => {
        if (!advancedOpen || showGeneration) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') setAdvancedOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [advancedOpen, showGeneration]);

    const actions = (
        <div className="panel-actions">
            <ViewOptions options={viewOptions} setOption={setViewOption} />
            <button
                type="button"
                className="icon-btn"
                onClick={() => setMinimized((m) => !m)}
                title={minimized ? 'Show the panel' : 'Hide the panel'}
                aria-label={minimized ? 'Show the panel' : 'Hide the panel'}
            >
                {minimized ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
            </button>
        </div>
    );

    // The app's mark: a loop that comes back to its start.
    const brand = (
        <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
                <path
                    className="brand-mark__loop"
                    d="M16 24.500c-5.500 0-9.500-3.400-9.500-8s3.800-8 8.500-8c4 0 7 2.700 7 6.100 0 3.100-2.400 5.400-5.500 5.400"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                />
                <circle cx="16" cy="24.500" r="3" fill="currentColor" />
            </svg>
        </span>
    );

    if (minimized) {
        return (
            <div className="control-panel control-panel--minimized">
                <div className="panel-top">
                    {brand}
                    <span className="panel-title">{title}</span>
                    {actions}
                </div>
            </div>
        );
    }

    if (showGeneration) {
        return (
            <div className="control-panel control-panel--full">
                <GenerationPanel
                    key={activeGeneration.id}
                    generation={activeGeneration}
                    headerActions={actions}
                    toolsProps={toolsProps}
                    {...generationProps}
                />
            </div>
        );
    }

    if (favoritesPage) {
        return (
            <div className="control-panel control-panel--full">
                <FavoritesPage {...favoritesPage} headerActions={actions} toolsProps={toolsProps} />
            </div>
        );
    }

    if (boundaryEditor && !showGeneration) {
        return (
            <div className="control-panel control-panel--full">
                <BoundaryEditor {...boundaryEditor} />
            </div>
        );
    }

    if (advancedOpen) {
        return (
            <div className="control-panel control-panel--full">
                <AdvancedSettings
                    genSettings={genSettings}
                    setGenSettings={setGenSettings}
                    algorithmOptions={algorithms}
                    onClose={() => setAdvancedOpen(false)}
                />
            </div>
        );
    }

    return (
        <div className="control-panel">
            <div className="panel-top">
                {brand}
                <span className="panel-title">{title}</span>
                {actions}
            </div>
            <div className="panel-section">
                <PlanCard
                    genSettings={genSettings}
                    setGenSettings={setGenSettings}
                    units={units}
                    setUnits={setUnits}
                    pinArea={pinArea}
                    pinName={pinName}
                    hasStart={hasStart}
                    onGenerate={onGenerate}
                    toolsProps={toolsProps}
                    setsHere={setsHere}
                    addToId={addToId}
                    onChooseStart={onChooseStart}
                    boundary={boundaryProps}
                />
            </div>
            {(generations.length > 0 || favoriteCount > 0) && (
                <div className="panel-section panel-section--grow">
                    <div className="plan-lists__head">
                        <span className="section-label">
                            Your loops <span className="plan-lists__count">{generations.length}</span>
                        </span>
                        <button
                            type="button"
                            className="fav-open-btn"
                            onClick={onOpenFavorites}
                            title="Every favorite route, on its own page: sort, group, filter, step through them"
                        >
                            <Star size={13} fill="currentColor" />
                            <span>Favorites</span>
                            <span className="fav-open-btn__count">{favoriteCount}</span>
                            <ChevronRight size={14} />
                        </button>
                    </div>
                    {generations.length > 0 ? (
                        <GenerationsList
                            generations={generations}
                            onOpen={onOpenGeneration}
                            onDelete={onDeleteGeneration}
                            onRename={onRenameGeneration}
                            onHover={onHoverGeneration}
                            showHeader={false}
                        />
                    ) : (
                        <div className="gen-empty">No loops yet: set a start and press Find loops.</div>
                    )}
                </div>
            )}
            <button type="button" className="panel-footer-btn" onClick={() => setAdvancedOpen(true)}>
                <SlidersHorizontal size={15} />
                <span>Advanced settings</span>
                {genSettings.road_preference === 'custom' && <span className="pill">custom roads</span>}
                <ChevronRight size={16} />
            </button>
            <p className="panel-privacy">
                Your routes are saved only in this browser. The server sees the start points you search
                from but doesn&apos;t store them.
            </p>
        </div>
    );
}

export default ControlPanel;
