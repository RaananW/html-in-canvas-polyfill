import { composedParent, computedStyle, HOST_ATTR, isElement, reverseTreeOrder } from '../dom.js';
import { Geometry } from '../geometry/state.js';
import { CanvasPaintEvent } from '../paint/event.js';
import { SnapshotRecord } from '../snapshot/record.js';
import { changedMatches, pageRules, sameSignature, type Signature, stateSignature } from '../snapshot/selectors.js';
import { deepActiveElement, selectionRange, textControl } from '../snapshot/selection.js';
import { snapshot, StyleCache } from '../snapshot/serializer.js';

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

/** Native caret blink half-period. */
const CARET_BLINK_MS = 500;

/**
 * A running animation redraws natively every frame. Re-serializing a drawable
 * that often can take the whole main thread when the drawable is large (an
 * 18 px spinner in a 500-element panel took the page to 4 frames a second), so
 * captures that only follow a running animation wait this many times their
 * measured cost after the previous one, keeping them to about a quarter of the
 * main thread. Cheap drawables still capture every frame. Real changes (input,
 * mutations, hover, the animation's end) are captured at once.
 */
const ANIMATION_CAPTURE_SPACING = 3;
/** Milliseconds of idle time each slice of the re-check of reused styles may take. */
const RECHECK_SLICE_MS = 4;

/** Incremental snapshots (docs/INCREMENTAL.md); install({ incremental: false }) turns them off. */
export const snapshotSettings = { incremental: true };

/** What a drawable's last snapshot was taken against. */
interface CaptureContext {
  signature: Signature;
  /** The page rules' key: stylesheets added, removed or edited at the top level. */
  key: string;
  viewport: string;
  /** With container queries: each query container's size, in and above the drawable. */
  containers?: string;
}

/** The sizes of `list`, as getComputedStyle reports them (used, unrounded px). */
function sizes(list: Element[]): string {
  return list.map((e) => {
    const cs = computedStyle(e);
    return `${cs.width}x${cs.height}`;
  }).join();
}

export interface StateCallbacks {
  schedule(): void;
  onError(error: unknown): void;
  /** The polyfill stylesheet of a document or shadow root, injecting it if needed. */
  sheetFor(root: Node): CSSStyleSheet | null;
}

export class CanvasState {
  readonly host: HTMLElement;
  readonly mode: HostMode;
  readonly #hostStyleBackup: string | null;
  /** Committed snapshots: the ones drawElementImage uses. */
  readonly snapshots = new Map<Element, SnapshotRecord>();
  /** Finished snapshots waiting for the next paint event. */
  readonly #ready = new Map<Element, SnapshotRecord>();
  readonly #dirty = new Set<Element>();
  readonly #inFlight = new Set<Element>();
  /**
   * The tick each capture started in. Captures started together are painted
   * together, like native's single paint per frame.
   */
  readonly #inFlightBatch = new Map<Element, number>();
  readonly #readyBatch = new Map<Element, number>();
  #ticks = 0;
  readonly #redo = new Set<Element>();
  readonly #animating = new Set<Element>();
  /** Drawables a pointer entered or left, checked for :hover changes on the next tick. */
  readonly #hoverChecks = new Set<Element>();
  readonly #captured = new WeakMap<Element, CaptureContext>();
  /** Styles kept between snapshots; null when incremental snapshots are off. */
  readonly #styleCache = snapshotSettings.incremental ? new StyleCache() : null;
  /**
   * Per drawable, the elements whose subtrees may have new styles since its
   * last snapshot, from DOM changes; 'all' when anything may have changed.
   */
  readonly #styleChanges = new Map<Element, Set<Element> | 'all'>();
  /** Per drawable, what its last snapshot reused, still to re-check in idle time. */
  readonly #recheck = new Map<Element, Array<[Element, string | null]>>();
  #recheckScheduled = false;
  /** Per drawable, the query containers it and its ancestors had at its last snapshot. */
  readonly #queryContainers = new WeakMap<Element, Element[]>();
  /** Main-thread milliseconds the last capture of each drawable took, and when it ended. */
  readonly #captureCost = new Map<Element, { ms: number; ended: number }>();
  readonly #observed = new Set<Element>();
  #allDirty = true;
  #paintRequested = false;
  #structureChanged = true;
  readonly #resizeObserver: ResizeObserver;
  readonly #listeners: Array<[string, EventListener]> = [];
  readonly #onSelectionChange: () => void;
  /** Drawables in the last selection, which need a redraw when it moves. */
  #selected = new Set<Element>();
  /** Committed records whose caret blink phase flipped since the last paint. */
  readonly #blinked = new Set<Element>();
  #blinkTimer: ReturnType<typeof setInterval> | undefined;
  readonly geometry: Geometry;
  #scaleX = 1;
  #scaleY = 1;
  contentWidth = 0;
  contentHeight = 0;
  /** The content-box origin relative to the canvas border box, in CSS pixels. */
  contentLeft = 0;
  contentTop = 0;
  #hostLeft = 0;
  #hostTop = 0;
  readonly #callbacks: StateCallbacks;

  constructor(readonly canvas: HTMLCanvasElement, callbacks: StateCallbacks) {
    this.#callbacks = callbacks;
    const authoring = findAuthoringHost(canvas);
    this.mode = authoring ? 'authoring' : 'auto';
    this.host = authoring ?? canvas.ownerDocument.createElement('div');
    this.#hostStyleBackup = authoring ? authoring.getAttribute('style') : null;
    if (!authoring) {
      this.host.setAttribute(HOST_ATTR, '');
      canvas.after(this.host);
      this.adoptChildren();
      Object.defineProperties(canvas, childShims(this.host));
    }
    hostStates.set(this.host, this);
    this.geometry = new Geometry({
      host: this.host,
      owns: (el) => this.isDrawable(el) && nearestState(el) === this,
      contentOrigin: () => ({ x: this.contentLeft, y: this.contentTop }),
      sheetFor: (root) => this.#callbacks.sheetFor(root),
    });

    // Observation always reports an initial size; only real changes matter.
    const sizes = new WeakMap<Element, string>();
    this.#resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize?.[0];
        const size = box ? `${box.inlineSize}x${box.blockSize}` : `${entry.contentRect.width}x${entry.contentRect.height}`;
        const previous = sizes.get(entry.target);
        sizes.set(entry.target, size);
        if (previous === undefined || previous === size) continue;
        if (entry.target === this.canvas) this.#allDirty = true;
        else this.#markWithAncestors(entry.target);
      }
      this.#callbacks.schedule();
    });
    this.#resizeObserver.observe(canvas);

    const markTarget = (e: Event) => {
      if (isElement(e.target)) this.markNode(e.target);
    };
    // An animation's target has new styles when it starts, and again when it
    // ends (getAnimations no longer lists it then).
    const animationStart = (e: Event) => {
      const d = isElement(e.target) ? this.#drawableFor(e.target) : null;
      if (d) this.#animating.add(d);
      if (isElement(e.target)) this.markStyle(e.target);
      this.#callbacks.schedule();
    };
    const animationEnd = (e: Event) => {
      if (!isElement(e.target)) return;
      this.markNode(e.target);
      this.markStyle(e.target);
    };
    // :hover, :active and :focus-within also match the target's ancestors,
    // which may be enclosing drawables.
    const markChain = (e: Event) => {
      if (!isElement(e.target)) return;
      this.#markWithAncestors(e.target);
      this.#callbacks.schedule();
    };
    for (const type of ['input', 'change', 'scroll', 'load', 'error', 'toggle']) {
      this.#listeners.push([type, markTarget]);
    }
    for (const type of ['focusin', 'focusout', 'pointerdown', 'pointerup', 'pointercancel']) {
      this.#listeners.push([type, markChain]);
    }
    // Most pointer moves change no :hover match; those are checked on the next tick.
    const checkHover = (e: Event) => {
      if (!isElement(e.target)) return;
      for (let n: Node | null = e.target; n && n !== this.host; n = composedParent(n)) {
        if (isElement(n) && this.isDrawable(n)) this.#hoverChecks.add(n);
      }
      this.#callbacks.schedule();
    };
    for (const type of ['pointerover', 'pointerout']) this.#listeners.push([type, checkHover]);
    for (const type of ['animationstart', 'transitionrun', 'animationend', 'transitionend', 'animationcancel', 'transitioncancel']) {
      this.#listeners.push([type, type.endsWith('start') || type.endsWith('run') ? animationStart : animationEnd]);
    }
    for (const [type, fn] of this.#listeners) this.host.addEventListener(type, fn, true);
    this.#onSelectionChange = () => this.#selectionChanged();
    canvas.ownerDocument.addEventListener('selectionchange', this.#onSelectionChange, true);

    this.#layoutHost();
    this.#callbacks.schedule();
  }

  /** Auto mode: canvas children become children of the host, in order. */
  adoptChildren(): void {
    if (this.mode !== 'auto' || !this.canvas.firstChild) return;
    const { canvas, host } = this;
    const move = (host as Partial<Pick<HTMLElement, 'moveBefore'>>).moveBefore;
    for (let child = canvas.firstChild; child; child = canvas.firstChild) {
      // `moveBefore` keeps focus, iframes and animations alive across the move.
      try {
        if (move) move.call(host, child, null);
        else host.appendChild(child);
      } catch {
        host.appendChild(child);
      }
      if (isElement(child) && !Object.hasOwn(child, 'parentElement')) {
        Object.defineProperty(child, 'parentElement', parentShim(canvas, host));
      }
    }
    this.#structureChanged = true;
    this.#allDirty = true;
  }

  get #legacy(): boolean {
    return this.canvas.hasAttribute('layoutsubtree') && !this.canvas.hasAttribute('content');
  }

  isDrawable(el: Element): boolean {
    if (el.hasAttribute('drawable')) return true;
    // The legacy `layoutsubtree` API made every child drawable.
    return this.#legacy && el.parentNode === this.host;
  }

  /** The nearest drawable at or above `node` within this host, or null. */
  #drawableFor(node: Node): Element | null {
    for (let n: Node | null = node; n && n !== this.host; n = composedParent(n)) {
      if (isElement(n) && this.isDrawable(n)) return n;
    }
    return null;
  }

  #drawables(): Element[] {
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
    const d = this.#drawableFor(node);
    if (d) this.#dirty.add(d);
    else this.#allDirty = true;
    this.#callbacks.schedule();
  }

  /** A change on `el` itself can affect inherited styles of nested drawables too. */
  markSubtree(el: Element): void {
    this.markNode(el);
    for (const d of this.#observed) if (el.contains(d)) this.#dirty.add(d);
  }

  #markWithAncestors(el: Element): void {
    for (let n: Node | null = el; n && n !== this.host; n = composedParent(n)) {
      if (isElement(n) && this.isDrawable(n)) this.#dirty.add(n);
    }
  }

  /** Redraws the drawables a selection or caret left and the ones it entered. */
  #selectionChanged(): void {
    const now = new Set<Element>();
    const range = selectionRange();
    // Text controls keep their selection out of the document selection.
    const control = textControl(deepActiveElement());
    const d = control && this.#drawableFor(control);
    if (d) now.add(d);
    if (range && !range.collapsed) {
      for (const d of this.#observed) if (range.intersectsNode(d)) now.add(d);
    } else if (range && this.host.contains(range.startContainer)) {
      // Only editing hosts draw a collapsed selection (the caret).
      const parent = isElement(range.startContainer) ? range.startContainer : range.startContainer.parentElement;
      const d = parent instanceof HTMLElement && parent.isContentEditable ? this.#drawableFor(parent) : null;
      if (d) now.add(d);
    }
    for (const d of this.#selected) this.#dirty.add(d);
    for (const d of now) this.#dirty.add(d);
    this.#selected = now;
    if (this.#dirty.size > 0) this.#callbacks.schedule();
  }

  /** Restarts the caret blink, visible first, while any committed snapshot has a caret. */
  #restartBlink(): void {
    clearInterval(this.#blinkTimer);
    this.#blinkTimer = undefined;
    for (const record of this.snapshots.values()) record.caretHidden = false;
    if (![...this.snapshots.values()].some((r) => r.caretOff)) return;
    this.#blinkTimer = setInterval(() => {
      for (const [el, record] of this.snapshots) {
        if (!record.caretOff) continue;
        record.caretHidden = !record.caretHidden;
        this.#blinked.add(el);
      }
      if (this.#blinked.size > 0) this.#callbacks.schedule();
    }, CARET_BLINK_MS);
  }

  markAll(): void {
    this.#allDirty = true;
    for (const d of this.#observed) this.#styleChanges.set(d, 'all');
    this.#callbacks.schedule();
  }

  /**
   * An attribute or child-list change on `el`: its subtree may have new
   * styles, and so may its following siblings' through + and ~.
   */
  markStyle(el: Element): void {
    let siblings: boolean | undefined;
    for (const d of this.#observed) {
      const changes = this.#styleChanges.get(d);
      if (changes === 'all') continue;
      if (d === el || d.contains(el)) {
        if (changes) changes.add(el);
        else this.#styleChanges.set(d, new Set([el]));
      } else if (el.contains(d)) {
        this.#styleChanges.set(d, 'all');
      } else if (el.parentNode?.contains(d) && (siblings ??= pageRules(el.ownerDocument)?.siblings ?? true)) {
        // A sibling of an element containing the drawable.
        this.#styleChanges.set(d, 'all');
      }
    }
  }

  markStructure(): void {
    this.#structureChanged = true;
    this.#allDirty = true;
    this.#callbacks.schedule();
  }

  requestPaint(): void {
    this.#paintRequested = true;
    this.#callbacks.schedule();
  }

  /** The canvas content box in CSS pixels and the CSS-to-grid scale. */
  measure(cs = computedStyle(this.canvas)) {
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

  /** Sizes and positions the host over the canvas content box. */
  #layoutHost(): void {
    const canvas = this.canvas;
    const cs = computedStyle(canvas);
    const { padL, padT, width, height, scaleX, scaleY } = this.measure(cs);
    if (scaleX !== this.#scaleX || scaleY !== this.#scaleY || width !== this.contentWidth || height !== this.contentHeight) {
      this.#allDirty = true;
    }
    this.#scaleX = scaleX;
    this.#scaleY = scaleY;
    this.contentWidth = width;
    this.contentHeight = height;
    this.contentLeft = canvas.clientLeft + padL;
    this.contentTop = canvas.clientTop + padT;

    const style = this.host.style;
    // Only write changed values: every style write queues a mutation record.
    const set = (name: string, value: string, important = true) => {
      if (style.getPropertyValue(name) !== value || (style.getPropertyPriority(name) === 'important') !== important) {
        style.setProperty(name, value, important ? 'important' : '');
      }
    };
    const position = cs.position === 'fixed' ? 'fixed' : 'absolute';
    if (style.getPropertyValue('position') !== position) this.#hostLeft = this.#hostTop = 0;
    set('position', position);
    set('width', `${width}px`);
    set('height', `${height}px`);
    set('box-sizing', 'content-box');
    set('margin', '0px');
    set('padding', '0px');
    set('border', 'none');
    // Invisible but still hit-tested. `filter`, not `opacity: 0`: natively the
    // children are visible to `checkVisibility({ opacityProperty: true })`,
    // and an `opacity: 0` ancestor would make every one of them report hidden.
    set('filter', 'opacity(0)');
    set('pointer-events', 'none');
    set('overflow', 'clip');
    set('display', 'block');
    set('transform', 'none');
    // Stay above the canvas so drawn elements with geometry receive hits.
    set('z-index', cs.position !== 'static' && cs.zIndex !== 'auto' ? cs.zIndex : 'auto');
    // `inherit` keeps values such as a unitless line-height, which computed
    // styles report in pixels, when the canvas inherits the same value.
    const parent = this.host.parentElement;
    const ps = parent ? computedStyle(parent) : null;
    for (const name of INHERITED_FROM_CANVAS) {
      const value = cs.getPropertyValue(name);
      if (value) set(name, ps?.getPropertyValue(name) === value ? 'inherit' : value, false);
    }
    // Mirrored classes keep descendant selectors such as `.chart .label`
    // matching the moved children; the important styles above keep the box.
    if (this.mode === 'auto') {
      const classes = canvas.getAttribute('class');
      if (this.host.getAttribute('class') !== classes) {
        if (classes === null) this.host.removeAttribute('class');
        else this.host.setAttribute('class', classes);
      }
    }
    if (canvas.lang && this.host.lang !== canvas.lang) this.host.lang = canvas.lang;
    if (canvas.dir && this.host.dir !== canvas.dir) this.host.dir = canvas.dir;

    // Move the host by the difference between where it is and where the
    // canvas content box is. This works for any offset parent.
    set('left', `${this.#hostLeft}px`);
    set('top', `${this.#hostTop}px`);
    const cr = canvas.getBoundingClientRect();
    const hr = this.host.getBoundingClientRect();
    const dx = cr.left + canvas.clientLeft + padL - hr.left;
    const dy = cr.top + canvas.clientTop + padT - hr.top;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      this.#hostLeft += dx;
      this.#hostTop += dy;
      set('left', `${this.#hostLeft}px`);
      set('top', `${this.#hostTop}px`);
    }
  }

  #syncStructure(): void {
    const current = new Set(this.#drawables());
    for (const el of this.#observed) {
      if (!current.has(el)) {
        this.#resizeObserver.unobserve(el);
        this.#observed.delete(el);
        this.snapshots.get(el)?.release();
        this.snapshots.delete(el);
        this.#ready.get(el)?.release();
        this.#ready.delete(el);
        this.#readyBatch.delete(el);
        this.#animating.delete(el);
        this.#captureCost.delete(el);
        this.geometry.clear(el);
      }
    }
    for (const el of current) {
      if (!this.#observed.has(el)) {
        this.#observed.add(el);
        this.#resizeObserver.observe(el);
      }
    }
  }

  /** One frame of work. Returns true while more frames are needed. */
  tick(): boolean {
    this.#ticks++;
    if (this.#structureChanged) {
      this.#structureChanged = false;
      this.#syncStructure();
    }
    this.#layoutHost();
    // Layout may have moved the live boxes that carry hit-test geometry.
    this.geometry.invalidate();
    if (this.#allDirty) {
      this.#allDirty = false;
      for (const el of this.#observed) this.#dirty.add(el);
    }
    for (const el of this.#hoverChecks) {
      const last = this.#captured.get(el);
      if (!last || !sameSignature(last.signature, stateSignature(el))) this.#dirty.add(el);
    }
    this.#hoverChecks.clear();
    const now = performance.now();
    for (const el of this.#animating) {
      if (!el.isConnected || !el.getAnimations({ subtree: true }).some((a) => a.playState === 'running')) {
        // The end state is captured at once.
        this.#animating.delete(el);
        this.#dirty.add(el);
        continue;
      }
      if (this.#dirty.has(el) || this.#inFlight.has(el)) continue;
      const last = this.#captureCost.get(el);
      if (last && now < last.ended + last.ms * ANIMATION_CAPTURE_SPACING) continue;
      this.#dirty.add(el);
    }
    for (const el of this.#dirty) {
      if (!this.#observed.has(el)) continue;
      if (this.#inFlight.has(el)) this.#redo.add(el);
      else this.#capture(el);
    }
    this.#dirty.clear();

    // Like native, every drawable has a paint record by the time paint fires.
    const firstCapture = [...this.#inFlight].some((el) => !this.snapshots.has(el) && !this.#ready.has(el));
    // A snapshot waits for the others that started in the same tick.
    const running = new Set(this.#inFlightBatch.values());
    const held = [...this.#readyBatch.values()].some((batch) => running.has(batch));
    if ((this.#ready.size > 0 || this.#blinked.size > 0 || this.#paintRequested) && !firstCapture && !held) this.#dispatchPaint();
    return this.#inFlight.size > 0 || this.#dirty.size > 0 || this.#animating.size > 0;
  }

  #capture(el: Element): void {
    this.#inFlight.add(el);
    const batch = this.#ticks;
    this.#inFlightBatch.set(el, batch);
    const styles = this.#styleCache ? { cache: this.#styleCache, fresh: this.#freshStyles(el) } : undefined;
    const scaleX = this.#scaleX;
    const scaleY = this.#scaleY;
    // Cloning the element and reading its styles, the main-thread work, runs
    // before the snapshot first waits.
    const started = performance.now();
    const pending = snapshot(el, {
      scaleX,
      scaleY,
      isBoundary: (e) => hostStates.has(e) || this.isDrawable(e),
      rootStyle: this.geometry.authoredStyle(el),
      styles,
    });
    const ms = performance.now() - started;
    if (styles && pageRules(el.ownerDocument)?.containers) this.#recordContainers(el);
    if (styles) this.#scheduleRecheck(el, this.#styleCache!.reusedList);
    // Visible in DevTools' performance panel, and read by scripts/bench.mjs.
    // Browsers without the options form (Safari before 14.1) throw.
    try {
      const detail = this.#styleCache ? { read: this.#styleCache.read, reused: this.#styleCache.reused } : undefined;
      performance.measure('html-in-canvas snapshot', { start: started, duration: ms, detail });
    } catch {
      // No measure, no harm.
    }
    pending
      .then(
        (result) => {
          if (!this.#observed.has(el)) {
            result.bitmap?.close();
            result.caretOff?.close();
            return;
          }
          this.#ready.get(el)?.release();
          this.#ready.set(el, new SnapshotRecord(result, scaleX, scaleY, el));
          this.#readyBatch.set(el, batch);
        },
        (error: unknown) => this.#callbacks.onError(error),
      )
      .finally(() => {
        if (this.#observed.has(el)) this.#captureCost.set(el, { ms, ended: performance.now() });
        this.#inFlight.delete(el);
        this.#inFlightBatch.delete(el);
        if (this.#redo.delete(el)) this.#dirty.add(el);
        this.#callbacks.schedule();
      });
  }

  /**
   * Which elements of `el` the next snapshot must read in full, and records
   * what it's taken against (docs/INCREMENTAL.md).
   */
  #freshStyles(el: Element): (e: Element) => boolean {
    const rules = pageRules(el.ownerDocument);
    const signature = rules ? stateSignature(el, rules) : null;
    const viewport = `${innerWidth}x${innerHeight}`;
    const last = this.#captured.get(el);
    const changes = this.#styleChanges.get(el);
    this.#styleChanges.delete(el);
    const context: CaptureContext = { signature, key: rules?.key ?? '', viewport };
    this.#captured.set(el, context);
    const cache = this.#styleCache!;
    // Container queries follow container sizes, which come from layout: compare
    // the sizes of the containers this drawable met last time.
    const containers = rules?.containers ? sizes(this.#queryContainers.get(el) ?? []) : undefined;
    cache.read = cache.reused = 0;
    cache.containers = [];
    cache.reusedList = [];
    const all = () => true;
    if (!last || !rules || changes === 'all' || last.key !== rules.key || last.viewport !== viewport) return all;
    if (rules.containers && (last.containers === undefined || last.containers !== containers)) return all;
    const matched = changedMatches(last.signature, signature);
    if (!matched) return all;
    const roots = new Set(changes);
    for (const m of matched) {
      // A changed ancestor changes what the whole drawable inherits.
      if (m !== el && m.contains(el)) return all;
      roots.add(m);
    }
    for (const animation of el.getAnimations?.({ subtree: true }) ?? []) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (target) roots.add(target);
    }
    if (rules.siblings) {
      for (const r of [...roots]) for (let s = r.nextElementSibling; s; s = s.nextElementSibling) roots.add(s);
    }
    const fresh = new Set<Element>();
    for (const r of roots) {
      if (r !== el && !el.contains(r)) continue;
      fresh.add(r);
      for (const e of Array.from(r.querySelectorAll('*'))) fresh.add(e);
    }
    return (e) => fresh.has(e);
  }

  /**
   * The safety net of docs/INCREMENTAL.md: a change the invalidation rules
   * miss (a stylesheet edited in place, say) would otherwise leave reused
   * styles stale. In idle time, re-read what the last snapshot of `el` reused,
   * a few milliseconds at a time, and take a new snapshot if any of it changed.
   */
  #scheduleRecheck(el: Element, reused: Array<[Element, string | null]>): void {
    if (reused.length === 0) this.#recheck.delete(el);
    else this.#recheck.set(el, [...reused]);
    if (this.#recheck.size === 0 || this.#recheckScheduled) return;
    this.#recheckScheduled = true;
    const idle = (globalThis as { requestIdleCallback?: (fn: () => void, opts: { timeout: number }) => number }).requestIdleCallback;
    const later = (fn: () => void) => (idle ? idle(fn, { timeout: 1000 }) : setTimeout(fn, 50));
    const slice = () => {
      const end = performance.now() + RECHECK_SLICE_MS;
      for (const [drawable, list] of this.#recheck) {
        if (!this.#observed.has(drawable)) {
          this.#recheck.delete(drawable);
          continue;
        }
        while (list.length > 0 && performance.now() < end) {
          const [target, pseudo] = list.pop()!;
          if (this.#styleCache!.check(target, pseudo)) continue;
          // Stale: drop what's kept and redraw. The new snapshot replaces the rest of the list.
          this.#styleCache!.delete(target);
          this.markStyle(target);
          this.#dirty.add(drawable);
          this.#callbacks.schedule();
          list.length = 0;
        }
        if (list.length === 0) this.#recheck.delete(drawable);
        if (performance.now() >= end) break;
      }
      if (this.#recheck.size > 0) later(slice);
      else this.#recheckScheduled = false;
    };
    later(slice);
  }

  /** The query containers in and above `el`, and their sizes, for the next snapshot to compare. */
  #recordContainers(el: Element): void {
    const list = [...this.#styleCache!.containers];
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (computedStyle(n).containerType !== 'normal') list.push(n);
    }
    this.#queryContainers.set(el, list);
    const context = this.#captured.get(el);
    if (context) context.containers = sizes(list);
  }

  #dispatchPaint(): void {
    const caretChanged = [...this.#ready].some(([el, r]) => r.caretOff || this.snapshots.get(el)?.caretOff);
    for (const [el, record] of this.#ready) {
      this.snapshots.get(el)?.release();
      this.snapshots.set(el, record);
    }
    // A new caret starts visible, like native after typing or moving it.
    if (caretChanged) this.#restartBlink();
    const changedElements = reverseTreeOrder(new Set([...this.#ready.keys(), ...this.#blinked]));
    this.#ready.clear();
    this.#readyBatch.clear();
    this.#blinked.clear();
    this.#paintRequested = false;
    this.canvas.dispatchEvent(new CanvasPaintEvent('paint', { changedElements }));
  }

  destroy(): void {
    this.geometry.destroy();
    this.#resizeObserver.disconnect();
    clearInterval(this.#blinkTimer);
    this.canvas.ownerDocument.removeEventListener('selectionchange', this.#onSelectionChange, true);
    for (const [type, fn] of this.#listeners) this.host.removeEventListener(type, fn, true);
    for (const record of this.snapshots.values()) record.release();
    for (const record of this.#ready.values()) record.release();
    this.snapshots.clear();
    this.#ready.clear();
    this.#readyBatch.clear();
    this.#observed.clear();
    this.#captureCost.clear();
    hostStates.delete(this.host);
    if (this.mode === 'auto') {
      for (const name of CHILD_SHIMS) delete (this.canvas as unknown as Record<string, unknown>)[name];
      for (const child of this.host.children) delete (child as unknown as Record<string, unknown>).parentElement;
      while (this.host.firstChild) this.canvas.appendChild(this.host.firstChild);
      this.host.remove();
    } else if (this.#hostStyleBackup === null) {
      this.host.removeAttribute('style');
    } else {
      this.host.setAttribute('style', this.#hostStyleBackup);
    }
  }
}

const CHILD_SHIMS = ['children', 'firstElementChild', 'lastElementChild', 'childElementCount', 'querySelector', 'querySelectorAll'] as const;

/**
 * Auto mode: element-level child reads on the canvas see the relocated
 * children, so code such as `for (const el of canvas.children)` keeps working.
 * Node-level reads (`firstChild`, `childNodes`) still see the canvas itself.
 */
function childShims(host: HTMLElement): PropertyDescriptorMap {
  const shims: PropertyDescriptorMap = {};
  for (const name of CHILD_SHIMS) {
    shims[name] = name.startsWith('query')
      ? { value: (selectors: string) => host[name as 'querySelector'](selectors), configurable: true, writable: true }
      : { get: () => host[name], configurable: true };
  }
  return shims;
}

const nativeParentElement = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')!.get!;

/** Auto mode: a relocated child still reports the canvas as its parent element. */
function parentShim(canvas: HTMLCanvasElement, host: HTMLElement): PropertyDescriptor {
  return {
    get(this: Node) {
      const parent = nativeParentElement.call(this);
      return parent === host ? canvas : parent;
    },
    configurable: true,
  };
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

/** Auto mode: the canvas whose relocated content `host` holds. */
export function autoCanvasOf(host: Element): HTMLCanvasElement | null {
  const state = hostStates.get(host);
  return state?.mode === 'auto' ? state.canvas : null;
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
