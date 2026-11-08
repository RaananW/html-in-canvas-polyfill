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

const none = (v: string | undefined): v is undefined => !v || v === 'none';

/** The origin of a computed `transform-origin`, in CSS pixels. */
export function originOf(value: string | undefined, width: number, height: number): [number, number, number] {
  const [ox, oy, oz] = (value || '0 0').split(/\s+/);
  return [px(ox, width), px(oy, height), px(oz, 0)];
}

/** The matrix of a computed `translate` value. */
export function translateMatrix(value: string | undefined, width: number, height: number): DOMMatrix {
  if (none(value)) return new DOMMatrix();
  const [tx, ty, tz] = value.split(/\s+/);
  return new DOMMatrix().translate(px(tx, width), px(ty, height), px(tz, 0));
}

/** The matrix of a computed `rotate` value. */
export function rotateMatrix(value: string | undefined): DOMMatrix {
  if (none(value)) return new DOMMatrix();
  const parts = value.split(/\s+/);
  if (parts.length === 2) return new DOMMatrix(`rotate${parts[0]!.toUpperCase()}(${parts[1]})`);
  if (parts.length === 4) return new DOMMatrix(`rotate3d(${parts.join(',')})`);
  return new DOMMatrix(`rotate(${parts[0]})`);
}

/** The matrix of a computed `scale` value. */
export function scaleMatrix(value: string | undefined): DOMMatrix {
  if (none(value)) return new DOMMatrix();
  const [sx = '1', sy, sz] = value.split(/\s+/);
  const x = parseFloat(sx);
  return new DOMMatrix().scale(x, sy === undefined ? x : parseFloat(sy), sz === undefined ? 1 : parseFloat(sz));
}

/**
 * The full local transform of a box from its computed style, including the
 * individual transform properties and transform-origin. Null when none.
 */
export function localTransform(cs: TransformStyle, width: number, height: number): DOMMatrix | null {
  if (none(cs.transform) && none(cs.translate) && none(cs.rotate) && none(cs.scale)) return null;
  const [originX, originY, originZ] = originOf(cs.transformOrigin, width, height);
  let m = new DOMMatrix().translate(originX, originY, originZ);
  m = m.multiply(translateMatrix(cs.translate, width, height));
  m = m.multiply(rotateMatrix(cs.rotate));
  m = m.multiply(scaleMatrix(cs.scale));
  if (!none(cs.transform)) m = m.multiply(new DOMMatrix(cs.transform));
  return m.translate(-originX, -originY, -originZ);
}

/**
 * Transform properties the page has set inline with `!important`. No stylesheet
 * rule can override them, so the overlay has to work around them. Each value is
 * the property's matrix (about the transform origin); `origin` is in CSS pixels.
 */
export interface LockedTransform {
  origin?: [number, number, number];
  transform?: DOMMatrix;
  translate?: DOMMatrix;
  rotate?: DOMMatrix;
  scale?: DOMMatrix;
}

const fmt = (v: number) => String(Object.is(v, -0) ? 0 : v);

/**
 * Declarations that give an element the full transform `x` (origin 0 0) when
 * the properties in `locked` cannot be overridden. The CSS transform is
 * origin · translate · rotate · scale · transform · origin⁻¹, so:
 *
 * - With `transform` free, the locked individual properties are divided out of it.
 * - With `transform` locked, `x` must be expressed by `translate`, `rotate` and
 *   `scale`, which is exact for 2D geometry without skew after dividing the
 *   locked transform out.
 *
 * Null when `x` can't be expressed exactly; the element must then not be hit.
 */
export function overlayTransform(x: DOMMatrixReadOnly, locked: LockedTransform = {}): string | null {
  const [ox, oy, oz] = locked.origin ?? [0, 0, 0];
  // The transform the properties must produce about the origin.
  const n = new DOMMatrix().translate(-ox, -oy, -oz).multiply(x).translate(ox, oy, oz);
  const free = 'translate:none!important;rotate:none!important;scale:none!important;';
  if (!locked.transform) {
    const parts = new DOMMatrix()
      .multiply(locked.translate ?? new DOMMatrix())
      .multiply(locked.rotate ?? new DOMMatrix())
      .multiply(locked.scale ?? new DOMMatrix());
    const t = parts.isIdentity ? n : parts.inverse().multiply(n);
    return isFiniteMatrix(t) ? `transform:${cssMatrix(t)}!important;${free}` : null;
  }
  if (locked.translate || locked.rotate || locked.scale) return null;
  // translate · rotate · scale about z: any 2D geometry without skew.
  const p = n.multiply(locked.transform.inverse());
  const sy = Math.hypot(p.c, p.d);
  // A reflection goes into the x scale.
  const sx = Math.hypot(p.a, p.b) * (p.a * p.d - p.b * p.c < 0 ? -1 : 1);
  if (!(sy > 1e-12) || !(Math.abs(sx) > 1e-12)) return null;
  const angle = (Math.atan2(p.b / sx, p.a / sx) * 180) / Math.PI;
  // Rebuild what the browser will compute and require it to match.
  const want = p.toFloat64Array();
  const got = new DOMMatrix().translate(p.e, p.f).rotate(angle).scale(sx, sy).toFloat64Array();
  if (!want.every((v, i) => Math.abs(v - got[i]!) <= 1e-6 * Math.max(1, Math.abs(v)))) return null;
  return `translate:${fmt(p.e)}px ${fmt(p.f)}px!important;rotate:${fmt(angle)}deg!important;scale:${fmt(sx)} ${fmt(sy)}!important;`;
}

/** `polygon()` for a clip rectangle in the element's border-box coordinates. */
export function cssClip(r: DOMRectReadOnly): string {
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  return `polygon(${x0}px ${y0}px,${x1}px ${y0}px,${x1}px ${y1}px,${x0}px ${y1}px)`;
}
