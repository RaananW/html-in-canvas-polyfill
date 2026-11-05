import { chromium, devices, expect, test, type Browser, type Page } from '@playwright/test';
import { mismatch } from './helpers';

// The WICG demos in examples/wicg, served unmodified with the polyfill
// injected. Polyfilled renders are compared against native Chromium.
const DEMOS = [
  { file: 'complex-text.html', canvas: '#canvas' },
  // Draws 15 random sparkle dots per frame, a negligible share of pixels.
  { file: 'nested-sparkles.html', canvas: '#canvas' },
  { file: 'pie-chart.html', canvas: 'canvas' },
  { file: 'webGL.html', canvas: '#gl-canvas' },
];
// Font rasterisation differs between engines, as in visual.spec.ts.
const BUDGET: Record<string, number> = { chromium: 0.02, webkit: 0.08, firefox: 0.08 };

/**
 * WebKit lacks `device-pixel-content-box`, which every demo observes to size
 * its canvas grid. Report the content box instead: headless Chromium reports
 * device pixels at the real device scale, which Playwright's emulated scale
 * does not change, so this matches the native reference.
 */
function shimDevicePixelBox() {
  if ('devicePixelContentBoxSize' in ResizeObserverEntry.prototype) return;
  const Native = ResizeObserver;
  window.ResizeObserver = class extends Native {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        const shimmed = entries.map((entry) => {
          const [box] = entry.contentBoxSize;
          const size = { inlineSize: Math.round(box!.inlineSize), blockSize: Math.round(box!.blockSize) };
          return {
            target: entry.target,
            contentRect: entry.contentRect,
            borderBoxSize: entry.borderBoxSize,
            contentBoxSize: entry.contentBoxSize,
            devicePixelContentBoxSize: [size],
          } as unknown as ResizeObserverEntry;
        });
        callback(shimmed, observer);
      });
    }
    // `box` is converted to a string, so pie-chart's one-element array works.
    override observe(target: Element, options?: ResizeObserverOptions) {
      super.observe(target, String(options?.box) === 'device-pixel-content-box' ? { box: 'content-box' } : options);
    }
  };
}

async function open(page: Page, file: string, native: boolean): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(shimDevicePixelBox);
  // Serve webGL.html's gl-matrix from npm; it matches the cdnjs integrity hash.
  await page.route('https://cdnjs.cloudflare.com/**/gl-matrix-min.js', (route) =>
    route.fulfill({
      path: 'node_modules/gl-matrix/dist/gl-matrix-min.js',
      headers: { 'access-control-allow-origin': '*', 'content-type': 'text/javascript' },
    }),
  );
  await page.goto(`/examples/wicg/${file}${native ? '' : '?force'}`);
  const status = await page.evaluate(() => (window as unknown as { HTMLInCanvasPolyfill: { polyfilled: boolean } }).HTMLInCanvasPolyfill);
  expect(status.polyfilled).toBe(!native);
  return errors;
}

let reference: Browser | undefined;
test.afterAll(async () => reference?.close());

for (const demo of DEMOS) {
  test(`WICG ${demo.file} renders like native`, async ({ page, baseURL }, info) => {
    const native = info.project.name === 'native';
    const errors = await open(page, demo.file, native);
    const canvas = page.locator(demo.canvas);
    if (native) {
      await page.waitForTimeout(500);
      await info.attach('native', { body: await canvas.screenshot(), contentType: 'image/png' });
      expect(errors).toEqual([]);
      return;
    }

    reference ??= await chromium.launch({ channel: 'chromium', args: ['--enable-blink-features=CanvasDrawElement'] });
    const context = await reference.newContext({
      ...devices['Desktop Chrome'],
      baseURL,
      viewport: page.viewportSize(),
      deviceScaleFactor: info.project.use.deviceScaleFactor ?? 1,
    });
    const nativePage = await context.newPage();
    await open(nativePage, demo.file, true);
    await nativePage.waitForTimeout(500);
    const expected = await nativePage.locator(demo.canvas).screenshot();
    await context.close();

    let share = 1;
    await expect
      .poll(async () => (share = await mismatch(page, await canvas.screenshot(), expected)), { timeout: 10_000 })
      .toBeLessThan(BUDGET[info.project.name] ?? 0.08);
    await info.attach('native', { body: expected, contentType: 'image/png' });
    await info.attach('polyfill', { body: await canvas.screenshot(), contentType: 'image/png' });
    console.log(`[${info.project.name}] ${demo.file} mismatch ${(share * 100).toFixed(2)}%`);
    expect(errors).toEqual([]);
  });
}
