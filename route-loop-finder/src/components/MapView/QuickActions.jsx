import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Keyboard, Moon, Sun, X } from 'lucide-react';
import { switchTheme, useTheme } from '../../utils/theme';

const GROUPS = [
    {
        title: 'Plan',
        rows: [
            ['Search for a place', ['/']],
            ['Find loops from the start', ['Enter']],
            ['Stop finding / cancel', ['Esc']],
        ],
    },
    {
        title: 'Routes',
        rows: [
            ['Next route', ['→', '↓']],
            ['Previous route', ['←', '↑']],
            ['Favorite the route', ['S']],
            ['More routes', ['M']],
            ['Show or hide elevation', ['E']],
            ['Back to your loops', ['Backspace']],
        ],
    },
    {
        title: 'Route through / avoid',
        rows: [
            ['Pan', ['K']],
            ['Paint a road', ['R']],
            ['Circle area', ['C']],
            ['Box area', ['B']],
            ['Freeform area', ['F']],
            ['Switch through / avoid', ['D']],
            ['Flip it for one click', ['Shift']],
            ['Undo the last one', ['Z']],
        ],
    },
    {
        title: 'App',
        rows: [
            ['Light / dark', ['T']],
            ['This sheet', ['?']],
        ],
    },
];

function typing(target) {
    const tag = target?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
}

/** Every keyboard shortcut, over the whole window (Esc or a click outside closes it). */
function ShortcutsSheet({ onClose }) {
    return createPortal(
        <div className="shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={onClose}>
            <div className="shortcuts__sheet" onMouseDown={(e) => e.stopPropagation()}>
                <div className="shortcuts__head">
                    <Keyboard size={18} />
                    <h2>Keyboard shortcuts</h2>
                    <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
                        <X size={16} />
                    </button>
                </div>
                <div className="shortcuts__body">
                    {GROUPS.map((group) => (
                        <section key={group.title} className="shortcuts__group">
                            <h3>{group.title}</h3>
                            {group.rows.map(([label, keys]) => (
                                <div key={label} className="shortcuts__row">
                                    <span>{label}</span>
                                    <span className="shortcuts__keys">
                                        {keys.map((key, i) => (
                                            <span key={key} style={{ display: 'contents' }}>
                                                {i > 0 && 'or'}
                                                <kbd>{key}</kbd>
                                            </span>
                                        ))}
                                    </span>
                                </div>
                            ))}
                        </section>
                    ))}
                </div>
            </div>
        </div>,
        document.body,
    );
}

/**
 * The bottom of the map's control rail: light / dark (T) and the keyboard
 * shortcuts sheet (?). The new appearance grows out of the button.
 */
function QuickActions() {
    const { theme } = useTheme();
    const [sheetOpen, setSheetOpen] = useState(false);
    const dark = theme === 'dark';

    // Capture phase: while the sheet is open, its keys never reach the app's own shortcuts.
    useEffect(() => {
        const onKey = (e) => {
            if (sheetOpen) {
                if (e.key === 'Escape' || e.key === '?') setSheetOpen(false);
                if (e.key !== 'Tab') e.stopPropagation();
                return;
            }
            if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key === '?') {
                e.stopPropagation();
                setSheetOpen(true);
            } else if (e.key === 't' || e.key === 'T') {
                e.stopPropagation();
                const btn = document.querySelector('.quick-actions__btn')?.getBoundingClientRect();
                switchTheme(dark ? 'light' : 'dark', btn ? { x: btn.left + btn.width / 2, y: btn.top + btn.height / 2 } : null);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [sheetOpen, dark]);

    return (
        <>
            <div className="quick-actions">
                <button
                    type="button"
                    className="quick-actions__btn"
                    onClick={(e) => switchTheme(dark ? 'light' : 'dark', { x: e.clientX, y: e.clientY })}
                    title={dark ? 'Light appearance (T)' : 'Dark appearance (T)'}
                    aria-label={dark ? 'Switch to the light appearance' : 'Switch to the dark appearance'}
                >
                    {dark
                        ? <Sun key="sun" size={18} className="quick-actions__theme-icon" />
                        : <Moon key="moon" size={18} className="quick-actions__theme-icon" />}
                </button>
                <button
                    type="button"
                    className="quick-actions__btn"
                    onClick={() => setSheetOpen(true)}
                    title="Keyboard shortcuts (?)"
                    aria-label="Keyboard shortcuts"
                >
                    <Keyboard size={18} />
                </button>
            </div>
            {sheetOpen && <ShortcutsSheet onClose={() => setSheetOpen(false)} />}
        </>
    );
}

export default QuickActions;
