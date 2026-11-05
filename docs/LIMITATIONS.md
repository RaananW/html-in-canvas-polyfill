# Limitations

The polyfill aims to behave like the native implementation where it can and to
be explicit where it can't. At runtime, `HTMLInCanvasPolyfill.limitations` (or
`getStatus().limitations`) lists the gaps that apply to the current browser.
It is empty when the browser supports the API natively, because the polyfill
then does nothing.

## API coverage

| Member | Status |
|---|---|
| `canvas.content` (`fallback` / `drawable`), `drawable` attribute | Full. The legacy `layoutsubtree` attribute is also accepted. |
| `paint` event, `onpaint`, `CanvasPaintEvent.changedElements` | Full, fired in reverse tree order (native Chromium 156 uses tree order). |
| `requestPaint()` | Full. |
| `CanvasRenderingContext2D.drawElementImage` (all overloads) | Full. Returns `undefined`, as in the spec (native Chromium returns a `DOMMatrix`). Updates the element's geometry from the context transform and destination rectangle unless `preserveElementGeometry` is set. |
| `captureElementImage()`, `ElementImage` | Full on the main thread. `ElementImage` can't be transferred to workers. |
| `getElementImageDefaultSize()` | Full (not yet shipped in native Chromium 156). |
| `OffscreenCanvasRenderingContext2D.drawElementImage` | `ElementImage` sources only. Automatic geometry works for canvases transferred with `transferControlToOffscreen()` on the main thread. |
| `updateElementGeometry`, `clearElementGeometry`, `getElementTransform` | Full on `HTMLCanvasElement`, following the explainer (see [Element geometry](#element-geometry)). |
| `OffscreenCanvas.updateElementGeometry` / `clearElementGeometry`, `elementgeometryupdate`, `ElementGeometryUpdateEvent` | Main thread only. Updates are batched in a microtask, then announced on the placeholder canvas. Calls from a worker do nothing. |
| `WebGLRenderingContext` / `WebGL2RenderingContext` `.texElementSubImage2D` | Main thread. RGBA/UNSIGNED_BYTE uploads only (see [WebGL and WebGPU](#webgl-and-webgpu)). |
| `GPUQueue.drawElementImageToTexture` | Main thread. Full otherwise, including source rectangles, `size`, `premultipliedAlpha`, and color formats that `copyExternalImageToTexture` accepts. |
| Legacy `texElementImage2D`, `GPUQueue.copyElementImageToTexture` | Not provided. Native Chromium 156 has them with shapes that differ from the explainer. |

## How content is laid out

Native browsers lay out canvas children in place. The polyfill can't, so it
moves the children into a sibling *host* element (`div[data-hic-host]`). The
host gets the same content box and inherited styles as the canvas, sits
exactly on top of it, and is invisible (`opacity: 0`). Only elements with
geometry are hit-testable.

Consequences:

- Selectors such as `canvas > .item` no longer match, and
  `child.parentElement` is the host, not the canvas.
- Frameworks that own the canvas children (React, Vue, …) will fight the
  move. Use *authoring mode* instead: render the children into your own
  `<div data-hic-host>` immediately after the canvas. The polyfill then lays
  out that element and leaves the DOM alone. When there's more than one
  candidate, `data-hic-host="<canvas id>"` selects the canvas.
- Children are focusable and in the tab order. They receive pointer events
  once they have element geometry, as in native browsers.
- Events from children bubble through the host, not through the canvas.
- `uninstall()` moves the children back into the canvas.

## Element geometry

The polyfill follows the explainer. `canvasTransform` maps the element's
border box, in CSS pixels before CSS transforms, to the canvas border box in
CSS pixels. `canvasClip` is a rectangle in the element's own CSS pixels. A 2D
draw sets the transform to `ctx.getTransform()` × the destination rectangle,
converted from grid pixels; the clip is kept.

The geometry is applied to the live element in the invisible host as a CSS
`transform` and `clip-path` (in a polyfill stylesheet, not inline styles), so
the browser's own hit testing, focus, and caret placement follow it. A later
update puts the element on top (`z-index`) unless `preserveHitTestOrder` is
set. Updates are applied in a microtask, and synchronously before
`elementFromPoint`, `elementsFromPoint`, `getBoundingClientRect`, and
`getClientRects`. `getBoundingClientRect` reflects the geometry, as the
explainer says it should.

Native Chromium 156 doesn't follow the explainer yet. It expects
`getElementTransform(element, drawTransform)`, doesn't move hit regions for
`canvasTransform`, and ignores `canvasClip`. The polyfill's geometry tests
therefore don't run against native Chromium.

Limitations:

- Hits are bounded by the canvas content box. Clips and perspective on the
  element's ancestors inside the canvas aren't undone, and a drawable's clip
  also clips the drawables nested inside it.
- Hit-test order between nested drawables only applies among siblings,
  because each drawable is its own stacking context.
- An authored `clip-path` on an element with geometry is replaced for hit
  testing. Snapshots still use the authored value.
- An authored `transition` on `transform` animates the hit region.
- Element positions come from `offsetLeft`/`offsetTop`, which are whole
  pixels, so a hit region can be up to half a CSS pixel off.
- CSS transforms on the canvas itself aren't supported.

## WebGL and WebGPU

Both upload the element's snapshot, which is the same image `drawElementImage`
draws. By default they upload the border box at the canvas grid size, as
`getElementImageDefaultSize()` reports it. Source rectangles are in CSS
pixels, and partly given rectangles throw `OperationError`, as in native
Chromium.

- `texElementSubImage2D` uploads with
  `texSubImage2D(target, level, x, y, RGBA, UNSIGNED_BYTE, canvas)`, so the
  texture must have an RGBA8 or SRGB8_ALPHA8 format. Native Chromium also
  accepts RGBA16F and RGBA32F textures. `UNPACK_FLIP_Y_WEBGL` and
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` apply. Out-of-range uploads set `INVALID_VALUE`, as in native Chromium.
- `drawElementImageToTexture` uses `copyExternalImageToTexture`, so the
  texture needs `COPY_DST` and `RENDER_ATTACHMENT` usage. Missing usage or an
  out-of-range copy is a WebGPU validation error, not an exception. Like
  native Chromium, it accepts elements of any drawable canvas.
- Scaled or cropped uploads are resampled on a 2D canvas first, so they're
  filtered the same way `drawImage` filters them.
- `ElementImage` can't be transferred to workers, so uploads from a worker
  aren't possible.
- When snapshots taint canvases (see `getStatus().limitations`), uploads throw
  `SecurityError`.

## Snapshots

Each `drawable` element is serialized into an SVG `foreignObject` with inlined
computed styles, fonts, images, and form state, then decoded into an
`ImageBitmap`. In practice:

- Snapshots are asynchronous. A drawn image lags DOM changes by at least one
  frame, and drawing before the first `paint` throws, as in native.
- Serialization costs about 5–50 ms for complex trees: fine for forms, menus,
  and labels, not for animating large subtrees every frame.
- Changes are detected with MutationObserver, ResizeObserver, input, change,
  focus, scroll, load, CSS transition/animation events, and
  `document.fonts`. Changes those can't see (animations started with
  `element.animate()`, pixels of a nested canvas) aren't picked up until
  something else changes. `requestPaint()` fires `paint` but doesn't take
  new snapshots; to force one, change an attribute on the element.
- There's no caret, selection highlight, or IME composition.
- `:hover` and `:active` styles aren't reflected.
- Cross-origin images and fonts without CORS are left out. Iframes and
  `<video>` render empty. A `<canvas>` inside a drawable is copied when the
  snapshot is taken (skipped if tainted), and isn't re-copied when only its
  pixels change.
- Shadow DOM contents aren't serialized yet.
- Opaque pseudo-elements (`::-webkit-slider-thumb`, `::marker`, …) are copied
  as stylesheet rules. Rules that depend on ancestors outside the snapshot
  don't match.

## Per-browser notes

| | Chromium (flag off) | WebKit | Firefox |
|---|---|---|---|
| Canvas stays readable after drawing | Yes (bitmap via an intermediate canvas) | Yes | Yes |
| Form controls | Native look | No platform theme: no accent colour; flat range and select | Flat text field, select, and range; checkboxes aren't painted |
| `background-clip: text` | Yes | Yes | Lost |
| Strata components vs live DOM (mismatched pixels) | 0.03% | 0.67% | Under the 8% test budget |

The path from SVG to bitmap is chosen by a feature test, not by user-agent
sniffing. If both paths taint the canvas, `limitations` says so.
