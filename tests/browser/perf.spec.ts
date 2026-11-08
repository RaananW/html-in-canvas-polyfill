import { expect, test } from '@playwright/test';
import { load } from './helpers';

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

// A small endless animation (a spinner) inside a large drawable. Natively it
// redraws every frame; re-serializing the whole drawable that often took a
// Strata gallery to 4 frames a second. Captures that only follow the animation
// are paced by their cost, while a real change is still captured at once.
test('an endless animation in a large drawable keeps the page responsive', async ({ page }, info) => {
  test.skip(info.project.name === 'native' || info.project.name === 'canary', 'polyfill pacing');
  await load(page, false);
  const result = await page.evaluate(async () => {
    const cells = Array.from(
      { length: 500 },
      (_, i) => `<button style="margin:1px;padding:2px 4px;border:1px solid #888;border-radius:3px;font:11px sans-serif">${i}</button>`,
    ).join('');
    document.body.innerHTML = `
      <style>@keyframes turn { to { rotate: 1turn } }</style>
      <canvas id="c" width="800" height="600" content="drawable">
        <div id="panel" drawable style="width:800px;height:600px;overflow:hidden;background:white">
          <div style="width:16px;height:16px;border:3px solid;border-top-color:transparent;border-radius:50%;animation:turn 0.8s linear infinite"></div>
          <input id="field" value="before">
          ${cells}
        </div>
      </canvas>`;
    const canvas = document.getElementById('c') as HTMLCanvasElement;
    const panel = document.getElementById('panel')!;
    const paints: number[] = [];
    canvas.addEventListener('paint', (e) => {
      if ((e as CanvasPaintEvent).changedElements.includes(panel)) paints.push(performance.now());
    });
    while (paints.length < 2) await new Promise(requestAnimationFrame);
    const frames = async (ms: number) => {
      let count = 0;
      const start = performance.now();
      while (performance.now() - start < ms) {
        await new Promise(requestAnimationFrame);
        count++;
      }
      return (count * 1000) / (performance.now() - start);
    };
    const from = paints.length;
    const fps = await frames(3000);
    const animationPaints = paints.slice(from);
    const intervals = animationPaints.slice(1).map((t, i) => t - animationPaints[i]!);
    // A real change: drawn in the next capture, not after the animation's spacing.
    await new Promise((r) => setTimeout(r, 50));
    const field = document.getElementById('field') as HTMLInputElement;
    const changed = performance.now();
    field.value = 'after';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const before = paints.length;
    while (paints.length === before) await new Promise(requestAnimationFrame);
    canvas.remove();
    const longest = Math.max(...intervals);
    return { fps, animationPaints: animationPaints.length, longest, input: paints[before]! - changed };
  });
  console.log(
    `[${info.project.name}] ${result.fps.toFixed(1)} fps, ${result.animationPaints} animation paints in 3 s, ` +
      `longest gap ${result.longest.toFixed(0)} ms, input drawn after ${result.input.toFixed(0)} ms`,
  );
  // The animation is still drawn.
  expect(result.animationPaints).toBeGreaterThanOrEqual(2);
  // Captures leave most frames to the page.
  expect(result.fps).toBeGreaterThan(20);
  // A real change doesn't wait for the animation's spacing.
  expect(result.input).toBeLessThan(Math.max(result.longest, 200));
});
