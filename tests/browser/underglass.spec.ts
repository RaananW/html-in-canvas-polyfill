import { expect, test } from '@playwright/test';
import { darkShare } from './helpers';

// Smoke test: the Underglass GPU runtime (@underglass/core, Apache-2.0) admits
// and presents Strata controls through the polyfill, as it does natively.

interface UnderglassPage {
  HTMLInCanvasPolyfill?: { polyfilled: boolean };
  underglass: { ready: Promise<void>; state(): { mode: string; reason?: string }; clicks(): number };
}

test('Underglass presents a Strata panel through WebGPU', async ({ page }, info) => {
  const native = info.project.name === 'native';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/examples/underglass/');
  const support = await page.evaluate(async () => ({
    gpu: !!(await navigator.gpu?.requestAdapter()),
    moveBefore: typeof Element.prototype.moveBefore === 'function',
    defaultSize: 'getElementImageDefaultSize' in HTMLCanvasElement.prototype,
  }));
  test.skip(!support.gpu, 'WebGPU is unavailable');
  test.skip(!support.moveBefore, 'Underglass requires state-preserving Element.moveBefore');
  test.skip(native && !support.defaultSize, 'This native build predates getElementImageDefaultSize');

  await page.waitForFunction(() => 'underglass' in window);
  const result = await page.evaluate(async () => {
    const w = window as unknown as UnderglassPage;
    await w.underglass.ready;
    return { polyfilled: w.HTMLInCanvasPolyfill?.polyfilled ?? false, state: w.underglass.state() };
  });
  expect(result.polyfilled).toBe(!native);
  expect(result.state, JSON.stringify(result.state)).toMatchObject({ mode: 'gpu' });

  // The panel is live DOM inside the canvas: clicking it hits the real button.
  await page.locator('#save').click();
  expect(await page.evaluate(() => (window as unknown as UnderglassPage).underglass.clicks())).toBe(1);

  // The canvas shows the panel's surface and controls, not the white page.
  const box = await page.evaluate(() => {
    const r = document.getElementById('panel')!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  const painted = await darkShare(page, await page.screenshot({ clip: box }), 250);
  console.log(`[${info.project.name}] underglass painted ${(painted * 100).toFixed(1)}%`);
  expect(painted).toBeGreaterThan(0.5);
  expect(errors).toEqual([]);
});
