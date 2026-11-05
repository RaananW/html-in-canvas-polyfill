import { domToCanvas } from 'modern-screenshot';
import { toCanvas } from 'html-to-image';
import { snapshot, resetCaches, type BitmapPath, type UrlKind } from './serializer';

export type Method =
  | 'own-data-img'
  | 'own-data-canvas'
  | 'own-blob-img'
  | 'own-blob-canvas'
  | 'modern-screenshot'
  | 'html-to-image';

interface UsageResult {
  readback2d: string;
  webgl: string;
  webgpu: string;
}

export interface RunResult {
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  totalMs?: number;
  timings?: Record<string, number>;
  svgBytes?: number;
  warnings?: string[];
  usage?: UsageResult;
  nonEmpty?: boolean | null;
}

let lastBitmap: ImageBitmap | null = null;

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 200);
  return String(e).slice(0, 200);
}

function checkReadback(bitmap: ImageBitmap): { status: string; nonEmpty: boolean | null } {
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  try {
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let alpha = 0;
    for (let i = 3; i < data.length; i += 4) alpha += data[i]!;
    return { status: 'ok', nonEmpty: alpha > 0 };
  } catch (e) {
    return { status: errText(e), nonEmpty: null };
  }
}

let glCtx: WebGLRenderingContext | WebGL2RenderingContext | null | undefined;
function checkWebGL(bitmap: ImageBitmap): string {
  if (glCtx === undefined) {
    const c = document.createElement('canvas');
    glCtx = c.getContext('webgl2') ?? c.getContext('webgl');
  }
  const gl = glCtx;
  if (!gl) return 'unavailable';
  const tex = gl.createTexture();
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bitmap.width, bitmap.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    const err = gl.getError();
    return err === gl.NO_ERROR ? 'ok' : `glError ${err}`;
  } catch (e) {
    return errText(e);
  } finally {
    gl.deleteTexture(tex);
  }
}

let gpuDevice: Promise<GPUDevice | null> | undefined;
async function checkWebGPU(bitmap: ImageBitmap): Promise<string> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return 'unavailable (no navigator.gpu)';
  gpuDevice ??= gpu
    .requestAdapter()
    .then((a) => (a ? a.requestDevice() : null))
    .catch(() => null);
  const device = await gpuDevice;
  if (!device) return 'unavailable (no adapter)';
  const texture = device.createTexture({
    size: [bitmap.width, bitmap.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.pushErrorScope('validation');
  try {
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);
    const err = await device.popErrorScope();
    await device.queue.onSubmittedWorkDone();
    return err ? `validation: ${err.message.slice(0, 160)}` : 'ok';
  } catch (e) {
    await device.popErrorScope().catch(() => null);
    return errText(e);
  } finally {
    texture.destroy();
  }
}

async function checkUsage(bitmap: ImageBitmap): Promise<{ usage: UsageResult; nonEmpty: boolean | null }> {
  const rb = checkReadback(bitmap);
  return {
    usage: { readback2d: rb.status, webgl: checkWebGL(bitmap), webgpu: await checkWebGPU(bitmap) },
    nonEmpty: rb.nonEmpty,
  };
}

function fixture(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no fixture ${id}`);
  return el;
}

async function run(method: Method, fixtureId: string, dpr: number, checks = true): Promise<RunResult> {
  const el = fixture(fixtureId);
  lastBitmap?.close();
  lastBitmap = null;
  try {
    let bitmap: ImageBitmap;
    let timings: Record<string, number> | undefined;
    let svgBytes: number | undefined;
    let warnings: string[] | undefined;
    const t0 = performance.now();
    if (method.startsWith('own-')) {
      const [, urlKind, bitmapPath] = method.split('-') as [string, UrlKind, BitmapPath];
      const r = await snapshot(el, { scale: dpr, urlKind, bitmapPath });
      bitmap = r.bitmap;
      timings = { ...r.timings };
      svgBytes = r.svgBytes;
      warnings = r.warnings;
    } else if (method === 'modern-screenshot') {
      const canvas = await domToCanvas(el, { scale: dpr });
      bitmap = await createImageBitmap(canvas);
    } else {
      const canvas = await toCanvas(el, { pixelRatio: dpr });
      bitmap = await createImageBitmap(canvas);
    }
    const totalMs = performance.now() - t0;
    lastBitmap = bitmap;
    const result: RunResult = { ok: true, width: bitmap.width, height: bitmap.height, totalMs, timings, svgBytes, warnings };
    if (checks) Object.assign(result, await checkUsage(bitmap));
    return result;
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// Draw the last bitmap into the visible output canvas at the fixture's CSS size
// so Playwright can screenshot it for comparison (works even if tainted).
function show(fixtureId: string, dpr: number): void {
  const el = fixture(fixtureId);
  const out = document.getElementById('out') as HTMLCanvasElement;
  out.style.width = `${el.offsetWidth}px`;
  out.style.height = `${el.offsetHeight}px`;
  out.width = Math.round(el.offsetWidth * dpr);
  out.height = Math.round(el.offsetHeight * dpr);
  const ctx = out.getContext('2d')!;
  ctx.clearRect(0, 0, out.width, out.height);
  if (lastBitmap) ctx.drawImage(lastBitmap, 0, 0, out.width, out.height);
}

const NATIVE_MEMBERS: Array<[string, () => object | undefined]> = [
  ['CanvasRenderingContext2D.drawElementImage', () => CanvasRenderingContext2D.prototype],
  ['CanvasRenderingContext2D.drawElement', () => CanvasRenderingContext2D.prototype],
  ['HTMLCanvasElement.requestPaint', () => HTMLCanvasElement.prototype],
  ['HTMLCanvasElement.captureElementImage', () => HTMLCanvasElement.prototype],
  ['HTMLCanvasElement.updateElementGeometry', () => HTMLCanvasElement.prototype],
  ['HTMLCanvasElement.getElementTransform', () => HTMLCanvasElement.prototype],
  ['HTMLCanvasElement.getElementImageDefaultSize', () => HTMLCanvasElement.prototype],
  ['HTMLCanvasElement.content', () => HTMLCanvasElement.prototype],
  ['HTMLCanvasElement.layoutSubtree', () => HTMLCanvasElement.prototype],
  ['HTMLCanvasElement.onpaint', () => HTMLCanvasElement.prototype],
  ['WebGLRenderingContext.texElementSubImage2D', () => WebGLRenderingContext.prototype],
  ['WebGLRenderingContext.texElementImage2D', () => WebGLRenderingContext.prototype],
  ['GPUQueue.drawElementImageToTexture', () => (globalThis as { GPUQueue?: { prototype: object } }).GPUQueue?.prototype],
  ['GPUQueue.copyElementImageToTexture', () => (globalThis as { GPUQueue?: { prototype: object } }).GPUQueue?.prototype],
];

function probeNative(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, proto] of NATIVE_MEMBERS) {
    const member = name.split('.')[1]!;
    const p = proto();
    out[name] = !!p && member in p;
  }
  out.CanvasPaintEvent = 'CanvasPaintEvent' in globalThis;
  out.ElementImage = 'ElementImage' in globalThis;
  return out;
}

// Render a fixture clone with the native API (Chromium with the flag on) into
// #out so it can be compared with the live DOM and the polyfill snapshots.
async function nativeRender(fixtureId: string, dpr: number): Promise<RunResult & { api?: string }> {
  const src = fixture(fixtureId);
  const out = document.getElementById('out') as HTMLCanvasElement;
  const w = src.offsetWidth;
  const h = src.offsetHeight;
  const canvas = document.createElement('canvas');
  canvas.id = 'native';
  canvas.setAttribute('content', 'drawable');
  canvas.setAttribute('layoutsubtree', '');
  canvas.style.cssText = `position:absolute;left:${out.offsetLeft}px;top:${out.offsetTop}px;width:${w}px;height:${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  // Keep ids: fixture styles are id-scoped. resetNative() removes the canvas
  // before the next truth screenshot, so duplicates never coexist with it.
  const clone = src.cloneNode(true) as HTMLElement;
  clone.setAttribute('drawable', '');
  // Re-apply live form state that cloneNode does not carry.
  const srcControls = src.querySelectorAll('input,textarea,select');
  clone.querySelectorAll('input,textarea,select').forEach((c, i) => {
    const s = srcControls[i] as HTMLInputElement;
    const t = c as HTMLInputElement;
    if (s.type === 'checkbox' || s.type === 'radio') t.checked = s.checked;
    else t.value = s.value;
  });
  canvas.appendChild(clone);
  document.getElementById('native')?.remove();
  out.parentElement!.appendChild(canvas);
  out.style.visibility = 'hidden';
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D & Record<string, unknown>;
  const api = typeof ctx.drawElementImage === 'function' ? 'drawElementImage' : typeof ctx.drawElement === 'function' ? 'drawElement' : null;
  if (!api) return { ok: false, error: 'no native draw API' };
  const draw = () => {
    ctx.reset?.();
    // drawElementImage already maps CSS px to the canvas grid; no ctx.scale(dpr).
    (ctx[api] as (el: Element, x: number, y: number) => void).call(ctx, clone, 0, 0);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          draw();
          resolve();
        } catch (e) {
          reject(e);
        }
      }, 1000);
      canvas.addEventListener(
        'paint',
        () => {
          try {
            draw();
            clearTimeout(timer);
            resolve();
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        },
        { once: true },
      );
      (canvas as HTMLCanvasElement & { requestPaint?: () => void }).requestPaint?.();
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ok: true, api, width: canvas.width, height: canvas.height };
  } catch (e) {
    return { ok: false, api, error: errText(e) };
  }
}

function resetNative(): void {
  document.getElementById('native')?.remove();
  (document.getElementById('out') as HTMLCanvasElement).style.visibility = '';
}

function fixtures(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.fx')).map((e) => e.id);
}

async function ready(): Promise<void> {
  const typed = fixture('typed') as HTMLInputElement;
  typed.value = 'Typed value ✓';
  (fixture('agree') as HTMLInputElement).checked = true;
  (fixture('size') as HTMLSelectElement).selectedIndex = 2;
  (fixture('notes') as HTMLTextAreaElement).value = 'Textarea value\nsecond line';
  (fixture('volume') as HTMLInputElement).value = '80';
  fixture('scroller').scrollTop = 40;
  (fixture('strata-switch') as HTMLInputElement).checked = true;
  (fixture('strata-check') as HTMLInputElement).checked = true;
  (fixture('strata-email') as HTMLInputElement).value = 'ada@example.com';
  (fixture('strata-display') as HTMLInputElement).value = '12:34';
  // Stress fixture: ~600 elements to approximate a "complex" panel.
  const large = fixture('fx-large');
  large.innerHTML = Array.from(
    { length: 200 },
    (_, i) => `<div class="row"><span>Item ${i + 1}</span><b>${(i * 37) % 997}</b></div>`,
  ).join('');
  await document.fonts.ready;
  await Promise.all(
    Array.from(document.images).map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)))),
  );
}

async function debugSvg(fixtureId: string): Promise<string> {
  const r = await snapshot(fixture(fixtureId), { scale: 1, urlKind: 'data', bitmapPath: 'canvas', keepSvg: true });
  r.bitmap.close();
  return r.svg!;
}

Object.assign(window, {
  spike: { run, show, fixtures, ready, resetCaches, probeNative, nativeRender, resetNative, debugSvg },
});
