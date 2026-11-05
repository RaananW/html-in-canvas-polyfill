// Minimal foreignObject serializer used to evaluate the "own serializer" option.
// Spike quality: it covers the techniques phase 1 needs (computed-style
// inlining with default diffing, pseudo-elements, form state, image/font
// inlining, scroll offsets) so latency and fidelity can be compared with
// off-the-shelf libraries.

export type UrlKind = 'data' | 'blob';
export type BitmapPath = 'img' | 'canvas';

export interface SnapshotOptions {
  scale: number;
  urlKind: UrlKind;
  bitmapPath: BitmapPath;
  /** Keep the SVG markup on the result (debugging only). */
  keepSvg?: boolean;
}

export interface SnapshotTimings {
  clone: number;
  resources: number;
  serialize: number;
  decode: number;
  bitmap: number;
  total: number;
}

export interface SnapshotResult {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  timings: SnapshotTimings;
  svgBytes: number;
  svg?: string;
  warnings: string[];
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

let standardNames: string[] | null = null;

// Enumerating a computed style also yields every inherited custom property;
// design systems put hundreds on :root (Strata: ~300), tripling the cost.
// Computed values are already var()-resolved, so only custom properties used
// by verbatim-copied rules are read.
function styleToMap(cs: CSSStyleDeclaration, custom: ReadonlySet<string> = EMPTY): Map<string, string> {
  if (!standardNames) {
    standardNames = [];
    for (let i = 0; i < cs.length; i++) if (!cs[i]!.startsWith('--')) standardNames.push(cs[i]!);
  }
  const map = new Map<string, string>();
  for (const name of standardNames) map.set(name, cs.getPropertyValue(name));
  for (const name of custom) {
    const v = cs.getPropertyValue(name);
    if (v) map.set(name, v);
  }
  return map;
}

const EMPTY: ReadonlySet<string> = new Set();

// UA defaults differ per input type (a checkbox has margins, a text input does not).
function getDefaultStyle(src: Element, pseudo: string | null): Map<string, string> {
  const type = src instanceof HTMLInputElement ? src.type : '';
  const key = `${src.localName}[${type}]${pseudo ?? ''}`;
  let cached = defaultStyleCache.get(key);
  if (!cached) {
    const doc = getSandboxDoc();
    const el = doc.createElement(src.localName);
    if (type) el.setAttribute('type', type);
    doc.body.appendChild(el);
    cached = styleToMap(doc.defaultView!.getComputedStyle(el, pseudo));
    el.remove();
    defaultStyleCache.set(key, cached);
  }
  return cached;
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

async function inlineCssUrls(value: string, base: string, warnings: string[]): Promise<string> {
  const matches = [...value.matchAll(URL_RE)];
  if (matches.length === 0) return value;
  const replacements = await Promise.all(
    matches.map(async (m) => {
      const abs = new URL(m[2]!, base).href;
      const data = await inlineUrl(abs);
      if (!data) warnings.push(`could not inline ${abs}`);
      return `url("${data ?? TRANSPARENT_PIXEL}")`;
    }),
  );
  let i = 0;
  return value.replace(URL_RE, () => replacements[i++]!);
}

interface CloneContext {
  pending: Promise<void>[];
  customProps: ReadonlySet<string>;
  pseudoRules: string[];
  families: Set<string>;
  warnings: string[];
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
  cs: Map<string, string>,
  defaults: Map<string, string>,
  parent: Map<string, string> | null,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const base = baselineStyle();
  for (const [name, value] of cs) {
    // Inherited properties compare against the parent, unless the UA sheet
    // resets them for this tag (e.g. `font` on form controls): then the
    // clone will not inherit either, so compare against the UA default.
    const uaResets = defaults !== base && defaults.get(name) !== base.get(name);
    const ref = parent && isInherited(name) && !uaResets ? parent.get(name) : defaults.get(name);
    if (value !== ref || ALWAYS_WRITE.has(name) || mustPairWidth(name, cs, defaults)) out.push([name, value]);
  }
  return out;
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
function mustPairWidth(name: string, cs: Map<string, string>, defaults: Map<string, string>): boolean {
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
          v.includes('url(') ? await inlineCssUrls(v, document.baseURI, ctx.warnings) : v,
        ],
      ),
    ).then((resolved) => apply(toCss(resolved))),
  );
}

function clonePseudo(
  src: Element,
  clone: Element,
  hostStyle: Map<string, string>,
  ctx: CloneContext,
): void {
  for (const pseudo of ['::before', '::after', '::placeholder'] as const) {
    const isPlaceholder = pseudo === '::placeholder';
    if (isPlaceholder && !(src instanceof HTMLInputElement || src instanceof HTMLTextAreaElement)) continue;
    const cs = getComputedStyle(src, pseudo);
    const content = cs.getPropertyValue('content');
    if (!isPlaceholder && (content === 'none' || content === 'normal' || content === '')) continue;
    const map = styleToMap(cs, ctx.customProps);
    const decls = diffStyle(map, getDefaultStyle(src, pseudo), hostStyle);
    if (!isPlaceholder && !decls.some(([n]) => n === 'content')) decls.push(['content', content]);
    collectFamilies(map.get('font-family'), ctx.families);
    const cls = `hic-p${++pseudoCounter}`;
    clone.classList.add(cls);
    applyDeclarations(decls, ctx, (css) => ctx.pseudoRules.push(`.${cls}${pseudo}{${css}}`));
  }
}

function copyFormState(src: Element, clone: Element): void {
  if (src instanceof HTMLInputElement) {
    if (src.type === 'checkbox' || src.type === 'radio') {
      if (src.checked) clone.setAttribute('checked', '');
      else clone.removeAttribute('checked');
    } else if (src.type !== 'file' && src.type !== 'password') {
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

function cloneNode(
  src: Node,
  parentStyle: Map<string, string> | null,
  ctx: CloneContext,
  isRoot: boolean,
): Node | null {
  if (src.nodeType === Node.TEXT_NODE) return src.cloneNode(false);
  if (src.nodeType !== Node.ELEMENT_NODE) return null;
  const el = src as Element;
  if (el.localName === 'script' || el.localName === 'style' || el.localName === 'noscript') return null;

  let clone: Element;
  if (el instanceof HTMLCanvasElement) {
    clone = document.createElement('img');
    try {
      clone.setAttribute('src', el.toDataURL());
    } catch {
      ctx.warnings.push('tainted <canvas> child skipped');
    }
  } else {
    clone = el.cloneNode(false) as Element;
    clone.removeAttribute('id');
  }

  const csMap = styleToMap(getComputedStyle(el), ctx.customProps);
  collectFamilies(csMap.get('font-family'), ctx.families);
  let decls = diffStyle(csMap, getDefaultStyle(el, null), parentStyle);
  if (el.localName === 'fieldset') {
    // WebKit's computed fieldset height excludes the rendered legend; pinning
    // it would clip the clone. Let the fieldset size from its content.
    decls = decls.filter(([n]) => n !== 'height' && n !== 'block-size');
  }
  if (csMap.get('-webkit-text-fill-color') === csMap.get('color')) {
    // currentcolor resolved; pinning it overrides WebKit's ::placeholder colour.
    decls = decls.filter(([n]) => n !== '-webkit-text-fill-color');
  }
  decls.push(['animation', 'none'], ['transition', 'none']);
  const overflowX = csMap.get('overflow-x');
  const overflowY = csMap.get('overflow-y');
  if (overflowX === 'auto' || overflowX === 'scroll' || overflowY === 'auto' || overflowY === 'scroll') {
    // A snapshot cannot scroll: clip instead, but keep the space classic
    // scrollbars take so content wraps exactly as in the live element.
    const he = el as HTMLElement;
    const cs = getComputedStyle(el);
    const gutterX = he.offsetWidth - he.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    const gutterY = he.offsetHeight - he.clientHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    decls.push(['overflow', 'hidden']);
    if (gutterX > 0 || gutterY > 0) decls.push(['scrollbar-gutter', 'stable']);
  }
  if (isRoot) {
    decls.push(
      ['margin', '0'],
      ['inset', 'auto'],
      ['transform', 'none'],
      ['translate', 'none'],
      ['rotate', 'none'],
      ['scale', 'none'],
    );
  }
  applyDeclarations(decls, ctx, (css) => clone.setAttribute('style', css));
  clonePseudo(el, clone, csMap, ctx);

  if (el instanceof HTMLImageElement) {
    const url = el.currentSrc || el.src;
    clone.removeAttribute('srcset');
    clone.removeAttribute('loading');
    if (url) {
      ctx.pending.push(
        inlineUrl(url).then((data) => {
          if (!data) ctx.warnings.push(`could not inline <img> ${url}`);
          clone.setAttribute('src', data ?? TRANSPARENT_PIXEL);
        }),
      );
    }
  }

  let target: Element = clone;
  if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
    // The snapshot is static, so emulate the scroll offset by shifting content.
    target = document.createElementNS(XHTML_NS, 'div');
    target.setAttribute('style', `transform:translate(${-el.scrollLeft}px,${-el.scrollTop}px)`);
    clone.appendChild(target);
  }
  for (const child of Array.from(el.childNodes)) {
    const c = cloneNode(child, csMap, ctx, false);
    if (c) target.appendChild(c);
  }
  // After children so <option> clones exist.
  copyFormState(el, clone);
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
function scanSheets(root: Element, warnings: string[]): SheetScan {
  const scan: SheetScan = { fontFaces: [], pseudoRules: [], customProps: new Set() };
  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules: CSSRuleList;
    try {
      cssRules = sheet.cssRules;
    } catch {
      warnings.push(`cross-origin stylesheet skipped: ${sheet.href}`);
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

function sheetCss(scan: SheetScan, families: Set<string>, warnings: string[]): Promise<string[]> {
  return Promise.all([
    ...scan.fontFaces.filter((f) => families.has(f.family)).map((f) => inlineCssUrls(f.cssText, f.base, warnings)),
    ...scan.pseudoRules.map((r) => inlineCssUrls(r.cssText, r.base, warnings)),
  ]);
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

export async function snapshot(el: HTMLElement, opts: SnapshotOptions): Promise<SnapshotResult> {
  const t0 = performance.now();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const warnings: string[] = [];
  const scan = scanSheets(el, warnings);
  const ctx: CloneContext = { pending: [], customProps: scan.customProps, pseudoRules: [], families: new Set(), warnings };
  const clone = cloneNode(el, null, ctx, true) as Element;
  const t1 = performance.now();

  const sheetRules = sheetCss(scan, ctx.families, ctx.warnings);
  await Promise.all(ctx.pending);
  const css = `${(await sheetRules).join('\n')}\n${ctx.pseudoRules.join('\n')}`;
  const t2 = performance.now();

  const body = new XMLSerializer().serializeToString(clone);
  const pw = Math.round(width * opts.scale);
  const ph = Math.round(height * opts.scale);
  const svg =
    // Scale with a CSS transform rather than viewBox: WebKit rasterizes
    // foreignObject content at 1x and ignores the viewBox scale.
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}">` +
    `<foreignObject x="0" y="0" width="${pw}" height="${ph}">` +
    `<div xmlns="${XHTML_NS}" style="width:${width}px;height:${height}px;transform:scale(${pw / width},${ph / height});transform-origin:0 0">` +
    `<style>${escapeXmlText(css)}</style>${body}</div></foreignObject></svg>`;
  const url =
    opts.urlKind === 'blob'
      ? URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const t3 = performance.now();

  const img = new Image();
  img.width = pw;
  img.height = ph;
  img.src = url;
  try {
    await img.decode();
  } finally {
    if (opts.urlKind === 'blob') URL.revokeObjectURL(url);
  }
  const t4 = performance.now();

  let bitmap: ImageBitmap;
  if (opts.bitmapPath === 'img') {
    bitmap = await createImageBitmap(img);
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    canvas.getContext('2d')!.drawImage(img, 0, 0, pw, ph);
    bitmap = await createImageBitmap(canvas);
  }
  const t5 = performance.now();

  return {
    bitmap,
    width: pw,
    height: ph,
    svgBytes: svg.length,
    svg: opts.keepSvg ? svg : undefined,
    warnings: ctx.warnings,
    timings: {
      clone: t1 - t0,
      resources: t2 - t1,
      serialize: t3 - t2,
      decode: t4 - t3,
      bitmap: t5 - t4,
      total: t5 - t0,
    },
  };
}
