import { nearestState } from '../host/canvas-state.js';
import { ElementGeometryUpdateEvent } from '../paint/event.js';
import { getState } from '../runtime.js';
import { flushGeometry, type GeometryUpdate } from './state.js';

const placeholders = new WeakMap<OffscreenCanvas, HTMLCanvasElement>();

export function linkPlaceholder(offscreen: OffscreenCanvas, canvas: HTMLCanvasElement): void {
  placeholders.set(offscreen, canvas);
}

/** The canvas an OffscreenCanvas was transferred from on this thread. */
export function placeholderOf(offscreen: OffscreenCanvas): HTMLCanvasElement | undefined {
  return placeholders.get(offscreen);
}

interface Job {
  canvas: HTMLCanvasElement;
  element: Element;
  /** Null clears the geometry. */
  update: GeometryUpdate | null;
}

let queue: Job[] = [];

/** OffscreenCanvas geometry updates are batched in a microtask, then announced with an event. */
export function queueOffscreenGeometry(job: Job): void {
  if (queue.length === 0) queueMicrotask(applyQueued);
  queue.push(job);
}

function applyQueued(): void {
  const jobs = queue;
  queue = [];
  const applied = new Map<HTMLCanvasElement, Set<Element>>();
  for (const { canvas, element, update } of jobs) {
    const state = getState(canvas);
    if (!state || !element.isConnected || nearestState(element) !== state) continue;
    if (update) state.geometry.update(element, update);
    else state.geometry.clear(element);
    let set = applied.get(canvas);
    if (!set) applied.set(canvas, (set = new Set()));
    set.add(element);
  }
  flushGeometry();
  for (const [canvas, elements] of applied) {
    const connected = [...elements].filter((el) => el.isConnected);
    canvas.dispatchEvent(new ElementGeometryUpdateEvent('elementgeometryupdate', { elements: connected }));
  }
}
