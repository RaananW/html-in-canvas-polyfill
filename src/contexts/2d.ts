import { invalidState, isElement } from '../dom';
import { ElementImage, elementImageRecord } from '../element-image';
import { nearestState } from '../host/canvas-state';
import type { SnapshotRecord } from '../snapshot/record';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Resolves the snapshot to draw, throwing the errors the spec requires. */
export function recordFor(canvas: AnyCanvas, source: unknown): SnapshotRecord {
  if (source instanceof ElementImage) return elementImageRecord(source);
  if (!isElement(source)) throw new TypeError("The provided value is not of type '(Element or ElementImage)'.");
  const state = nearestState(source);
  if (!state || state.canvas !== canvas) {
    throw invalidState('The element can only be drawn into its nearest ancestor <canvas>.');
  }
  if (!state.isDrawable(source)) throw invalidState('The element does not have the drawable attribute.');
  const record = state.snapshots.get(source);
  if (!record) throw invalidState('No cached paint record for element.');
  return record;
}

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

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawElementImage(this: Ctx2D, source: unknown, ...args: unknown[]): void {
  const numbers = parseDrawArgs(args);
  const record = recordFor(this.canvas, source);
  if (!record.bitmap) return;
  (this.drawImage as (image: CanvasImageSource, ...n: number[]) => void).call(
    this,
    record.bitmap,
    ...toDrawImageArgs(record, numbers),
  );
}
