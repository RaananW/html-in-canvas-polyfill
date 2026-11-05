import { recordFor } from './2d';
import type { WebGLCopyElementImageConfig } from '../types';
import { allOrNone, rasterize, uploadRegion } from './upload';

type GL = WebGLRenderingContext | WebGL2RenderingContext;

/**
 * Uploads a snapshot with texSubImage2D. A canvas is uploaded rather than the
 * ImageBitmap, because WebGL ignores the UNPACK_* flags for ImageBitmaps.
 */
export function texElementSubImage2D(
  this: GL,
  target: number,
  level: number,
  xoffset: number,
  yoffset: number,
  source: unknown,
  config?: WebGLCopyElementImageConfig | null,
): void {
  if (arguments.length < 5) {
    throw new TypeError(`Failed to execute 'texElementSubImage2D': 5 arguments required, but only ${arguments.length} present.`);
  }
  const record = recordFor(this.canvas, source);
  const c = config ?? {};
  allOrNone([c.sx, c.sy, c.swidth, c.sheight], 'sx,sy,swidth,sheight');
  allOrNone([c.width, c.height], 'width,height');
  const region = uploadRegion(record, c.sx, c.sy, c.swidth, c.sheight, c.width, c.height);
  if (region.width === 0 || region.height === 0) return;
  this.texSubImage2D(target, level, xoffset, yoffset, this.RGBA, this.UNSIGNED_BYTE, rasterize(record, region));
}
