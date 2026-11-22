import { describe, expect, it } from 'vitest';
import { whenText } from '../dates';

describe('short dates (Your loops, a pin\'s menu)', () => {
    const now = new Date(2025, 5, 15, 12, 0);

    it('today: the time', () => {
        expect(whenText(new Date(2025, 5, 15, 9, 5).getTime(), now)).toMatch(/9.05/);
    });

    it('this year: the day, no year', () => {
        const text = whenText(new Date(2025, 2, 3).getTime(), now);
        expect(text).toMatch(/3/);
        expect(text).not.toMatch(/2025/);
    });

    it('another year: with the year', () => {
        expect(whenText(new Date(2023, 2, 3).getTime(), now)).toMatch(/2023/);
    });

    it('nothing for no date or a bad one', () => {
        expect(whenText(0, now)).toBe('');
        expect(whenText(null, now)).toBe('');
        expect(whenText('not a date', now)).toBe('');
    });
});
