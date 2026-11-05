import { expect, test } from '@playwright/test';
import { BASIC, load } from './helpers';

// Element geometry and hit testing. Native Chromium's geometry differs from the
// explainer (see docs/LIMITATIONS.md), so the native project does not run this file.
test.beforeEach(async ({ page }) => {
  await load(page, false);
  await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
  }, BASIC);
});

test('getElementTransform returns identity, then the exact transform set', async ({ page }) => {
  const result = await page.evaluate(() => {
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const before = c.getElementTransform(a);
    const m = new DOMMatrix().translate(10, 20, 3).rotate(10, 20, 30);
    m.m34 = -0.002;
    c.updateElementGeometry(a, { canvasTransform: m });
    const after = c.getElementTransform(a);
    return {
      identity: before.isIdentity,
      exact: Array.from(after.toFloat64Array()).every((v, i) => Math.abs(v - m.toFloat64Array()[i]!) < 1e-9),
      is2D: after.is2D,
      copy: c.getElementTransform(a) !== after,
    };
  });
  expect(result).toEqual({ identity: true, exact: true, is2D: false, copy: true });
});

test('2D draws update geometry unless preserveElementGeometry is set', async ({ page }) => {
  const result = await page.evaluate(() => {
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const ctx = c.getContext('2d')!;
    const t = () => {
      const m = c.getElementTransform(a);
      return [m.a, m.b, m.c, m.d, m.e, m.f].map((v) => Math.round(v * 1000) / 1000);
    };
    const out: Record<string, number[]> = {};
    ctx.drawElementImage(a, 20, 10);
    out.two = t();
    ctx.drawElementImage(a, 0, 0, 200, 80);
    out.four = t();
    ctx.drawElementImage(a, 10, 0, 20, 20, 40, 40);
    out.six = t();
    ctx.drawElementImage(a, 0, 0, 50, 20, 0, 0, 50, 20);
    out.eight = t();
    ctx.translate(100, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawElementImage(a, 0, 0);
    out.rotated = t();
    ctx.resetTransform();
    ctx.drawElementImage(a, 300, 100, { preserveElementGeometry: true });
    out.preserved = t();
    return out;
  });
  expect(result.two).toEqual([1, 0, 0, 1, 10, 5]);
  expect(result.four).toEqual([2, 0, 0, 2, 0, 0]);
  expect(result.six).toEqual([1, 0, 0, 1, 10, 20]);
  expect(result.eight).toEqual([0.5, 0, 0, 0.5, 0, 0]);
  expect(result.rotated).toEqual([0, 1, -1, 0, 50, 0]);
  expect(result.preserved).toEqual(result.rotated);
});

test('hit testing follows transform and clip', async ({ page }) => {
  const result = await page.evaluate(() => {
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const r = c.getBoundingClientRect();
    const hit = (x: number, y: number) => document.elementFromPoint(r.left + x, r.top + y)?.id ?? null;
    const out: Record<string, unknown[] | string | null> = { none: hit(10, 10) };
    c.updateElementGeometry(a, { canvasTransform: new DOMMatrix().translate(50, 25) });
    out.moved = [hit(60, 30), hit(10, 10)];
    const box = a.getBoundingClientRect();
    out.rect = [box.left - r.left, box.top - r.top, box.width, box.height];
    c.updateElementGeometry(a, { canvasTransform: new DOMMatrix().translate(100, 50).rotate(90) });
    out.rotated = [hit(90, 90), hit(120, 55)];
    c.updateElementGeometry(a, { canvasClip: new DOMRect(0, 0, 25, 20) });
    out.clipped = [hit(90, 55), hit(90, 90)];
    c.updateElementGeometry(a, { canvasTransform: new DOMMatrix().translate(180, 0), canvasClip: new DOMRect(0, 0, 50, 20) });
    out.bounded = [hit(190, 10), hit(210, 10)];
    c.clearElementGeometry(a);
    out.cleared = [hit(190, 10), c.getElementTransform(a).isIdentity];
    return out;
  });
  expect(result.none).toBe('c');
  expect(result.moved).toEqual(['a', 'c']);
  expect(result.rect).toEqual([50, 25, 50, 20]);
  expect(result.rotated).toEqual(['a', 'c']);
  expect(result.clipped).toEqual(['a', 'c']);
  // Hits are bounded by the canvas content box.
  const bounded = result.bounded as unknown[];
  expect(bounded[0]).toBe('a');
  expect(bounded[1]).not.toBe('a');
  expect(result.cleared).toEqual(['c', true]);
});

test('later updates are on top unless preserveHitTestOrder is set', async ({ page }) => {
  const result = await page.evaluate(() => {
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const r = c.getBoundingClientRect();
    const hit = () => document.elementFromPoint(r.left + 15, r.top + 5)?.id;
    const at = { canvasTransform: new DOMMatrix() };
    c.updateElementGeometry(a, at);
    c.updateElementGeometry(b, at);
    const first = hit();
    c.updateElementGeometry(a, { ...at, preserveHitTestOrder: true });
    const preserved = hit();
    c.updateElementGeometry(a, at);
    return [first, preserved, hit()];
  });
  expect(result).toEqual(['b', 'b', 'a']);
});

test('nested drawables without geometry are not hit', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `
      <canvas id="c" width="400" height="200" content="drawable">
        <div id="outer" drawable style="width:100px;height:50px;background:yellow">
          <div id="inner" drawable style="width:20px;height:20px;background:red"></div>
          <span id="text">text</span>
        </div>
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const r = c.getBoundingClientRect();
    const hit = (x: number, y: number) => document.elementFromPoint(r.left + x, r.top + y)?.id;
    c.updateElementGeometry(document.getElementById('outer')!, { canvasTransform: new DOMMatrix() });
    const before = [hit(5, 5), hit(5, 30)];
    c.updateElementGeometry(document.getElementById('inner')!, { canvasTransform: new DOMMatrix().translate(50, 0) });
    return { before, after: [hit(5, 5), hit(55, 5)] };
  });
  expect(result.before).toEqual(['outer', 'text']);
  expect(result.after).toEqual(['outer', 'inner']);
});

test('canvas border and padding offset automatic geometry', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    c.style.cssText = 'padding:3px;border:2px solid black;width:200px;height:100px;box-sizing:content-box';
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const a = document.getElementById('a')!;
    c.getContext('2d')!.drawElementImage(a, 0, 0);
    const m = c.getElementTransform(a);
    const r = c.getBoundingClientRect();
    return { offset: [m.e, m.f], hit: document.elementFromPoint(r.left + 6, r.top + 6)?.id };
  }, BASIC);
  expect(result).toEqual({ offset: [5, 5], hit: 'a' });
});

test('drawn inputs receive clicks and typing', async ({ page }) => {
  const point = await page.evaluate(async () => {
    document.body.innerHTML = `
      <canvas id="c" width="400" height="200" content="drawable">
        <input id="i" drawable style="width:80px;height:20px;box-sizing:border-box">
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    c.getContext('2d')!.drawElementImage(document.getElementById('i')!, 200, 100);
    const r = c.getBoundingClientRect();
    return { x: r.left + 140, y: r.top + 60 };
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.type('hello');
  const state = await page.evaluate(() => ({
    focused: document.activeElement?.id,
    value: (document.getElementById('i') as HTMLInputElement).value,
  }));
  expect(state).toEqual({ focused: 'i', value: 'hello' });
});

test('geometry methods validate their arguments', async ({ page }) => {
  const result = await page.evaluate(() => {
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const error = (fn: () => void) => {
      try {
        fn();
        return null;
      } catch (e) {
        return (e as Error).name;
      }
    };
    const other = document.createElement('canvas');
    other.setAttribute('content', 'drawable');
    const plain = document.createElement('div');
    document.querySelector('[data-hic-host]')!.append(plain);
    return {
      notElement: error(() => c.updateElementGeometry({} as Element)),
      wrongCanvas: error(() => other.updateElementGeometry(a)),
      notDrawable: error(() => c.updateElementGeometry(plain)),
      clearWrong: error(() => other.clearElementGeometry(a)),
      image: error(() => c.updateElementGeometry(c.captureElementImage(a), { canvasTransform: { e: 3 } })),
      viaImage: c.getElementTransform(a).e,
      foreign: c.getElementTransform(plain).isIdentity,
      ctor: new ElementGeometryUpdateEvent('elementgeometryupdate', { elements: [a] }).elements[0] === a,
    };
  });
  expect(result).toEqual({
    notElement: 'TypeError',
    wrongCanvas: 'InvalidStateError',
    notDrawable: 'InvalidStateError',
    clearWrong: 'InvalidStateError',
    image: null,
    viaImage: 3,
    foreign: true,
    ctor: true,
  });
});

test('OffscreenCanvas updates are batched and announced', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const offscreen = c.transferControlToOffscreen();
    const events: string[][] = [];
    c.addEventListener('elementgeometryupdate', (e) =>
      events.push((e as ElementGeometryUpdateEvent).elements.map((el) => el.id)),
    );
    offscreen.updateElementGeometry(a, { canvasTransform: new DOMMatrix().translate(10, 0) });
    offscreen.updateElementGeometry(b, { canvasTransform: new DOMMatrix().translate(20, 0) });
    const sync = c.getElementTransform(a).e;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
    const applied = [c.getElementTransform(a).e, c.getElementTransform(b).e];
    offscreen.clearElementGeometry(a);
    await new Promise((r) => setTimeout(r));
    return { sync, applied, cleared: c.getElementTransform(a).isIdentity, events };
  });
  expect(result).toEqual({ sync: 0, applied: [10, 20], cleared: true, events: [['a', 'b'], ['a']] });
});
