# HTML-in-Canvas polyfill — plan

Target API: current WICG explainer (`content="drawable"`, `drawable`, `paint` /
`requestPaint`, `drawElementImage`, `captureElementImage`/`ElementImage`,
`texElementSubImage2D`, `GPUQueue.drawElementImageToTexture`,
`updateElementGeometry` / `clearElementGeometry` / `getElementTransform`,
`getElementImageDefaultSize`). Keep older names (`layoutsubtree`,
`drawElement`) as aliases; the spec is moving, so the API layer must stay
thin. Native Chromium's `texElementImage2D` and `copyElementImageToTexture`
have shapes the explainer doesn't define, so they aren't aliased.

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
| `texElementSubImage2D` | `texSubImage2D(target, level, x, y, RGBA, UNSIGNED_BYTE, canvas)`; the snapshot is drawn into a 2D canvas first, because WebGL ignores `UNPACK_*` flags for `ImageBitmap` sources |
| `drawElementImageToTexture` | `queue.copyExternalImageToTexture({source: bitmap, origin}, dest, size)`; cropped or scaled uploads go through a 2D canvas |
| `updateElementGeometry` / `clear` / `getElementTransform` | store matrix; apply CSS transform (canvas CSS-px scale × matrix) and `clip-path`; `preserveHitTestOrder` → z-index stack |
| `getElementImageDefaultSize` | border-box × (canvas.width / clientWidth) |
| `elementgeometryupdate` | microtask-batched event (OffscreenCanvas path minimal) |

## Known limitations (document them, don't fight them)

- No IME composition rendering in snapshots. (Phase 4 added the caret and
  selection highlight.)
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
1. **Core 2D (done)**: feature detection (respect native), host setup
   (auto and authoring modes), snapshot engine with resource cache,
   `ElementImage`, `drawElementImage`, `paint` / `requestPaint`, default
   size. Conformance tests run against native Chromium 156 with the flag.
   A Strata panel drawn by the polyfill differs from the live DOM in 0.03%
   of pixels in Chromium and 0.67% in WebKit; Firefox passes the same tests
   within its 8% budget. Underglass needs phases 2–3
   (geometry and WebGPU), so it isn't a phase-1 smoke test.

   Native semantics found while testing (the polyfill follows them unless
   noted):
   - The `drawElementImage` source rectangle is in the element's CSS pixels.
     The default destination size is the element's border box in canvas
     grid pixels, before CSS transforms.
   - Errors are `InvalidStateError`. The canvas `content=drawable` check
     comes first, then the nearest-canvas check, then "no cached paint
     record".
   - Native Chromium 156 fires `paint` in tree order and includes
     non-`drawable` children in `changedElements`. The polyfill follows the
     spec (reverse tree order, drawables only).
   - Native `drawElementImage` returns a `DOMMatrix`; the spec and the
     polyfill return `undefined`. Native has no `getElementImageDefaultSize`
     yet.
2. **Geometry & interaction (done)**: update/clear/getElementTransform,
   auto-geometry from 2D draws, overlay hit-testing with CSS transforms and
   `clip-path` on the live elements, `preserveHitTestOrder`, and
   OffscreenCanvas batching with `elementgeometryupdate`. Drawn inputs take
   clicks and typing. Underglass's admission probes (`verifyProbeGeometry`,
   `verifyFrameBounds`, `verifyProjectiveHits`) pass against the polyfill in
   Chromium and WebKit.

   Native Chromium 156 geometry doesn't match the explainer, so it can't be
   the oracle for this phase. The polyfill follows the explainer and the
   convention Underglass verified:
   - `getElementTransform` takes `(element, drawTransform)` and returns
     the draw transform conjugated by the content offset and grid scale.
   - `canvasTransform` doesn't move hit regions, `canvasClip` is ignored,
     and draws don't create hit regions.
   - `OffscreenCanvas` has `updateElementGeometry`/`clearElementGeometry`,
     and `ElementGeometryUpdateEvent` exists, but no event fires for
     main-thread updates.
   - The wrong-canvas error is `InvalidStateError`: "The element can only be
     drawn into its nearest ancestor <canvas>." The polyfill uses the same
     message.
3. **WebGL / WebGPU** upload paths. **Done.** `texElementSubImage2D` on
   WebGL and WebGL2 and `GPUQueue.drawElementImageToTexture` pass the same
   tests in the polyfill (Chromium, WebKit) and in native Chromium. Underglass's
   GPU admission probe (`createAdmissionProbe`, `drawElementImageToTexture`,
   `verifyProbePixels`) passes in Chromium and WebKit with real WebGPU.

   Native Chromium 156 behavior the polyfill matches:
   - The default upload is the border box in grid pixels. Source rectangles
     are in CSS pixels; the destination defaults to the source in grid
     pixels, and `width`/`height` (WebGL) or `size` (WebGPU) scale it.
   - Partly given source rectangles, and WebGL `width` without `height`,
     throw `OperationError`.
   - WebGL respects `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL`,
     and an upload past the texture edge sets `INVALID_VALUE`.
   - WebGPU uploads unpremultiplied by default and respects
     `premultipliedAlpha`. It accepts elements of any drawable canvas, and
     needs that canvas to have a rendering context; the polyfill doesn't.
     Usage and bounds errors are WebGPU validation errors.

   This phase also fixed `paint` firing after `requestPaint()` before a
   newly added child's first snapshot was ready. Underglass's admission
   probe found it.
4. **Fidelity (done)**: `:hover`/`:active`, open shadow trees with slotted
   content, text-input scroll offsets and masked passwords, and the
   selection highlight and blinking caret. Fonts, pseudo-elements, and other
   form state were already drawn in phase 1. Native Chromium is the oracle:
   - Selected text gets the `Highlight` system color,
     `rgba(128,188,254,0.6)` (`rgb(179,215,254)` over white), and keeps its
     text color, in text, inputs, and editing hosts alike.
   - The caret is 1 CSS px wide, as tall as the font's content area, at the
     character boundary. It shows first, then toggles every 500 ms with a
     `paint` event each time. The polyfill matches the highlight's bounds and
     the caret's columns exactly in Chromium and WebKit.
   - WebKit draws themed form controls without their theme in SVG images, so
     visual tests use `appearance: none` fields.
5. **Testing (done)**: Playwright on chromium/firefox/webkit, with native
   Chromium as the oracle. Pixel-tolerance comparisons cover the WICG
   complex-text, nested-sparkles, pie-chart and WebGL demos, Strata
   components, and form state. Running them found:
   - Native lays out each canvas child on its own at the content-box origin,
     shrink-to-fit, with percentages against the content box. The host now
     does the same, mirrors the canvas class so descendant selectors match,
     and inherits a unitless `line-height` instead of freezing it in pixels.
   - `canvas.children`, `querySelector()`, a child's `parentElement` and
     `closest()` see the canvas, as natively; node-level reads see the real
     tree. Children move with `moveBefore()` where available.
   - `paint` fires after the page's animation frame callbacks.
   - `getComputedStyle()` reports authored styles for elements with
     geometry; natively, geometry doesn't change computed styles.

   [Underglass](https://github.com/RaananW/underglass) mounts a Strata panel
   in WebGPU mode under the polyfill in Chromium and accepts clicks. It needs
   `moveBefore()`, so WebKit and Firefox skip it. In Chrome Canary 159, with
   the full native API, the panel drawn natively and through the polyfill
   differ in 0.06% of pixels. Its admission checks found the last three
   items above. Playwright's default Chromium headless shell hands out
   invalid WebGPU canvas textures, even without the polyfill, so the
   polyfill Chromium project runs full Chromium.

   The WICG WebGPU jelly slider (TypeGPU) uploads its value label with
   `drawElementImageToTexture` and takes clicks and keys through a drawable
   range input. It runs through the polyfill in Chromium; in Canary 159 the
   native and polyfilled scenes differ in 0.07% of pixels. WebKit can't
   compile the demo's shaders, polyfill or not, and Firefox has no WebGPU.

   Perf budgets cover a Strata panel of about 40 elements. Medians: first
   paint 34–50 ms (native 16 ms), update to `paint` 34–50 ms (native under
   1 ms, in the same frame), and a cached draw about 0.01 ms. Updates take
   two or three frames because the snapshot decodes asynchronously.

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
  auto.ts             side-effect entry: import "@underglass/html-in-canvas-polyfill/auto"
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

- ~~Repository owner/name and license~~ Decided:
  `RaananW/html-in-canvas-polyfill`, MIT, published on npm as
  `@underglass/html-in-canvas-polyfill` (the unscoped name is taken).
- ~~Own serializer vs a dependency~~ Decided: own serializer. It has better
  fidelity, is 5–40× faster on token-heavy pages, and is the smallest at
  3.9 KB. See [SPIKE.md](SPIKE.md).
- ~~Auto-relocate DOM vs authoring-mode host~~ Decided: both. Children
  are moved into a generated host by default. A `<div data-hic-host>` right
  after the canvas opts into authoring mode, for frameworks.
