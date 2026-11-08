// Selectors whose matches can change without a DOM change: state
// pseudo-classes (:hover, :focus, :checked, …) and :has(). Recording which
// elements each one matches, at each snapshot, tells which elements' styles
// such a change can have touched:
//
// - a pointer move that changes no match needs no new snapshot (it can only
//   change styles through :hover and the like);
// - an incremental snapshot re-reads the elements whose matches changed
//   (docs/INCREMENTAL.md).
//
// Ancestors are recorded too, because a drawable inherits from them.

/** Which elements each selector matched; null when the page can't be analysed. */
export type Signature = Element[][] | null;

/** What the page's stylesheets say about how styles can change. */
export interface PageRules {
  /** Selectors with a state pseudo-class or :has(), pseudo-elements stripped. */
  selectors: string[];
  /** Some selector uses a sibling combinator (+ or ~). */
  siblings: boolean;
  /** Container queries or container units: styles follow container sizes. */
  containers: boolean;
  /** Changes whenever a stylesheet is added or removed, or gains or loses top-level rules. */
  key: string;
}

const STATE =
  /:(?:has|hover|active|focus|focus-visible|focus-within|checked|indeterminate|placeholder-shown|valid|invalid|user-valid|user-invalid|in-range|out-of-range|target|target-within|open|closed|popover-open|modal|autofill|default|fullscreen|picture-in-picture|playing|paused|seeking|buffering|stalled|muted|volume-locked|state)(?![\w-])/;
// Pseudo-elements can't be matched with querySelectorAll; their originating element can.
const PSEUDO_ELEMENT = /::?(?:before|after|first-line|first-letter)\b|::[\w-]+(?:\([^)]*\))?/g;
// Shadow-tree selectors match across boundaries querySelectorAll doesn't see.
const UNSUPPORTED = /::(?:part|slotted)\b|:host\b|&/;
const SIBLING = /[+~]/;
const CONTAINER_UNIT = /\d(?:cq[whib]|cqmin|cqmax)\b/;

interface SheetEntry {
  length: number;
  rules: PageRules | null;
}
const sheets = new WeakMap<CSSStyleSheet, SheetEntry>();

/** Adds what `rules` contribute to `out`; false when one can't be evaluated. */
function collect(rules: CSSRuleList, out: PageRules, seen: Set<string>): boolean {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const nested = (rule as CSSStyleRule & { cssRules?: CSSRuleList }).cssRules;
      if (nested && nested.length > 0 && STATE.test(rule.cssText)) return false;
      const text = rule.selectorText;
      // Parentheses and attribute values hold no combinators of this rule.
      if (SIBLING.test(text.replace(/\([^)]*\)|\[[^\]]*\]/g, ''))) out.siblings = true;
      if (!out.containers && CONTAINER_UNIT.test(rule.cssText)) out.containers = true;
      if (!STATE.test(text)) continue;
      if (UNSUPPORTED.test(text)) return false;
      const selector = text.replace(PSEUDO_ELEMENT, '') || '*';
      if (!seen.has(selector)) {
        seen.add(selector);
        out.selectors.push(selector);
      }
    } else if (typeof CSSImportRule !== 'undefined' && rule instanceof CSSImportRule) {
      const sheet = rule.styleSheet;
      if (sheet && !collectSheet(sheet, out, seen)) return false;
    } else if ('cssRules' in rule) {
      // @media, @supports, @layer: kept whether or not they apply now.
      const name = rule.constructor.name;
      if (name === 'CSSContainerRule') out.containers = true;
      if (name === 'CSSScopeRule' && STATE.test(rule.cssText)) return false;
      if (!collect((rule as CSSGroupingRule).cssRules, out, seen)) return false;
    }
  }
  return true;
}

function collectSheet(sheet: CSSStyleSheet, out: PageRules, seen: Set<string>): boolean {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    // A cross-origin sheet can't be read.
    return false;
  }
  let entry = sheets.get(sheet);
  if (!entry || entry.length !== rules.length) {
    const own: PageRules = { selectors: [], siblings: false, containers: false, key: '' };
    entry = { length: rules.length, rules: collect(rules, own, new Set()) ? own : null };
    sheets.set(sheet, entry);
  }
  if (!entry.rules) return false;
  for (const s of entry.rules.selectors) {
    if (!seen.has(s)) {
      seen.add(s);
      out.selectors.push(s);
    }
  }
  out.siblings ||= entry.rules.siblings;
  out.containers ||= entry.rules.containers;
  out.key += `${rules.length},`;
  return true;
}

/** The document's rules, or null when they can't all be read. */
export function pageRules(doc: Document): PageRules | null {
  const out: PageRules = { selectors: [], siblings: false, containers: false, key: '' };
  const seen = new Set<string>();
  const all = [...Array.from(doc.styleSheets), ...(doc.adoptedStyleSheets ?? [])];
  for (const sheet of all) {
    // The polyfill's own sheet holds element geometry, which changes as
    // elements are drawn; the snapshot reads those properties afresh anyway.
    if ((sheet.ownerNode as Element | null)?.hasAttribute?.('data-hic-style')) continue;
    if (!collectSheet(sheet as CSSStyleSheet, out, seen)) return null;
  }
  return out;
}

/** What each state selector matches in `el`, its subtree and its ancestors. */
export function stateSignature(el: Element, rules = pageRules(el.ownerDocument)): Signature {
  if (!rules) return null;
  const inside = el.querySelectorAll('*');
  if (el.shadowRoot || Array.from(inside).some((e) => e.shadowRoot)) return null;
  const ancestors: Element[] = [];
  for (let n = el.parentElement; n; n = n.parentElement) ancestors.push(n);
  try {
    return rules.selectors.map((s) => {
      const matched = ancestors.filter((a) => a.matches(s));
      if (el.matches(s)) matched.push(el);
      for (const e of Array.from(el.querySelectorAll(s))) matched.push(e);
      return matched;
    });
  } catch {
    return null;
  }
}

export function sameSignature(a: Signature, b: Signature): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((list, i) => {
    const other = b[i]!;
    return list.length === other.length && list.every((e, j) => e === other[j]);
  });
}

/**
 * The elements whose match of some selector differs between two signatures
 * of the same page rules, or null when that can't be told.
 */
export function changedMatches(a: Signature, b: Signature): Set<Element> | null {
  if (!a || !b || a.length !== b.length) return null;
  const changed = new Set<Element>();
  a.forEach((before, i) => {
    const after = b[i]!;
    if (before.length === after.length && before.every((e, j) => e === after[j])) return;
    const was = new Set(before);
    const now = new Set(after);
    for (const e of was) if (!now.has(e)) changed.add(e);
    for (const e of now) if (!was.has(e)) changed.add(e);
  });
  return changed;
}
