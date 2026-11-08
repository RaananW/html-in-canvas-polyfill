// `@underglass/html-in-canvas-polyfill/worker`: import it in a worker that
// receives ElementImages from a polyfilled page. It revives them from their
// envelopes and installs drawElementImage on OffscreenCanvas 2D contexts,
// texElementSubImage2D on WebGL contexts, and drawElementImageToTexture on
// GPUQueue. Native workers need none of this, and the entry then does nothing.
import { drawRecord, imageRecord, notSource, parseDrawArgs } from './contexts/draw.js';
import { texElementSubImage2DWith } from './contexts/webgl.js';
import { drawElementImageToTextureWith } from './contexts/webgpu.js';
import { define, method, restoreAll } from './define.js';
import { ElementImage, elementImageRecord } from './element-image.js';
import { patchMessaging } from './transfer.js';

import './types.js';

export { ElementImage } from './element-image.js';

export interface WorkerInstallOptions {
  /** Install even when the worker supports ElementImage natively (testing only). */
  force?: boolean;
}

let installed = false;

/** True when this worker implements ElementImage itself. */
export function hasNativeSupport(): boolean {
  return (
    'ElementImage' in globalThis ||
    (typeof OffscreenCanvasRenderingContext2D !== 'undefined' && 'drawElementImage' in OffscreenCanvasRenderingContext2D.prototype)
  );
}

function drawElementImage(this: OffscreenCanvasRenderingContext2D, source: unknown, ...args: unknown[]): void {
  const numbers = parseDrawArgs(args);
  drawRecord(this, imageRecord(this.canvas, source), numbers);
}

function image(source: unknown): ElementImage {
  if (!(source instanceof ElementImage)) throw notSource('ElementImage');
  return source;
}

/** Installs the worker side unless the worker has native support. Idempotent; returns whether it's active. */
export function install(options: WorkerInstallOptions = {}): boolean {
  if (installed) return true;
  if (hasNativeSupport() && !options.force) return false;
  installed = true;
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    method(OffscreenCanvasRenderingContext2D.prototype, 'drawElementImage', drawElementImage);
  }
  const texElementSubImage2D = texElementSubImage2DWith(imageRecord);
  for (const gl of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (gl) method(gl.prototype, 'texElementSubImage2D', texElementSubImage2D);
  }
  if (typeof GPUQueue !== 'undefined') {
    method(GPUQueue.prototype, 'drawElementImageToTexture', drawElementImageToTextureWith(imageRecord));
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    method(OffscreenCanvas.prototype, 'getElementImageDefaultSize', function (source: unknown) {
      const record = elementImageRecord(image(source));
      return { width: record.defaultWidth, height: record.defaultHeight };
    });
    // Geometry from a worker doesn't reach the main thread yet (docs/LIMITATIONS.md).
    method(OffscreenCanvas.prototype, 'updateElementGeometry', function (source: unknown) {
      elementImageRecord(image(source));
    });
    method(OffscreenCanvas.prototype, 'clearElementGeometry', function (source: unknown) {
      elementImageRecord(image(source));
    });
  }
  define(globalThis, 'ElementImage', { value: ElementImage, writable: true, enumerable: false });
  patchMessaging();
  return true;
}

export function uninstall(): void {
  if (!installed) return;
  installed = false;
  restoreAll();
}

install();
