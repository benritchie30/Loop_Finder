import { useMemo, useState } from 'react';
import { Check, ChevronDown, Pencil, Trash2 } from 'lucide-react';
import { startGroups } from '../../utils/pathSetGroups';
import { distanceUnit, milesToDisplay, useUnits } from '../../utils/units';
import { whenText as when } from '../../utils/dates';

/** "5.2–14.8 mi": the lengths the generation's routes actually have. */
function rangeText(range, units) {
    if (!range) return null;
    const [lo, hi] = range.map((miles) => milesToDisplay(miles, units).toFixed(1));
    return `${lo === hi ? lo : `${lo}–${hi}`} ${distanceUnit(units)}`;
}

/** A name being edited: Enter or leaving the field saves, Esc cancels. */
function NameEditor({ name, onSave, onCancel }) {
    const [draft, setDraft] = useState(name);
    const save = () => {
        if (draft.trim() && draft.trim() !== name) onSave(draft.trim());
        else onCancel();
    };
    return (
        <div className="gen-list__edit">
            <input
                className="gen-list__input"
                value={draft}
                autoFocus
                aria-label="Name"
                onChange={(e) => setDraft(e.target.value)}
                onFocus={(e) => e.target.select()}
                onBlur={save}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        save();
                    }
                    if (e.key === 'Escape') {
                        e.stopPropagation();
                        onCancel();
                    }
                }}
            />
            <button type="button" className="icon-btn icon-btn--small" onMouseDown={(e) => e.preventDefault()} onClick={save} aria-label="Save the name">
                <Check size={14} />
            </button>
        </div>
    );
}

const COLLAPSED_KEY = 'collapsedStarts';

function readCollapsed() {
    try {
        const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
        return new Set(Array.isArray(saved) ? saved : []);
    } catch {
        return new Set();
    }
}

/**
 * Saved generations in their own scroll box, by start (utils/pathSetGroups
 * startGroups): a group per start, its sets newest first; the starts with a
 * route in the map's view (`view`) first, marked "in view", then the rest,
 * each by its newest set; the kept set (favorites from deleted sets) last. A
 * group's arrow folds it (remembered, localStorage `collapsedStarts`); its
 * name opens all its sets (onOpenGroup: all routes from that start).
 * Open a set, rename it, or delete it (with undo; its favorites stay, in the
 * kept set). The kept set has no rename, and Remove unfavorites them.
 * Hovering a row previews its set on the map, a header its start's sets
 * (onHover: id, [ids] or null); the hover ends when the pointer leaves the
 * list, so moving between rows never drops it.
 */
function GenerationsList({
    generations, onOpen, onOpenGroup, onDelete, onRename, onHover, showHeader = true, favoritesOnly = false, view = null,
}) {
    const units = useUnits();
    const [editing, setEditing] = useState(null);
    const [collapsed, setCollapsed] = useState(readCollapsed);
    const groups = useMemo(() => startGroups(generations, view), [generations, view]);
    const toggle = (key) => setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
        return next;
    });
    if (!generations.length) {
        return showHeader ? null : <div className="gen-empty fav-list__empty">No loops yet: set a start and press Find loops.</div>;
    }
    const row = (g) => (
        <li key={g.id} className="gen-list__row" onMouseEnter={() => onHover?.(g.id)}>
            {editing === g.id ? (
                <NameEditor
                    name={g.name}
                    onSave={(name) => { onRename?.(g.id, name); setEditing(null); }}
                    onCancel={() => setEditing(null)}
                />
            ) : (
                <button type="button" className="gen-list__open" onClick={() => onOpen(g.id)} title={`Open ${g.name}`}>
                    <span className="gen-list__name">{g.name}</span>
                    <span className="gen-list__meta">
                        {[
                            favoritesOnly || g.kept
                                ? `${g.favoriteCount} ${g.favoriteCount === 1 ? 'favorite' : 'favorites'}`
                                : `${g.pathCount} ${g.pathCount === 1 ? 'route' : 'routes'}`,
                            rangeText(g.lengthRange, units),
                            when(g.createdAt),
                        ].filter(Boolean).join(' · ')}
                        {!g.isComplete && ' · finding…'}
                    </span>
                </button>
            )}
            {editing !== g.id && !g.kept && (
                <button
                    type="button"
                    className="icon-btn icon-btn--small gen-list__action"
                    onClick={() => setEditing(g.id)}
                    title="Rename"
                    aria-label={`Rename ${g.name}`}
                >
                    <Pencil size={14} />
                </button>
            )}
            <button
                type="button"
                className="icon-btn icon-btn--small gen-list__action gen-list__delete"
                onClick={() => onDelete(g.id)}
                title={g.kept ? 'Remove all of these favorites (they go for good)' : 'Delete (its favorites are kept)'}
                aria-label={`${g.kept ? 'Remove' : 'Delete'} ${g.name}`}
            >
                <Trash2 size={14} />
            </button>
        </li>
    );
    return (
        <div className="gen-list">
            {showHeader && (
                <div className="field-row">
                    <span className="section-label">Your loops</span>
                    <span className="field-hint">{generations.length}</span>
                </div>
            )}
            <ul className="gen-list__scroll" onMouseLeave={() => onHover?.(null)}>
                {groups.map((group) => {
                    const folded = collapsed.has(group.key);
                    return (
                        <li key={group.key} className={`gen-group ${group.near ? 'is-near' : ''}`}>
                            <div
                                className="gen-group__head"
                                onMouseEnter={() => onHover?.(group.kept ? group.sets[0].id : group.sets.map((g) => g.id))}
                            >
                                <button
                                    type="button"
                                    className="gen-group__fold"
                                    aria-expanded={!folded}
                                    onClick={() => toggle(group.key)}
                                    title={folded ? 'Show its sets' : 'Fold its sets'}
                                    aria-label={`${folded ? 'Show' : 'Fold'} ${group.name}`}
                                >
                                    <ChevronDown size={14} className="gen-group__chevron" />
                                </button>
                                <button
                                    type="button"
                                    className="gen-group__open"
                                    onClick={() => (onOpenGroup ? onOpenGroup(group) : onOpen(group.sets[0].id))}
                                    title={group.kept || group.sets.length === 1 ? `Open ${group.sets[0].name}` : `Open all ${group.sets.length} sets from here`}
                                >
                                    <span className="gen-group__name">{group.name}</span>
                                    {group.near && <span className="gen-group__near">in view</span>}
                                    <span className="gen-group__count">{group.sets.length}</span>
                                </button>
                            </div>
                            {!folded && <ul className="gen-group__sets">{group.sets.map(row)}</ul>}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

export default GenerationsList;
