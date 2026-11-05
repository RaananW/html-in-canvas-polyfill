import { expect, test } from '@playwright/test';

// Loose performance budgets (median milliseconds) for a Strata-sized panel:
// about 40 elements with form controls, gradients and web fonts. They catch
// regressions such as a snapshot per frame, not small slowdowns.
const BUDGET: Record<string, { first: number; update: number; draw: number }> = {
  native: { first: 100, update: 50, draw: 1 },
  chromium: { first: 300, update: 200, draw: 1 },
  webkit: { first: 300, update: 200, draw: 1 },
  firefox: { first: 500, update: 300, draw: 1 },
};

test('Strata panel paint latency stays within budget', async ({ page }, info) => {
  const native = info.project.name === 'native';
  await page.goto(native ? '/examples/strata/' : '/examples/strata/?force');
  await page.waitForFunction(() => (window as unknown as { __painted?: number }).__painted);
  await page.evaluate(() => document.fonts.ready);

  const result = await page.evaluate(async () => {
    const source = document.getElementById('panel')!;
    const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1] ?? NaN;
    const nextPaint = (canvas: HTMLCanvasElement) =>
      new Promise<CanvasPaintEvent>((r) => canvas.addEventListener('paint', r as EventListener, { once: true }));

    // First paint: insert a canvas holding a fresh copy of the panel.
    const first: number[] = [];
    for (let i = 0; i < 5; i++) {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('content', 'drawable');
      canvas.width = 640;
      canvas.height = 480;
      const panel = source.cloneNode(true) as HTMLElement;
      panel.removeAttribute('id');
      panel.querySelectorAll('input[name="view"]').forEach((input) => ((input as HTMLInputElement).name = `perf-${i}`));
      canvas.append(panel);
      const start = performance.now();
      const painted = nextPaint(canvas);
      document.body.append(canvas);
      await painted;
      first.push(performance.now() - start);
      canvas.remove();
    }

    // Update: a style change inside the panel until the paint that reports it.
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    const label = source.querySelector('.ug-button__label') as HTMLElement;
    const update: number[] = [];
    for (let i = 0; i < 10; i++) {
      await new Promise(requestAnimationFrame);
      const start = performance.now();
      label.textContent = `Save ${i}`;
      for (;;) {
        const event = await nextPaint(canvas);
        if (event.changedElements.includes(source)) break;
      }
      update.push(performance.now() - start);
    }

    // Drawing a cached snapshot, averaged over a batch: timers are coarse.
    const ctx = canvas.getContext('2d')!;
    const start = performance.now();
    for (let i = 0; i < 100; i++) ctx.drawElementImage(source, 0, 0);
    const draw = (performance.now() - start) / 100;
    return { first: median(first), update: median(update), draw };
  });

  const budget = BUDGET[info.project.name] ?? BUDGET.firefox!;
  const fmt = (v: number) => v.toFixed(1);
  console.log(
    `[${info.project.name}] first paint ${fmt(result.first)} ms, update ${fmt(result.update)} ms, draw ${result.draw.toFixed(3)} ms`,
  );
  expect(result.first).toBeLessThan(budget.first);
  expect(result.update).toBeLessThan(budget.update);
  expect(result.draw).toBeLessThan(budget.draw);
});
