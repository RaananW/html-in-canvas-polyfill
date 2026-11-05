import type { SnapshotRecord } from '../snapshot/record.js';

/** The part of a snapshot to upload, and the size it's uploaded at. */
export interface UploadRegion {
  /** Source rectangle in bitmap pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Destination size in texels. */
  width: number;
  height: number;
}

/** Native rejects a group of optional members that is only partly given. */
export function allOrNone(values: unknown[], names: string): void {
  const given = values.filter((v) => v !== undefined).length;
  if (given !== 0 && given !== values.length) {
    throw new DOMException(`Must specify ${values.length > 2 ? 'all or none' : 'neither or both'} of (${names}).`, 'OperationError');
  }
}

const num = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v));

/**
 * Resolves an optional source rectangle (CSS pixels) and destination size
 * (texels). The default destination is the source in canvas grid pixels.
 */
export function uploadRegion(
  record: SnapshotRecord,
  sx?: unknown,
  sy?: unknown,
  sw?: unknown,
  sh?: unknown,
  width?: unknown,
  height?: unknown,
): UploadRegion {
  const x = num(sx) ?? 0;
  const y = num(sy) ?? 0;
  const w = num(sw) ?? record.cssWidth - x;
  const h = num(sh) ?? record.cssHeight - y;
  const kx = record.cssWidth > 0 ? record.width / record.cssWidth : 0;
  const ky = record.cssHeight > 0 ? record.height / record.cssHeight : 0;
  const gx = record.cssWidth > 0 ? record.defaultWidth / record.cssWidth : 0;
  const gy = record.cssHeight > 0 ? record.defaultHeight / record.cssHeight : 0;
  return {
    x: x * kx,
    y: y * ky,
    w: w * kx,
    h: h * ky,
    width: Math.max(0, Math.round(num(width) ?? w * gx)),
    height: Math.max(0, Math.round(num(height) ?? h * gy)),
  };
}

/** True when the region is a whole-pixel crop of the bitmap at its own size. */
export function isDirectCopy(record: SnapshotRecord, r: UploadRegion): boolean {
  return (
    !!record.bitmap &&
    [r.x, r.y, r.w, r.h].every(Number.isInteger) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.x + r.w <= record.width &&
    r.y + r.h <= record.height &&
    r.w === r.width &&
    r.h === r.height
  );
}

let scratch: HTMLCanvasElement | undefined;

/** Renders the region into a shared canvas of the destination size. Valid until the next call. */
export function rasterize(record: SnapshotRecord, r: UploadRegion): HTMLCanvasElement {
  scratch ??= document.createElement('canvas');
  // Assigning the size clears the canvas, even when it is unchanged.
  scratch.width = r.width;
  scratch.height = r.height;
  const ctx = scratch.getContext('2d')!;
  if (record.bitmap && r.w > 0 && r.h > 0) ctx.drawImage(record.bitmap, r.x, r.y, r.w, r.h, 0, 0, r.width, r.height);
  return scratch;
}
