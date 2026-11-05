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
      patched:
        'drawElementImage' in CanvasRenderingContext2D.prototype ||
        'texElementSubImage2D' in WebGL2RenderingContext.prototype ||
        (typeof GPUQueue !== 'undefined' && 'drawElementImageToTexture' in GPUQueue.prototype),
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

test('authoring mode lays out an existing host without moving children', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `
      <canvas id="c" width="400" height="200" content="drawable"></canvas>
      <div data-hic-host="c"><div id="a" drawable style="width:50px;height:20px;background:rgb(255,0,0)"></div></div>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const host = c.nextElementSibling as HTMLElement;
    const event = await new Promise<CanvasPaintEvent>((r) => c.addEventListener('paint', r as EventListener, { once: true }));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const a = document.getElementById('a')!;
    ctx.drawElementImage(a, 0, 0);
    const cr = c.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    return {
      changed: event.changedElements.map((e) => e.id),
      parent: a.parentElement === host,
      generated: document.querySelectorAll('[data-hic-host]').length,
      offset: [hr.left - cr.left, hr.top - cr.top, hr.width, hr.height],
      pixel: Array.from(ctx.getImageData(10, 10, 1, 1).data),
    };
  });
  expect(result.changed).toEqual(['a']);
  expect(result.parent).toBe(true);
  expect(result.generated).toBe(1);
  expect(result.offset).toEqual([0, 0, 200, 100]);
  expect(result.pixel).toEqual([255, 0, 0, 255]);
});

test('getElementImageDefaultSize returns grid pixels', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const a = document.getElementById('a')!;
    const image = c.captureElementImage(a);
    return [c.getElementImageDefaultSize(a), c.getElementImageDefaultSize(image)];
  }, BASIC);
  expect(result).toEqual([
    { width: 100, height: 40 },
    { width: 100, height: 40 },
  ]);
});

test('the script build installs and reports status', async ({ page }) => {
  await page.goto('/tests/browser/fixtures/iife.html');
  const status = await page.evaluate(() => {
    const s = (window as unknown as { HTMLInCanvasPolyfill: { polyfilled: boolean; limitations: string[] } })
      .HTMLInCanvasPolyfill;
    return { polyfilled: s.polyfilled, limitations: s.limitations.length > 0, api: typeof CanvasRenderingContext2D.prototype.drawElementImage };
  });
  expect(status).toEqual({ polyfilled: true, limitations: true, api: 'function' });
});
