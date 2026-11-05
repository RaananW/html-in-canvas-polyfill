import { expect, test } from '@playwright/test';
import type { GPUDrawElementImageDestination, GPUDrawElementImageSource } from '../../src/types';
import { load } from './helpers';

// Runs against native Chromium (project "native") and the polyfill in every
// other project. Expectations are the native behavior.

/** 40×20 CSS px quadrants (red, lime / blue, white) and a half-transparent white box, at grid scale 2. */
const QUADS = `
  <canvas id="c" width="400" height="200" content="drawable">
    <div id="q" drawable style="width:40px;height:20px;display:grid;grid-template:1fr 1fr / 1fr 1fr">
      <i style="background:rgb(255,0,0)"></i><i style="background:rgb(0,255,0)"></i>
      <i style="background:rgb(0,0,255)"></i><i style="background:rgb(255,255,255)"></i>
    </div>
    <div id="h" drawable style="width:10px;height:10px;background:rgba(255,255,255,0.5)"></div>
  </canvas>
  <canvas id="other" width="100" height="100" content="drawable"><div id="o" drawable style="width:10px;height:10px;background:red"></div></canvas>`;

const RED = [255, 0, 0, 255];
const LIME = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

test.beforeEach(async ({ page }, info) => {
  await load(page, info.project.name === 'native');
  await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const other = document.getElementById('other') as HTMLCanvasElement;
    await Promise.all([c, other].map((x) => new Promise((r) => x.addEventListener('paint', r, { once: true }))));
  }, QUADS);
});

/** Pixel within 1 of the expected value in every channel. */
function near(actual: number[], expected: number[]): void {
  expect(actual.length).toBe(4);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `${actual} vs ${expected}`).toBeLessThanOrEqual(1));
}

test.describe('WebGL texElementSubImage2D', () => {
  test.beforeEach(async ({ page }) => {
    const ok = await page.evaluate(() => {
      const c = document.getElementById('c') as HTMLCanvasElement;
      const gl = c.getContext('webgl2');
      if (!gl) return false;
      const w = window as unknown as Record<string, unknown>;
      w.gl = gl;
      /** A fresh, zeroed 128×64 RGBA8 texture bound to TEXTURE_2D. */
      w.fresh = () => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 128, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return (x: number, y: number) => {
          const out = new Uint8Array(4);
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
          return Array.from(out);
        };
      };
      return true;
    });
    // Headless Firefox on Linux CI has no WebGL.
    test.skip(!ok, 'WebGL 2 is unavailable');
  });

  test('uploads the border box in grid pixels', async ({ page }) => {
    const r = await page.evaluate(() => {
      const w = window as unknown as { gl: WebGL2RenderingContext; fresh: () => (x: number, y: number) => number[] };
      const { gl } = w;
      const px = w.fresh();
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, document.getElementById('q')!);
      return { tl: px(2, 2), tr: px(78, 2), bl: px(2, 38), br: px(78, 38), right: px(82, 2), below: px(2, 42), error: gl.getError() };
    });
    expect(r).toEqual({ tl: RED, tr: LIME, bl: BLUE, br: WHITE, right: CLEAR, below: CLEAR, error: 0 });
  });

  test('respects UNPACK_FLIP_Y_WEBGL and offsets', async ({ page }) => {
    const r = await page.evaluate(() => {
      const w = window as unknown as { gl: WebGL2RenderingContext; fresh: () => (x: number, y: number) => number[] };
      const { gl } = w;
      const px = w.fresh();
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 10, 5, document.getElementById('q')!);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      return { first: px(12, 7), last: px(88, 43), before: px(8, 7), error: gl.getError() };
    });
    expect(r).toEqual({ first: BLUE, last: LIME, before: CLEAR, error: 0 });
  });

  test('maps the config source rectangle in CSS pixels and scales to width and height', async ({ page }) => {
    const r = await page.evaluate(() => {
      const w = window as unknown as { gl: WebGL2RenderingContext; fresh: () => (x: number, y: number) => number[] };
      const { gl } = w;
      const q = document.getElementById('q')!;
      let px = w.fresh();
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, q, { sx: 20, sy: 0, swidth: 20, sheight: 10 });
      const cropped = { first: px(1, 1), last: px(38, 18), right: px(41, 1), below: px(1, 21) };
      px = w.fresh();
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, q, { sx: 20, sy: 10, swidth: 20, sheight: 10, width: 8, height: 4 });
      const scaled = { first: px(1, 1), last: px(7, 3), right: px(9, 1), below: px(1, 5) };
      return { cropped, scaled, error: gl.getError() };
    });
    expect(r).toEqual({
      cropped: { first: LIME, last: LIME, right: CLEAR, below: CLEAR },
      scaled: { first: WHITE, last: WHITE, right: CLEAR, below: CLEAR },
      error: 0,
    });
  });

  test('respects UNPACK_PREMULTIPLY_ALPHA_WEBGL', async ({ page }) => {
    const r = await page.evaluate(() => {
      const w = window as unknown as { gl: WebGL2RenderingContext; fresh: () => (x: number, y: number) => number[] };
      const { gl } = w;
      const h = document.getElementById('h')!;
      let px = w.fresh();
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, h);
      const straight = px(5, 5);
      px = w.fresh();
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, h);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      return { straight, premultiplied: px(5, 5) };
    });
    near(r.straight, [255, 255, 255, 128]);
    near(r.premultiplied, [128, 128, 128, 128]);
  });

  test('uploads ElementImage sources and reports errors', async ({ page }) => {
    const r = await page.evaluate(() => {
      const w = window as unknown as { gl: WebGL2RenderingContext; fresh: () => (x: number, y: number) => number[] };
      const { gl } = w;
      const c = document.getElementById('c') as HTMLCanvasElement;
      const px = w.fresh();
      const image = c.captureElementImage(document.getElementById('q')!);
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image);
      const fromImage = px(78, 38);
      const error = (fn: () => void) => {
        try {
          fn();
          return 'none';
        } catch (e) {
          return (e as Error).name;
        }
      };
      image.close();
      return {
        fromImage,
        closed: error(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image)),
        foreign: error(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, document.getElementById('o')!)),
        notElement: error(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, {} as Element)),
        partialSource: error(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, document.getElementById('q')!, { sx: 20, swidth: 20 })),
        partialSize: error(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, document.getElementById('q')!, { width: 8 })),
        overflow: (gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 100, 0, document.getElementById('q')!), gl.getError()),
      };
    });
    expect(r).toEqual({
      fromImage: WHITE,
      closed: 'InvalidStateError',
      foreign: 'InvalidStateError',
      notElement: 'TypeError',
      partialSource: 'OperationError',
      partialSize: 'OperationError',
      overflow: 0x0501,
    });
  });
});

test.describe('WebGPU drawElementImageToTexture', () => {
  test.beforeEach(async ({ page }) => {
    const ok = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      // Native requires the element's canvas to have a rendering context.
      for (const id of ['c', 'other']) {
        const ctx = (document.getElementById(id) as HTMLCanvasElement).getContext('webgpu') as GPUCanvasContext;
        ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
      }
      const w = window as unknown as Record<string, unknown>;
      w.device = device;
      /** Draws into a fresh 128×64 texture and returns a pixel reader. */
      w.draw = async (
        source: GPUDrawElementImageSource,
        dest: Partial<GPUDrawElementImageDestination> = {},
        format: GPUTextureFormat = 'rgba8unorm',
      ) => {
        const texture = device.createTexture({
          size: [128, 64],
          format,
          // COPY_SRC | COPY_DST | RENDER_ATTACHMENT
          usage: 0x01 | 0x02 | 0x10,
        });
        device.queue.drawElementImageToTexture(source, { texture, ...dest });
        const buffer = device.createBuffer({ size: 512 * 64, usage: 0x08 | 0x01 /* COPY_DST | MAP_READ */ });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 512 }, [128, 64]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(0x01 /* READ */);
        const data = new Uint8Array(buffer.getMappedRange().slice(0));
        buffer.unmap();
        return (x: number, y: number) => Array.from(data.subarray(y * 512 + x * 4, y * 512 + x * 4 + 4));
      };
      return true;
    });
    test.skip(!ok, 'WebGPU is unavailable');
  });

  type Draw = (
    source: GPUDrawElementImageSource,
    dest?: Partial<GPUDrawElementImageDestination>,
    format?: GPUTextureFormat,
  ) => Promise<(x: number, y: number) => number[]>;

  test('draws the border box in grid pixels', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { draw } = window as unknown as { draw: Draw };
      const px = await draw({ source: document.getElementById('q')! });
      return { tl: px(2, 2), tr: px(78, 2), bl: px(2, 38), br: px(78, 38), right: px(82, 2), below: px(2, 42) };
    });
    expect(r).toEqual({ tl: RED, tr: LIME, bl: BLUE, br: WHITE, right: CLEAR, below: CLEAR });
  });

  test('maps source rectangles in CSS pixels, origin and size', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { draw } = window as unknown as { draw: Draw };
      const q = document.getElementById('q')!;
      let px = await draw({ source: q, sourceX: 20, sourceY: 0, sourceWidth: 20, sourceHeight: 10 }, { origin: [10, 5] });
      const cropped = { first: px(11, 6), last: px(48, 23), before: px(9, 6), right: px(51, 6) };
      px = await draw({ source: q, sourceX: 20, sourceY: 10, sourceWidth: 20, sourceHeight: 10 }, { size: { width: 8, height: 4 } });
      const sized = { first: px(1, 1), last: px(7, 3), right: px(9, 1), below: px(1, 5) };
      return { cropped, sized };
    });
    expect(r).toEqual({
      cropped: { first: LIME, last: LIME, before: CLEAR, right: CLEAR },
      sized: { first: WHITE, last: WHITE, right: CLEAR, below: CLEAR },
    });
  });

  test('respects premultipliedAlpha and texture formats', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { draw } = window as unknown as { draw: Draw };
      const h = document.getElementById('h')!;
      const straight = (await draw({ source: h }))(5, 5);
      const premultiplied = (await draw({ source: h }, { premultipliedAlpha: true }))(5, 5);
      const bgra = (await draw({ source: document.getElementById('q')! }, {}, 'bgra8unorm'))(2, 2);
      return { straight, premultiplied, bgra };
    });
    near(r.straight, [255, 255, 255, 128]);
    near(r.premultiplied, [128, 128, 128, 128]);
    expect(r.bgra).toEqual([0, 0, 255, 255]);
  });

  test('accepts ElementImages and elements of other canvases, and reports errors', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { draw, device } = window as unknown as { draw: Draw; device: GPUDevice };
      const c = document.getElementById('c') as HTMLCanvasElement;
      const image = c.captureElementImage(document.getElementById('q')!);
      const fromImage = (await draw({ source: image }))(78, 38);
      const foreign = (await draw({ source: document.getElementById('o')! }))(2, 2);
      const error = (fn: () => void) => {
        try {
          fn();
          return 'none';
        } catch (e) {
          return (e as Error).name;
        }
      };
      image.close();
      const texture = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 0x02 /* COPY_DST only */ });
      device.pushErrorScope('validation');
      device.queue.drawElementImageToTexture({ source: document.getElementById('h')! }, { texture });
      const validation = await device.popErrorScope();
      return {
        fromImage,
        foreign,
        closed: error(() => device.queue.drawElementImageToTexture({ source: image }, { texture })),
        notElement: error(() => device.queue.drawElementImageToTexture({ source: {} as Element }, { texture })),
        detached: error(() => device.queue.drawElementImageToTexture({ source: document.createElement('div') }, { texture })),
        partialSource: error(() =>
          device.queue.drawElementImageToTexture({ source: document.getElementById('h')!, sourceX: 1, sourceWidth: 2 }, { texture }),
        ),
        validation: validation?.constructor.name ?? null,
      };
    });
    expect(r).toEqual({
      fromImage: WHITE,
      foreign: [255, 0, 0, 255],
      closed: 'InvalidStateError',
      notElement: 'TypeError',
      detached: 'TypeError',
      partialSource: 'OperationError',
      validation: 'GPUValidationError',
    });
  });
});
