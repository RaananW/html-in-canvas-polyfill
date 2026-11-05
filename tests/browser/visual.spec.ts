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
