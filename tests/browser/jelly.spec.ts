import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mismatch } from './helpers';

// The WICG WebGPU jelly-slider demo (TypeGPU, MIT, Software Mansion): a
// drawable range input and value label rendered into a WebGPU scene through
// GPUQueue.drawElementImageToTexture. The `native` and `canary` projects run
// it on the native implementation.

const NATIVE = new Set(['native', 'canary']);
const URL = '/examples/wicg/webgpu-jelly-slider/';

async function open(page: Page, path: string, errors: string[]) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await page.goto(path);
  return page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    const info = adapter?.info as (GPUAdapterInfo & { isFallbackAdapter?: boolean }) | undefined;
    const name = [info?.vendor, info?.architecture, info?.device, info?.description].join(' ');
    return {
      gpu: !!adapter,
      software: !!info?.isFallbackAdapter || /swiftshader|llvmpipe|lavapipe|software/i.test(name),
      adapter: name.trim(),
      polyfilled: (window as { HTMLInCanvasPolyfill?: { polyfilled: boolean } }).HTMLInCanvasPolyfill?.polyfilled ?? false,
    };
  });
}

async function settle(page: Page) {
  await page.waitForFunction(() => document.getElementById('value')?.textContent !== '');
  // The jelly springs into place and TAA converges over a few dozen frames.
  await page.waitForTimeout(1500);
}

function canvasBox(page: Page) {
  return page.evaluate(() => {
    const r = document.querySelector('canvas')!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

/** Share of pixels where `channel` clearly dominates the other two. */
function tint(page: Page, png: Buffer, channel: 0 | 2) {
  return page.evaluate(
    async ({ data, channel }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let hits = 0;
      for (let i = 0; i < px.length; i += 4) {
        const c = px[i + channel]!;
        if (c - px[i + (2 - channel)]! > 80 && c - px[i + 1]! > 20) hits++;
      }
      return hits / (px.length / 4);
    },
    { data: png.toString('base64'), channel },
  );
}

test('the WebGPU jelly slider renders and responds to input', async ({ page }, info) => {
  const errors: string[] = [];
  const support = await open(page, URL, errors);
  test.skip(!support.gpu, 'WebGPU is unavailable');
  // GPU-less CI runners only offer a software adapter (SwiftShader), on which
  // the demo's ray-marched scene does not draw, natively or polyfilled.
  test.skip(support.software, `WebGPU only has a software adapter (${support.adapter})`);
  // WebKit's WGSL-to-Metal compiler rejects one of TypeGPU's shaders ("no
  // matching function for call to '__unpack'" on a uniform vec3), so the
  // scene never draws there, polyfill or not.
  test.skip(info.project.name === 'webkit', "WebKit can't compile the demo's shaders");
  expect(support.polyfilled).toBe(!NATIVE.has(info.project.name));
  await settle(page);

  const box = await canvasBox(page);
  const before = await page.screenshot({ clip: box });
  // An orange jelly fills the track at the initial value of 100.
  expect(await tint(page, before, 0)).toBeGreaterThan(0.01);
  expect(await page.textContent('#value')).toBe('One-hundred %');

  // The input lives inside the canvas: clicking its drawn track focuses it and
  // moves the thumb, and the focused jelly turns blue.
  const track = await page.evaluate(() => {
    const r = document.getElementById('slider')!.getBoundingClientRect();
    return { x: r.left + r.width * 0.3, y: r.top + r.height / 2 };
  });
  await page.mouse.click(track.x, track.y);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('slider');
  const value = Number(await page.inputValue('#slider'));
  expect(value).toBeGreaterThan(15);
  expect(value).toBeLessThan(45);

  await page.keyboard.press('Home');
  await expect.poll(() => page.textContent('#value')).toBe('Zero %');
  await page.keyboard.press('End');
  await expect.poll(() => page.textContent('#value')).toBe('One-hundred %');
  await settle(page);
  const after = await page.screenshot({ clip: box });
  expect(await tint(page, after, 2)).toBeGreaterThan(0.01);
  expect(errors).toEqual([]);
});

test('the jelly slider draws the same scene natively and through the polyfill', async ({ page }, info) => {
  test.skip(info.project.name !== 'canary', 'Needs Chrome Canary with the full native API');
  const shot = async (path: string) => {
    const errors: string[] = [];
    await open(page, path, errors);
    await settle(page);
    const png = await page.screenshot({ clip: await canvasBox(page) });
    expect(errors).toEqual([]);
    return png;
  };
  const native = await shot(URL);
  const polyfilled = await shot(`${URL}?force`);
  const ratio = await mismatch(page, native, polyfilled);
  await info.attach('native', { body: native, contentType: 'image/png' });
  await info.attach('polyfilled', { body: polyfilled, contentType: 'image/png' });
  console.log(`[${info.project.name}] jelly mismatch ${(ratio * 100).toFixed(2)}%`);
  expect(ratio).toBeLessThan(0.02);
});
