/// <reference types="node" />
import { expect, type Page } from '@playwright/test';

/** Loads the fixture, forcing the polyfill unless running against native Chromium. */
export async function load(page: Page, native: boolean): Promise<void> {
  await page.goto(native ? '/tests/browser/fixtures/index.html' : '/tests/browser/fixtures/index.html?force');
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready);
  const status = await page.evaluate(() => (window as unknown as { __status: { native: boolean; polyfilled: boolean } }).__status);
  expect(status.polyfilled).toBe(!native);
}

/** A 400×200 grid canvas laid out at 200×100 CSS px (grid scale 2). */
export const BASIC = `
  <canvas id="c" width="400" height="200" content="drawable">
    <div id="a" drawable style="width:50px;height:20px;background:rgb(255,0,0)"></div>
    <div id="b" drawable style="width:30px;height:30px;background:rgb(0,0,255)"></div>
  </canvas>`;

/** Fraction of pixels whose largest channel difference exceeds `tolerance`. */
export async function mismatch(page: Page, a: Buffer, b: Buffer, tolerance = 48): Promise<number> {
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

/** Fraction of pixels in a PNG whose channels are all below `limit`, i.e. text-dark. */
export async function darkShare(page: Page, png: Buffer, limit = 96): Promise<number> {
  return page.evaluate(
    async ({ png, limit }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) < limit) dark++;
      return dark / (bitmap.width * bitmap.height);
    },
    { png: png.toString('base64'), limit },
  );
}
