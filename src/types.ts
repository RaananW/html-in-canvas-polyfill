import type { ElementImage } from './element-image.js';
import type { CanvasPaintEvent, ElementGeometryUpdateEvent } from './paint/event.js';

export type CanvasContent = 'fallback' | 'drawable';

export interface DrawElementImageOptions {
  preserveElementGeometry?: boolean;
}

export interface ElementImageSize {
  width: number;
  height: number;
}

export interface UpdateElementGeometryOptions {
  /** Maps the element's border box, in CSS pixels, to the canvas border box in CSS pixels. */
  canvasTransform?: DOMMatrixInit;
  /** Restricts hit testing to this rectangle, in the element's local CSS pixels. */
  canvasClip?: DOMRectInit;
  /** Keep the element's current hit-test order instead of moving it to the top. */
  preserveHitTestOrder?: boolean;
}

type DrawSource = Element | ElementImage;

/** Source rectangle in CSS pixels; destination size in texels (defaults to the source in grid pixels). */
export interface WebGLCopyElementImageConfig {
  sx?: number;
  sy?: number;
  swidth?: number;
  sheight?: number;
  width?: number;
  height?: number;
}

interface TexElementSubImage2D {
  texElementSubImage2D(
    target: GLenum,
    level: GLint,
    xoffset: GLint,
    yoffset: GLint,
    source: DrawSource,
    config?: WebGLCopyElementImageConfig,
  ): void;
}

/** Source rectangle in CSS pixels. */
export interface GPUDrawElementImageSource {
  source: DrawSource;
  sourceX?: number;
  sourceY?: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

/** Destination size in texels; defaults to the source in grid pixels. */
export interface GPUDrawElementImageDestination extends GPUCopyExternalImageDestInfo {
  size?: GPUExtent3D;
}

interface DrawElementImage {
  drawElementImage(source: DrawSource, dx: number, dy: number, options?: DrawElementImageOptions): void;
  drawElementImage(
    source: DrawSource,
    dx: number,
    dy: number,
    dwidth: number,
    dheight: number,
    options?: DrawElementImageOptions,
  ): void;
  drawElementImage(
    source: DrawSource,
    sx: number,
    sy: number,
    swidth: number,
    sheight: number,
    dx: number,
    dy: number,
    options?: DrawElementImageOptions,
  ): void;
  drawElementImage(
    source: DrawSource,
    sx: number,
    sy: number,
    swidth: number,
    sheight: number,
    dx: number,
    dy: number,
    dwidth: number,
    dheight: number,
    options?: DrawElementImageOptions,
  ): void;
}

declare global {
  interface HTMLCanvasElement {
    content: CanvasContent;
    /** @deprecated Use `content = 'drawable'`. */
    layoutSubtree: boolean;
    onpaint: ((this: HTMLCanvasElement, event: CanvasPaintEvent) => unknown) | null;
    requestPaint(): void;
    captureElementImage(element: Element): ElementImage;
    getElementImageDefaultSize(source: DrawSource): ElementImageSize;
    updateElementGeometry(source: DrawSource, options?: UpdateElementGeometryOptions): void;
    clearElementGeometry(source: DrawSource): void;
    getElementTransform(element: Element): DOMMatrix;
  }

  interface HTMLCanvasElementEventMap {
    paint: CanvasPaintEvent;
    elementgeometryupdate: ElementGeometryUpdateEvent;
  }

  interface OffscreenCanvas {
    getElementImageDefaultSize(source: ElementImage): ElementImageSize;
    updateElementGeometry(source: DrawSource, options?: UpdateElementGeometryOptions): void;
    clearElementGeometry(source: DrawSource): void;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface CanvasRenderingContext2D extends DrawElementImage {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface OffscreenCanvasRenderingContext2D extends DrawElementImage {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface WebGLRenderingContext extends TexElementSubImage2D {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface WebGL2RenderingContext extends TexElementSubImage2D {}
  interface GPUQueue {
    drawElementImageToTexture(source: GPUDrawElementImageSource, destination: GPUDrawElementImageDestination): void;
  }
}
