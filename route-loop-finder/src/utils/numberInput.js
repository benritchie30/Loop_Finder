/**
 * The value a number box's text stands for (Advanced settings' number
 * boxes): the number brought into [min, max] (rounded first when `integer`),
 * or `empty` when the text is blank or not a number. null min / max: no limit.
 */
export function numberFromText(text, { min = null, max = null, integer = false, empty = null } = {}) {
    const trimmed = text == null ? '' : String(text).trim();
    const num = trimmed === '' ? NaN : Number(trimmed);
    if (!Number.isFinite(num)) return empty;
    let value = integer ? Math.round(num) : num;
    if (min != null) value = Math.max(min, value);
    if (max != null) value = Math.min(max, value);
    return value;
}
