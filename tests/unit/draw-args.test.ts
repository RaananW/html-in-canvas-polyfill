import { describe, expect, it } from 'vitest';
import { parseDrawArgs, toDrawImageArgs } from '../../src/contexts/draw';
import { SnapshotRecord } from '../../src/snapshot/record';

// 50×20 CSS px element, rasterized at 2 device px per CSS px, canvas grid scale 2.
const record = new SnapshotRecord(
  { bitmap: null, width: 100, height: 40, cssWidth: 50, cssHeight: 20 },
  2,
  2,
  document.createElement('div'),
);

describe('parseDrawArgs', () => {
  it('accepts 2, 4, 6 and 8 numbers with an optional options object', () => {
    expect(parseDrawArgs([1, 2])).toEqual([1, 2]);
    expect(parseDrawArgs([1, 2, {}])).toEqual([1, 2]);
    expect(parseDrawArgs([1, 2, 3, 4, undefined])).toEqual([1, 2, 3, 4]);
    expect(parseDrawArgs([1, 2, 3, 4, 5, 6, null])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseDrawArgs([1, 2, 3, 4, 5, 6, 7, 8, { preserveElementGeometry: true }])).toHaveLength(8);
  });

  it('rejects other arities', () => {
    expect(() => parseDrawArgs([])).toThrow(TypeError);
    expect(() => parseDrawArgs([1])).toThrow(TypeError);
    expect(() => parseDrawArgs([1, 2, 3])).toThrow(TypeError);
    expect(() => parseDrawArgs([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toThrow(TypeError);
  });
});

describe('toDrawImageArgs', () => {
  it('defaults the destination size to grid pixels', () => {
    expect(toDrawImageArgs(record, [5, 6])).toEqual([5, 6, 100, 40]);
  });

  it('passes an explicit destination size through', () => {
    expect(toDrawImageArgs(record, [5, 6, 7, 8])).toEqual([5, 6, 7, 8]);
  });

  it('maps a CSS-pixel source rect and scales the destination to grid pixels', () => {
    expect(toDrawImageArgs(record, [10, 5, 20, 10, 0, 0])).toEqual([20, 10, 40, 20, 0, 0, 40, 20]);
  });

  it('maps the source rect and keeps an explicit destination', () => {
    expect(toDrawImageArgs(record, [10, 5, 20, 10, 1, 2, 3, 4])).toEqual([20, 10, 40, 20, 1, 2, 3, 4]);
  });
});
