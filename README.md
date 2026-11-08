# @underglass/html-in-canvas-polyfill

An open-source, engine-agnostic polyfill for the WICG
[HTML-in-Canvas](https://github.com/WICG/html-in-canvas) proposal. It aims to
work as well as possible in browsers without native support, and it documents
its limitations clearly.

> **Status:** phases 1 (core 2D), 2 (element geometry), 3 (WebGL and
> WebGPU), 4 (fidelity), and 5 (testing) are done. `content="drawable"`, `paint`, `requestPaint()`,
> `drawElementImage`, `captureElementImage`, and `getElementImageDefaultSize`
> work in Chromium, WebKit, and Firefox, and are checked against native
> Chromium. `updateElementGeometry`, `clearElementGeometry`, and
> `getElementTransform` make drawn elements clickable and focusable where
> they're drawn. `texElementSubImage2D` and `drawElementImageToTexture` upload
> elements to WebGL and WebGPU textures. Snapshots include `:hover` and
> `:active`, open shadow trees, form state, the selection highlight, and a
> blinking caret. The WICG demos and Strata components are compared with
> native Chromium, [Underglass](https://github.com/RaananW/underglass) and
> the WICG WebGPU jelly slider run through the polyfill, and perf budgets guard paint latency. See
> [docs/PLAN.md](docs/PLAN.md) and [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Usage

```sh
npm install @underglass/html-in-canvas-polyfill
```

```js
import '@underglass/html-in-canvas-polyfill/auto';
```

or, with control over installation:

```js
import { install } from '@underglass/html-in-canvas-polyfill';

const status = install(); // { native, polyfilled, version, limitations }
```

A `<script>` build is also available: `dist/html-in-canvas-polyfill.iife.js`
(`@underglass/html-in-canvas-polyfill/iife`).
In every case the polyfill does nothing when the browser supports
HTML-in-Canvas natively. `install({ force: true })` overrides that for
testing.

```html
<canvas id="canvas" content="drawable">
  <form id="form" drawable>…</form>
</canvas>
<script type="module">
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  canvas.onpaint = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawElementImage(document.getElementById('form'), 0, 0);
  };
</script>
```

An `ElementImage` from `captureElementImage()` can be transferred to a worker
with `postMessage(message, [image])`, as natively. The worker needs the
polyfill's worker entry to receive it and to draw or upload it; it does
nothing where the browser supports the API natively:

```js
// In a module worker. Classic workers: importScripts('…/html-in-canvas-polyfill.worker.iife.js').
import '@underglass/html-in-canvas-polyfill/worker';

self.onmessage = ({ data }) => {
  ctx.drawElementImage(data.image, 0, 0); // ctx: the 2D context of a transferred OffscreenCanvas
};
```

See [docs/WORKERS.md](docs/WORKERS.md) and the
[Workers section of the limitations](docs/LIMITATIONS.md#workers).

The polyfill moves canvas children into a sibling host element. If a
framework renders those children, render them into
`<div data-hic-host>` right after the canvas instead. See
[docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # static checks and unit tests
pnpm test:browser                          # builds, then runs Playwright
pnpm build && pnpm serve                   # http://localhost:4173/examples/strata/
```

The Playwright project `native` runs the conformance tests against Chromium
with `--enable-blink-features=CanvasDrawElement`. The other projects run the
same tests against the polyfill. When Chrome Canary is installed (macOS
default path, or set `CANARY_PATH`), the `canary` project runs Underglass and
the WICG jelly slider on the full native API and compares each with the
polyfill in the same browser.

## Goals

- Implement the spec API surface: `content="drawable"`, `drawable`, `paint` /
  `requestPaint()`, `drawElementImage`, `captureElementImage`,
  `texElementSubImage2D`, `drawElementImageToTexture`, and element geometry.
- Never override native support.
- Work with any engine or plain 2D canvas, WebGL and WebGPU.
- Keep limitations explicit. They're listed in
  [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## License

MIT
