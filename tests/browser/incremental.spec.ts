import { expect, type Page, test } from '@playwright/test';

// Incremental snapshots (docs/INCREMENTAL.md) reuse styles of elements that
// can't have changed. Each test makes one kind of change and checks that the
// next snapshot draws it, with reuse on and off; both must draw the same.
// Polyfill only: natively there's nothing to reuse.

const BLUE = [0, 0, 255, 255];
const RED = [255, 0, 0, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

interface Scenario {
  /** Markup inside the canvas, plus anything around it. */
  html: string;
  /** Changes the page; runs in the page. */
  change: () => void | Promise<void>;
  /** CSS-pixel points of the drawn layer to sample after the change. */
  points: Array<[number, number]>;
  expected: number[][];
  /** Pixels at the same points before the change, as a check that it changed something. */
  before: number[][];
}

/** Loads the fixture with incremental snapshots on or off. */
async function open(page: Page, incremental: boolean): Promise<void> {
  await page.goto(`/tests/browser/fixtures/index.html?force${incremental ? '' : '&full'}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready);
}

/** Draws #layer, makes the change, and samples the first paint that draws it differently (or the last one). */
async function run(page: Page, s: Scenario) {
  return page.evaluate(
    async ({ html, change, points }) => {
      document.body.innerHTML = html;
      const c = document.getElementById('c') as HTMLCanvasElement;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      const layer = document.getElementById('layer')!;
      const paint = (ms: number) =>
        new Promise((r) => {
          c.addEventListener('paint', r, { once: true });
          setTimeout(r, ms);
        });
      const sample = () => {
        ctx.reset();
        ctx.drawElementImage(layer, 0, 0);
        return points.map(([x, y]) => Array.from(ctx.getImageData(x * 2 + 1, y * 2 + 1, 1, 1).data));
      };
      await new Promise((r) => c.addEventListener('paint', r, { once: true }));
      // Settle: the first snapshot, then one more frame for anything it triggered.
      for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
      const before = sample();
      await new Function(`return (${change})()`)();
      let after = before;
      const until = performance.now() + 2000;
      while (performance.now() < until) {
        await paint(250);
        after = sample();
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          // A transition may still be running; take its end state.
          await new Promise((r) => setTimeout(r, 400));
          for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
          after = sample();
          break;
        }
      }
      return { before, after };
    },
    { html: s.html, change: s.change.toString(), points: s.points },
  );
}

const box = (id: string, style: string) => `<div id="${id}" style="width:20px;height:20px;${style}"></div>`;
const canvas = (layer: string, around = '') =>
  `${around}<canvas id="c" width="400" height="200" content="drawable" style="display:block;width:200px;height:100px">${layer}</canvas>`;

const SCENARIOS: Record<string, Scenario> = {
  'a class change on a descendant': {
    html: canvas(`<div id="layer" drawable style="display:flex"><style>.x.on { background: blue !important }</style>${box('a', 'background:white')}${box('b', 'background:white').replace('<div', '<div class="x"')}</div>`),
    change: () => document.querySelector('.x')!.classList.add('on'),
    points: [[30, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
  'a sibling combinator': {
    html: canvas(`<div id="layer" drawable style="display:flex"><style>.a.on ~ .b { background: blue !important }</style><div class="a" style="width:20px;height:20px;background:white"></div><i style="width:20px;height:20px;background:white"></i><div class="b" style="width:20px;height:20px;background:white"></div></div>`),
    change: () => document.querySelector('.a')!.classList.add('on'),
    points: [[50, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
  'a child list change under :first-child': {
    html: canvas(`<div id="layer" drawable style="display:flex"><style>#layer > div:first-of-type { background: blue !important }</style><div id="one" style="width:20px;height:20px;background:white"></div><div style="width:20px;height:20px;background:white"></div></div>`),
    change: () => {
      const n = document.createElement('div');
      n.style.cssText = 'width:40px;height:20px;background:red';
      document.getElementById('layer')!.prepend(n);
    },
    // The new first child takes the rule; the old one, moved to 40-60 px, loses it.
    points: [[10, 10], [50, 10]],
    before: [BLUE, CLEAR],
    expected: [BLUE, WHITE],
  },
  ':checked, without a DOM change': {
    html: canvas(`<div id="layer" drawable style="display:flex;background:white"><style>#cb:checked + .mark { background: blue !important }</style><input id="cb" type="checkbox" style="margin:0;width:20px;height:20px"><div class="mark" style="width:20px;height:20px;background:white"></div></div>`),
    change: () => (document.getElementById('cb') as HTMLInputElement).click(),
    points: [[30, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
  ':has()': {
    html: canvas(`<div id="layer" drawable style="display:flex;background:white"><style>.card:has(input:checked) { background: blue !important }</style><input id="cb" type="checkbox" style="margin:0;width:20px;height:20px"><div class="card" style="width:40px;height:20px;background:white"><input type="checkbox" id="inner" style="opacity:0;margin:0"></div></div>`),
    change: () => (document.getElementById('inner') as HTMLInputElement).click(),
    points: [[50, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
  ':focus-within': {
    html: canvas(`<div id="layer" drawable style="display:flex;background:white"><style>.form:focus-within .mark { background: blue !important }</style><div class="form" style="display:flex"><input id="in" style="width:20px;height:20px;padding:0;border:0;outline:none;background:white"><div class="mark" style="width:20px;height:20px;background:white"></div></div></div>`),
    change: () => document.getElementById('in')!.focus(),
    points: [[30, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
  'a class on a wrapper outside the canvas': {
    html: `<style>.wrap.dark .x { background: blue !important }</style><div class="wrap">${canvas(`<div id="layer" drawable style="display:flex">${box('a', 'background:white').replace('<div', '<div class="x"')}</div>`)}</div>`,
    change: () => document.querySelector('.wrap')!.classList.add('dark'),
    points: [[10, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
  'an added stylesheet': {
    html: canvas(`<div id="layer" drawable style="display:flex">${box('a', 'background:white').replace('<div', '<div class="x"')}</div>`),
    change: () => {
      const style = document.createElement('style');
      style.textContent = '.x { background: blue !important }';
      document.head.append(style);
    },
    points: [[10, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
  'a custom property on the layer root': {
    html: canvas(`<div id="layer" drawable style="display:flex;--c:white"><style>.x { background: var(--c) }</style>${box('a', '').replace('<div', '<div class="x"')}</div>`),
    change: () => document.getElementById('layer')!.style.setProperty('--c', 'blue'),
    points: [[10, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
  'a container query that flips with a text change': {
    // The container shrinks as the text beside it grows; nothing inside it changes.
    html: canvas(`<div id="layer" drawable style="display:flex;width:180px;background:white"><style>.cq { container-type: inline-size; flex: 1; height: 20px } @container (max-width: 100px) { .mark { background: blue !important } }</style><span id="t" style="font:10px monospace;color:white">a</span><div class="cq"><div class="mark" style="width:20px;height:20px;background:white"></div></div></div>`),
    change: () => {
      (document.getElementById('t')!.firstChild as Text).data = 'aaaaaaaaaaaaaaaaaaaaaa';
    },
    points: [[140, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
  'a transition, drawn at its end': {
    html: canvas(`<div id="layer" drawable style="display:flex"><style>.x { transition: background-color 150ms linear } .x.on { background: blue !important }</style>${box('a', 'background:white').replace('<div', '<div class="x"')}</div>`),
    change: () => document.querySelector('.x')!.classList.add('on'),
    points: [[10, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
  'a text change that moves its neighbour': {
    html: canvas(`<div id="layer" drawable style="display:flex;align-items:flex-start;background:white;width:180px"><span id="t" style="font:10px monospace;color:white">a</span><div style="width:20px;height:20px;background:red"></div></div>`),
    change: () => {
      (document.getElementById('t')!.firstChild as Text).data = 'aaaaaaaaaaaa';
    },
    // The red box moved from just after one character to just after twelve.
    points: [[10, 10], [80, 10]],
    before: [RED, WHITE],
    expected: [WHITE, RED],
  },
  'an inset of a positioned element, after its container grows': {
    // The red box sits at left: 50% of a container that widens with the box
    // beside it; the red box itself doesn't change.
    html: canvas(`<div id="layer" drawable style="background:white;width:180px;height:20px"><div style="position:relative;display:inline-block;height:20px;vertical-align:top"><i id="w" style="display:inline-block;width:20px;height:20px"></i><div style="position:absolute;left:50%;top:0;width:10px;height:20px;background:red"></div></div></div>`),
    change: () => {
      (document.getElementById('w') as HTMLElement).style.width = '100px';
    },
    // 20 px wide: the box is at 10-20 px. 100 px wide: at 50-60 px.
    points: [[15, 10], [55, 10]],
    before: [RED, WHITE],
    expected: [WHITE, RED],
  },
  'a percentage transform, after its box grows': {
    html: canvas(`<div id="layer" drawable style="background:white;width:180px;height:20px"><div id="box" style="display:inline-block;height:20px;transform:translateX(100%);background:red"><span id="t" style="font:10px monospace;color:red">aaaa</span></div></div>`),
    change: () => {
      (document.getElementById('t')!.firstChild as Text).data = 'aaaaaaaa';
    },
    // 4 chars: 24 px, drawn at 24-48. 8 chars: 48 px, drawn at 48-96.
    points: [[30, 10], [80, 10]],
    before: [RED, WHITE],
    expected: [WHITE, RED],
  },
  'logical margins in a right-to-left layout': {
    // The box keeps margin-inline-start (its right margin) as its neighbour's text grows.
    html: canvas(`<div id="layer" drawable dir="rtl" style="display:flex;background:white;width:180px;height:20px"><div style="width:20px;height:20px;margin-inline-start:30px;background:red"></div><span id="t" style="font:10px monospace;color:white">a</span></div>`),
    change: () => {
      (document.getElementById('t')!.firstChild as Text).data = 'aaaaaaaaaa';
    },
    // Right to left: 30 px margin from the right edge (180), so the box is at 130-150.
    points: [[140, 10], [165, 10]],
    before: [RED, WHITE],
    expected: [RED, WHITE],
  },
  'logical sizes in a vertical writing mode': {
    html: canvas(`<div id="layer" drawable style="writing-mode:vertical-lr;background:white;width:60px;height:80px"><div style="inline-size:20px;block-size:10px;margin-block-start:10px;background:red"></div><span id="t" style="font:10px monospace;color:white">a</span></div>`),
    change: () => {
      (document.getElementById('t')!.firstChild as Text).data = 'aaaa';
    },
    // Vertical, left to right: the block axis is horizontal, so the box is 10 px wide at x 10-20, 20 px tall.
    points: [[15, 10], [5, 10], [15, 30]],
    before: [RED, WHITE, WHITE],
    expected: [RED, WHITE, WHITE],
  },
  'a rule edited in place, then another change': {
    // No rule sees an in-place CSSOM edit. The snapshot the second change
    // takes reuses #a's stale style; the idle re-check catches it.
    html: canvas(`<div id="layer" drawable style="display:flex"><style id="s">.x { background: white }</style>${box('a', '').replace('<div', '<div class="x"')}${box('b', 'background:white')}</div>`),
    change: () => {
      const sheet = (document.getElementById('s') as HTMLStyleElement).sheet!;
      (sheet.cssRules[0] as CSSStyleRule).style.background = 'blue';
      document.getElementById('b')!.setAttribute('data-n', '1');
    },
    points: [[10, 10]],
    before: [WHITE],
    expected: [BLUE],
  },
};

for (const incremental of [true, false]) {
  test.describe(incremental ? 'with reuse' : 'without reuse', () => {
    test.beforeEach(async ({ page }, info) => {
      test.skip(info.project.name === 'native' || info.project.name === 'canary', 'polyfill only');
      await open(page, incremental);
    });
    for (const [name, s] of Object.entries(SCENARIOS)) {
      test(name, async ({ page }) => {
        const { before, after } = await run(page, s);
        expect(before, 'before the change').toEqual(s.before);
        expect(after, 'after the change').toEqual(s.expected);
      });
    }
  });
}
