# HTML-in-Canvas polyfill — plan

Target API: current WICG explainer (`content="drawable"`, `drawable`, `paint` /
`requestPaint`, `drawElementImage`, `captureElementImage`/`ElementImage`,
`texElementSubImage2D`, `GPUQueue.drawElementImageToTexture`,
`updateElementGeometry` / `clearElementGeometry` / `getElementTransform`,
`getElementImageDefaultSize`). Keep older names (`layoutsubtree`,
`drawElement`, `texElementImage2D`, `copyElementImageToTexture`) as aliases;
the spec is moving, so the API layer must stay thin.

## Core idea: two cooperating layers

1. **Pixel layer (snapshot)**: serialize each drawable subtree into an SVG
   `<foreignObject>`, then decode it to an `ImageBitmap`. That bitmap backs
   `ElementImage` and feeds `drawImage` / `texSubImage2D` /
   `copyExternalImageToTexture`.
2. **Interaction layer (live DOM)**: the real element stays live in an overlay
   host positioned over the canvas. `updateElementGeometry` maps to a CSS
   `matrix3d` transform plus `clip-path` on that element. The element remains
   hit-testable, focusable, IME-capable, and accessible, but is visually
   transparent (`opacity: 0`) because the canvas shows its pixels.

Why the overlay: in non-supporting browsers, canvas children are fallback
content with no layout box, so they cannot be measured, serialized with
layout, or hit-tested. Drawable children must be relocated into a sibling host
sized to the canvas content box. There are two modes:
- Auto: move the content and leave a placeholder comment. This breaks
  `canvas > x` selectors and `parentElement`.
- Authoring: the user puts content in `<div data-hic-host>`, and the polyfill
  does not move it.

## API mapping

| Native | Polyfill |
|---|---|
| `content=drawable` / `layoutsubtree` | MutationObserver on attributes → set up host |
| snapshot per `drawable` (excl. nested drawables) | clone → inline computed styles, fonts, images (data URLs), form state → foreignObject (data URL only) → `img.decode()` → `createImageBitmap` (Chromium: via an intermediate canvas to avoid taint; WebKit/Firefox: direct; chosen by feature test, see [SPIKE.md](SPIKE.md)); nested drawables replaced by same-size empty boxes |
| `paint` event + `changedElements` | dirty tracking: MutationObserver, ResizeObserver, input/change/focus/scroll, transition/animation run→end (continuous), `document.fonts`, image load. Re-snapshot dirty elements, then dispatch `CanvasPaintEvent` in rAF when the bitmaps are ready. Reverse tree order. |
| `requestPaint()` | force paint in next rAF |
| `drawElementImage` (3 overloads) | `drawImage(bitmap, …)` scaled by DPR. Throws before the first snapshot, matching native behavior. Auto `updateElementGeometry` from `ctx.getTransform()` × dest rect unless `preserveElementGeometry` is set. |
| `captureElementImage` / `ElementImage` | wrapper over `ImageBitmap`; `close()` releases it. Worker transfer only via an exposed bitmap helper. |
| `texElementSubImage2D` | `texSubImage2D(target, level, x, y, RGBA, UNSIGNED_BYTE, bitmap)` |
| `drawElementImageToTexture` | `queue.copyExternalImageToTexture({source: bitmap}, dest, size)` |
| `updateElementGeometry` / `clear` / `getElementTransform` | store matrix; apply CSS transform (canvas CSS-px scale × matrix) and `clip-path`; `preserveHitTestOrder` → z-index stack |
| `getElementImageDefaultSize` | border-box × (canvas.width / clientWidth) |
| `elementgeometryupdate` | microtask-batched event (OffscreenCanvas path minimal) |

## Known limitations (document them, don't fight them)

- No caret, selection highlight, or IME composition rendering in snapshots.
  The caret could be faked later.
- Snapshots are async, so the drawn image is about one frame stale after a
  change. The spec already says "draws last snapshot", so this fits.
- Serialization cost is roughly 5–50 ms for complex trees. That is fine for
  menus, labels, and forms, not for 60 fps animated DOM.
- Cross-origin images/fonts without CORS, iframes, `<video>`/`<canvas>`
  children need special handling (video/canvas → per-frame bitmap) or are
  unsupported.
- `:hover`, `:focus-visible`, and `:active` must be mirrored onto clones via
  classes.
- Native form-control appearance inside foreignObject varies by engine.
  WebKit draws form controls without the platform theme: no accent colour,
  and a flat range input and select. Firefox also flattens text fields,
  selects, and range inputs, and does not paint checkboxes at all.
- Firefox loses `background-clip: text` (gradient text) on the
  canvas/bitmap path.
- Tainting (verified in the spike): blob URLs taint in Chromium and WebKit,
  but not in Firefox. In Chromium, `createImageBitmap(img)` taints, but going
  through an intermediate canvas is clean. In WebKit and Firefox, the direct
  bitmap is clean.
- Opaque pseudo-elements (`::-webkit-slider-thumb`, `::marker`, …) are copied
  as stylesheet rules. Rules that depend on ancestors outside the snapshot
  root do not match.
- Only flat-plane geometry is interactive. Shader-distorted or
  depth-occluded content gets correct pixels but approximate hit-testing.

## Phases

0. **Spike (done; see [SPIKE.md](SPIKE.md))**: foreignObject snapshot of a form + styled text in
   Chromium (flag off), Firefox, and WebKit. Measure taint, latency, fidelity,
   and WebGL/WebGPU upload. Decide: own serializer vs build on
   `modern-screenshot` / `html-to-image`. Outcome: own serializer, starting
   from `spike/src/serializer.ts`.
1. **Core 2D**: feature detection (respect native, including the
   ElementCanvasTransform geometry probe used in BabylonHTML), host setup,
   snapshot engine with resource cache, `ElementImage`, `drawElementImage`,
   `paint` / `requestPaint`, default size.
2. **Geometry & interaction**: update/clear/getElementTransform, auto-geometry
   from 2D draws, overlay hit-testing, focus/a11y checks.
3. **WebGL / WebGPU** upload paths.
4. **Fidelity**: fonts, pseudo-elements, form state, interaction-state
   mirroring, scroll offsets, optional fake caret.
5. **Testing**: Playwright on chromium/firefox/webkit. Pixel-tolerance
   comparison against native Chrome-with-flag baselines. Run the WICG demos and
   [Underglass](https://github.com/RaananW/underglass) (including its Strata
   design system) as smoke tests. Add perf budgets.

## Project shape (decided: standalone, open source, engine-agnostic)

- New directory + new GitHub repository. No dependency on, or knowledge of,
  Babylon.js / BabylonHTML or any engine. Engines consume the spec API only.
- Goal: "works the best we can, with known limitations". The limitations
  are first-class documentation, not hidden.
- Never overrides native support. If the browser has the API, the polyfill
  is a no-op. A `force` option exists for testing.
- Exposes `window.HTMLInCanvasPolyfill = { native, polyfilled, limitations }`
  so apps can report honestly whether the API is native or polyfilled.

Proposed layout (TypeScript, ESM, zero runtime dependencies if the spike
allows):

```
src/
  index.ts            install() / uninstall() / feature detection
  auto.ts             side-effect entry: import "html-in-canvas-polyfill/auto"
  host/               canvas setup, relocation, overlay host
  snapshot/           serializer, resource inliner/cache, foreignObject → ImageBitmap
  paint/              dirty tracking, paint/requestPaint scheduling, CanvasPaintEvent
  geometry/           update/clear/getElementTransform, hit-test overlay
  contexts/           2D, WebGL/WebGL2, WebGPU, OffscreenCanvas shims
  element-image.ts
examples/             WICG demos running unmodified + engine-neutral samples
tests/
  unit/               vitest (jsdom/happy-dom where possible)
  browser/            Playwright chromium/firefox/webkit, pixel-tolerance baselines
docs/
  LIMITATIONS.md      per-feature, per-browser support matrix
  API-COVERAGE.md     spec member → status (full / partial / unsupported)
```

Tooling: pnpm, tsc (or tsup) build to ESM + IIFE (`<script>` use), eslint,
vitest, Playwright, GitHub Actions CI (lint, unit, 3-browser e2e, bundle
size), Changesets for releases, npm publishing. License: MIT (to confirm).

## Open decisions

- Repository owner/name and license.
- ~~Own serializer vs a dependency~~ Decided: own serializer. It has better
  fidelity, is 5–40× faster on token-heavy pages, and is the smallest at
  3.9 KB. See [SPIKE.md](SPIKE.md).
- Auto-relocate DOM (default) vs require the authoring-mode host (opt-in).
