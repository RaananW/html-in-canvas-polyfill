// The DOM-free part of drawing and uploading snapshots, shared by the main
// thread and the worker entry.
import { ElementImage, elementImageRecord } from '../element-image.js';
import type { SnapshotRecord } from '../snapshot/record.js';

/** Finds the snapshot a draw or upload call names, throwing the errors the spec requires. */
export type Resolve = (canvas: unknown, source: unknown) => SnapshotRecord;

export const notSource = (type = '(Element or ElementImage)'): TypeError =>
  new TypeError(`The provided value is not of type '${type}'.`);

/** Off the main thread there are no elements, only ElementImages. */
export const imageRecord: Resolve = (_canvas, source) => {
  if (source instanceof ElementImage) return elementImageRecord(source);
  throw notSource();
};

/** Splits `(n1, …, nk, options?)` into the numbers and validates the overload. */
export function parseDrawArgs(args: unknown[]): number[] {
  const rest = args.slice();
  const last = rest[rest.length - 1];
  if (rest.length % 2 === 1 && (last === undefined || last === null || typeof last === 'object')) rest.pop();
  if (rest.length !== 2 && rest.length !== 4 && rest.length !== 6 && rest.length !== 8) {
    throw new TypeError(
      `Failed to execute 'drawElementImage': ${args.length + 1} arguments do not match any overload.`,
    );
  }
  return rest.map(Number);
}

/** The trailing DrawElementImageOptions dictionary, if any. */
export function drawOptions(args: unknown[]): { preserveElementGeometry: boolean } {
  const last = args.length % 2 === 1 ? args[args.length - 1] : undefined;
  const options = typeof last === 'object' && last !== null ? (last as { preserveElementGeometry?: unknown }) : {};
  return { preserveElementGeometry: Boolean(options.preserveElementGeometry) };
}

/**
 * Maps a drawElementImage call onto drawImage arguments. Source rectangles
 * are in the element's CSS pixels; the default destination size is the
 * element's size in canvas grid pixels (matching native Chromium).
 */
export function toDrawImageArgs(record: SnapshotRecord, n: number[]): number[] {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = n;
  const kx = record.width / record.cssWidth;
  const ky = record.height / record.cssHeight;
  const gx = record.defaultWidth / record.cssWidth;
  const gy = record.defaultHeight / record.cssHeight;
  switch (n.length) {
    case 2:
      return [a, b, record.defaultWidth, record.defaultHeight];
    case 4:
      return [a, b, c, d];
    case 6:
      return [a * kx, b * ky, c * kx, d * ky, e, f, c * gx, d * gy];
    default:
      return [a * kx, b * ky, c * kx, d * ky, e, f, g, h];
  }
}

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawRecord(ctx: Ctx2D, record: SnapshotRecord, numbers: number[]): void {
  if (!record.bitmap) return;
  (ctx.drawImage as (image: CanvasImageSource, ...n: number[]) => void).call(
    ctx,
    record.bitmap,
    ...toDrawImageArgs(record, numbers),
  );
}
