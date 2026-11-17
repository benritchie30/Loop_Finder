import { describe, expect, it } from 'vitest';
import { numberFromText } from '../numberInput';

describe('numberFromText (Advanced number boxes)', () => {
    const firstBatch = { min: 1, max: 200, integer: true, empty: 50 };

    it('a blank box stands for its default', () => {
        expect(numberFromText('', firstBatch)).toBe(50);
        expect(numberFromText('  ', firstBatch)).toBe(50);
        expect(numberFromText(null, firstBatch)).toBe(50);
        expect(numberFromText('', { min: 1, max: 100, integer: true, empty: 20 })).toBe(20);
    });

    it('an optional box left blank stays empty (null: the server default)', () => {
        expect(numberFromText('', { min: 0 })).toBeNull();
    });

    it('a number in range is taken as typed', () => {
        expect(numberFromText('7', firstBatch)).toBe(7);
        expect(numberFromText('75', firstBatch)).toBe(75);
        expect(numberFromText('08', firstBatch)).toBe(8);
    });

    it('a number out of range is brought into it', () => {
        expect(numberFromText('0', firstBatch)).toBe(1);
        expect(numberFromText('500', firstBatch)).toBe(200);
        expect(numberFromText('5', { min: 10, max: 1000, empty: 50 })).toBe(10);
        expect(numberFromText('-3', { min: 0 })).toBe(0);
    });

    it('batch sizes are whole numbers; road weights keep decimals', () => {
        expect(numberFromText('12.6', firstBatch)).toBe(13);
        expect(numberFromText('2.5', { min: 0 })).toBe(2.5);
    });

    it('no limits: any number', () => {
        expect(numberFromText('1e3')).toBe(1000);
        expect(numberFromText('-4.5')).toBe(-4.5);
    });

    it('text that is not a number stands for the default', () => {
        expect(numberFromText('abc', firstBatch)).toBe(50);
        expect(numberFromText('-', { min: 0, empty: 4 })).toBe(4);
    });
});
