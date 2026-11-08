// A pointer moving inside a drawable changes its computed styles only through
// rules whose selectors use :hover. When no such selector changes which
// elements it matches — the drawable, its descendants, or the ancestors it
// inherits from — the last snapshot is still exact and needs no successor.

/** Which elements each :hover selector matched; null when the page can't be analysed. */
export type HoverSignature = Element[][] | null;

const HOVER = /:hover(?![\w-])/;
// Pseudo-elements can't be matched with querySelectorAll; their originating element can.
const PSEUDO_ELEMENT = /::?(?:before|after|first-line|first-letter)\b|::[\w-]+(?:\([^)]*\))?/g;
// Shadow-tree selectors match across boundaries querySelectorAll doesn't see.
const UNSUPPORTED = /::(?:part|slotted)\b|:host\b|&/;

interface SheetEntry {
  length: number;
  selectors: string[] | null;
}
const sheets = new WeakMap<CSSStyleSheet, SheetEntry>();

/** Adds the :hover selectors of `rules`; false when one can't be evaluated. */
function collect(rules: CSSRuleList, out: Set<string>): boolean {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const nested = (rule as CSSStyleRule & { cssRules?: CSSRuleList }).cssRules;
      if (nested && nested.length > 0 && HOVER.test(rule.cssText)) return false;
      if (!HOVER.test(rule.selectorText)) continue;
      if (UNSUPPORTED.test(rule.selectorText)) return false;
      out.add(rule.selectorText.replace(PSEUDO_ELEMENT, '') || '*');
    } else if (typeof CSSImportRule !== 'undefined' && rule instanceof CSSImportRule) {
      const sheet = rule.styleSheet;
      if (sheet && !collectSheet(sheet, out)) return false;
    } else if ('cssRules' in rule) {
      // @media, @supports, @layer, @container: kept whether or not they apply now.
      if (rule.constructor.name === 'CSSScopeRule' && HOVER.test(rule.cssText)) return false;
      if (!collect((rule as CSSGroupingRule).cssRules, out)) return false;
    }
  }
  return true;
}

function collectSheet(sheet: CSSStyleSheet, out: Set<string>): boolean {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    // A cross-origin sheet can't be read.
    return false;
  }
  let entry = sheets.get(sheet);
  if (!entry || entry.length !== rules.length) {
    const own = new Set<string>();
    entry = { length: rules.length, selectors: collect(rules, own) ? [...own] : null };
    sheets.set(sheet, entry);
  }
  if (!entry.selectors) return false;
  for (const s of entry.selectors) out.add(s);
  return true;
}

/** The document's :hover selectors, or null when they can't all be evaluated. */
export function hoverSelectors(doc: Document): string[] | null {
  const out = new Set<string>();
  const all = [...Array.from(doc.styleSheets), ...(doc.adoptedStyleSheets ?? [])];
  for (const sheet of all) if (!collectSheet(sheet as CSSStyleSheet, out)) return null;
  return [...out];
}

export function hoverSignature(el: Element): HoverSignature {
  const selectors = hoverSelectors(el.ownerDocument);
  if (!selectors) return null;
  const inside = el.querySelectorAll('*');
  if (el.shadowRoot || Array.from(inside).some((e) => e.shadowRoot)) return null;
  const ancestors: Element[] = [];
  for (let n = el.parentElement; n; n = n.parentElement) ancestors.push(n);
  try {
    return selectors.map((s) => {
      const matched = ancestors.filter((a) => a.matches(s));
      if (el.matches(s)) matched.push(el);
      for (const e of Array.from(el.querySelectorAll(s))) matched.push(e);
      return matched;
    });
  } catch {
    return null;
  }
}

export function sameSignature(a: HoverSignature, b: HoverSignature): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((list, i) => {
    const other = b[i]!;
    return list.length === other.length && list.every((e, j) => e === other[j]);
  });
}
