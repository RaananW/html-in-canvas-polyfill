import { composedParent, HOST_ATTR, isElement, reverseTreeOrder } from '../dom';
import { CanvasPaintEvent } from '../paint/event';
import { SnapshotRecord } from '../snapshot/record';
import { snapshot } from '../snapshot/serializer';

export type HostMode = 'auto' | 'authoring';

/** Owning state of every live host element, for nearest-canvas lookups. */
const hostStates = new WeakMap<Element, CanvasState>();

/** Inherited properties copied from the canvas so the host behaves as if the content were still inside it. */
const INHERITED_FROM_CANVAS = [
  'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant',
  'font-feature-settings', 'font-kerning', 'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-indent', 'text-transform', 'text-shadow', 'white-space', 'direction',
  'writing-mode', 'visibility', 'cursor', 'color-scheme', 'accent-color', 'caret-color',
  '-webkit-font-smoothing',
];

const BLOCKIFY: Record<string, string> = {
  inline: 'block',
  'inline-block': 'block',
  'inline-flex': 'flex',
  'inline-grid': 'grid',
  'inline-table': 'table',
  'inline flow-root': 'block',
};

export const BLOCKIFY_ATTR = 'data-hic-blockify';

export interface StateCallbacks {
  schedule(): void;
  onError(error: unknown): void;
}

export class CanvasState {
  readonly host: HTMLElement;
  readonly mode: HostMode;
  private readonly hostStyleBackup: string | null;
  /** Committed snapshots: the ones drawElementImage uses. */
  readonly snapshots = new Map<Element, SnapshotRecord>();
  /** Finished snapshots waiting for the next paint event. */
  private readonly ready = new Map<Element, SnapshotRecord>();
  private readonly dirty = new Set<Element>();
  private readonly inFlight = new Set<Element>();
  private readonly redo = new Set<Element>();
  private readonly animating = new Set<Element>();
  private readonly observed = new Set<Element>();
  private allDirty = true;
  private paintRequested = false;
  private structureChanged = true;
  private readonly resizeObserver: ResizeObserver;
  private readonly listeners: Array<[string, EventListener]> = [];
  scaleX = 1;
  scaleY = 1;
  private contentWidth = 0;
  private contentHeight = 0;
  private hostLeft = 0;
  private hostTop = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly callbacks: StateCallbacks,
  ) {
    const authoring = findAuthoringHost(canvas);
    this.mode = authoring ? 'authoring' : 'auto';
    this.host = authoring ?? canvas.ownerDocument.createElement('div');
    this.hostStyleBackup = authoring ? authoring.getAttribute('style') : null;
    if (!authoring) {
      this.host.setAttribute(HOST_ATTR, '');
      canvas.after(this.host);
      this.adoptChildren();
    }
    hostStates.set(this.host, this);

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === this.canvas) this.allDirty = true;
        else this.markWithAncestors(entry.target);
      }
      this.callbacks.schedule();
    });
    this.resizeObserver.observe(canvas);

    const markTarget = (e: Event) => {
      if (isElement(e.target)) this.markNode(e.target);
    };
    const animationStart = (e: Event) => {
      const d = isElement(e.target) ? this.drawableFor(e.target) : null;
      if (d) this.animating.add(d);
      this.callbacks.schedule();
    };
    for (const type of ['input', 'change', 'focusin', 'focusout', 'scroll', 'load', 'error', 'toggle']) {
      this.listeners.push([type, markTarget]);
    }
    for (const type of ['animationstart', 'transitionrun', 'animationend', 'transitionend', 'animationcancel', 'transitioncancel']) {
      this.listeners.push([type, type.endsWith('start') || type.endsWith('run') ? animationStart : markTarget]);
    }
    for (const [type, fn] of this.listeners) this.host.addEventListener(type, fn, true);

    this.layoutHost();
    this.callbacks.schedule();
  }

  /** Auto mode: canvas children become children of the host, in order. */
  adoptChildren(): void {
    if (this.mode !== 'auto' || !this.canvas.firstChild) return;
    const fragment = this.canvas.ownerDocument.createDocumentFragment();
    while (this.canvas.firstChild) fragment.appendChild(this.canvas.firstChild);
    this.host.appendChild(fragment);
    this.structureChanged = true;
    this.allDirty = true;
  }

  get legacy(): boolean {
    return this.canvas.hasAttribute('layoutsubtree') && !this.canvas.hasAttribute('content');
  }

  isDrawable(el: Element): boolean {
    if (el.hasAttribute('drawable')) return true;
    // The legacy `layoutsubtree` API made every child drawable.
    return this.legacy && el.parentNode === this.host;
  }

  /** The nearest drawable at or above `node` within this host, or null. */
  drawableFor(node: Node): Element | null {
    for (let n: Node | null = node; n && n !== this.host; n = composedParent(n)) {
      if (isElement(n) && this.isDrawable(n)) return n;
    }
    return null;
  }

  drawables(): Element[] {
    const found: Element[] = [];
    const visit = (root: ParentNode) => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (this.isDrawable(el) && nearestState(el) === this) found.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(this.host);
    return found;
  }

  markNode(node: Node): void {
    const d = this.drawableFor(node);
    if (d) this.dirty.add(d);
    else this.allDirty = true;
    this.callbacks.schedule();
  }

  /** A change on `el` itself can affect inherited styles of nested drawables too. */
  markSubtree(el: Element): void {
    this.markNode(el);
    for (const d of this.observed) if (el.contains(d)) this.dirty.add(d);
  }

  markWithAncestors(el: Element): void {
    for (let n: Node | null = el; n && n !== this.host; n = composedParent(n)) {
      if (isElement(n) && this.isDrawable(n)) this.dirty.add(n);
    }
  }

  markAll(): void {
    this.allDirty = true;
    this.callbacks.schedule();
  }

  markStructure(): void {
    this.structureChanged = true;
    this.allDirty = true;
    this.callbacks.schedule();
  }

  requestPaint(): void {
    this.paintRequested = true;
    this.callbacks.schedule();
  }

  /** Sizes and positions the host over the canvas content box. */
  /** The canvas content box in CSS pixels and the CSS-to-grid scale. */
  measure(cs = getComputedStyle(this.canvas)) {
    const canvas = this.canvas;
    const px = (v: string) => parseFloat(v) || 0;
    const padL = px(cs.paddingLeft);
    const padT = px(cs.paddingTop);
    const width = Math.max(0, canvas.clientWidth - padL - px(cs.paddingRight));
    const height = Math.max(0, canvas.clientHeight - padT - px(cs.paddingBottom));
    const scaleX = width > 0 ? canvas.width / width : 1;
    const scaleY = height > 0 ? canvas.height / height : 1;
    return { padL, padT, width, height, scaleX, scaleY };
  }

  layoutHost(): void {
    const canvas = this.canvas;
    const cs = getComputedStyle(canvas);
    const { padL, padT, width, height, scaleX, scaleY } = this.measure(cs);
    if (scaleX !== this.scaleX || scaleY !== this.scaleY || width !== this.contentWidth || height !== this.contentHeight) {
      this.allDirty = true;
    }
    this.scaleX = scaleX;
    this.scaleY = scaleY;
    this.contentWidth = width;
    this.contentHeight = height;

    const style = this.host.style;
    // Only write changed values: every style write queues a mutation record.
    const set = (name: string, value: string, important = true) => {
      if (style.getPropertyValue(name) !== value || (style.getPropertyPriority(name) === 'important') !== important) {
        style.setProperty(name, value, important ? 'important' : '');
      }
    };
    const position = cs.position === 'fixed' ? 'fixed' : 'absolute';
    if (style.getPropertyValue('position') !== position) this.hostLeft = this.hostTop = 0;
    set('position', position);
    set('width', `${width}px`);
    set('height', `${height}px`);
    set('box-sizing', 'content-box');
    set('margin', '0px');
    set('padding', '0px');
    set('border', 'none');
    set('opacity', '0');
    set('pointer-events', 'none');
    set('overflow', 'clip');
    set('display', 'block');
    set('transform', 'none');
    for (const name of INHERITED_FROM_CANVAS) {
      const value = cs.getPropertyValue(name);
      if (value) set(name, value, false);
    }
    if (canvas.lang && this.host.lang !== canvas.lang) this.host.lang = canvas.lang;
    if (canvas.dir && this.host.dir !== canvas.dir) this.host.dir = canvas.dir;

    // Move the host by the difference between where it is and where the
    // canvas content box is. This works for any offset parent.
    set('left', `${this.hostLeft}px`);
    set('top', `${this.hostTop}px`);
    const cr = canvas.getBoundingClientRect();
    const hr = this.host.getBoundingClientRect();
    const dx = cr.left + canvas.clientLeft + padL - hr.left;
    const dy = cr.top + canvas.clientTop + padT - hr.top;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      this.hostLeft += dx;
      this.hostTop += dy;
      set('left', `${this.hostLeft}px`);
      set('top', `${this.hostTop}px`);
    }
  }

  /** Native canvases blockify their immediate children. */
  private blockifyChildren(): void {
    for (const child of Array.from(this.host.children)) {
      const previous = child.getAttribute(BLOCKIFY_ATTR);
      if (previous) child.removeAttribute(BLOCKIFY_ATTR);
      const target = BLOCKIFY[getComputedStyle(child).display];
      if (target) child.setAttribute(BLOCKIFY_ATTR, target);
    }
  }

  private syncStructure(): void {
    this.blockifyChildren();
    const current = new Set(this.drawables());
    for (const el of this.observed) {
      if (!current.has(el)) {
        this.resizeObserver.unobserve(el);
        this.observed.delete(el);
        this.snapshots.get(el)?.release();
        this.snapshots.delete(el);
        this.ready.get(el)?.release();
        this.ready.delete(el);
        this.animating.delete(el);
      }
    }
    for (const el of current) {
      if (!this.observed.has(el)) {
        this.observed.add(el);
        this.resizeObserver.observe(el);
      }
    }
  }

  /** One frame of work. Returns true while more frames are needed. */
  tick(): boolean {
    if (this.structureChanged) {
      this.structureChanged = false;
      this.syncStructure();
    }
    this.layoutHost();
    if (this.allDirty) {
      this.allDirty = false;
      for (const el of this.observed) this.dirty.add(el);
    }
    for (const el of this.animating) {
      if (!el.isConnected || !el.getAnimations({ subtree: true }).some((a) => a.playState === 'running')) {
        this.animating.delete(el);
      }
      this.dirty.add(el);
    }
    for (const el of this.dirty) {
      if (!this.observed.has(el)) continue;
      if (this.inFlight.has(el)) this.redo.add(el);
      else this.capture(el);
    }
    this.dirty.clear();

    if (this.ready.size > 0 || this.paintRequested) this.dispatchPaint();
    return this.inFlight.size > 0 || this.dirty.size > 0 || this.animating.size > 0;
  }

  private capture(el: Element): void {
    this.inFlight.add(el);
    const scaleX = this.scaleX;
    const scaleY = this.scaleY;
    snapshot(el, { scaleX, scaleY, isBoundary: (e) => hostStates.has(e) || this.isDrawable(e) })
      .then(
        (result) => {
          if (!this.observed.has(el)) {
            result.bitmap?.close();
            return;
          }
          this.ready.get(el)?.release();
          this.ready.set(el, new SnapshotRecord(result, scaleX, scaleY));
        },
        (error: unknown) => this.callbacks.onError(error),
      )
      .finally(() => {
        this.inFlight.delete(el);
        if (this.redo.delete(el)) this.dirty.add(el);
        this.callbacks.schedule();
      });
  }

  private dispatchPaint(): void {
    for (const [el, record] of this.ready) {
      this.snapshots.get(el)?.release();
      this.snapshots.set(el, record);
    }
    const changedElements = reverseTreeOrder(this.ready.keys());
    this.ready.clear();
    this.paintRequested = false;
    this.canvas.dispatchEvent(new CanvasPaintEvent('paint', { changedElements }));
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    for (const [type, fn] of this.listeners) this.host.removeEventListener(type, fn, true);
    for (const record of this.snapshots.values()) record.release();
    for (const record of this.ready.values()) record.release();
    this.snapshots.clear();
    this.ready.clear();
    this.observed.clear();
    for (const child of Array.from(this.host.children)) child.removeAttribute(BLOCKIFY_ATTR);
    hostStates.delete(this.host);
    if (this.mode === 'auto') {
      while (this.host.firstChild) this.canvas.appendChild(this.host.firstChild);
      this.host.remove();
    } else if (this.hostStyleBackup === null) {
      this.host.removeAttribute('style');
    } else {
      this.host.setAttribute('style', this.hostStyleBackup);
    }
  }
}

function findAuthoringHost(canvas: HTMLCanvasElement): HTMLElement | null {
  const usable = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && !hostStates.has(el);
  const next = canvas.nextElementSibling;
  if (usable(next) && next.getAttribute(HOST_ATTR) === '') return next;
  if (canvas.id) {
    const named = canvas.ownerDocument.querySelector(`[${HOST_ATTR}="${CSS.escape(canvas.id)}"]`);
    if (usable(named)) return named;
  }
  return null;
}

/** The state of the nearest polyfilled canvas that `node` belongs to. */
export function nearestState(node: Node): CanvasState | null {
  for (let n = composedParent(node); n; n = composedParent(n)) {
    if (isElement(n)) {
      const state = hostStates.get(n);
      if (state) return state;
    }
  }
  return null;
}

export function stateForHost(el: Element): CanvasState | undefined {
  return hostStates.get(el);
}
