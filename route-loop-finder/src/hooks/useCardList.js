import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * A list of route cards (`.route-card`, `data-route-id`) in its own scroll
 * box: a generation's routes (GenerationPanel) and the Favorites page.
 *
 * - The selected card sits in the middle of the list (as near as the ends
 *   allow), so the routes before and after it are one short move away. A
 *   clicked card is the exception: it stays under the pointer (centring it
 *   would slide another card under the pointer, which would preview that
 *   one); the list only scrolls to show all of it, never so far that it
 *   leaves the pointer. It centres again when the selection or `orderKey`
 *   (the sort, the grouping) changes, not when routes stream in.
 * - The card under the pointer is previewed on the map (onHoverPath).
 *   Crossing the gap between two cards keeps the last one; leaving the list
 *   ends it. Only a real pointer move previews (a card the list scrolls under
 *   a still pointer does not), and a new selection ends the preview.
 * - The mouse wheel scrolls one card per notch (a trackpad: one card per
 *   card's height of movement), so no card is skipped; when it settles, the
 *   card under the pointer is previewed.
 *
 * - onReselect (optional): the selected card clicked again (the Favorites
 *   page brings its route back into view).
 *
 * Returns { listRef, selectedRef, selectCard, hoverCard, leaveList }: the
 * list's and the selected card's refs, and the cards' handlers (one identity
 * each, so memoized cards do not render again for them).
 */

const LIST_EDGE_PX = 14; // the list fades its cards out this close to its edges
const LIST_TOP_PX = 10; // a card scrolled to the top of the list sits this far down (below the fade)
const WHEEL_NOTCH_PX = 50; // a wheel event this big is one notch of a mouse wheel
const WHEEL_CARD_PX = 66; // trackpad: about one card of movement steps one card
const WHEEL_SETTLE_MS = 700; // no scrollend event (older browsers): settled after this

/**
 * Where the list scrolls to put the next (dir 1) or previous (dir -1) card at
 * its top, going from scrollTop `from`; null at the end.
 */
function nextCardTop(list, from, dir) {
    const max = list.scrollHeight - list.clientHeight;
    const tops = [...list.querySelectorAll('.route-card')]
        .map((card) => Math.min(max, Math.max(0, card.offsetTop - LIST_TOP_PX)));
    if (dir > 0) {
        const next = tops.find((top) => top > from + 1);
        return next ?? null;
    }
    const before = tops.filter((top) => top < from - 1);
    return before.length ? before[before.length - 1] : null;
}

/**
 * Scroll the list just enough that a clicked card shows whole, but keep the
 * card under the pointer at pointerY (page px), so no other card slides there.
 */
function revealUnderPointer(list, card, pointerY) {
    const l = list.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    let delta = 0; // > 0 scrolls the list down (the card moves up)
    if (c.bottom > l.bottom - LIST_EDGE_PX) delta = c.bottom - (l.bottom - LIST_EDGE_PX);
    if (c.top - delta < l.top + LIST_EDGE_PX) delta = c.top - (l.top + LIST_EDGE_PX);
    if (pointerY != null) {
        const keep = 8; // px of the card kept between the pointer and the card's edge
        if (delta > 0) delta = Math.min(delta, Math.max(0, c.bottom - pointerY - keep));
        if (delta < 0) delta = Math.max(delta, -Math.max(0, pointerY - c.top - keep));
    }
    if (Math.abs(delta) < 1) return;
    if (typeof list.scrollTo === 'function') list.scrollTo({ top: list.scrollTop + delta, behavior: 'smooth' });
    else list.scrollTop += delta;
}

export function useCardList({ paths, currentId, onSelectPath, onHoverPath, onReselect = null, orderKey = '' }) {
    const listRef = useRef(null);
    const selectedRef = useRef(null);
    const pointerAt = useRef(null); // last pointer position over the list
    const clickedId = useRef(null); // a card was clicked: the selection it makes stays put
    // The handlers read what is current from refs, so they keep one identity
    // (even when the callers' callbacks do not).
    const currentIdRef = useRef(currentId);
    currentIdRef.current = currentId;
    const calls = useRef({});
    calls.current = { onSelectPath, onReselect };
    const selectCard = useCallback((id) => {
        if (id === currentIdRef.current) {
            // The selected card clicked again: bring it into view if it is
            // partly hidden (the same just-enough scroll as a new selection).
            clickedId.current = null;
            if (listRef.current && selectedRef.current) {
                revealUnderPointer(listRef.current, selectedRef.current, pointerAt.current?.y);
            }
            calls.current.onReselect?.(id);
            return;
        }
        clickedId.current = id;
        calls.current.onSelectPath(id);
    }, []);

    useLayoutEffect(() => {
        const list = listRef.current;
        const card = selectedRef.current;
        const clicked = clickedId.current != null && clickedId.current === currentId;
        clickedId.current = null;
        if (!list || !card) return;
        if (clicked) {
            revealUnderPointer(list, card, pointerAt.current?.y);
            return;
        }
        const top = card.offsetTop - (list.clientHeight - card.offsetHeight) / 2;
        const target = Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight));
        // Scroll even when the list seems to be there already: a glide from an
        // earlier change may still be running (and can read as being at the
        // target for a moment); a new scroll replaces it.
        // Glide to a nearby card; jump when it is far (a long glide is slow and disorienting).
        const far = Math.abs(list.scrollTop - target) > list.clientHeight * 1.5;
        if (typeof list.scrollTo === 'function') list.scrollTo({ top: target, behavior: far ? 'auto' : 'smooth' });
        else list.scrollTop = target;
        // Only when the selection or the order changes: new routes streaming in
        // must not pull the list away from where the user scrolled.
    }, [currentId, orderKey]);

    const previewId = useRef(null);
    const setPreview = useCallback((id) => {
        if (previewId.current === id) return;
        previewId.current = id;
        onHoverPath?.(id);
    }, [onHoverPath]);
    const hoverCard = useCallback((id, e) => {
        const last = pointerAt.current;
        if (last && last.x === e.clientX && last.y === e.clientY) return;
        pointerAt.current = { x: e.clientX, y: e.clientY };
        setPreview(id);
    }, [setPreview]);
    const leaveList = useCallback(() => {
        pointerAt.current = null;
        setPreview(null);
    }, [setPreview]);
    useEffect(() => {
        setPreview(null);
    }, [currentId, setPreview]);

    const pathsRef = useRef(paths);
    pathsRef.current = paths;
    useEffect(() => {
        const list = listRef.current;
        if (!list) return undefined;
        let collected = 0;
        let target = null; // where the queued steps end
        let stepping = false;
        let settleTimer = null;
        const settle = () => {
            if (!stepping) return;
            stepping = false;
            clearTimeout(settleTimer);
            target = null;
            const at = pointerAt.current;
            if (!at) return;
            const card = document.elementFromPoint(at.x, at.y)?.closest?.('.route-card');
            if (!card || !list.contains(card)) return;
            const path = pathsRef.current.find((p) => String(p.id) === card.dataset.routeId);
            if (path) setPreview(path.id);
        };
        const onWheel = (e) => {
            if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // pinch zoom, sideways
            e.preventDefault();
            let px = e.deltaY;
            if (e.deltaMode === 1) px *= 40; // lines
            else if (e.deltaMode === 2) px *= list.clientHeight; // pages
            collected += px;
            if (Math.abs(px) < WHEEL_NOTCH_PX && Math.abs(collected) < WHEEL_CARD_PX) return;
            const dir = Math.sign(collected);
            collected = 0;
            const next = nextCardTop(list, target ?? list.scrollTop, dir);
            if (next == null) return;
            target = next;
            stepping = true;
            if (typeof list.scrollTo === 'function') list.scrollTo({ top: next, behavior: 'smooth' });
            else list.scrollTop = next;
            clearTimeout(settleTimer);
            settleTimer = setTimeout(settle, WHEEL_SETTLE_MS);
        };
        list.addEventListener('wheel', onWheel, { passive: false });
        list.addEventListener('scrollend', settle);
        return () => {
            clearTimeout(settleTimer);
            list.removeEventListener('wheel', onWheel);
            list.removeEventListener('scrollend', settle);
        };
    }, [setPreview]);
    useEffect(() => () => onHoverPath?.(null), [onHoverPath]);

    return { listRef, selectedRef, selectCard, hoverCard, leaveList };
}
