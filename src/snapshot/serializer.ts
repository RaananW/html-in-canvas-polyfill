// Renders an element subtree to an ImageBitmap through an SVG <foreignObject>:
// clone the subtree, inline computed styles (diffed against UA defaults),
// pseudo-elements, form state, images and fonts as data URLs, then decode the
// SVG and convert it to a bitmap. See docs/SPIKE.md for the measurements
// behind these choices.

import { computedStyle } from '../dom.js';
import { GEOMETRY_ATTR } from '../geometry/state.js';
import { toBitmap } from './bitmap.js';
import {
  CARET_VAR,
  caretBefore,
  cloneText,
  controlOverlay,
  readSelection,
  resetSelectionCaches,
  type SelectionState,
} from './selection.js';

export interface SnapshotOptions {
  /** Device pixels per CSS pixel, per axis. */
  scaleX: number;
  scaleY: number;
  /**
   * Descendants for which this returns true are drawn as empty boxes of the
   * same size (nested `drawable` elements have their own snapshots).
   */
  isBoundary?: (el: Element) => boolean;
  /** Declarations appended to the root, restoring authored values the polyfill overrides. */
  rootStyle?: Array<[string, string]>;
  /** Reuse styles read by earlier snapshots of the same element (docs/INCREMENTAL.md). */
  styles?: { cache: StyleCache; fresh: (el: Element) => boolean };
}

/**
 * Values read again for every element: getComputedStyle reports used values
 * for most of these, so they change with layout, anywhere. The others are the
 * ones element geometry overrides (position, z-index, clip-path and the
 * individual transforms), whose rules change as elements are drawn.
 */
const LAYOUT = new Set(
  ['width', 'height', 'inline-size', 'block-size', 'top', 'right', 'bottom', 'left', 'transform', 'transform-origin', 'perspective-origin', 'grid-template-columns', 'grid-template-rows', 'position', 'z-index', 'clip-path', 'translate', 'rotate', 'scale'].concat(
    ...['margin', 'padding'].map((box) => ['top', 'right', 'bottom', 'left', 'block-start', 'block-end', 'inline-start', 'inline-end'].map((side) => `${box}-${side}`)),
    ['block-start', 'block-end', 'inline-start', 'inline-end'].map((side) => `inset-${side}`),
  ),
);

interface StyleEntry {
  /** The values that differ from `defaults`, without the layout ones. */
  values: Map<string, string>;
  /** The UA default they were diffed against: a different one means the element's state changed. */
  defaults: Map<string, string>;
  /** The declarations those values gave, without the layout ones. */
  decls?: Array<[string, string]>;
  /** The layout values the last snapshot used. */
  layout?: Map<string, string>;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
/** What element geometry overrides on the elements it applies to. */
const GEOMETRY_OVERRIDES = ['position', 'z-index', 'clip-path', 'translate', 'rotate', 'scale'];

/** Physical sides for the block and inline axes, or null when the writing mode isn't one we map. */
function logicalSides(writingMode: string, direction: string): { block: [string, string]; inline: [string, string] } | null {
  const horizontal = writingMode === 'horizontal-tb';
  if (!horizontal && writingMode !== 'vertical-rl' && writingMode !== 'vertical-lr') return null;
  const block: [string, string] = horizontal ? ['top', 'bottom'] : writingMode === 'vertical-rl' ? ['right', 'left'] : ['left', 'right'];
  const inline: [string, string] = horizontal ? ['left', 'right'] : ['top', 'bottom'];
  if (direction === 'rtl') inline.reverse();
  return { block, inline };
}

/**
 * The layout values of a reused element. Only what can have changed is read:
 * sizes, margins and padding (percentages and auto follow layout), insets of
 * positioned elements, transforms and their origins when the box was
 * resized, grid tracks of grids, and what element geometry overrides on
 * elements that have it. Logical properties mirror the physical ones.
 */
function relayout(el: Element, cs: CSSStyleDeclaration, kept: StyleEntry, defaults: Map<string, string>): Map<string, string> {
  const last = kept.layout!;
  const out = new Map(last);
  const value = (n: string) => kept.values.get(n) ?? defaults.get(n) ?? '';
  const read = (n: string) => {
    const v = cs.getPropertyValue(n);
    out.set(n, v);
    return v;
  };
  const resized = read('width') !== last.get('width') || read('height') !== last.get('height');
  for (const side of SIDES) {
    read(`margin-${side}`);
    read(`padding-${side}`);
  }
  const geometry = el.hasAttribute(GEOMETRY_ATTR);
  if (geometry) for (const n of GEOMETRY_OVERRIDES) read(n);
  if (geometry || out.get('position') !== 'static') for (const side of SIDES) read(side);
  if (geometry || resized) for (const n of ['transform', 'transform-origin', 'perspective-origin']) read(n);
  if (value('display').includes('grid')) for (const n of ['grid-template-columns', 'grid-template-rows']) read(n);
  const sides = logicalSides(value('writing-mode'), value('direction'));
  for (const name of layoutNames!) {
    const m = /^(margin|padding|inset)-(block|inline)-(start|end)$/.exec(name);
    if (!m && name !== 'inline-size' && name !== 'block-size') continue;
    if (!sides) {
      read(name);
    } else if (m) {
      const side = sides[m[2] as 'block' | 'inline'][m[3] === 'start' ? 0 : 1];
      out.set(name, out.get(m[1] === 'inset' ? side : `${m[1]}-${side}`)!);
    } else {
      const horizontal = sides.block[0] === 'top';
      out.set(name, out.get((name === 'inline-size') === horizontal ? 'width' : 'height')!);
    }
  }
  kept.layout = out;
  return out;
}

/** Computed values by name. */
interface Style {
  get(name: string): string | undefined;
}

/** A computed style as readStyle returns it. */
interface ReadStyle extends Style {
  /** The whole style, when it was read in full. */
  map: Map<string, string> | null;
  /** What the cache keeps for it. */
  entry: StyleEntry | undefined;
}

let layoutNames: string[] | null = null;

/** Styles kept between snapshots, per element and pseudo-element. */
export class StyleCache {
  readonly #entries = new WeakMap<Element, Map<string, StyleEntry>>();
  /** Elements read in full, and reused, by the last snapshot. */
  read = 0;
  reused = 0;
  /** Query containers (container-type other than normal) the last snapshot met. */
  containers: Element[] = [];
  /** What the last snapshot reused, to re-check in idle time: [element, pseudo-element]. */
  reusedList: Array<[Element, string | null]> = [];
  /** The custom properties the last snapshot read. */
  customProps: ReadonlySet<string> = EMPTY;

  get(el: Element, pseudo: string | null): StyleEntry | undefined {
    return this.#entries.get(el)?.get(pseudo ?? '');
  }

  set(el: Element, pseudo: string | null, entry: StyleEntry): void {
    let byPseudo = this.#entries.get(el);
    if (!byPseudo) this.#entries.set(el, (byPseudo = new Map()));
    byPseudo.set(pseudo ?? '', entry);
  }

  /** Drops what's kept for `el` (its pseudo-elements included). */
  delete(el: Element): void {
    this.#entries.delete(el);
  }

  /**
   * Reads `el`'s style in full and compares it with what's kept: false when
   * a value the cache would reuse has changed (or the element's UA default
   * has), so the kept entry is stale.
   */
  check(el: Element, pseudo: string | null): boolean {
    const kept = this.get(el, pseudo);
    if (!kept || !el.isConnected) return true;
    if (getDefaultStyle(el, pseudo) !== kept.defaults) return false;
    const map = styleToMap(computedStyle(el, pseudo), this.customProps, false);
    for (const [name, value] of map) {
      if (LAYOUT.has(name)) continue;
      if (value !== (kept.values.get(name) ?? kept.defaults.get(name))) return false;
    }
    return true;
  }
}

export interface SnapshotResult {
  /** Null when the element has an empty border box. */
  bitmap: ImageBitmap | null;
  /** The same snapshot without the caret, when it has one (the other blink phase). */
  caretOff?: ImageBitmap | null;
  /** Bitmap size in device pixels. */
  width: number;
  height: number;
  /** Border-box size in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
}

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const TRANSPARENT_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const resourceCache = new Map<string, Promise<string | null>>();
const defaultStyleCache = new Map<string, Map<string, string>>();
let sandbox: HTMLIFrameElement | null = null;
let pseudoCounter = 0;

export function resetCaches(): void {
  resourceCache.clear();
  defaultStyleCache.clear();
  sandbox?.remove();
  sandbox = null;
  layoutUnit = undefined;
  resetSelectionCaches();
}

function getSandboxDoc(): Document {
  if (!sandbox) {
    sandbox = document.createElement('iframe');
    sandbox.setAttribute('aria-hidden', 'true');
    sandbox.style.cssText =
      'position:fixed;left:-10000px;top:0;width:100px;height:100px;visibility:hidden;border:0';
    document.documentElement.appendChild(sandbox);
    const doc = sandbox.contentDocument!;
    doc.open();
    doc.write('<!doctype html><html><body></body></html>');
    doc.close();
  }
  return sandbox.contentDocument!;
}

let standardNames: { html: string[]; svg: string[] } | null = null;

// Properties that can't change a still picture: motion, scrolling and
// interaction. Snapshots set animation and transition to none, and the caret
// is drawn from the live element.
const NOT_PAINTED =
  /^(?:animation|transition|scroll-(?:behavior|margin|padding|snap|timeline|initial-target)|view-timeline|timeline-scope|overscroll-behavior|caret|cursor$|pointer-events$|touch-action$|(?:-webkit-)?user-(?:select|drag|modify)$|-webkit-tap-highlight-color$|interactivity$|interpolate-size$|speak$|(?:-webkit-)?app-region$)/;
// Properties only SVG elements use. An SVG descendant still reads them, and
// writes them, since its HTML parent has no value to inherit.
const SVG_ONLY =
  /^(?:fill|stroke|marker|stop-|flood-|lighting-color$|shape-rendering$|vector-effect$|dominant-baseline$|alignment-baseline$|baseline-shift$|text-anchor$|color-rendering$|color-interpolation$|clip-rule$|(?:cx|cy|r|rx|ry|x|y|d)$|buffered-rendering$|mask-type$)/;

// Enumerating a computed style also yields every inherited custom property;
// design systems put hundreds on :root (Strata: ~300), tripling the cost.
// Computed values are already var()-resolved, so only custom properties used
// by verbatim-copied rules are read.
function styleToMap(cs: CSSStyleDeclaration, custom: ReadonlySet<string> = EMPTY, svg = false): Map<string, string> {
  if (!standardNames) {
    const all: string[] = [];
    for (let i = 0; i < cs.length; i++) if (!cs[i]!.startsWith('--') && !NOT_PAINTED.test(cs[i]!)) all.push(cs[i]!);
    standardNames = { svg: all, html: all.filter((name) => !SVG_ONLY.test(name)) };
  }
  const map = new Map<string, string>();
  for (const name of svg ? standardNames.svg : standardNames.html) map.set(name, cs.getPropertyValue(name));
  for (const name of custom) {
    const v = cs.getPropertyValue(name);
    if (v) map.set(name, v);
  }
  return map;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * An element's (or pseudo-element's) computed style, as styleToMap reads it.
 * With a cache, an element that can't have changed is rebuilt from the values
 * kept last time, its UA default and a fresh read of the layout values.
 */
function readStyle(el: Element, pseudo: string | null, ctx: CloneContext): ReadStyle {
  const cs = computedStyle(el, pseudo);
  const svg = el instanceof SVGElement;
  const styles = ctx.styles;
  const whole = (map: Map<string, string>, entry?: StyleEntry): ReadStyle => ({ get: (n) => map.get(n), map, entry });
  // SVG geometry properties keep their own rules; SVG is read in full.
  if (!styles || svg) return whole(styleToMap(cs, ctx.customProps, svg));
  const defaults = getDefaultStyle(el, pseudo);
  const kept = styles.cache.get(el, pseudo);
  let style: ReadStyle;
  if (kept?.decls && kept.defaults === defaults && !styles.fresh(el)) {
    styles.cache.reused++;
    styles.cache.reusedList.push([el, pseudo]);
    const layout = relayout(el, cs, kept, defaults);
    style = { get: (n) => layout.get(n) ?? kept.values.get(n) ?? defaults.get(n), map: null, entry: kept };
  } else {
    styles.cache.read++;
    const map = styleToMap(cs, ctx.customProps, false);
    const values = new Map<string, string>();
    for (const [name, value] of map) if (!LAYOUT.has(name) && value !== defaults.get(name)) values.set(name, value);
    layoutNames ??= standardNames!.html.filter((n) => LAYOUT.has(n));
    const entry: StyleEntry = { values, defaults, layout: new Map(layoutNames.map((n) => [n, map.get(n)!])) };
    styles.cache.set(el, pseudo, entry);
    style = whole(map, entry);
  }
  if (!pseudo && style.get('container-type') !== 'normal') styles.cache.containers.push(el);
  return style;
}

/**
 * The declarations for a style. A reused one keeps its declarations, and only
 * its layout values are diffed again: an element whose parent changed is
 * re-read itself, so what it inherits is unchanged.
 */
function declarationsFor(
  style: ReadStyle,
  defaults: Map<string, string>,
  parent: Style | null,
  adjust: (decls: Array<[string, string]>) => Array<[string, string]> = (d) => d,
): Array<[string, string]> {
  if (!style.map) return [...style.entry!.decls!, ...diffStyle(style, defaults, parent, layoutNames!)];
  const decls = adjust(diffStyle(style, defaults, parent, style.map.keys()));
  if (style.entry) style.entry.decls = decls.filter(([n]) => !LAYOUT.has(n));
  return decls;
}

const LISTS = new Set(['ul', 'ol', 'menu', 'dir']);

// UA defaults differ per input type (a checkbox has margins, a text input does
// not), and UA rules key on state and context too: a `:disabled` field turns
// grey, a nested list gets circle markers, and a radio is round only with its
// native `appearance`. A value the page sets back to the plain default would be
// left out, and the clone would take the UA's, so the default is read from an
// element in the same state. Its `appearance` stays the UA's, so a changed one
// is still written.
function getDefaultStyle(src: Element, pseudo: string | null): Map<string, string> {
  const type = src instanceof HTMLInputElement ? src.type : '';
  const appearance = pseudo ? '' : computedStyle(src).appearance;
  const disabled = src.matches(':disabled');
  const nested = LISTS.has(src.localName) && !!src.parentElement?.closest('ul,ol,menu,dir');
  const key = `${src.localName}[${type}]${pseudo ?? ''}${disabled ? ':' : ''}${nested ? '>' : ''}`;
  const read = (key: string, appearance = '') => {
    let style = defaultStyleCache.get(key);
    if (!style) {
      const doc = getSandboxDoc();
      const parent = nested ? doc.body.appendChild(doc.createElement('ul')) : doc.body;
      const el = parent.appendChild(doc.createElement(src.localName)) as HTMLElement;
      if (type) el.setAttribute('type', type);
      el.toggleAttribute('disabled', disabled);
      el.style.appearance = appearance;
      style = styleToMap(doc.defaultView!.getComputedStyle(el, pseudo), EMPTY, src instanceof SVGElement);
      (nested ? parent : el).remove();
      defaultStyleCache.set(key, style);
    }
    return style;
  };
  const plain = read(key);
  const ua = plain.get('appearance')!;
  if (!appearance || appearance === ua) return plain;
  const themed = read(`${key}{${appearance}}`, appearance);
  themed.set('appearance', ua);
  return themed;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function inlineUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:')) return Promise.resolve(url);
  let pending = resourceCache.get(url);
  if (!pending) {
    pending = fetch(url, { mode: 'cors', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(readAsDataUrl)
      .catch(() => null);
    resourceCache.set(url, pending);
  }
  return pending;
}

const URL_RE = /url\((['"]?)([^'")]+)\1\)/g;

async function inlineCssUrls(value: string, base: string): Promise<string> {
  const matches = [...value.matchAll(URL_RE)];
  if (matches.length === 0) return value;
  const replacements = await Promise.all(
    matches.map(async (m) => {
      const data = await inlineUrl(new URL(m[2]!, base).href);
      return `url("${data ?? TRANSPARENT_PIXEL}")`;
    }),
  );
  let i = 0;
  return value.replace(URL_RE, () => replacements[i++]!);
}

interface CloneContext {
  isBoundary: ((el: Element) => boolean) | undefined;
  styles: SnapshotOptions['styles'];
  rootStyle: Array<[string, string]> | undefined;
  pending: Promise<void>[];
  customProps: ReadonlySet<string>;
  pseudoRules: string[];
  families: Set<string>;
  root: Element;
  sel: SelectionState;
  /** Markup drawn over the root (text-control carets and selections). */
  overlays: string[];
}

const INHERITED_PREFIXES = ['font', 'text-', '-webkit-text-', 'list-style', 'fill', 'stroke', 'marker', 'white-space', 'word-', 'letter-', 'line-', 'hyphen', 'ruby', 'math-'];
const INHERITED = new Set([
  'color', 'direction', 'writing-mode', 'visibility', 'cursor', 'quotes', 'tab-size', 'overflow-wrap',
  'caret-color', 'accent-color', 'color-scheme', 'border-collapse', 'border-spacing', 'caption-side',
  'empty-cells', 'orphans', 'widows', 'paint-order', 'image-rendering', 'pointer-events', 'speak',
  'dominant-baseline', 'text-anchor', 'shape-rendering', 'clip-rule', 'color-interpolation',
  'color-rendering', 'print-color-adjust', 'forced-color-adjust', '-webkit-locale', '-webkit-font-smoothing',
  '-moz-osx-font-smoothing', '-webkit-border-horizontal-spacing', '-webkit-border-vertical-spacing',
  '-webkit-rtl-ordering', '-webkit-user-modify', '-webkit-text-security', '-webkit-highlight', 'hanging-punctuation',
]);
// Prefix exceptions: text-decoration propagates rather than inherits.
const NOT_INHERITED = /^text-(decoration|overflow|box)|^-webkit-text-decorations|^line-clamp/;

function isInherited(name: string): boolean {
  if (INHERITED.has(name)) return true;
  if (NOT_INHERITED.test(name)) return false;
  return INHERITED_PREFIXES.some((p) => name.startsWith(p));
}

// Inherited properties are written when they differ from the parent;
// everything else when it differs from the UA default. Never writing UA
// defaults matters for form controls: an author-specified border/background
// (even an identical one) disables their native appearance.
function diffStyle(
  cs: Style,
  defaults: Map<string, string>,
  parent: Style | null,
  names: Iterable<string>,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const base = baselineStyle();
  // UA padding depends on `appearance` (WebKit themes text fields), so a
  // default computed with another appearance can't be trusted for padding.
  const themed = cs.get('appearance') !== defaults.get('appearance');
  for (const name of names) {
    const value = cs.get(name)!;
    if (themed && name.startsWith('padding')) {
      out.push([name, value]);
      continue;
    }
    // Inherited properties compare against the parent, unless the UA sheet
    // resets them for this tag (e.g. `font` on form controls): then the
    // clone will not inherit either, so compare against the UA default.
    const uaResets = defaults !== base && defaults.get(name) !== base.get(name);
    const ref = parent && isInherited(name) && !uaResets ? parent.get(name) : defaults.get(name);
    if (value !== ref || ALWAYS_WRITE.has(name) || mustPairWidth(name, cs, defaults)) {
      out.push([name, SIZE.test(name) ? snapToUnit(value, layoutUnit ??= measureLayoutUnit()) : value]);
    }
  }
  return out;
}

// Computed sizes are rounded to six significant digits ("273.281px"), while
// layout keeps a finer unit (1/64 px in Blink and WebKit, 1/60 in Gecko). Read
// back, a shrink-to-fit width can lose a unit and wrap its last item in the
// clone, so sizes are written in the engine's unit, measured once.
const SIZE = /^(?:width|height|(?:inline|block)-size)$/;
let layoutUnit: number | undefined;

function measureLayoutUnit(): number {
  const doc = getSandboxDoc();
  const probe = doc.body.appendChild(doc.createElement('div'));
  probe.style.width = '.02px';
  const read = parseFloat(doc.defaultView!.getComputedStyle(probe).width);
  probe.remove();
  // A width kept at 0.02px (no layout, as in a DOM emulation) says nothing.
  return read > 0 && read < 0.0199 ? 1 / Math.round(1 / read) : 0;
}

/** A computed `px` length, rounded to the nearest multiple of `unit` (none when 0). */
export function snapToUnit(value: string, unit: number): string {
  const n = unit && value.endsWith('px') ? Number(value.slice(0, -2)) : NaN;
  return n === n ? `${Math.round(n / unit) * unit}px` : value;
}

function baselineStyle(): Map<string, string> {
  return defaultStyleCache.get('div[]') ?? getDefaultStyle(getSandboxDoc().createElement('div'), null);
}

// `min-width: auto` computes to `0px` outside flex/grid items (like the UA
// default element), so a live `0px` can hide a needed override in context.
const ALWAYS_WRITE = new Set(['min-width', 'min-height', 'min-inline-size', 'min-block-size']);

// A `none` style computes its width to 0, so a default's `0px` width hides the
// specified `medium` initial value. When the element has a visible style but a
// 0px width, the width must be written explicitly or the clone gets 3px.
function mustPairWidth(name: string, cs: Style, defaults: Map<string, string>): boolean {
  if (!name.endsWith('-width')) return false;
  const styleName = name.slice(0, -'width'.length) + 'style';
  const style = cs.get(styleName);
  return style !== undefined && style !== 'none' && style !== defaults.get(styleName);
}

function collectFamilies(value: string | undefined, into: Set<string>): void {
  if (!value) return;
  for (const f of value.split(',')) into.add(f.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
}

function applyDeclarations(
  decls: Array<[string, string]>,
  ctx: CloneContext,
  apply: (css: string) => void,
): void {
  const toCss = (list: Array<[string, string]>) => list.map(([n, v]) => `${n}:${v}`).join(';');
  if (!decls.some(([, v]) => v.includes('url('))) {
    apply(toCss(decls));
    return;
  }
  ctx.pending.push(
    Promise.all(
      decls.map(
        async ([n, v]): Promise<[string, string]> => [
          n,
          v.includes('url(') ? await inlineCssUrls(v, document.baseURI) : v,
        ],
      ),
    ).then((resolved) => apply(toCss(resolved))),
  );
}

function clonePseudo(
  src: Element,
  clone: Element,
  hostStyle: Style,
  ctx: CloneContext,
): void {
  for (const pseudo of ['::before', '::after', '::placeholder'] as const) {
    const isPlaceholder = pseudo === '::placeholder';
    if (isPlaceholder && !(src instanceof HTMLInputElement || src instanceof HTMLTextAreaElement)) continue;
    const cs = computedStyle(src, pseudo);
    const content = cs.getPropertyValue('content');
    if (!isPlaceholder && (content === 'none' || content === 'normal' || content === '')) continue;
    const style = readStyle(src, pseudo, ctx);
    const decls = declarationsFor(style, getDefaultStyle(src, pseudo), hostStyle);
    if (!isPlaceholder && !decls.some(([n]) => n === 'content')) decls.push(['content', content]);
    collectFamilies(style.get('font-family'), ctx.families);
    const cls = `hic-p${++pseudoCounter}`;
    clone.classList.add(cls);
    applyDeclarations(decls, ctx, (css) => ctx.pseudoRules.push(`.${cls}${pseudo}{${css}}`));
  }
}

const isFormControl = (el: Element) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;

function copyFormState(src: Element, clone: Element): void {
  if (src instanceof HTMLInputElement) {
    if (src.type === 'checkbox' || src.type === 'radio') {
      if (src.checked) clone.setAttribute('checked', '');
      else clone.removeAttribute('checked');
    } else if (src.type === 'password') {
      // The clone masks it the same way; the real value never enters the snapshot.
      clone.setAttribute('value', 'x'.repeat([...src.value].length));
    } else if (src.type !== 'file') {
      clone.setAttribute('value', src.value);
    }
  } else if (src instanceof HTMLTextAreaElement) {
    clone.textContent = src.value;
  } else if (src instanceof HTMLSelectElement) {
    const opts = clone.querySelectorAll('option');
    Array.from(src.options).forEach((o, i) => {
      if (o.selected) opts[i]?.setAttribute('selected', '');
      else opts[i]?.removeAttribute('selected');
    });
  }
}

/**
 * Children in the flat tree: an open shadow root replaces the light children,
 * and a slot is replaced by its assigned nodes (or its fallback content).
 */
function flatChildren(el: Element): Node[] {
  if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
  if (el instanceof HTMLSlotElement && el.getRootNode() instanceof ShadowRoot) {
    const assigned = el.assignedNodes();
    if (assigned.length > 0) return assigned;
  }
  return Array.from(el.childNodes);
}

function cloneNode(
  src: Node,
  parentStyle: Style | null,
  ctx: CloneContext,
  isRoot: boolean,
): Node | null {
  if (src.nodeType === Node.TEXT_NODE) return cloneText(src as Text, ctx.sel);
  if (src.nodeType !== Node.ELEMENT_NODE) return null;
  const el = src as Element;
  if (el.localName === 'script' || el.localName === 'style' || el.localName === 'noscript') return null;

  if (!isRoot && ctx.isBoundary?.(el) && computedStyle(el).display === 'inline') {
    // Nested drawables have their own snapshots. An inline one can wrap and
    // ignores width and height, so clone its content invisibly to keep the
    // parent's line boxes exact.
    const isBoundary = ctx.isBoundary;
    ctx.isBoundary = (e) => e !== el && isBoundary(e);
    let box: Node | null;
    try {
      box = cloneNode(src, parentStyle, ctx, false);
    } finally {
      ctx.isBoundary = isBoundary;
    }
    if (box instanceof Element) {
      for (const e of [box, ...box.querySelectorAll('*')]) {
        e.setAttribute('style', `${e.getAttribute('style') ?? ''};visibility:hidden!important`);
      }
    }
    return box;
  }

  const style = readStyle(el, null, ctx);
  // currentcolor resolved; pinning it overrides WebKit's ::placeholder colour.
  const unpinFill = (decls: Array<[string, string]>) =>
    style.get('-webkit-text-fill-color') === style.get('color') ? decls.filter(([n]) => n !== '-webkit-text-fill-color') : decls;
  if (!isRoot && ctx.isBoundary?.(el)) {
    // Nested drawables have their own snapshots. Keep the box so siblings lay
    // out the same, but paint nothing.
    const he = el as HTMLElement;
    const decls = declarationsFor(style, getDefaultStyle(el, null), parentStyle, unpinFill);
    decls.push(
      ['box-sizing', 'border-box'],
      ['width', `${he.offsetWidth}px`],
      ['height', `${he.offsetHeight}px`],
      ['visibility', 'hidden'],
      ['animation', 'none'],
      ['transition', 'none'],
    );
    const box = document.createElementNS(XHTML_NS, el.localName === 'canvas' ? 'span' : el.localName);
    box.setAttribute('style', decls.map(([n, v]) => `${n}:${v.replace(/url\([^)]*\)/g, 'none')}`).join(';'));
    return box;
  }

  let clone: Element;
  if (el instanceof HTMLCanvasElement) {
    clone = document.createElement('img');
    try {
      clone.setAttribute('src', el.toDataURL());
    } catch {
      // A tainted canvas can't be read, so it's left out.
    }
  } else {
    clone = el.cloneNode(false) as Element;
  }

  collectFamilies(style.get('font-family'), ctx.families);
  let decls = declarationsFor(style, getDefaultStyle(el, null), parentStyle, unpinFill);
  if (el.localName === 'fieldset' || (el instanceof HTMLTableElement && el.caption)) {
    // WebKit's computed fieldset height excludes the rendered legend; pinning
    // it would clip the clone. A table's includes its caption in Blink and
    // WebKit, while a specified height doesn't, so pinning it would spread the
    // caption's height over the rows. Let both size from their content.
    decls = decls.filter(([n]) => n !== 'height' && n !== 'block-size');
  }
  decls.push(['animation', 'none'], ['transition', 'none']);
  const overflowX = style.get('overflow-x');
  const overflowY = style.get('overflow-y');
  if (overflowX === 'auto' || overflowX === 'scroll' || overflowY === 'auto' || overflowY === 'scroll') {
    // A snapshot cannot scroll: clip instead, but keep the space classic
    // scrollbars take so content wraps exactly as in the live element.
    const he = el as HTMLElement;
    const cs = computedStyle(el);
    const gutterX = he.offsetWidth - he.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    const gutterY = he.offsetHeight - he.clientHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    decls.push(['overflow', 'hidden']);
    if (gutterX > 0 || gutterY > 0) decls.push(['scrollbar-gutter', 'stable']);
  }
  if (el instanceof HTMLInputElement && el.scrollLeft !== 0) {
    // Inputs can't be scrolled in the snapshot; indent the text instead.
    decls.push(['text-indent', `calc(${style.get('text-indent') ?? '0px'} - ${Math.abs(el.scrollLeft)}px)`]);
  }
  if (isRoot) {
    decls.push(
      ['margin', '0'],
      ['inset', 'auto'],
      ['transform', 'none'],
      ['translate', 'none'],
      ['rotate', 'none'],
      ['scale', 'none'],
      // Computed min/max sizes keep percentages, which would resolve against
      // the snapshot instead of the canvas. The pinned width/height suffice.
      ['min-width', '0'],
      ['max-width', 'none'],
      ['min-height', '0'],
      ['max-height', 'none'],
      ...(ctx.rootStyle ?? []),
    );
  }
  applyDeclarations(decls, ctx, (css) => clone.setAttribute('style', css));
  clonePseudo(el, clone, style, ctx);

  if (el instanceof HTMLImageElement) {
    const url = el.currentSrc || el.src;
    clone.removeAttribute('srcset');
    clone.removeAttribute('loading');
    if (url) {
      ctx.pending.push(
        inlineUrl(url).then((data) => clone.setAttribute('src', data ?? TRANSPARENT_PIXEL)),
      );
    }
  }

  let target: Element = clone;
  if ((el.scrollTop !== 0 || el.scrollLeft !== 0) && !isFormControl(el)) {
    // The snapshot is static, so emulate the scroll offset by shifting content.
    target = document.createElementNS(XHTML_NS, 'div');
    target.setAttribute('style', `transform:translate(${-el.scrollLeft}px,${-el.scrollTop}px)`);
    clone.appendChild(target);
  }
  const children = flatChildren(el);
  children.forEach((child, i) => {
    const caret = caretBefore(el, i, ctx.sel);
    if (caret) target.appendChild(caret);
    const c = cloneNode(child, style, ctx, false);
    if (c) target.appendChild(c);
  });
  const caret = caretBefore(el, children.length, ctx.sel);
  if (caret) target.appendChild(caret);
  // After children so <option> clones exist.
  copyFormState(el, clone);
  if (el === ctx.sel.control) ctx.overlays.push(controlOverlay(ctx.sel.control, ctx.root, ctx.sel));
  return clone;
}

// Pseudo-elements whose styles getComputedStyle cannot read (vendor form-control
// parts, ::marker, ::file-selector-button, ...). ::before/::after/::placeholder
// are cloned from computed style instead.
const OPAQUE_PSEUDO_RE = /::(?!before\b|after\b|placeholder\b)[\w-]+(?:\([^)]*\))?/g;

function conditionHolds(rule: CSSRule): boolean {
  if (rule instanceof CSSMediaRule) return matchMedia(rule.conditionText).matches;
  if (rule instanceof CSSSupportsRule) return CSS.supports(rule.conditionText);
  return true;
}

function matchesWithin(root: Element, selectorText: string): boolean {
  const base = selectorText.replace(OPAQUE_PSEUDO_RE, '');
  try {
    return root.matches(base) || root.querySelector(base) !== null;
  } catch {
    return false;
  }
}

interface SheetScan {
  fontFaces: Array<{ family: string; cssText: string; base: string }>;
  pseudoRules: Array<{ cssText: string; base: string }>;
  customProps: Set<string>;
}

const VAR_RE = /var\(\s*(--[\w-]+)/g;

/**
 * Walks same-origin stylesheets once, collecting @font-face rules and verbatim
 * rules for opaque pseudo-elements that match inside `root`. Classes and
 * attributes survive cloning, so those rules still match in the snapshot as
 * long as they do not depend on ancestors outside `root`.
 */
function scanSheets(root: Element): SheetScan {
  const scan: SheetScan = { fontFaces: [], pseudoRules: [], customProps: new Set() };
  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules: CSSRuleList;
    try {
      cssRules = sheet.cssRules;
    } catch {
      // A cross-origin stylesheet can't be read.
      continue;
    }
    const base = sheet.href ?? document.baseURI;
    const walk = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSFontFaceRule) {
          const family = rule.style
            .getPropertyValue('font-family')
            .replace(/^['"]|['"]$/g, '')
            .toLowerCase();
          scan.fontFaces.push({ family, cssText: rule.cssText, base });
        } else if (rule instanceof CSSStyleRule) {
          OPAQUE_PSEUDO_RE.lastIndex = 0;
          if (OPAQUE_PSEUDO_RE.test(rule.selectorText) && matchesWithin(root, rule.selectorText)) {
            scan.pseudoRules.push({ cssText: rule.cssText, base });
            for (const m of rule.cssText.matchAll(VAR_RE)) scan.customProps.add(m[1]!);
          }
        } else if ('cssRules' in rule && conditionHolds(rule)) {
          walk((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    walk(cssRules);
  }
  return scan;
}

function sheetCss(scan: SheetScan, families: Set<string>): Promise<string[]> {
  return Promise.all([
    ...scan.fontFaces.filter((f) => families.has(f.family)).map((f) => inlineCssUrls(f.cssText, f.base)),
    ...scan.pseudoRules.map((r) => inlineCssUrls(r.cssText, r.base)),
  ]);
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

export async function snapshot(el: Element, opts: SnapshotOptions): Promise<SnapshotResult> {
  const he = el as HTMLElement;
  const cssWidth = he.offsetWidth ?? 0;
  const cssHeight = he.offsetHeight ?? 0;
  const width = Math.round(cssWidth * opts.scaleX);
  const height = Math.round(cssHeight * opts.scaleY);
  if (width <= 0 || height <= 0) return { bitmap: null, width: 0, height: 0, cssWidth, cssHeight };

  const scan = scanSheets(el);
  if (opts.styles) opts.styles.cache.customProps = scan.customProps;
  const ctx: CloneContext = {
    isBoundary: opts.isBoundary,
    styles: opts.styles,
    rootStyle: opts.rootStyle,
    pending: [],
    customProps: scan.customProps,
    pseudoRules: [],
    families: new Set(),
    root: el,
    sel: readSelection(),
    overlays: [],
  };
  const clone = cloneNode(el, null, ctx, true) as Element;
  const sheetRules = sheetCss(scan, ctx.families);
  await Promise.all(ctx.pending);
  const css = `${(await sheetRules).join('\n')}\n${ctx.pseudoRules.join('\n')}`;

  const body = new XMLSerializer().serializeToString(clone) + ctx.overlays.join('');
  const svgFor = (caret: string) =>
    // Scale with a CSS transform rather than viewBox: WebKit rasterizes
    // foreignObject content at 1x and ignores the viewBox scale.
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="${XHTML_NS}" style="width:${cssWidth}px;height:${cssHeight}px;${CARET_VAR}:${caret};` +
    `transform:scale(${width / cssWidth},${height / cssHeight});transform-origin:0 0">` +
    `<style>${escapeXmlText(css)}</style>${body}</div></foreignObject></svg>`;
  const render = async (svg: string) => {
    // Data URLs only: blob URLs taint the canvas in Chromium and WebKit.
    const img = new Image(width, height);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    return toBitmap(img, width, height);
  };
  const caret = ctx.sel.caretColor;
  const svg = svgFor(caret ?? 'transparent');
  const [bitmap, caretOff] = await Promise.all([render(svg), caret ? render(svgFor('transparent')) : null]);
  return { bitmap, caretOff, width, height, cssWidth, cssHeight };
}
