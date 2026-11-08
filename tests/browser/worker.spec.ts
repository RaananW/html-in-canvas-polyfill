import { expect, type Page, test } from '@playwright/test';
import { load } from './helpers';

// ElementImage in workers. Runs against native Chromium (project "native",
// and "canary" when it's installed) and the polyfill in every other project.
// Expectations are the native behavior. The native worker imports nothing;
// the polyfilled one imports the polyfill's worker entry, and the page its
// messaging entry.

/** 40×20 CSS px quadrants (red, lime / blue, white) at grid scale 2, in two canvases. */
const QUADS = `<div drawable style="width:40px;height:20px;display:grid;grid-template:1fr 1fr / 1fr 1fr">
    <i style="background:rgb(255,0,0)"></i><i style="background:rgb(0,255,0)"></i>
    <i style="background:rgb(0,0,255)"></i><i style="background:rgb(255,255,255)"></i></div>`;
const HTML = `
  <canvas id="c" width="400" height="200" content="drawable">${QUADS.replace('<div', '<div id="q"')}</canvas>
  <canvas id="g" width="400" height="200" content="drawable">${QUADS.replace('<div', '<div id="r"')}</canvas>`;

const RED = [255, 0, 0, 255];
const LIME = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

/** Quadrant probes of an 80×40 upload at the origin, in pixels from the top left. */
const QUAD_PROBES = [[2, 2], [78, 2], [2, 38], [78, 38], [82, 2], [2, 42]];
const QUAD_PIXELS = [RED, LIME, BLUE, WHITE, CLEAR, CLEAR];

type Call = (op: string, payload?: Record<string, unknown>, transfer?: Transferable[]) => Promise<Record<string, unknown>>;
interface TestWindow {
  call: Call;
  /** The error drawing the image into a fresh canvas throws: the closed error once it is closed or transferred away. An open native image throws "captured from a different canvas" instead. */
  closedError: (image: ElementImage) => string | null;
  echo?: unknown;
  /** The page's ElementImage constructor, native or polyfilled. */
  ElementImage: abstract new (...args: never[]) => object;
  hasSize: boolean;
  worker: Worker;
}

/** Chromium 156 has ElementImage.width/height (as the polyfill does); Canary 159 and the explainer don't. */
const size = (hasSize: boolean) => (hasSize ? { width: 80, height: 40 } : { width: undefined, height: undefined });
const CLOSED = /^InvalidStateError: .*The ElementImage has been closed\.$/;

/** Each channel within 1 of the expected value. */
function near(actual: unknown, expected: number[][]): void {
  const pixels = actual as number[][];
  expect(pixels.length).toBe(expected.length);
  pixels.forEach((px, i) =>
    px.forEach((v, c) => expect(Math.abs(v - expected[i]![c]!), `pixel ${i}: ${px} vs ${expected[i]}`).toBeLessThanOrEqual(1)),
  );
}

async function startWorker(page: Page, polyfilled: boolean): Promise<void> {
  await page.evaluate(async (url) => {
    const w = window as unknown as TestWindow;
    w.hasSize = 'width' in w.ElementImage.prototype;
    // Natively the closed check comes before the canvas check.
    w.closedError = (image) => {
      try {
        document.createElement('canvas').getContext('2d')!.drawElementImage(image, 0, 0);
        return null;
      } catch (e) {
        return `${(e as Error).name}: ${(e as Error).message}`;
      }
    };
    w.worker = new Worker(url, { type: 'module' });
    const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    let next = 0;
    w.worker.onmessage = ({ data }) => {
      if ('echo' in data) {
        w.echo = data.echo;
        return;
      }
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) p?.reject(new Error(data.error));
      else p?.resolve(data.result);
    };
    w.call = (op, payload = {}, transfer = []) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        w.worker.postMessage({ id, op, ...payload }, transfer);
      });
    // The worker answers once its modules have loaded.
    await w.call('info', { image: null });
  }, polyfilled ? '/tests/browser/fixtures/worker-polyfill.js' : '/tests/browser/fixtures/worker.js');
}

test.beforeEach(async ({ page }, info) => {
  const native = info.project.name === 'native' || info.project.name === 'canary';
  await load(page, native, 'messaging');
  await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const canvases = [...document.querySelectorAll('canvas')];
    await Promise.all(canvases.map((c) => new Promise((r) => c.addEventListener('paint', r, { once: true }))));
  }, HTML);
  await startWorker(page, !native);
});

async function skipWithoutOffscreen(page: Page): Promise<void> {
  const ok = await page.evaluate(() => 'transferControlToOffscreen' in HTMLCanvasElement.prototype);
  // Playwright's WebKit on Windows has no OffscreenCanvas.
  test.skip(!ok, 'transferControlToOffscreen is unavailable');
}


test('a transferred ElementImage arrives in the worker, and the source is closed', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { call, closedError, hasSize } = window as unknown as TestWindow;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const image = c.captureElementImage(document.getElementById('q')!);
    const before = { width: image.width, height: image.height };
    const received = await call('info', { image }, [image as unknown as Transferable]);
    const closed = closedError(image);
    image.close();
    return { hasSize, before, received, closed, tag: Object.prototype.toString.call(image) };
  });
  expect(r.before).toEqual(size(r.hasSize));
  expect(r.received).toMatchObject({ isElementImage: true, type: '[object ElementImage]', closable: true, ...size(r.hasSize) });
  expect(r.closed).toMatch(CLOSED);
  expect(r.tag).toBe('[object ElementImage]');
});

test('cloning an ElementImage throws DataCloneError, and leaves it open', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { worker, closedError } = window as unknown as TestWindow;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const image = c.captureElementImage(document.getElementById('q')!);
    const attempt = (fn: () => unknown) => {
      try {
        fn();
        return 'no error';
      } catch (e) {
        return (e as Error).name;
      }
    };
    const errors = {
      worker: attempt(() => worker.postMessage({ image })),
      workerEmptyTransfer: attempt(() => worker.postMessage({ image }, [])),
      structuredClone: attempt(() => structuredClone(image)),
      nested: attempt(() => structuredClone({ list: [new Map([['k', image]])] })),
      port: attempt(() => new MessageChannel().port1.postMessage(image)),
      broadcast: attempt(() => new BroadcastChannel('hic-test').postMessage(image)),
      window: attempt(() => window.postMessage(image, '*')),
      history: attempt(() => history.pushState({ image }, '')),
    };
    return { errors, closed: closedError(image) };
  });
  for (const name of Object.values(r.errors)) expect(name).toBe('DataCloneError');
  expect(r.closed ?? '').not.toMatch(CLOSED);
});

test('transferring a closed or duplicated ElementImage throws DataCloneError', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { worker, closedError } = window as unknown as TestWindow;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const q = document.getElementById('q')!;
    const attempt = (fn: () => unknown) => {
      try {
        fn();
        return 'no error';
      } catch (e) {
        return `${(e as Error).name}: ${(e as Error).message}`;
      }
    };
    const t = (image: unknown) => image as Transferable;
    const closed = c.captureElementImage(q);
    closed.close();
    const dup = c.captureElementImage(q);
    return {
      closedPost: attempt(() => worker.postMessage({ closed }, [t(closed)])),
      closedClone: attempt(() => structuredClone(closed, { transfer: [t(closed)] })),
      duplicate: attempt(() => worker.postMessage({ dup }, [t(dup), t(dup)])),
      duplicateClosed: closedError(dup),
    };
  });
  expect(r.closedPost).toMatch(/^DataCloneError: .*An ElementImage is closed and could not be cloned\.$/);
  expect(r.closedClone).toMatch(/^DataCloneError: .*An ElementImage is closed and could not be cloned\.$/);
  expect(r.duplicate).toMatch(/^DataCloneError: /);
  expect(r.duplicateClosed ?? '').not.toMatch(CLOSED);
});

test('an ElementImage only in the transfer list is still detached', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { worker, closedError } = window as unknown as TestWindow;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const image = c.captureElementImage(document.getElementById('q')!);
    worker.postMessage({ id: -1, op: 'info', image: null }, [image as unknown as Transferable]);
    return closedError(image);
  });
  expect(r).toMatch(CLOSED);
});

test.describe('in the worker', () => {
  test.beforeEach(async ({ page }) => {
    await skipWithoutOffscreen(page);
  });

  test("draws into the worker's OffscreenCanvas, with every overload", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { call } = window as unknown as TestWindow;
      const c = document.getElementById('c') as HTMLCanvasElement;
      const q = document.getElementById('q')!;
      const canvas = c.transferControlToOffscreen();
      await call('init2d', { canvas }, [canvas]);
      const draw = (args: unknown[], probes: number[][], close = false) => {
        const image = c.captureElementImage(q);
        return call('draw', { image, args, probes, close }, [image as unknown as Transferable]);
      };
      return {
        whole: await draw([0, 0], [[2, 2], [78, 2], [2, 38], [78, 38], [82, 2], [2, 42]]),
        scaled: await draw([0, 0, 40, 20], [[2, 2], [22, 2], [2, 12], [22, 12], [42, 2]]),
        cropped: await draw([20, 0, 20, 10, 0, 0], [[2, 2], [38, 18], [42, 2]]),
        closed: await draw([100, 50, { preserveElementGeometry: true }], [[102, 52]], true),
      };
    });
    near(r.whole.pixels, [RED, LIME, BLUE, WHITE, CLEAR, CLEAR]);
    near(r.scaled.pixels, [RED, LIME, BLUE, WHITE, CLEAR]);
    near(r.cropped.pixels, [LIME, LIME, CLEAR]);
    near(r.closed.pixels, [RED]);
    // Native Chromium 156 has no OffscreenCanvas.getElementImageDefaultSize; Canary 159 does.
    if (r.whole.defaultSize) expect(r.whole.defaultSize).toEqual({ width: 80, height: 40 });
    expect(r.closed.drawClosed).toMatch(CLOSED);
  });

  test('uploads with WebGL texElementSubImage2D', async ({ page }) => {
    const r = await page.evaluate(async (probes) => {
      const { call } = window as unknown as TestWindow;
      const g = document.getElementById('g') as HTMLCanvasElement;
      const canvas = g.transferControlToOffscreen();
      const image = g.captureElementImage(document.getElementById('r')!);
      return call('gl', { canvas, image, probes }, [canvas, image as unknown as Transferable]);
    }, QUAD_PROBES);
    test.skip(typeof r.skip === 'string', String(r.skip));
    expect(r.error).toBe(0);
    near(r.pixels, QUAD_PIXELS);
  });

  test('uploads with WebGPU drawElementImageToTexture, as Underglass does', async ({ page }) => {
    const r = await page.evaluate(async (probes) => {
      const { call } = window as unknown as TestWindow;
      const g = document.getElementById('g') as HTMLCanvasElement;
      const el = document.getElementById('r')!;
      // Natively the snapshot's canvas needs a rendering context; Underglass configures WebGPU on it in the worker.
      const canvas = g.transferControlToOffscreen();
      const init = await call('initgpu', { canvas }, [canvas]);
      if (init.skip) return init;
      const whole = g.captureElementImage(el);
      const crop = g.captureElementImage(el);
      const images = [
        { slot: 0, width: 80, height: 40, image: whole, probes },
        // The top-right quadrant, in CSS pixels.
        { slot: 1, width: 40, height: 20, image: crop, probes: [[2, 2], [38, 18], [42, 2]], source: { sourceX: 20, sourceY: 0, sourceWidth: 20, sourceHeight: 10 } },
      ];
      return call('frame', { type: 'frame', images }, [whole, crop] as unknown as Transferable[]);
    }, QUAD_PROBES);
    test.skip(typeof r.skip === 'string', String(r.skip));
    const [whole, crop] = r.results as { error: string | null; pixels: number[][] }[];
    expect(whole!.error).toBeNull();
    near(whole!.pixels, QUAD_PIXELS);
    expect(crop!.error).toBeNull();
    near(crop!.pixels, [LIME, LIME, CLEAR]);
  });
});

test('an ElementImage transfers back from the worker', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as unknown as TestWindow;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const image = c.captureElementImage(document.getElementById('q')!);
    const workerSide = await w.call('echo', { image }, [image as unknown as Transferable]);
    const echo = w.echo as ElementImage;
    return { workerSide, isElementImage: echo instanceof w.ElementImage, closed: w.closedError(echo) };
  });
  if (r.workerSide.closed !== 'no OffscreenCanvas') expect(r.workerSide.closed).toMatch(CLOSED);
  expect(r.isElementImage).toBe(true);
  expect(r.closed ?? '').not.toMatch(CLOSED);
});

test('ElementImages inside objects, arrays, Maps, Sets and cycles arrive, keeping identity', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { call, closedError, hasSize } = window as unknown as TestWindow;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const q = document.getElementById('q')!;
    const [a, b, k, s] = [0, 1, 2, 3].map(() => c.captureElementImage(q));
    const data: Record<string, unknown> = {
      nested: { deep: [{ image: a }] },
      again: a,
      map: new Map([['k', b]]),
      keyed: new Map([[k, 'v']]),
      set: new Set([s]),
      typed: new Uint8Array([1, 2, 3]),
      text: 'hello',
    };
    data.self = data;
    const result = await call('structure', { data }, [a, b, k, s] as unknown as Transferable[]);
    return { hasSize, result, closed: [a, b, k, s].map((x) => closedError(x!)) };
  });
  const image = { isElementImage: true, ...size(r.hasSize) };
  expect(r.result).toMatchObject({ nested: image, sameObject: true, mapValue: image, mapKey: image, set: image, cycle: true, typed: [1, 2, 3], text: 'hello' });
  for (const closed of r.closed) expect(closed).toMatch(CLOSED);
});

test('an ElementImage crosses a MessageChannel into the worker', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { call, closedError, hasSize } = window as unknown as TestWindow;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const image = c.captureElementImage(document.getElementById('q')!);
    const channel = new MessageChannel();
    const received = call('port', { port: channel.port2 }, [channel.port2]);
    channel.port1.postMessage({ image }, [image as unknown as Transferable]);
    return { hasSize, received: await received, closed: closedError(image) };
  });
  expect(r.received).toMatchObject({ isElementImage: true, ...size(r.hasSize) });
  expect(r.closed).toMatch(CLOSED);
});

test('structuredClone with a transfer list moves the ElementImage', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { closedError } = window as unknown as TestWindow;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const image = c.captureElementImage(document.getElementById('q')!);
    const { copy } = structuredClone({ copy: image }, { transfer: [image as unknown as Transferable] });
    const ctx = c.getContext('2d')!;
    ctx.drawElementImage(copy, 0, 0);
    return {
      isElementImage: copy instanceof (window as unknown as TestWindow).ElementImage,
      source: closedError(image),
      pixel: Array.from(ctx.getImageData(2, 2, 1, 1).data),
    };
  });
  expect(r.isElementImage).toBe(true);
  expect(r.source).toMatch(CLOSED);
  near([r.pixel], [RED]);
});

test('a worker without the worker entry receives the envelope', async ({ page }, info) => {
  test.skip(info.project.name === 'native' || info.project.name === 'canary', 'polyfill only');
  await startWorker(page, false);
  const r = await page.evaluate(async () => {
    const { call } = window as unknown as TestWindow;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const image = c.captureElementImage(document.getElementById('q')!);
    return call('info', { image }, [image as unknown as Transferable]);
  });
  expect(r).toMatchObject({ isElementImage: false, type: '[object Object]', width: 80, height: 40, closable: false, bitmap: '[object ImageBitmap]' });
});

test('top-level arrays, Maps and ElementImages cross a MessageChannel unchanged', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { ElementImage: Image } = window as unknown as TestWindow;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const q = document.getElementById('q')!;
    const { port1, port2 } = new MessageChannel();
    const received: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      port2.onmessage = (e) => {
        received.push(e.data);
        if (received.length === 3) resolve();
      };
    });
    const [a, b, d] = [0, 1, 2].map(() => c.captureElementImage(q)) as unknown as Transferable[];
    port1.postMessage([a, 'x'], [a!]);
    port1.postMessage(new Map([['k', b]]), [b!]);
    port1.postMessage(d, [d!]);
    await done;
    const [list, map, bare] = received as [unknown[], Map<string, unknown>, unknown];
    return { list: [list[0] instanceof Image, list[1], Object.keys(list)], map: map.get('k') instanceof Image, bare: bare instanceof Image };
  });
  expect(r).toEqual({ list: [true, 'x', ['0', '1']], map: true, bare: true });
});
