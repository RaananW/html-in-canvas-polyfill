import { drawElementImage, recordFor } from './contexts/2d';
import { invalidState, isElement } from './dom';
import { createElementImage, ElementImage, elementImageRecord } from './element-image';
import { nearestState } from './host/canvas-state';
import { CanvasPaintEvent } from './paint/event';
import { getState, observeRoot, syncCanvas } from './runtime';

type Restore = () => void;
const restores: Restore[] = [];

function define(target: object, name: string, descriptor: PropertyDescriptor): void {
  const previous = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, enumerable: true, ...descriptor });
  restores.push(() => {
    if (previous) Object.defineProperty(target, name, previous);
    else delete (target as Record<string, unknown>)[name];
  });
}

function method(target: object, name: string, fn: (...args: never[]) => unknown): void {
  define(target, name, { value: fn, writable: true, enumerable: true });
}

/** An `on<type>` IDL event handler attribute. */
function eventHandler(target: object, type: string): void {
  const handlers = new WeakMap<EventTarget, { fn: unknown; listener: EventListener }>();
  define(target, `on${type}`, {
    get(this: EventTarget) {
      return handlers.get(this)?.fn ?? null;
    },
    set(this: EventTarget, value: unknown) {
      const previous = handlers.get(this);
      if (previous) this.removeEventListener(type, previous.listener);
      handlers.delete(this);
      if (typeof value !== 'function') return;
      const listener = (event: Event) => {
        const result = (value as (e: Event) => unknown).call(this, event);
        if (result === false) event.preventDefault();
      };
      handlers.set(this, { fn: value, listener });
      this.addEventListener(type, listener);
    },
  });
}

function sizeOf(canvas: HTMLCanvasElement, source: unknown): { width: number; height: number } {
  if (source instanceof ElementImage) {
    const record = elementImageRecord(source);
    return { width: record.defaultWidth, height: record.defaultHeight };
  }
  if (!isElement(source)) throw new TypeError("The provided value is not of type '(Element or ElementImage)'.");
  const state = nearestState(source);
  if (!state || state.canvas !== canvas) {
    throw invalidState('The element is not a descendant of this <canvas>.');
  }
  const { scaleX, scaleY } = state.measure();
  const el = source as HTMLElement;
  return { width: (el.offsetWidth ?? 0) * scaleX, height: (el.offsetHeight ?? 0) * scaleY };
}

export function patch(): void {
  const canvasProto = HTMLCanvasElement.prototype;
  define(canvasProto, 'content', {
    get(this: HTMLCanvasElement) {
      return this.getAttribute('content')?.toLowerCase() === 'drawable' ? 'drawable' : 'fallback';
    },
    set(this: HTMLCanvasElement, value: unknown) {
      this.setAttribute('content', String(value));
      syncCanvas(this);
    },
  });
  define(canvasProto, 'layoutSubtree', {
    get(this: HTMLCanvasElement) {
      return this.hasAttribute('layoutsubtree');
    },
    set(this: HTMLCanvasElement, value: unknown) {
      this.toggleAttribute('layoutsubtree', Boolean(value));
      syncCanvas(this);
    },
  });
  eventHandler(canvasProto, 'paint');
  eventHandler(canvasProto, 'elementgeometryupdate');
  method(canvasProto, 'requestPaint', function (this: HTMLCanvasElement) {
    getState(this)?.requestPaint();
  });
  method(canvasProto, 'captureElementImage', function (this: HTMLCanvasElement, element: Element) {
    if (element instanceof ElementImage) throw new TypeError("The provided value is not of type 'Element'.");
    return createElementImage(recordFor(this, element));
  });
  method(canvasProto, 'getElementImageDefaultSize', function (this: HTMLCanvasElement, source: unknown) {
    return sizeOf(this, source);
  });

  method(CanvasRenderingContext2D.prototype, 'drawElementImage', drawElementImage);
  if (!('drawElement' in CanvasRenderingContext2D.prototype)) {
    method(CanvasRenderingContext2D.prototype, 'drawElement', drawElementImage);
  }
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    method(OffscreenCanvasRenderingContext2D.prototype, 'drawElementImage', drawElementImage);
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    method(OffscreenCanvas.prototype, 'getElementImageDefaultSize', function (source: unknown) {
      if (!(source instanceof ElementImage)) throw new TypeError("The provided value is not of type 'ElementImage'.");
      const record = elementImageRecord(source);
      return { width: record.defaultWidth, height: record.defaultHeight };
    });
  }

  const g = globalThis as Record<string, unknown>;
  if (!('ElementImage' in g)) define(g, 'ElementImage', { value: ElementImage, writable: true, enumerable: false });
  if (!('CanvasPaintEvent' in g)) {
    define(g, 'CanvasPaintEvent', { value: CanvasPaintEvent, writable: true, enumerable: false });
  }

  // Canvases inside shadow roots are found through the roots' own observers.
  const attachShadow = Element.prototype.attachShadow;
  method(Element.prototype, 'attachShadow', function (this: Element, init: ShadowRootInit) {
    const root = attachShadow.call(this, init);
    observeRoot(root);
    return root;
  });
}

export function unpatch(): void {
  for (const restore of restores.splice(0).reverse()) restore();
}
