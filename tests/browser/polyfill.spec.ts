import { expect, test } from '@playwright/test';
import { BASIC, load } from './helpers';

// Polyfill-specific behavior (the native project does not run this file).
test.beforeEach(async ({ page }) => {
  await load(page, false);
});

test('lays the host over the canvas content box', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML = `<div style="padding:13px 7px">${html}</div>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    c.style.cssText = 'padding:3px;border:2px solid black;width:200px;height:100px;box-sizing:content-box';
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const host = document.querySelector('[data-hic-host]') as HTMLElement;
    const a = document.getElementById('a')!;
    const cr = c.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    return {
      host: [hr.left - cr.left, hr.top - cr.top, hr.width, hr.height],
      child: [ar.left - cr.left, ar.top - cr.top],
      opacity: getComputedStyle(host).opacity,
      parent: a.parentElement === host,
      hit: document.elementFromPoint(cr.left + 10, cr.top + 10) === c,
    };
  }, BASIC);
  expect(result.host).toEqual([5, 5, 200, 100]);
  expect(result.child).toEqual([5, 5]);
  expect(result.opacity).toBe('0');
  expect(result.parent).toBe(true);
  expect(result.hit).toBe(true);
});

test('uninstall restores canvas children and prototypes', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const w = window as unknown as { __polyfill: { uninstall(): void } };
    w.__polyfill.uninstall();
    return {
      children: Array.from(c.children).map((e) => e.id),
      hosts: document.querySelectorAll('[data-hic-host]').length,
      patched: 'drawElementImage' in CanvasRenderingContext2D.prototype,
    };
  }, BASIC);
  expect(result.children).toEqual(['a', 'b']);
  expect(result.hosts).toBe(0);
  expect(result.patched).toBe(false);
});

test('snapshots text, borders and nested drawables', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `
      <canvas id="c" width="400" height="200" content="drawable">
        <div id="outer" drawable style="width:100px;height:50px;background:rgb(255,255,0);border:5px solid rgb(0,128,0);box-sizing:border-box">
          <div id="inner" drawable style="width:20px;height:20px;background:rgb(255,0,255)"></div>
        </div>
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawElementImage(document.getElementById('outer')!, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return { border: px(4, 50), fill: px(150, 50), hole: px(20, 20) };
  });
  expect(result.border).toEqual([0, 128, 0, 255]);
  expect(result.fill).toEqual([255, 255, 0, 255]);
  // Nested drawables are excluded from the parent's snapshot.
  expect(result.hole).toEqual([255, 255, 0, 255]);
});
