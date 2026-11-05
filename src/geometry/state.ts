import { composedParent, isElement, reverseTreeOrder } from '../dom';
import { cssClip, cssMatrix, isFiniteMatrix, localTransform } from './matrix';

/** Marks elements with geometry; the value keys their overlay rule. */
export const GEOMETRY_ATTR = 'data-hic-g';

export interface GeometryUpdate {
  /** Maps the border box (CSS px, before CSS transforms) to the canvas border box (CSS px). */
  transform?: DOMMatrix;
  /** Hit-test clip in the transform's input space. */
  clip?: DOMRect;
  preserveHitTestOrder?: boolean;
}

export interface GeometryOwner {
  readonly host: HTMLElement;
  /** True while `el` is a drawable of this canvas. */
  owns(el: Element): boolean;
  /** The canvas content-box origin relative to its border box. */
  contentOrigin(): { x: number; y: number };
  sheetFor(root: Node): CSSStyleSheet | null;
}

interface Entry {
  id: number;
  transform: DOMMatrix;
  clip: DOMRect | null;
  rule: CSSStyleRule | null;
  sheet: CSSStyleSheet | null;
  css: string;
  /** Authored values of properties the overlay rule overrides, read before the first rule. */
  authored: { position: string; clipPath: string } | null;
  /** The CSS transform written for the element. */
  applied: DOMMatrix | null;
}

const pending = new Set<Geometry>();
let flushing = false;
let nextId = 1;

/** Applies pending geometry now. Hit-testing and geometry reads call this first. */
export function flushGeometry(): void {
  if (flushing || pending.size === 0) return;
  flushing = true;
  try {
    for (const geometry of Array.from(pending)) geometry.flush();
  } finally {
    flushing = false;
  }
}

const sameMatrix = (a: DOMMatrixReadOnly, b: DOMMatrixReadOnly) => {
  if (a.is2D !== b.is2D) return false;
  const x = a.toFloat64Array();
  const y = b.toFloat64Array();
  return x.every((v, i) => v === y[i]);
};

const sameRect = (a: DOMRectReadOnly | null, b: DOMRectReadOnly | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/**
 * Element geometry for one canvas. Hit testing works by giving each element
 * with geometry a CSS transform (and clip) that places its live box, inside the
 * invisible host, exactly where the canvas drew it. The rules live in the
 * polyfill's own stylesheet, so they never show up as DOM mutations.
 */
export class Geometry {
  private readonly entries = new Map<Element, Entry>();
  /** Hit-test stack; the last element is on top. */
  private stack: Element[] = [];
  private dirty = false;

  constructor(private readonly owner: GeometryOwner) {}

  has(el: Element): boolean {
    return this.entries.has(el);
  }

  transformOf(el: Element): DOMMatrix {
    const entry = this.entries.get(el);
    return entry ? DOMMatrix.fromMatrix(entry.transform) : new DOMMatrix();
  }

  update(el: Element, update: GeometryUpdate): void {
    let entry = this.entries.get(el);
    let changed = false;
    if (!entry) {
      entry = { id: nextId++, transform: new DOMMatrix(), clip: null, rule: null, sheet: null, css: '', authored: null, applied: null };
      this.entries.set(el, entry);
      el.setAttribute(GEOMETRY_ATTR, String(entry.id));
      changed = true;
    }
    if (update.transform && !sameMatrix(update.transform, entry.transform)) {
      entry.transform = update.transform;
      changed = true;
    }
    if (update.clip && !sameRect(update.clip, entry.clip)) {
      entry.clip = update.clip;
      changed = true;
    }
    const index = this.stack.indexOf(el);
    if (index < 0) {
      this.stack.push(el);
      changed = true;
    } else if (!update.preserveHitTestOrder && index !== this.stack.length - 1) {
      this.stack.splice(index, 1);
      this.stack.push(el);
      changed = true;
    }
    if (changed) this.invalidate();
  }

  clear(el: Element): void {
    if (!this.entries.has(el)) return;
    this.drop(el);
    // Descendants compensate for this element's transform.
    this.invalidate();
  }

  /** Recomputes every rule (layout may have moved the live boxes). */
  invalidate(): void {
    if (this.dirty || this.entries.size === 0) return;
    this.dirty = true;
    pending.add(this);
    queueMicrotask(flushGeometry);
  }

  /** Declarations that restore authored values in snapshots of `el`. */
  authoredStyle(el: Element): Array<[string, string]> | undefined {
    const authored = this.entries.get(el)?.authored;
    return authored ? [['clip-path', authored.clipPath]] : undefined;
  }

  flush(): void {
    pending.delete(this);
    this.dirty = false;
    for (const el of Array.from(this.entries.keys())) {
      if (!el.isConnected || !this.owner.owns(el)) this.drop(el);
    }
    if (this.entries.size === 0) return;
    for (const [el, entry] of this.entries) {
      if (entry.authored) continue;
      const cs = getComputedStyle(el);
      entry.authored = { position: cs.position, clipPath: cs.clipPath || 'none' };
    }
    const origin = this.owner.contentOrigin();
    const toHost = new DOMMatrix().translate(-origin.x, -origin.y);
    // Ancestors first: descendants compensate for their transforms.
    for (const el of reverseTreeOrder(this.entries.keys()).reverse()) {
      const entry = this.entries.get(el)!;
      const x = this.cssTransform(el, toHost.multiply(entry.transform));
      let css = 'pointer-events:none!important;';
      if (isFiniteMatrix(x)) {
        css =
          `transform:${cssMatrix(x)}!important;transform-origin:0 0!important;` +
          `translate:none!important;rotate:none!important;scale:none!important;` +
          `z-index:${this.stack.indexOf(el) + 1}!important;`;
        // z-index needs a positioned box; relative with no offsets does not move it.
        if (entry.authored!.position === 'static') css += 'position:relative!important;inset:auto!important;';
        if (entry.clip) css += `clip-path:${cssClip(entry.clip)}!important;`;
        entry.applied = x;
      } else {
        entry.applied = null;
      }
      if (css !== entry.css) this.write(el, entry, css);
    }
  }

  destroy(): void {
    pending.delete(this);
    for (const el of Array.from(this.entries.keys())) this.drop(el);
  }

  /**
   * The CSS transform (origin 0 0) that makes the element's border box land on
   * `target`, a map into host coordinates. Transformed ancestors inside the
   * host are compensated for.
   */
  private cssTransform(el: Element, target: DOMMatrix): DOMMatrix {
    const host = this.owner.host;
    const ancestors: Element[] = [];
    for (let n = composedParent(el); n && n !== host; n = composedParent(n)) {
      if (isElement(n)) ancestors.push(n);
    }
    let chain = new DOMMatrix();
    for (const a of ancestors.reverse()) {
      const entry = this.entries.get(a);
      const he = a as HTMLElement;
      const t = entry ? entry.applied : localTransform(getComputedStyle(a), he.offsetWidth ?? 0, he.offsetHeight ?? 0);
      if (!t) continue;
      const p = this.offset(a);
      chain = chain.translate(p.x, p.y).multiply(t).translate(-p.x, -p.y);
    }
    const p = this.offset(el);
    return new DOMMatrix().translate(-p.x, -p.y).multiply(chain.inverse()).multiply(target);
  }

  /** The element's layout position in host coordinates, ignoring transforms. */
  private offset(el: Element): { x: number; y: number } {
    const host = this.owner.host;
    let x = 0;
    let y = 0;
    let n = el as HTMLElement | null;
    if (typeof (el as HTMLElement).offsetLeft === 'number') {
      while (n && n !== host) {
        x += n.offsetLeft;
        y += n.offsetTop;
        const parent = n.offsetParent as HTMLElement | null;
        if (parent && parent !== host) {
          x += parent.clientLeft;
          y += parent.clientTop;
        }
        n = parent;
      }
    }
    if (n === host) {
      for (let a = composedParent(el); a && a !== host; a = composedParent(a)) {
        if (isElement(a)) {
          x -= a.scrollLeft;
          y -= a.scrollTop;
        }
      }
      return { x, y };
    }
    // No offset chain to the host (SVG, fixed positioning): use the rendered box.
    const r = el.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    return { x: r.left - h.left, y: r.top - h.top };
  }

  private write(el: Element, entry: Entry, css: string): void {
    const sheet = this.owner.sheetFor(el.getRootNode());
    if (!sheet) return;
    if (entry.sheet !== sheet) {
      this.deleteRule(entry);
      sheet.insertRule(`[${GEOMETRY_ATTR}="${entry.id}"]{}`, sheet.cssRules.length);
      entry.rule = sheet.cssRules[sheet.cssRules.length - 1] as CSSStyleRule;
      entry.sheet = sheet;
    }
    entry.rule!.style.cssText = css;
    entry.css = css;
  }

  private deleteRule(entry: Entry): void {
    if (entry.sheet && entry.rule) {
      const index = Array.prototype.indexOf.call(entry.sheet.cssRules, entry.rule);
      if (index >= 0) entry.sheet.deleteRule(index);
    }
    entry.sheet = null;
    entry.rule = null;
    entry.css = '';
  }

  private drop(el: Element): void {
    const entry = this.entries.get(el);
    if (!entry) return;
    this.deleteRule(entry);
    this.entries.delete(el);
    this.stack = this.stack.filter((e) => e !== el);
    if (el.getAttribute(GEOMETRY_ATTR) === String(entry.id)) el.removeAttribute(GEOMETRY_ATTR);
  }
}
