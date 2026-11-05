import { invalidState, isElement } from '../dom';
import { ElementImage, elementImageRecord } from '../element-image';
import { drawMatrix, gridToCanvas } from '../geometry/matrix';
import { placeholderOf, queueOffscreenGeometry } from '../geometry/offscreen';
import { nearestState } from '../host/canvas-state';
import { getState } from '../runtime';
import type { SnapshotRecord } from '../snapshot/record';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Resolves the snapshot to draw, throwing the errors the spec requires. */
export function recordFor(canvas: AnyCanvas, source: unknown): SnapshotRecord {
  if (source instanceof ElementImage) return elementImageRecord(source);
  if (!isElement(source)) throw new TypeError("The provided value is not of type '(Element or ElementImage)'.");
  if (!(canvas instanceof HTMLCanvasElement) || canvas.content !== 'drawable') {
    throw invalidState('DrawElementImage requires the canvas to have the content=drawable attribute.');
  }
  const state = nearestState(source);
  // Children not yet moved into a host (same task as insertion) have no snapshot yet.
  if (!state && source.parentElement === canvas) throw invalidState('No cached paint record for element.');
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

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawElementImage(this: Ctx2D, source: unknown, ...args: unknown[]): void {
  const numbers = parseDrawArgs(args);
  const record = recordFor(this.canvas, source);
  if (record.bitmap) {
    (this.drawImage as (image: CanvasImageSource, ...n: number[]) => void).call(
      this,
      record.bitmap,
      ...toDrawImageArgs(record, numbers),
    );
  }
  if (!drawOptions(args).preserveElementGeometry) updateDrawGeometry(this, record, numbers);
}

/** Points the drawn element's geometry at where this draw put it. */
function updateDrawGeometry(ctx: Ctx2D, record: SnapshotRecord, numbers: number[]): void {
  const canvas = ctx.canvas;
  const target = canvas instanceof HTMLCanvasElement ? canvas : placeholderOf(canvas);
  const state = target && getState(target);
  const element = record.element;
  if (!state || nearestState(element) !== state || !state.isDrawable(element)) return;
  const grid = drawMatrix(ctx.getTransform(), {
    args: numbers,
    cssWidth: record.cssWidth,
    cssHeight: record.cssHeight,
    defaultWidth: record.defaultWidth,
    defaultHeight: record.defaultHeight,
  });
  if (!grid) return;
  const scaleX = state.contentWidth > 0 ? canvas.width / state.contentWidth : 1;
  const scaleY = state.contentHeight > 0 ? canvas.height / state.contentHeight : 1;
  const transform = gridToCanvas(grid, state.contentLeft, state.contentTop, scaleX, scaleY);
  if (canvas instanceof HTMLCanvasElement) state.geometry.update(element, { transform });
  else queueOffscreenGeometry({ canvas: target!, element, update: { transform } });
}
