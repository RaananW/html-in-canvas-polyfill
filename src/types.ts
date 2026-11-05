import type { ElementImage } from './element-image';
import type { CanvasPaintEvent } from './paint/event';

export type CanvasContent = 'fallback' | 'drawable';

export interface DrawElementImageOptions {
  preserveElementGeometry?: boolean;
}

export interface ElementImageSize {
  width: number;
  height: number;
}

type DrawSource = Element | ElementImage;

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
  }

  interface HTMLCanvasElementEventMap {
    paint: CanvasPaintEvent;
  }

  interface OffscreenCanvas {
    getElementImageDefaultSize(source: ElementImage): ElementImageSize;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface CanvasRenderingContext2D extends DrawElementImage {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface OffscreenCanvasRenderingContext2D extends DrawElementImage {}
}
