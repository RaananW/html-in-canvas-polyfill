import { drawElementImage, gpuRecordFor, recordFor } from './contexts/2d.js';
import { texElementSubImage2DWith } from './contexts/webgl.js';
import { drawElementImageToTextureWith } from './contexts/webgpu.js';
import { define, method, restoreAll } from './define.js';
import { HOST_ATTR, invalidState, isElement } from './dom.js';
import { createElementImage, ElementImage, elementImageRecord, imageRecordFor } from './element-image.js';
import { linkPlaceholder, placeholderOf, queueOffscreenGeometry } from './geometry/offscreen.js';
import { flushGeometry, geometryOf, type GeometryUpdate } from './geometry/state.js';
import { autoCanvasOf, type CanvasState, nearestState } from './host/canvas-state.js';
import { CanvasPaintEvent, ElementGeometryUpdateEvent } from './paint/event.js';
import { getState, observeRoot, syncCanvas } from './runtime.js';
import { patchMessaging } from './transfer.js';

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
    const record = imageRecordFor(source, canvas);
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

function sourceElement(source: unknown): Element {
  const element = source instanceof ElementImage ? elementImageRecord(source).element : source;
  if (!isElement(element)) throw new TypeError("The provided value is not of type '(Element or ElementImage)'.");
  return element;
}

/** Resolves an updateElementGeometry/clearElementGeometry target, with the draw errors. */
function geometryTarget(canvas: HTMLCanvasElement, source: unknown): { state: CanvasState; element: Element } {
  const element = sourceElement(source);
  if (canvas.content !== 'drawable') {
    throw invalidState('Element geometry requires the canvas to have the content=drawable attribute.');
  }
  // Content inserted in this task has not been moved into the host yet.
  if (canvas.contains(element)) {
    syncCanvas(canvas);
    getState(canvas)?.adoptChildren();
  }
  const state = nearestState(element);
  if (!state || state.canvas !== canvas) {
    throw invalidState('The element can only be drawn into its nearest ancestor <canvas>.');
  }
  if (!state.isDrawable(element)) throw invalidState('The element does not have the drawable attribute.');
  return { state, element };
}

function geometryOptions(options: unknown): GeometryUpdate {
  if (options === undefined || options === null) return {};
  if (typeof options !== 'object' && typeof options !== 'function') {
    throw new TypeError("The provided value is not of type 'UpdateElementGeometryOptions'.");
  }
  const o = options as { canvasTransform?: DOMMatrixInit; canvasClip?: DOMRectInit; preserveHitTestOrder?: unknown };
  const update: GeometryUpdate = { preserveHitTestOrder: Boolean(o.preserveHitTestOrder) };
  if (o.canvasTransform !== undefined) update.transform = DOMMatrix.fromMatrix(o.canvasTransform);
  if (o.canvasClip !== undefined) update.clip = DOMRect.fromRect(o.canvasClip);
  return update;
}

/** Wraps a method so pending geometry is applied before it reads layout. */
function flushBefore(target: object, name: string): void {
  const original = (target as Record<string, unknown>)[name];
  if (typeof original !== 'function' || !Object.prototype.hasOwnProperty.call(target, name)) return;
  method(target, name, function (this: unknown, ...args: never[]) {
    flushGeometry();
    return (original as (...a: never[]) => unknown).apply(this, args);
  });
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
    return createElementImage(recordFor(this, element), this);
  });
  method(canvasProto, 'getElementImageDefaultSize', function (this: HTMLCanvasElement, source: unknown) {
    return sizeOf(this, source);
  });
  method(canvasProto, 'updateElementGeometry', function (this: HTMLCanvasElement, source: unknown, options?: unknown) {
    const update = geometryOptions(options);
    const { state, element } = geometryTarget(this, source);
    state.geometry.update(element, update);
  });
  method(canvasProto, 'clearElementGeometry', function (this: HTMLCanvasElement, source: unknown) {
    const { state, element } = geometryTarget(this, source);
    state.geometry.clear(element);
  });
  method(canvasProto, 'getElementTransform', function (this: HTMLCanvasElement, element: unknown) {
    if (!isElement(element)) throw new TypeError("The provided value is not of type 'Element'.");
    const state = nearestState(element);
    return state && state.canvas === this ? state.geometry.transformOf(element) : new DOMMatrix();
  });
  const transfer = canvasProto.transferControlToOffscreen;
  if (typeof transfer === 'function') {
    method(canvasProto, 'transferControlToOffscreen', function (this: HTMLCanvasElement) {
      const offscreen = transfer.call(this);
      linkPlaceholder(offscreen, this);
      return offscreen;
    });
  }

  method(CanvasRenderingContext2D.prototype, 'drawElementImage', drawElementImage);
  if (!('drawElement' in CanvasRenderingContext2D.prototype)) {
    method(CanvasRenderingContext2D.prototype, 'drawElement', drawElementImage);
  }
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    method(OffscreenCanvasRenderingContext2D.prototype, 'drawElementImage', drawElementImage);
  }
  const texElementSubImage2D = texElementSubImage2DWith(recordFor);
  for (const gl of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (gl) method(gl.prototype, 'texElementSubImage2D', texElementSubImage2D);
  }
  if (typeof GPUQueue !== 'undefined') {
    method(GPUQueue.prototype, 'drawElementImageToTexture', drawElementImageToTextureWith(gpuRecordFor));
  }
  patchMessaging();
  if (typeof OffscreenCanvas !== 'undefined') {
    method(OffscreenCanvas.prototype, 'getElementImageDefaultSize', function (this: OffscreenCanvas, source: unknown) {
      if (!(source instanceof ElementImage)) throw new TypeError("The provided value is not of type 'ElementImage'.");
      const record = imageRecordFor(source, placeholderOf(this), 'The ElementImage was captured from a different canvas.');
      return { width: record.defaultWidth, height: record.defaultHeight };
    });
    // Without a placeholder canvas on this thread there is nothing to update.
    method(OffscreenCanvas.prototype, 'updateElementGeometry', function (this: OffscreenCanvas, source: unknown, options?: unknown) {
      const update = geometryOptions(options);
      const element = sourceElement(source);
      const canvas = placeholderOf(this);
      if (canvas) queueOffscreenGeometry({ canvas, element, update });
    });
    method(OffscreenCanvas.prototype, 'clearElementGeometry', function (this: OffscreenCanvas, source: unknown) {
      const element = sourceElement(source);
      const canvas = placeholderOf(this);
      if (canvas) queueOffscreenGeometry({ canvas, element, update: null });
    });
  }

  const g = globalThis as Record<string, unknown>;
  if (!('ElementImage' in g)) define(g, 'ElementImage', { value: ElementImage, writable: true, enumerable: false });
  if (!('CanvasPaintEvent' in g)) {
    define(g, 'CanvasPaintEvent', { value: CanvasPaintEvent, writable: true, enumerable: false });
  }
  if (!('ElementGeometryUpdateEvent' in g)) {
    define(g, 'ElementGeometryUpdateEvent', { value: ElementGeometryUpdateEvent, writable: true, enumerable: false });
  }

  // Geometry is applied in a microtask; synchronous hit tests and box reads see it too.
  for (const name of ['elementFromPoint', 'elementsFromPoint', 'caretPositionFromPoint', 'caretRangeFromPoint']) {
    flushBefore(Document.prototype, name);
    if (typeof ShadowRoot !== 'undefined') flushBefore(ShadowRoot.prototype, name);
  }
  flushBefore(Element.prototype, 'getBoundingClientRect');
  flushBefore(Element.prototype, 'getClientRects');

  // Natively, element geometry leaves computed styles alone; the overlay rule must too.
  const getStyle = globalThis.getComputedStyle;
  method(globalThis, 'getComputedStyle', function (element: Element, pseudo?: string | null) {
    const style = getStyle(element, pseudo);
    const geometry = pseudo || !isElement(element) ? undefined : geometryOf(element);
    if (!geometry) return style;
    return new Proxy(style, {
      get(target, key) {
        if (key === 'getPropertyValue') {
          return (name: string) => {
            const read = () => target.getPropertyValue(name);
            return GEOMETRY_PROPS.has(name) ? geometry.authored(element, read) : read();
          };
        }
        if (typeof key === 'string' && GEOMETRY_PROPS.has(key)) return geometry.authored(element, () => target[key as 'zIndex']);
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });

  // Relocated canvas content still finds the canvas and its ancestors.
  const closest = Element.prototype.closest;
  method(Element.prototype, 'closest', function (this: Element, selectors: string) {
    const found = closest.call(this, selectors);
    const host = closest.call(this, `[${HOST_ATTR}]`);
    const canvas = host && host !== this ? autoCanvasOf(host) : null;
    if (!canvas || (found && found !== host && host!.contains(found))) return found;
    return canvas.closest(selectors);
  });

  // Canvases inside shadow roots are found through the roots' own observers.
  const attachShadow = Element.prototype.attachShadow;
  method(Element.prototype, 'attachShadow', function (this: Element, init: ShadowRootInit) {
    const root = attachShadow.call(this, init);
    observeRoot(root);
    return root;
  });
}

/** Properties the geometry overlay rule overrides, in both spellings. */
const GEOMETRY_PROPS = new Set(
  ['position', 'top', 'right', 'bottom', 'left', 'inset', 'transform', 'transform-origin', 'translate', 'rotate', 'scale', 'z-index', 'clip-path', 'pointer-events'].flatMap(
    (name) => [name, name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())],
  ),
);

export function unpatch(): void {
  restoreAll();
}
