import { describe, expect, it } from 'vitest';
import { cssClip, cssMatrix, drawMatrix, gridToCanvas } from '../../src/geometry/matrix';

const base = { cssWidth: 50, cssHeight: 20, defaultWidth: 100, defaultHeight: 40 };
const values = (m: DOMMatrixReadOnly | null) => (m ? [m.a, m.b, m.c, m.d, m.e, m.f] : null);

describe('drawMatrix', () => {
  const id = new DOMMatrix();
  it('maps the border box to the default size for 2 arguments', () => {
    expect(values(drawMatrix(id, { ...base, args: [10, 5] }))).toEqual([2, 0, 0, 2, 10, 5]);
  });
  it('scales to the destination size for 4 arguments', () => {
    expect(values(drawMatrix(id, { ...base, args: [0, 0, 50, 20] }))).toEqual([1, 0, 0, 1, 0, 0]);
  });
  it('offsets by the source rect for 6 arguments', () => {
    expect(values(drawMatrix(id, { ...base, args: [10, 5, 20, 10, 0, 0] }))).toEqual([2, 0, 0, 2, -20, -10]);
  });
  it('maps source to destination for 8 arguments', () => {
    expect(values(drawMatrix(id, { ...base, args: [10, 0, 25, 20, 4, 6, 100, 40] }))).toEqual([4, 0, 0, 2, -36, 6]);
  });
  it('applies the context transform first', () => {
    expect(values(drawMatrix(new DOMMatrix().translate(7, 3), { ...base, args: [1, 1] }))).toEqual([2, 0, 0, 2, 8, 4]);
  });
  it('rejects degenerate source rects', () => {
    expect(drawMatrix(id, { ...base, args: [0, 0, 0, 10, 0, 0, 10, 10] })).toBeNull();
  });
});

describe('gridToCanvas', () => {
  it('divides by the grid scale and adds the content origin', () => {
    const grid = new DOMMatrix([2, 0, 0, 2, 20, 10]);
    expect(values(gridToCanvas(grid, 5, 5, 2, 2))).toEqual([1, 0, 0, 1, 15, 10]);
  });
});

describe('css helpers', () => {
  it('formats 2D and 3D matrices', () => {
    expect(cssMatrix(new DOMMatrix([1, -0, 0, 1, 3, 4]))).toBe('matrix(1,0,0,1,3,4)');
    const m = new DOMMatrix();
    m.m34 = -0.01;
    expect(cssMatrix(m)).toBe('matrix3d(1,0,0,0,0,1,0,0,0,0,1,-0.01,0,0,0,1)');
  });
  it('formats a clip polygon', () => {
    expect(cssClip(new DOMRect(1, 2, 3, 4))).toBe('polygon(1px 2px,4px 2px,4px 6px,1px 6px)');
  });
});
