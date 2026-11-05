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
