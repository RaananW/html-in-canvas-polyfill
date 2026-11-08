// Test worker: answers `{ id, op, ... }` requests from tests/browser/worker.spec.ts.
// It uses only the native API surface. worker-polyfill.js imports the polyfill's
// worker entry first.
let ctx2d;
let device;

async function gpuDevice() {
  if (device !== undefined) return device;
  const adapter = await self.navigator.gpu?.requestAdapter();
  device = (await adapter?.requestDevice()) ?? null;
  return device;
}

const errorOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
};

/** Natively, the closed check comes before the canvas check, so any canvas will do. */
const closedError = (image) => errorOf(() => new OffscreenCanvas(1, 1).getContext('2d').drawElementImage(image, 0, 0));

const describe = (image) => ({
  isElementImage: typeof ElementImage === 'function' && image instanceof ElementImage,
  type: Object.prototype.toString.call(image),
  // Chromium 156 has ElementImage.width/height; Canary 159 and the explainer don't.
  hasSize: typeof ElementImage === 'function' && 'width' in ElementImage.prototype,
  width: image?.width,
  height: image?.height,
  closable: typeof image?.close === 'function',
  bitmap: Object.prototype.toString.call(image?.bitmap),
});

const pixels = (ctx, probes) => probes.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));

const ops = {
  info: ({ image }) => describe(image),

  init2d: ({ canvas }) => {
    ctx2d = canvas.getContext('2d');
    return { ok: true };
  },

  draw: ({ image, args, probes, close }) => {
    ctx2d.clearRect(0, 0, ctx2d.canvas.width, ctx2d.canvas.height);
    ctx2d.drawElementImage(image, ...args);
    const out = { pixels: pixels(ctx2d, probes) };
    if (typeof ctx2d.canvas.getElementImageDefaultSize === 'function') {
      out.defaultSize = ctx2d.canvas.getElementImageDefaultSize(image);
    }
    if (close) {
      image.close();
      out.drawClosed = errorOf(() => ctx2d.drawElementImage(image, 0, 0));
    }
    return out;
  },

  // Like Underglass's worker: the transferred canvas gets a WebGPU context on the worker's device.
  initgpu: async ({ canvas }) => {
    const gpu = await gpuDevice();
    if (!gpu) return { skip: 'no WebGPU adapter in the worker' };
    canvas.getContext('webgpu').configure({ device: gpu, format: 'rgba8unorm' });
    return { ok: true };
  },

  // The message shape of Underglass's worker compositor (worker-protocol.ts).
  frame: async ({ images }) => {
    const gpu = await gpuDevice();
    if (typeof Reflect.get(gpu.queue, 'drawElementImageToTexture') !== 'function') return { error: 'no drawElementImageToTexture' };
    const results = [];
    for (const { image, probes, source } of images) {
      if (typeof image?.close !== 'function') return { error: 'Invalid worker snapshot' };
      const texture = gpu.createTexture({
        size: [128, 64],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      gpu.pushErrorScope('validation');
      gpu.queue.drawElementImageToTexture({ source: image, ...source }, { texture });
      const buffer = gpu.createBuffer({ size: 512 * 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 512 }, [128, 64]);
      gpu.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(buffer.getMappedRange());
      const error = await gpu.popErrorScope();
      results.push({ error: error?.message ?? null, pixels: probes.map(([x, y]) => Array.from(data.slice(y * 512 + x * 4, y * 512 + x * 4 + 4))) });
      image.close();
    }
    return { results };
  },

  gl: ({ canvas, image, probes }) => {
    const gl = canvas.getContext('webgl2');
    if (!gl) return { skip: 'no WebGL 2 in the worker' };
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 128, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image);
    return {
      error: gl.getError(),
      pixels: probes.map(([x, y]) => {
        const out = new Uint8Array(4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
        return Array.from(out);
      }),
    };
  },

  // Transfers the image back to the page, then reports on this side's copy.
  echo: ({ id, image }) => {
    self.postMessage({ id, echo: image }, [image]);
    return { closed: typeof OffscreenCanvas === 'function' ? closedError(image) : 'no OffscreenCanvas' };
  },

  structure: ({ data }) => ({
    nested: describe(data.nested.deep[0].image),
    sameObject: data.nested.deep[0].image === data.again,
    mapValue: describe(data.map.get('k')),
    mapKey: describe([...data.keyed.keys()][0]),
    set: describe([...data.set][0]),
    cycle: data.self === data,
    typed: Array.from(data.typed),
    text: data.text,
  }),

  port: ({ port }) =>
    new Promise((resolve) => {
      port.onmessage = ({ data }) => resolve(describe(data.image));
    }),
};

self.onmessage = async ({ data }) => {
  try {
    const result = await ops[data.op](data);
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: `${error.name}: ${error.message}` });
  }
};
