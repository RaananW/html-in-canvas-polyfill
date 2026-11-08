import type { GPUDrawElementImageDestination, GPUDrawElementImageSource } from '../types.js';
import type { Resolve } from './draw.js';
import { allOrNone, isDirectCopy, rasterize, uploadRegion } from './upload.js';

const fail = (message: string) =>
  new TypeError(`Failed to execute 'drawElementImageToTexture' on 'GPUQueue': ${message}`);

function extent(size: GPUExtent3D | undefined): [number | undefined, number | undefined] {
  if (size === undefined) return [undefined, undefined];
  if (Symbol.iterator in Object(size)) {
    const [w, h = 1] = Array.from(size as Iterable<number>);
    return [w, h];
  }
  const dict = size as GPUExtent3DDict;
  return [dict.width, dict.height ?? 1];
}

/** GPUQueue.drawElementImageToTexture, finding snapshots with `resolve`. */
export function drawElementImageToTextureWith(resolve: Resolve) {
  return function drawElementImageToTexture(
    this: GPUQueue,
    source: GPUDrawElementImageSource,
    destination: GPUDrawElementImageDestination,
  ): void {
    if (typeof source !== 'object' || source === null) throw fail("parameter 1 is not of type 'GPUDrawElementImageSource'.");
    if (typeof destination !== 'object' || destination === null) {
      throw fail("parameter 2 is not of type 'GPUDrawElementImageDestination'.");
    }
    const record = resolve(this, source.source);
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
  };
}
