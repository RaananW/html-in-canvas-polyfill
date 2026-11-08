import { describe, expect, it } from 'vitest';
import { snapToUnit } from '../../src/snapshot/serializer';

describe('snapToUnit', () => {
  it('restores a size rounded to six significant digits', () => {
    // 273.28125 px (17490/64) computes as "273.281px", which Blink reads back as 273.265625.
    expect(snapToUnit('273.281px', 1 / 64)).toBe('273.28125px');
    expect(snapToUnit('60.9219px', 1 / 64)).toBe('60.921875px');
  });

  it('keeps whole pixels and Gecko units', () => {
    expect(snapToUnit('34px', 1 / 64)).toBe('34px');
    expect(Number.parseFloat(snapToUnit('273.283px', 1 / 60)) * 60).toBeCloseTo(16397, 6);
  });

  it('leaves other values, and every value without a unit', () => {
    expect(snapToUnit('auto', 1 / 64)).toBe('auto');
    expect(snapToUnit('50%', 1 / 64)).toBe('50%');
    expect(snapToUnit('calc(1px + 2%)', 1 / 64)).toBe('calc(1px + 2%)');
    expect(snapToUnit('273.281px', 0)).toBe('273.281px');
  });
});
