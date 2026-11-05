import { expect, test } from '@playwright/test';
import { BASIC, load } from './helpers';

// Runs against native Chromium (project "native") and the polyfill in every
// other project. Expectations are the native behavior unless noted.
test.beforeEach(async ({ page }, info) => {
  await load(page, info.project.name === 'native');
});

test('reflects the content attribute', async ({ page }) => {
  const result = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const values: string[] = [c.content];
    c.setAttribute('content', 'DRAWABLE');
    values.push(c.content);
    c.setAttribute('content', 'bogus');
    values.push(c.content);
    c.content = 'drawable';
    values.push(c.getAttribute('content')!);
    return values;
  });
  expect(result).toEqual(['fallback', 'drawable', 'fallback', 'drawable']);
});

test('fires paint and draws grid-sized snapshots', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const event = await new Promise<CanvasPaintEvent>((r) => c.addEventListener('paint', r as EventListener, { once: true }));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawElementImage(a, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return {
      type: event.constructor.name,
      bubbles: event.bubbles,
      changed: event.changedElements.map((e) => e.id).sort(),
      inside: px(98, 38),
      outside: px(102, 42),
      image: (() => {
        const img = c.captureElementImage(a);
        return [img.width, img.height];
      })(),
    };
  }, BASIC);
  expect(result.type).toBe('CanvasPaintEvent');
  expect(result.bubbles).toBe(false);
  expect(result.changed).toEqual(['a', 'b']);
  expect(result.inside).toEqual([255, 0, 0, 255]);
  expect(result.outside).toEqual([0, 0, 0, 0]);
  expect(result.image).toEqual([100, 40]);
});

test('maps source rectangles in CSS pixels', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `
      <canvas id="c" width="400" height="200" content="drawable">
        <div id="a" drawable style="width:40px;height:20px;box-sizing:border-box;border-left:20px solid rgb(255,0,0);background:rgb(0,0,255)"></div>
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    // Right half of the element (CSS px 20..40) drawn at the origin.
    ctx.drawElementImage(a, 20, 0, 20, 20, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return { first: px(2, 2), last: px(38, 38), beyond: px(42, 2) };
  });
  expect(result.first).toEqual([0, 0, 255, 255]);
  expect(result.last).toEqual([0, 0, 255, 255]);
  expect(result.beyond).toEqual([0, 0, 0, 0]);
});

test('reports changed elements after a style change and requestPaint', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const next = () =>
      new Promise<string[]>((r) =>
        c.addEventListener('paint', (e) => r((e as CanvasPaintEvent).changedElements.map((x) => x.id)), { once: true }),
      );
    await next();
    const style = next();
    document.getElementById('a')!.style.background = 'rgb(0,255,0)';
    const afterStyle = await style;
    const request = next();
    c.requestPaint();
    const afterRequest = await request;
    return { afterStyle, afterRequest };
  }, BASIC);
  expect(result.afterStyle).toEqual(['a']);
  expect(result.afterRequest).toEqual([]);
});

test('throws InvalidStateError for undrawable sources', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML =
      html +
      '<canvas id="plain" width="10" height="10"></canvas>' +
      '<canvas id="other" width="10" height="10" content="drawable"></canvas>';
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const ctx = c.getContext('2d')!;
    const attempt = (fn: () => void) => {
      try {
        fn();
        return 'ok';
      } catch (e) {
        return `${(e as Error).name}: ${(e as Error).message}`;
      }
    };
    const beforePaint = attempt(() => ctx.drawElementImage(a, 0, 0));
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const other = (document.getElementById('other') as HTMLCanvasElement).getContext('2d')!;
    const wrongCanvas = attempt(() => other.drawElementImage(a, 0, 0));
    const plain = (document.getElementById('plain') as HTMLCanvasElement).getContext('2d')!;
    const notDrawable = attempt(() => plain.drawElementImage(a, 0, 0));
    const image = c.captureElementImage(a);
    image.close();
    const closed = attempt(() => ctx.drawElementImage(image, 0, 0));
    return { beforePaint, wrongCanvas, notDrawable, closed };
  }, BASIC);
  // Native prefixes messages with "Failed to execute ...".
  expect(result.beforePaint).toMatch(/^InvalidStateError: .*No cached paint record for element\.$/);
  expect(result.wrongCanvas).toMatch(
    /^InvalidStateError: .*The element can only be drawn into its nearest ancestor <canvas>\.$/,
  );
  expect(result.notDrawable).toMatch(
    /^InvalidStateError: .*DrawElementImage requires the canvas to have the content=drawable attribute\.$/,
  );
  expect(result.closed).toMatch(/^InvalidStateError: .*The ElementImage has been closed\.$/);
});
