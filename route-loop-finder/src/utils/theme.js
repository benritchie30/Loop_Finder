import { createContext, useContext, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

/**
 * Light / dark appearance. The preference ('system' | 'light' | 'dark') is
 * saved in this browser; 'system' follows the device. The resolved theme is
 * written to <html data-theme>, which every colour token in index.css keys
 * off (index.html sets it before the first paint, so there is no flash).
 * `darkTiles`: in the dark theme, internet map tiles are dimmed to match.
 * `uiStyle`: 'classic' (plain solid panels, the system font, no effects) or
 * 'modern' (frosted glass, gradients, glows, motion), on <html data-style>;
 * classic.css restyles the same components for 'classic'.
 */

const THEME_KEY = 'theme';
const TILES_KEY = 'darkMapTiles';
const STYLE_KEY = 'uiStyle';
const PREFERENCES = ['system', 'light', 'dark'];
const STYLES = ['classic', 'modern'];
const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';
const media = hasDom && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function read(key) {
    try {
        return hasDom ? localStorage.getItem(key) : null;
    } catch {
        return null;
    }
}

function write(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // private window: the choice lasts for this visit
    }
}

let preference = PREFERENCES.includes(read(THEME_KEY)) ? read(THEME_KEY) : 'system';
let darkTiles = read(TILES_KEY) !== '0';
let uiStyle = STYLES.includes(read(STYLE_KEY)) ? read(STYLE_KEY) : 'classic';
let snapshot = null;
const listeners = new Set();

function resolved() {
    if (preference === 'system') return media?.matches ? 'dark' : 'light';
    return preference;
}

function apply() {
    const theme = resolved();
    snapshot = { preference, theme, darkTiles, uiStyle };
    if (!hasDom) return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.style = uiStyle;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1117' : '#f6f8fb');
}

function emit() {
    apply();
    listeners.forEach((listener) => listener());
}

apply();
media?.addEventListener?.('change', () => {
    if (preference === 'system') emit();
});

function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function setThemePreference(next) {
    if (!PREFERENCES.includes(next) || next === preference) return;
    preference = next;
    write(THEME_KEY, next);
    emit();
}

export function setUiStyle(next) {
    if (!STYLES.includes(next) || next === uiStyle) return;
    uiStyle = next;
    write(STYLE_KEY, next);
    emit();
}

export function setDarkTiles(on) {
    darkTiles = !!on;
    write(TILES_KEY, darkTiles ? '1' : '0');
    emit();
}

/**
 * Change the theme with a circular reveal growing from (x, y) (the button
 * that was pressed), where the browser can do it; a plain switch elsewhere.
 */
export function switchTheme(next, origin = null) {
    const after = next === 'system' ? (media?.matches ? 'dark' : 'light') : next;
    const reduce = hasDom && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // The same look (system -> what the system already shows): nothing to reveal.
    const hidden = hasDom && document.visibilityState !== 'visible'; // nothing would animate
    // The classic style has no effects: a plain switch.
    if (!hasDom || !document.startViewTransition || reduce || hidden || uiStyle === 'classic' || after === resolved()) {
        setThemePreference(next);
        return;
    }
    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const root = document.documentElement;
    root.style.setProperty('--reveal-x', `${x}px`);
    root.style.setProperty('--reveal-y', `${y}px`);
    root.style.setProperty('--reveal-r', `${radius}px`);
    root.classList.add('theme-reveal');
    const transition = document.startViewTransition(() => {
        flushSync(() => setThemePreference(next));
    });
    transition.finished.finally(() => root.classList.remove('theme-reveal'));
}

/** { preference, theme: 'light' | 'dark', darkTiles, uiStyle: 'classic' | 'modern' } */
export function useTheme() {
    return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/**
 * Is the map itself dark (MapView provides it)? Lines drawn on it pick light
 * colours then. Not the same as the theme: satellite imagery is always dark,
 * and tiles can be left bright in the dark theme.
 */
export const MapDarkContext = createContext(false);
export const useMapDark = () => useContext(MapDarkContext);
