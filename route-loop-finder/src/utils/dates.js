/**
 * When something was made, short: the time for today ("3:05 PM"), else the
 * day ("Mar 3"), with the year when it is not this year ("Mar 3, 2024").
 * `now` is for tests.
 */
export function whenText(ts, now = new Date()) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
}
