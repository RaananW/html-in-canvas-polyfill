import { invalidState, isElement } from '../dom.js';
import { ElementImage, elementImageRecord, imageRecordFor } from '../element-image.js';
import { drawMatrix, gridToCanvas } from '../geometry/matrix.js';
import { placeholderOf, queueOffscreenGeometry } from '../geometry/offscreen.js';
import { nearestState } from '../host/canvas-state.js';
import { getState } from '../runtime.js';
import type { SnapshotRecord } from '../snapshot/record.js';
import { type Ctx2D, drawOptions, drawRecord, notSource, parseDrawArgs } from './draw.js';


/** Resolves the snapshot to draw, throwing the errors the spec requires. */
export function recordFor(canvas: unknown, source: unknown): SnapshotRecord {
  // An OffscreenCanvas stands for the canvas it was transferred from.
  if (source instanceof ElementImage) return imageRecordFor(source, canvasOf(canvas));
  if (!isElement(source)) throw notSource();
  if (!(canvas instanceof HTMLCanvasElement) || canvas.content !== 'drawable') {
    throw invalidState('DrawElementImage requires the canvas to have the content=drawable attribute.');
  }
  const state = nearestState(source);
  // Content not yet moved into a host (same task as insertion) have no snapshot yet.
  if (!state && canvas.contains(source)) throw invalidState('No cached paint record for element.');
  if (!state || state.canvas !== canvas) {
    throw invalidState('The element can only be drawn into its nearest ancestor <canvas>.');
  }
  if (!state.isDrawable(source)) throw invalidState('The element does not have the drawable attribute.');
  const record = state.snapshots.get(source);
  if (!record) throw invalidState('No cached paint record for element.');
  return record;
}

/** The HTMLCanvasElement a 2D or WebGL context draws to, on this thread. */
function canvasOf(canvas: unknown): HTMLCanvasElement | undefined {
  if (canvas instanceof HTMLCanvasElement) return canvas;
  return typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas ? placeholderOf(canvas) : undefined;
}

const gpuFail = (message: string) =>
  new TypeError(`Failed to execute 'drawElementImageToTexture' on 'GPUQueue': ${message}`);

/** Unlike 2D and WebGL, WebGPU accepts an element of any drawable canvas. */
export function gpuRecordFor(_queue: unknown, source: unknown): SnapshotRecord {
  if (source instanceof ElementImage) return elementImageRecord(source);
  if (!isElement(source)) throw gpuFail("The provided value is not of type '(Element or ElementImage)'.");
  const state = nearestState(source);
  // Content not yet moved into a host (same task as insertion) have no snapshot yet.
  if (!state && source.closest('canvas')) {
    throw invalidState('No cached paint record for element.');
  }
  if (!state) throw gpuFail('Only children of a <canvas content=drawable> can be drawn.');
  if (!state.isDrawable(source)) throw invalidState('The element does not have the drawable attribute.');
  const record = state.snapshots.get(source);
  if (!record) throw invalidState('No cached paint record for element.');
  return record;
}

export function drawElementImage(this: Ctx2D, source: unknown, ...args: unknown[]): void {
  const numbers = parseDrawArgs(args);
  const record = recordFor(this.canvas, source);
  drawRecord(this, record, numbers);
  if (!drawOptions(args).preserveElementGeometry) updateDrawGeometry(this, record, numbers);
}

/** Points the drawn element's geometry at where this draw put it. */
function updateDrawGeometry(ctx: Ctx2D, record: SnapshotRecord, numbers: number[]): void {
  const canvas = ctx.canvas;
  const target = canvas instanceof HTMLCanvasElement ? canvas : placeholderOf(canvas);
  const state = target && getState(target);
  const element = record.element;
  if (!state || !element || nearestState(element) !== state || !state.isDrawable(element)) return;
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
