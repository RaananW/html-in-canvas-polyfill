import { describe, expect, it } from 'vitest';
import { cssClip, cssMatrix, drawMatrix, gridToCanvas, overlayTransform } from '../../src/geometry/matrix';

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

describe('overlayTransform', () => {
  type Locked = { origin?: [number, number, number]; transform?: DOMMatrix };
  const close = (a: DOMMatrixReadOnly, b: DOMMatrixReadOnly) =>
    Array.from(a.toFloat64Array()).every((v, i) => Math.abs(v - b.toFloat64Array()[i]!) < 1e-6);
  const value = (css: string, name: string) => new RegExp(`(?:^|;)${name}:([^;!]+)!important`).exec(css)?.[1];
  const numbers = (v: string) => v.slice(v.indexOf('(') + 1, -1).split(',').map(Number);
  // What the browser computes: origin · translate · rotate · scale · transform · origin⁻¹.
  const applied = (css: string, locked: Locked = {}) => {
    const [ox, oy, oz] = locked.origin ?? [0, 0, 0];
    const t = value(css, 'transform');
    const transform = locked.transform ?? (t && t !== 'none' ? new DOMMatrix(numbers(t)) : new DOMMatrix());
    const translate = value(css, 'translate');
    const [tx = 0, ty = 0, tz = 0] = translate && translate !== 'none' ? translate.split(' ').map(parseFloat) : [];
    const rotate = value(css, 'rotate') ?? 'none';
    const angles = rotate.split(' ').map(parseFloat);
    const r =
      rotate === 'none'
        ? new DOMMatrix()
        : angles.length === 1
          ? new DOMMatrix().rotateAxisAngle(0, 0, 1, angles[0])
          : new DOMMatrix().rotateAxisAngle(angles[0], angles[1], angles[2], angles[3]);
    const scale = value(css, 'scale');
    const [sx = 1, sy = 1, sz = 1] = scale && scale !== 'none' ? scale.split(' ').map(parseFloat) : [];
    return new DOMMatrix()
      .translate(ox, oy, oz)
      .translate(tx, ty, tz)
      .multiply(r)
      .scale(sx, sy, sz)
      .multiply(transform)
      .translate(-ox, -oy, -oz);
  };

  it('writes the transform itself when nothing is locked', () => {
    const x = new DOMMatrix().translate(228, 86).rotate(30).scale(2, 0.5);
    const css = overlayTransform(x)!;
    expect(css).toMatch(/^transform:matrix\(/);
    expect(css).toContain('translate:none!important;rotate:none!important;scale:none!important;');
    expect(close(applied(css), x)).toBe(true);
  });

  it('uses translate, rotate and scale when the transform is locked', () => {
    const none = { transform: new DOMMatrix() };
    for (const x of [
      new DOMMatrix().translate(228, 86),
      new DOMMatrix().translate(10, 20).rotate(45).scale(2, 3),
      new DOMMatrix().translate(-3.5, 9).rotate(-120).scale(0.25),
      new DOMMatrix().rotate(180),
      new DOMMatrix().scale(-1, 1),
    ]) {
      const css = overlayTransform(x, none);
      expect(css, String(x)).not.toBeNull();
      expect(css).not.toContain('transform:');
      expect(close(applied(css!, none), x), `${String(x)} -> ${css}`).toBe(true);
    }
  });

  it('divides a locked transform and origin out', () => {
    const locked: Locked = { transform: new DOMMatrix().translate(40, 0).rotate(10), origin: [50, 20, 0] };
    const x = new DOMMatrix().translate(300, 100).rotate(25);
    expect(close(applied(overlayTransform(x, locked)!, locked), x)).toBe(true);
  });

  it('divides locked individual properties out of a free transform', () => {
    const css = overlayTransform(new DOMMatrix().translate(100, 50), {
      translate: new DOMMatrix().translate(10, 0),
      scale: new DOMMatrix().scale(2),
    })!;
    const full = new DOMMatrix().translate(10, 0).scale(2).multiply(new DOMMatrix(numbers(value(css, 'transform')!)));
    expect(close(full, new DOMMatrix().translate(100, 50))).toBe(true);
  });

  it('refuses a transform it cannot express rather than writing a wrong one', () => {
    const none = { transform: new DOMMatrix() };
    expect(overlayTransform(new DOMMatrix().skewX(20), none)).toBeNull();
    const perspective = new DOMMatrix();
    perspective.m34 = -0.002;
    expect(overlayTransform(perspective, none)).toBeNull();
    expect(overlayTransform(new DOMMatrix().translate(0, 0, 5), none)).toBeNull();
    expect(overlayTransform(new DOMMatrix().rotateAxisAngle(1, 2, 3, 70), none)).toBeNull();
    expect(overlayTransform(new DOMMatrix().rotateAxisAngle(0, 1, 0, 180), none)).toBeNull();
    expect(overlayTransform(new DOMMatrix().scale(0, 1), none)).toBeNull();
    expect(overlayTransform(new DOMMatrix().scale(1, 0), none)).toBeNull();
    // A locked transform with a locked individual property leaves too little to set.
    expect(overlayTransform(new DOMMatrix().translate(1, 0), { ...none, translate: new DOMMatrix() })).toBeNull();
  });
});
