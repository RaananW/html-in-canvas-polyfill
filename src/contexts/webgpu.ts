import { invalidState, isElement } from '../dom';
import { ElementImage, elementImageRecord } from '../element-image';
import { nearestState } from '../host/canvas-state';
import type { SnapshotRecord } from '../snapshot/record';
import type { GPUDrawElementImageDestination, GPUDrawElementImageSource } from '../types';
import { allOrNone, isDirectCopy, rasterize, uploadRegion } from './upload';

const fail = (message: string) =>
  new TypeError(`Failed to execute 'drawElementImageToTexture' on 'GPUQueue': ${message}`);

/** Unlike 2D and WebGL, the element may belong to any drawable canvas. */
function gpuRecord(source: unknown): SnapshotRecord {
  if (source instanceof ElementImage) return elementImageRecord(source);
  if (!isElement(source)) throw fail("The provided value is not of type '(Element or ElementImage)'.");
  const state = nearestState(source);
  // Children not yet moved into a host (same task as insertion) have no snapshot yet.
  if (!state && source.parentElement instanceof HTMLCanvasElement) {
    throw invalidState('No cached paint record for element.');
  }
  if (!state) throw fail('Only children of a <canvas content=drawable> can be drawn.');
  if (!state.isDrawable(source)) throw invalidState('The element does not have the drawable attribute.');
  const record = state.snapshots.get(source);
  if (!record) throw invalidState('No cached paint record for element.');
  return record;
}

function extent(size: GPUExtent3D | undefined): [number | undefined, number | undefined] {
  if (size === undefined) return [undefined, undefined];
  if (Symbol.iterator in Object(size)) {
    const [w, h = 1] = Array.from(size as Iterable<number>);
    return [w, h];
  }
  const dict = size as GPUExtent3DDict;
  return [dict.width, dict.height ?? 1];
}

export function drawElementImageToTexture(
  this: GPUQueue,
  source: GPUDrawElementImageSource,
  destination: GPUDrawElementImageDestination,
): void {
  if (typeof source !== 'object' || source === null) throw fail("parameter 1 is not of type 'GPUDrawElementImageSource'.");
  if (typeof destination !== 'object' || destination === null) {
    throw fail("parameter 2 is not of type 'GPUDrawElementImageDestination'.");
  }
  const record = gpuRecord(source.source);
  const { sourceX, sourceY, sourceWidth, sourceHeight } = source;
  allOrNone([sourceX, sourceY, sourceWidth, sourceHeight], 'sourceX, sourceY, sourceWidth, sourceHeight');
  const { size, ...dest } = destination;
  const [width, height] = extent(size);
  const region = uploadRegion(record, sourceX, sourceY, sourceWidth, sourceHeight, width, height);
  if (region.width === 0 || region.height === 0) return;
  const copy: GPUCopyExternalImageSourceInfo = isDirectCopy(record, region)
    ? { source: record.bitmap!, origin: { x: region.x, y: region.y } }
    : { source: rasterize(record, region) };
  this.copyExternalImageToTexture(copy, dest, { width: region.width, height: region.height });
}
