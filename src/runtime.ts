import { HOST_ATTR, isElement } from './dom';
import { GEOMETRY_ATTR } from './geometry/state';
import { CanvasState, nearestState, stateForHost } from './host/canvas-state';

const states = new Map<HTMLCanvasElement, CanvasState>();
let observedRoots = new WeakSet<Node>();
let styledRoots = new WeakMap<Node, HTMLStyleElement>();
const injectedStyles: HTMLStyleElement[] = [];
let observer: MutationObserver | null = null;
let rafId = 0;
let running = false;
let warned = new Set<string>();

// Native Chromium lays out each canvas child on its own at the content-box
// origin: blockified, shrink-to-fit, percentages against the content box.
// An absolutely positioned box at 0,0 in the host does the same.
const STYLE = `
:where([${HOST_ATTR}]) :where([drawable]){isolation:isolate;will-change:transform}
:where([${HOST_ATTR}]) [drawable]:not([${GEOMETRY_ATTR}]){pointer-events:none!important}
:where([${GEOMETRY_ATTR}]){pointer-events:auto}
[${HOST_ATTR}]>*{position:absolute!important;inset:0 auto auto 0!important}
`;

const callbacks = {
  schedule,
  onError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (warned.has(message)) return;
    warned.add(message);
    console.warn('[html-in-canvas-polyfill] snapshot failed:', error);
  },
  sheetFor(root: Node): CSSStyleSheet | null {
    return injectStyle(root).sheet;
  },
};

export function schedule(): void {
  if (running && !rafId) rafId = requestAnimationFrame(frame);
}

function frame(): void {
  rafId = 0;
  let again = false;
  for (const [canvas, state] of states) {
    if (!wantsState(canvas)) {
      dropState(canvas);
      continue;
    }
    try {
      again = state.tick() || again;
    } catch (error) {
      callbacks.onError(error);
    }
  }
  if (again) schedule();
}

function wantsState(canvas: HTMLCanvasElement): boolean {
  if (!canvas.isConnected) return false;
  const content = canvas.getAttribute('content');
  if (content !== null) return content.toLowerCase() === 'drawable';
  return canvas.hasAttribute('layoutsubtree');
}

export function getState(canvas: HTMLCanvasElement): CanvasState | undefined {
  return states.get(canvas);
}

/** Creates or removes the polyfill state to match the canvas attributes. */
export function syncCanvas(canvas: HTMLCanvasElement): void {
  if (!running) return;
  const wanted = wantsState(canvas);
  if (wanted && !states.has(canvas)) {
    injectStyle(canvas.getRootNode());
    states.set(canvas, new CanvasState(canvas, callbacks));
  } else if (!wanted && states.has(canvas)) {
    dropState(canvas);
  }
}

function dropState(canvas: HTMLCanvasElement): void {
  states.get(canvas)?.destroy();
  states.delete(canvas);
}

function injectStyle(root: Node): HTMLStyleElement {
  const existing = styledRoots.get(root);
  if (existing?.isConnected) return existing;
  const style = document.createElement('style');
  styledRoots.set(root, style);
  style.setAttribute('data-hic-style', '');
  style.textContent = STYLE;
  injectedStyles.push(style);
  if (root instanceof ShadowRoot) root.prepend(style);
  else (document.head ?? document.documentElement).appendChild(style);
  return style;
}

function scan(root: ParentNode): void {
  if (root instanceof HTMLCanvasElement) syncCanvas(root);
  for (const canvas of Array.from(root.querySelectorAll('canvas'))) syncCanvas(canvas);
}

function stateOf(node: Node): CanvasState | null {
  return (isElement(node) && stateForHost(node)) || nearestState(node);
}

const isStyleNode = (node: Node) =>
  node instanceof HTMLStyleElement || (node instanceof HTMLLinkElement && node.rel === 'stylesheet');

function onMutations(records: MutationRecord[]): void {
  let globalStyle = false;
  for (const record of records) {
    const target = record.target;
    if (record.type === 'attributes') {
      const name = record.attributeName;
      if (target instanceof HTMLCanvasElement) {
        if (name === 'content' || name === 'layoutsubtree') syncCanvas(target);
        states.get(target)?.markAll();
      }
      const host = isElement(target) ? stateForHost(target) : undefined;
      if (host) {
        // Our own writes. Other attributes can change inherited styles.
        if (name !== 'style' && name !== 'lang' && name !== 'dir') host.markAll();
        continue;
      }
      if (name === GEOMETRY_ATTR) continue;
      const state = nearestState(target);
      if (state) {
        state.markSubtree(target as Element);
        if (name === 'drawable') state.markStructure();
      } else if (target === document.documentElement || target === document.body) {
        globalStyle = true;
      }
    } else if (record.type === 'characterData') {
      const state = nearestState(target);
      if (state) state.markNode(target);
      else if (target.parentNode && isStyleNode(target.parentNode)) globalStyle = true;
    } else {
      if (target instanceof HTMLCanvasElement) states.get(target)?.adoptChildren();
      const state = stateOf(target);
      let structural = false;
      for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
        if (!isElement(node)) continue;
        structural = true;
        if (isStyleNode(node)) globalStyle = true;
        if (node.isConnected) scan(node);
        else if (node instanceof HTMLCanvasElement || node.querySelector('canvas')) schedule();
      }
      if (state) {
        if (structural) state.markStructure();
        state.markNode(target);
      } else if (target instanceof HTMLStyleElement) {
        globalStyle = true;
      }
    }
  }
  if (globalStyle) for (const state of states.values()) state.markAll();
}

const OBSERVE: MutationObserverInit = { subtree: true, childList: true, attributes: true, characterData: true };

export function observeRoot(root: Document | ShadowRoot): void {
  if (!observer || observedRoots.has(root)) return;
  observedRoots.add(root);
  observer.observe(root, OBSERVE);
  scan(root);
}

const onFontsLoaded = () => {
  for (const state of states.values()) state.markAll();
};

export function start(): void {
  if (running) return;
  running = true;
  warned = new Set();
  observedRoots = new WeakSet();
  styledRoots = new WeakMap();
  observer = new MutationObserver(onMutations);
  observeRoot(document);
  // Shadow roots created before install; later ones come from attachShadow.
  const visit = (root: ParentNode) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.shadowRoot) {
        observeRoot(el.shadowRoot);
        visit(el.shadowRoot);
      }
    }
  };
  visit(document);
  document.fonts?.addEventListener('loadingdone', onFontsLoaded);
}

export function stop(): void {
  if (!running) return;
  running = false;
  observer?.disconnect();
  observer = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  document.fonts?.removeEventListener('loadingdone', onFontsLoaded);
  for (const canvas of Array.from(states.keys())) dropState(canvas);
  for (const style of injectedStyles.splice(0)) style.remove();
}
