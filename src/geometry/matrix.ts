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
 *   `scale`, which is exact when it has no skew or perspective after dividing the
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
  const p = n.multiply(locked.transform.inverse());
  if (!isFiniteMatrix(p) || p.m14 !== 0 || p.m24 !== 0 || p.m34 !== 0 || p.m44 !== 1) return null;
  const columns = [
    [p.m11, p.m12, p.m13],
    [p.m21, p.m22, p.m23],
    [p.m31, p.m32, p.m33],
  ];
  const s = columns.map((c) => Math.hypot(c[0]!, c[1]!, c[2]!));
  if (s.some((v) => !(v > 1e-12))) return null;
  const r = columns.map((c, i) => c.map((v) => v / s[i]!));
  const [r0, r1, r2] = r as [number[], number[], number[]];
  // A reflection goes into the x scale, so the rest is a rotation.
  const det =
    r0[0]! * (r1[1]! * r2[2]! - r1[2]! * r2[1]!) -
    r1[0]! * (r0[1]! * r2[2]! - r0[2]! * r2[1]!) +
    r2[0]! * (r0[1]! * r1[2]! - r0[2]! * r1[1]!);
  if (det < 0) {
    s[0] = -s[0]!;
    r[0] = r0.map((v) => -v);
  }
  const rotate = rotateValue(r as [number[], number[], number[]]);
  const declarations =
    `translate:${fmt(p.m41)}px ${fmt(p.m42)}px ${fmt(p.m43)}px!important;` +
    `rotate:${rotate}!important;scale:${s.map(fmt).join(' ')}!important;`;
  // Rebuild what the browser will compute and require it to match.
  const rebuilt = new DOMMatrix()
    .translate(p.m41, p.m42, p.m43)
    .multiply(rotate === 'none' ? new DOMMatrix() : rotationOf(rotate))
    .scale(s[0], s[1], s[2]);
  const want = p.toFloat64Array();
  const got = rebuilt.toFloat64Array();
  return want.every((v, i) => Math.abs(v - got[i]!) <= 1e-6 * Math.max(1, Math.abs(v))) ? declarations : null;
}

/** A CSS `rotate` value for an orthonormal, right-handed matrix given as columns. */
function rotateValue([c0, c1, c2]: [number[], number[], number[]]): string {
  const deg = (rad: number) => (rad * 180) / Math.PI;
  // About z only: a plain 2D angle.
  if (Math.abs(c0[2]!) < 1e-12 && Math.abs(c1[2]!) < 1e-12 && Math.abs(c2[0]!) < 1e-12 && Math.abs(c2[1]!) < 1e-12 && c2[2]! > 0) {
    const angle = deg(Math.atan2(c0[1]!, c0[0]!));
    return angle === 0 ? 'none' : `${fmt(angle)}deg`;
  }
  // Axis and angle through the quaternion, which stays stable near 180°.
  const m = (row: number, col: number) => [c0, c1, c2][col]![row]!;
  const trace = m(0, 0) + m(1, 1) + m(2, 2);
  let w: number, x: number, y: number, z: number;
  if (trace > 0) {
    const k = Math.sqrt(trace + 1) * 2;
    w = k / 4;
    x = (m(2, 1) - m(1, 2)) / k;
    y = (m(0, 2) - m(2, 0)) / k;
    z = (m(1, 0) - m(0, 1)) / k;
  } else if (m(0, 0) > m(1, 1) && m(0, 0) > m(2, 2)) {
    const k = Math.sqrt(1 + m(0, 0) - m(1, 1) - m(2, 2)) * 2;
    w = (m(2, 1) - m(1, 2)) / k;
    x = k / 4;
    y = (m(0, 1) + m(1, 0)) / k;
    z = (m(0, 2) + m(2, 0)) / k;
  } else if (m(1, 1) > m(2, 2)) {
    const k = Math.sqrt(1 + m(1, 1) - m(0, 0) - m(2, 2)) * 2;
    w = (m(0, 2) - m(2, 0)) / k;
    x = (m(0, 1) + m(1, 0)) / k;
    y = k / 4;
    z = (m(1, 2) + m(2, 1)) / k;
  } else {
    const k = Math.sqrt(1 + m(2, 2) - m(0, 0) - m(1, 1)) * 2;
    w = (m(1, 0) - m(0, 1)) / k;
    x = (m(0, 2) + m(2, 0)) / k;
    y = (m(1, 2) + m(2, 1)) / k;
    z = k / 4;
  }
  const length = Math.hypot(x, y, z);
  if (length < 1e-12) return 'none';
  const angle = deg(2 * Math.atan2(length, w));
  return `${fmt(x / length)} ${fmt(y / length)} ${fmt(z / length)} ${fmt(angle)}deg`;
}

/** The matrix of a `rotate` value written by `rotateValue`. */
function rotationOf(value: string): DOMMatrix {
  const parts = value.split(' ').map(parseFloat);
  if (parts.length === 1) return new DOMMatrix().rotateAxisAngle(0, 0, 1, parts[0]);
  return new DOMMatrix().rotateAxisAngle(parts[0], parts[1], parts[2], parts[3]);
}

/** `polygon()` for a clip rectangle in the element's border-box coordinates. */
export function cssClip(r: DOMRectReadOnly): string {
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  return `polygon(${x0}px ${y0}px,${x1}px ${y0}px,${x1}px ${y1}px,${x0}px ${y1}px)`;
}
