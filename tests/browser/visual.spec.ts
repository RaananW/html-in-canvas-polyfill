/// <reference types="node" />
import { expect, test, type Page } from '@playwright/test';

/** Fraction of pixels whose largest channel difference exceeds `tolerance`. */
async function mismatch(page: Page, a: Buffer, b: Buffer, tolerance = 48): Promise<number> {
  return page.evaluate(
    async ({ a, b, tolerance }) => {
      const decode = async (base64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [x, y] = await Promise.all([decode(a), decode(b)]);
      if (x.width !== y.width || x.height !== y.height) return 1;
      let bad = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        let diff = 0;
        for (let c = 0; c < 4; c++) diff = Math.max(diff, Math.abs(x.data[i + c]! - y.data[i + c]!));
        if (diff > tolerance) bad++;
      }
      return bad / (x.width * x.height);
    },
    { a: a.toString('base64'), b: b.toString('base64'), tolerance },
  );
}

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
  expect(ratio).toBeLessThan(0.01);
});
