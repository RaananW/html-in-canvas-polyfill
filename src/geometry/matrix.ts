// Pure matrix helpers for element geometry. Coordinates are CSS pixels unless
// a name says "grid" (canvas bitmap pixels).

export interface DrawGeometryInput {
  /** The 2, 4, 6 or 8 numeric drawElementImage arguments. */
  args: number[];
  /** The element's border box in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** The default destination size in grid pixels. */
  defaultWidth: number;
  defaultHeight: number;
}

/**
 * The grid-space matrix a 2D draw maps the element's border box with:
 * ctx · translate(d) · scale(dsize / ssize) · translate(−s). Null when the
 * mapping is degenerate.
 */
export function drawMatrix(ctxTransform: DOMMatrixReadOnly, input: DrawGeometryInput): DOMMatrix | null {
  const { args, cssWidth, cssHeight, defaultWidth, defaultHeight } = input;
  let sx = 0;
  let sy = 0;
  let sw = cssWidth;
  let sh = cssHeight;
  let dx: number;
  let dy: number;
  let dw = defaultWidth;
  let dh = defaultHeight;
  switch (args.length) {
    case 2:
      [dx = 0, dy = 0] = args;
      break;
    case 4:
      [dx = 0, dy = 0, dw = 0, dh = 0] = args;
      break;
    case 6:
      [sx = 0, sy = 0, sw = 0, sh = 0, dx = 0, dy = 0] = args;
      dw = cssWidth > 0 ? (sw * defaultWidth) / cssWidth : 0;
      dh = cssHeight > 0 ? (sh * defaultHeight) / cssHeight : 0;
      break;
    default:
      [sx = 0, sy = 0, sw = 0, sh = 0, dx = 0, dy = 0, dw = 0, dh = 0] = args;
  }
  const kx = dw / sw;
  const ky = dh / sh;
  if (![kx, ky, sx, sy, dx, dy].every(Number.isFinite)) return null;
  return DOMMatrix.fromMatrix(ctxTransform).translate(dx, dy).scale(kx, ky).translate(-sx, -sy);
}

/** Maps a grid-space matrix to the canvas border box in CSS pixels. */
export function gridToCanvas(
  grid: DOMMatrixReadOnly,
  contentLeft: number,
  contentTop: number,
  scaleX: number,
  scaleY: number,
): DOMMatrix {
  return new DOMMatrix().translate(contentLeft, contentTop).scale(1 / scaleX, 1 / scaleY).multiply(grid);
}

export function isFiniteMatrix(m: DOMMatrixReadOnly): boolean {
  return Array.from(m.toFloat64Array()).every(Number.isFinite);
}

/** A CSS `transform` value for `m`. */
export function cssMatrix(m: DOMMatrixReadOnly): string {
  const n = (v: number) => (Object.is(v, -0) ? 0 : v);
  if (m.is2D) return `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map(n).join(',')})`;
  return `matrix3d(${Array.from(m.toFloat64Array()).map(n).join(',')})`;
}

const px = (value: string | undefined, basis: number): number => {
  if (!value) return 0;
  return value.endsWith('%') ? (parseFloat(value) / 100) * basis : parseFloat(value) || 0;
};

export interface TransformStyle {
  transform: string;
  transformOrigin: string;
  translate: string;
  rotate: string;
  scale: string;
}

/**
 * The full local transform of a box from its computed style, including the
 * individual transform properties and transform-origin. Null when none.
 */
export function localTransform(cs: TransformStyle, width: number, height: number): DOMMatrix | null {
  const none = (v: string | undefined) => !v || v === 'none';
  if (none(cs.transform) && none(cs.translate) && none(cs.rotate) && none(cs.scale)) return null;
  const [ox, oy, oz] = (cs.transformOrigin || '0 0').split(/\s+/);
  const originX = px(ox, width);
  const originY = px(oy, height);
  const originZ = px(oz, 0);
  let m = new DOMMatrix().translate(originX, originY, originZ);
  if (!none(cs.translate)) {
    const [tx, ty, tz] = cs.translate.split(/\s+/);
    m = m.translate(px(tx, width), px(ty, height), px(tz, 0));
  }
  if (!none(cs.rotate)) {
    const parts = cs.rotate.split(/\s+/);
    if (parts.length === 2) m = m.multiply(new DOMMatrix(`rotate${parts[0]!.toUpperCase()}(${parts[1]})`));
    else if (parts.length === 4) m = m.multiply(new DOMMatrix(`rotate3d(${parts.join(',')})`));
    else m = m.multiply(new DOMMatrix(`rotate(${parts[0]})`));
  }
  if (!none(cs.scale)) {
    const [sx = '1', sy, sz] = cs.scale.split(/\s+/);
    const x = parseFloat(sx);
    m = m.scale(x, sy === undefined ? x : parseFloat(sy), sz === undefined ? 1 : parseFloat(sz));
  }
  if (!none(cs.transform)) m = m.multiply(new DOMMatrix(cs.transform));
  return m.translate(-originX, -originY, -originZ);
}

/** `polygon()` for a clip rectangle in the element's border-box coordinates. */
export function cssClip(r: DOMRectReadOnly): string {
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  return `polygon(${x0}px ${y0}px,${x1}px ${y0}px,${x1}px ${y1}px,${x0}px ${y1}px)`;
}
