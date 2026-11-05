/// <reference types="node" />
import { expect, test } from '@playwright/test';
import { mismatch } from './helpers';

// Upper bounds on the share of mismatched pixels against the live DOM.
const BUDGET: Record<string, number> = { native: 0.01, chromium: 0.03, webkit: 0.08, firefox: 0.08 };

test('Strata components match the live DOM', async ({ page }, info) => {
  const native = info.project.name === 'native';
  await page.goto(native ? '/examples/strata/' : '/examples/strata/?force');
  await page.waitForFunction(() => (window as unknown as { __painted?: number }).__painted);
  await page.evaluate(() => document.fonts.ready);
  const drawn = await page.locator('#canvas').screenshot();
  const live = await page.locator('#reference').screenshot();
  const ratio = await mismatch(page, drawn, live);
  await info.attach('drawn', { body: drawn, contentType: 'image/png' });
  await info.attach('live', { body: live, contentType: 'image/png' });
  console.log(`[${info.project.name}] strata mismatch ${(ratio * 100).toFixed(2)}%`);
  expect(ratio).toBeLessThan(BUDGET[info.project.name] ?? 0.08);
});

test('form state matches the live DOM', async ({ page }, info) => {
  const native = info.project.name === 'native';
  await page.goto(native ? '/tests/browser/fixtures/index.html' : '/tests/browser/fixtures/index.html?force');
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready);
  await page.evaluate(async () => {
    const form = (id: string) => `
      <div id="${id}" style="width:200px;height:60px;background:white;font:14px sans-serif">
        <input class="scrolled" style="width:80px;appearance:none;border:1px solid #888;border-radius:0;padding:2px;margin:0;font:inherit" value="abcdefghijklmnopqrstuvwxyz0123456789">
        <input class="password" type="password" style="width:80px;appearance:none;border:1px solid #888;border-radius:0;padding:2px;margin:0;font:inherit" value="secret">
      </div>`;
    document.body.innerHTML = `
      <style>body { margin: 0 } canvas, #ref { display: block; margin-bottom: 10px }</style>
      <canvas id="c" width="400" height="120" content="drawable" style="width:200px;height:60px">
        ${form('a').replace('<div', '<div drawable')}
      </canvas>
      <div id="ref">${form('r')}</div>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    // The polyfill moves canvas children, which resets their scroll offsets.
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('.scrolled'))) el.scrollLeft = 1000;
    // Wait for a paint after the scroll has been seen.
    await new Promise((r) => setTimeout(r, 100));
    await new Promise<void>((r) => {
      c.onpaint = () => {
        ctx.reset();
        ctx.drawElementImage(document.getElementById('a')!, 0, 0);
        r();
      };
      c.requestPaint();
    });
  });
  const drawn = await page.locator('#c').screenshot();
  const live = await page.locator('#r').screenshot();
  const ratio = await mismatch(page, drawn, live);
  await info.attach('drawn', { body: drawn, contentType: 'image/png' });
  await info.attach('live', { body: live, contentType: 'image/png' });
  console.log(`[${info.project.name}] form mismatch ${(ratio * 100).toFixed(2)}%`);
  // Linux glyph rasterisation varies between the two copies (native Chromium
  // also exceeds 1% there), and WebKitGTK resolves generic font families to a
  // wider font inside the snapshot, shifting the scrolled text.
  const linux = info.project.name === 'webkit' ? 0.07 : 0.03;
  expect(ratio).toBeLessThan(process.platform === 'linux' ? linux : 0.01);
});
