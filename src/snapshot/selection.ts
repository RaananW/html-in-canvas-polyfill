// Caret and selection highlights for snapshots. Selected text and the
// contenteditable caret are wrapped in spans inside the clone, so they follow
// its layout. Text controls have no children to wrap: their caret and
// selection are measured in a hidden mirror and drawn as an overlay.
//
// Carets use `var(--hic-caret)`, so one serialized tree renders both blink
// phases by changing the variable on the wrapper.

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** The custom property carets are painted with. */
export const CARET_VAR = '--hic-caret';

export interface SelectionState {
  /** A non-collapsed document selection. */
  range: Range | null;
  /** A collapsed selection inside a focused editing host. */
  caret: { node: Node; offset: number } | null;
  /** The focused text control, when it has a caret or selection to draw. */
  control: HTMLInputElement | HTMLTextAreaElement | null;
  /** The caret color, once a caret has been placed. */
  caretColor: string | null;
}

function deepActiveElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

export function readSelection(): SelectionState {
  const state: SelectionState = { range: null, caret: null, control: null, caretColor: null };
  const focused = document.hasFocus();
  const active = deepActiveElement();
  if (
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    active.selectionStart !== null &&
    (focused || active.selectionStart !== active.selectionEnd)
  ) {
    state.control = active;
  }
  const sel = getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (range && !range.collapsed) state.range = range;
  else if (range && focused && active instanceof HTMLElement && active.isContentEditable && active.contains(range.startContainer)) {
    state.caret = { node: range.startContainer, offset: range.startOffset };
  }
  return state;
}

function caretColor(el: Element): string | null {
  const cs = getComputedStyle(el);
  const color = cs.caretColor === 'auto' ? cs.color : cs.caretColor;
  return /^(transparent|rgba\(.*,\s*0\))$/.test(color) ? null : color;
}

/** A zero-advance inline caret, as tall as the font's content area. */
function caretSpan(parent: Element, state: SelectionState): Node | null {
  const color = caretColor(parent);
  if (!color) return null;
  state.caretColor = color;
  const span = document.createElementNS(XHTML_NS, 'span');
  span.setAttribute('style', `border-left:1px solid var(${CARET_VAR});margin-right:-1px`);
  return span;
}

/** The highlight style for selected text in `parent`: `::selection` colors, or the UA default. */
function selectionStyle(parent: Element): string {
  const sel = getComputedStyle(parent, '::selection');
  const bg = sel.backgroundColor;
  const fg = sel.color !== getComputedStyle(parent).color ? `;color:${sel.color}` : '';
  return `background-color:${bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' ? 'Highlight' : bg}${fg}`;
}

/**
 * Clones a text node, wrapping the selected part in a highlight span or
 * inserting the caret. The pieces share one span, so the text stays a single
 * item in flex and grid containers.
 */
export function cloneText(text: Text, state: SelectionState): Node {
  const { range, caret } = state;
  const len = text.data.length;
  let start = -1;
  let end = -1;
  if (range?.intersectsNode(text)) {
    start = text === range.startContainer ? range.startOffset : 0;
    end = text === range.endContainer ? range.endOffset : len;
  }
  const at = caret?.node === text ? caret.offset : -1;
  const parent = text.parentElement;
  if (!parent || (start >= end && at < 0)) return text.cloneNode(false);

  const wrap = document.createElementNS(XHTML_NS, 'span');
  const add = (from: number, to: number) => {
    if (to > from) wrap.appendChild(document.createTextNode(text.data.slice(from, to)));
  };
  if (at >= 0) {
    add(0, at);
    const span = caretSpan(parent, state);
    if (span) wrap.appendChild(span);
    add(at, len);
  } else {
    add(0, start);
    const hl = document.createElementNS(XHTML_NS, 'span');
    hl.setAttribute('style', selectionStyle(parent));
    hl.textContent = text.data.slice(start, end);
    wrap.appendChild(hl);
    add(end, len);
  }
  return wrap;
}

/** The caret span for a caret between `el`'s children, before child `index`. */
export function caretBefore(el: Element, index: number, state: SelectionState): Node | null {
  return state.caret?.node === el && state.caret.offset === index ? caretSpan(el, state) : null;
}

// Text layout properties a mirror needs to place characters like the control.
const MIRROR_PROPS = [
  'direction', 'font-family', 'font-feature-settings', 'font-kerning', 'font-size', 'font-stretch', 'font-style',
  'font-variant', 'font-variation-settings', 'font-weight', 'letter-spacing', 'line-height', 'overflow-wrap',
  'tab-size', 'text-align', 'text-indent', 'text-rendering', 'text-transform', 'white-space', 'word-break',
  'word-spacing',
];

let mirrorRoot: ShadowRoot | null = null;

/** A detached-from-observers place to measure text with the document's fonts. */
function mirrorHost(): ShadowRoot {
  if (!mirrorRoot?.host.isConnected) {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;visibility:hidden;pointer-events:none';
    document.documentElement.appendChild(host);
    mirrorRoot = host.attachShadow({ mode: 'closed' });
  }
  return mirrorRoot;
}

export function resetSelectionCaches(): void {
  mirrorRoot?.host.remove();
  mirrorRoot = null;
}

/** Layout offset of `el`'s border box from `root`'s, ignoring transforms, after scrolling. */
function offsetIn(el: HTMLElement, root: Element): { x: number; y: number } {
  const page = (n: HTMLElement | null) => {
    let x = 0;
    let y = 0;
    for (; n; n = n.offsetParent as HTMLElement | null) {
      x += n.offsetLeft;
      y += n.offsetTop;
      const p = n.offsetParent;
      if (p) {
        x += p.clientLeft;
        y += p.clientTop;
      }
    }
    return { x, y };
  };
  const a = page(el);
  const b = page(root as HTMLElement);
  let x = a.x - b.x;
  let y = a.y - b.y;
  for (let n = el.parentElement; n; n = n.parentElement) {
    x -= n.scrollLeft;
    y -= n.scrollTop;
    if (n === root) break;
  }
  return { x, y };
}

/**
 * Markup for the focused text control's caret or selection, positioned in
 * `root`'s border-box coordinates and clipped to the control's padding box.
 */
export function controlOverlay(el: HTMLInputElement | HTMLTextAreaElement, root: Element, state: SelectionState): string {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  const cs = getComputedStyle(el);
  const color = start === end ? caretColor(el) : null;
  if (start === end && (!color || !document.hasFocus())) return '';
  const px = (name: string) => parseFloat(cs.getPropertyValue(name)) || 0;
  const padL = px('padding-left');
  const padT = px('padding-top');
  const contentHeight = el.clientHeight - padT - px('padding-bottom');
  const textarea = el instanceof HTMLTextAreaElement;

  const mirror = document.createElement('div');
  for (const name of MIRROR_PROPS) mirror.style.setProperty(name, cs.getPropertyValue(name));
  mirror.style.cssText +=
    `;position:absolute;left:0;top:0;margin:0;padding:0;border:0;box-sizing:content-box;` +
    `width:${el.clientWidth - padL - px('padding-right')}px${textarea ? '' : ';white-space:pre'}`;
  // Passwords are masked one bullet per code point; offsets are UTF-16.
  const password = el instanceof HTMLInputElement && el.type === 'password';
  const value = password ? '\u2022'.repeat([...el.value].length) : el.value;
  const index = (i: number) => (password ? [...el.value.slice(0, i)].length : i);
  // A trailing character gives the end position (and a final empty line) a box.
  const text = document.createTextNode(`${value}\u200b`);
  mirror.appendChild(text);
  const host = mirrorHost();
  host.appendChild(mirror);
  const origin = mirror.getBoundingClientRect();
  const range = document.createRange();
  const rects = (from: number, to: number) => {
    range.setStart(text, index(from));
    range.setEnd(text, index(to));
    return Array.from(range.getClientRects()).filter((r) => r.height > 0);
  };
  // Single-line controls center their line vertically and scroll horizontally;
  // textareas are drawn unscrolled.
  const o = offsetIn(el, root);
  const left = o.x + el.clientLeft;
  const top = o.y + el.clientTop;
  // Boxes are direct children of the snapshot wrapper, above the root (which
  // may be positioned with a z-index), clipped to the control's padding box.
  // They can't share a container: a stacking context would isolate the blend.
  const box = (r: DOMRect, width: number, style: string) => {
    const x = padL + r.left - origin.left - (textarea ? 0 : el.scrollLeft);
    const y = padT + (textarea ? r.top - origin.top : (contentHeight - r.height) / 2);
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const w = Math.min(el.clientWidth, x + width) - x0;
    const h = Math.min(el.clientHeight, y + r.height) - y0;
    if (w <= 0 || h <= 0) return '';
    return `<div style="position:absolute;z-index:2147483647;left:${left + x0}px;top:${top + y0}px;width:${w}px;height:${h}px;${style}"></div>`;
  };
  let out = '';
  if (color) {
    const r = rects(start, start + 1)[0] ?? rects(start, start)[0];
    if (r) {
      state.caretColor = color;
      out = box(r, 1, `background:var(${CARET_VAR})`);
    }
  } else {
    const sel = getComputedStyle(el, '::selection').backgroundColor;
    const bg = sel === 'rgba(0, 0, 0, 0)' || sel === 'transparent' ? 'Highlight' : sel;
    // Multiply keeps dark text dark, like a highlight painted behind it.
    for (const r of rects(start, end)) out += box(r, r.width, `background:${bg};mix-blend-mode:multiply`);
  }
  mirror.remove();
  return out;
}
