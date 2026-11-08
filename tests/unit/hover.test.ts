import { afterEach, describe, expect, it } from 'vitest';
import { hoverSelectors, sameSignature } from '../../src/snapshot/hover';

function css(text: string): void {
  const style = document.createElement('style');
  style.textContent = text;
  document.head.append(style);
}

afterEach(() => {
  document.head.innerHTML = '';
});

describe('hoverSelectors', () => {
  it('collects :hover selectors, inside groups too, without pseudo-elements', () => {
    css(`
      .a:hover { color: red }
      .b { color: blue }
      .c:hover::after { content: 'x' }
      .d:hover-ish { color: red }
      @media (min-width: 1px) { .e:hover .f { color: red } }
      .g:hover, .h { color: red }
    `);
    expect(hoverSelectors(document)?.sort()).toEqual(['.a:hover', '.c:hover', '.e:hover .f', '.g:hover, .h']);
  });

  it("gives up on selectors querySelectorAll can't evaluate", () => {
    css(':host(:hover) { color: red }');
    expect(hoverSelectors(document)).toBeNull();
  });

  it('is empty without :hover rules', () => {
    css('.a { color: red }');
    expect(hoverSelectors(document)).toEqual([]);
  });
});

describe('sameSignature', () => {
  it('compares matched elements per selector, by identity', () => {
    const [a, b] = [document.createElement('i'), document.createElement('i')];
    expect(sameSignature([[a], []], [[a], []])).toBe(true);
    expect(sameSignature([[a], []], [[b], []])).toBe(false);
    expect(sameSignature([[a], []], [[], [a]])).toBe(false);
    expect(sameSignature([[a]], [[a], []])).toBe(false);
    expect(sameSignature(null, null)).toBe(false);
  });
});
