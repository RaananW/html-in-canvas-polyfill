import { afterEach, describe, expect, it } from 'vitest';
import { changedMatches, pageRules, sameSignature } from '../../src/snapshot/selectors';

function css(text: string): void {
  const style = document.createElement('style');
  style.textContent = text;
  document.head.append(style);
}

afterEach(() => {
  document.head.innerHTML = '';
});

describe('pageRules', () => {
  it('collects state and :has() selectors, inside groups too, without pseudo-elements', () => {
    css(`
      .a:hover { color: red }
      .b { color: blue }
      .c:hover::after { content: 'x' }
      .d:hover-ish { color: red }
      @media (min-width: 1px) { .e:focus-within .f { color: red } }
      .g:checked, .h { color: red }
      .i:has(> .j) { color: red }
    `);
    expect(pageRules(document)?.selectors.sort()).toEqual(['.a:hover', '.c:hover', '.e:focus-within .f', '.g:checked, .h', '.i:has(> .j)']);
  });

  it('notes sibling combinators outside parentheses and attribute values', () => {
    css('.a:nth-child(2n+1) { color: red } [title~="x"] { color: red }');
    expect(pageRules(document)?.siblings).toBe(false);
    css('.a ~ .b { color: red }');
    expect(pageRules(document)?.siblings).toBe(true);
  });

  it('changes its key when a rule is added', () => {
    css('.a { color: red }');
    const before = pageRules(document)!.key;
    (document.styleSheets[0] as CSSStyleSheet).insertRule('.b { color: blue }');
    expect(pageRules(document)!.key).not.toBe(before);
  });

  it("gives up on selectors querySelectorAll can't evaluate", () => {
    css(':host(:hover) { color: red }');
    expect(pageRules(document)).toBeNull();
  });
});

describe('signatures', () => {
  const [a, b, c] = [document.createElement('i'), document.createElement('i'), document.createElement('i')];

  it('compare matched elements per selector, by identity', () => {
    expect(sameSignature([[a], []], [[a], []])).toBe(true);
    expect(sameSignature([[a], []], [[b], []])).toBe(false);
    expect(sameSignature([[a], []], [[], [a]])).toBe(false);
    expect(sameSignature([[a]], [[a], []])).toBe(false);
    expect(sameSignature(null, null)).toBe(false);
  });

  it('report the elements whose matches changed', () => {
    expect(changedMatches([[a, b], [c]], [[a, b], [c]])).toEqual(new Set());
    expect(changedMatches([[a, b], [c]], [[b], [c, a]])).toEqual(new Set([a]));
    expect(changedMatches([[a]], [[b]])).toEqual(new Set([a, b]));
    expect(changedMatches(null, [[a]])).toBeNull();
    expect(changedMatches([[a]], [[a], []])).toBeNull();
  });
});
