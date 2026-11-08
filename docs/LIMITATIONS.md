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
| `captureElementImage()`, `ElementImage` | Full. Transferable to workers, ports and windows with `postMessage` and `structuredClone`, but a worker has to import the polyfill's worker entry (see [Workers](#workers)). Cloning without a transfer list throws `DataCloneError`, as natively. `width` and `height` are kept; Chrome Canary 159 and the explainer have dropped them. |
| `getElementImageDefaultSize()` | Full (not yet shipped in native Chromium 156). |
| `OffscreenCanvasRenderingContext2D.drawElementImage` | `ElementImage` sources only, on the main thread and in workers with the worker entry. Automatic geometry works for canvases transferred with `transferControlToOffscreen()` on the main thread, not yet from a worker. |
| `updateElementGeometry`, `clearElementGeometry`, `getElementTransform` | Full on `HTMLCanvasElement`, following the explainer (see [Element geometry](#element-geometry)). |
| `OffscreenCanvas.updateElementGeometry` / `clearElementGeometry`, `elementgeometryupdate`, `ElementGeometryUpdateEvent` | Main thread only. Updates are batched in a microtask, then announced on the placeholder canvas. Calls from a worker check their argument and do nothing; natively (Canary 159) they move the element's hit region. |
| `OffscreenCanvas.getElementImageDefaultSize` | Full, in workers too (Canary 159 has it; Chromium 156 doesn't). |
| `WebGLRenderingContext` / `WebGL2RenderingContext` `.texElementSubImage2D` | Main thread and workers with the worker entry. RGBA/UNSIGNED_BYTE uploads only (see [WebGL and WebGPU](#webgl-and-webgpu)). |
| `GPUQueue.drawElementImageToTexture` | Main thread and workers with the worker entry. Full otherwise, including source rectangles, `size`, `premultipliedAlpha`, and color formats that `copyExternalImageToTexture` accepts. |
| Legacy `texElementImage2D`, `GPUQueue.copyElementImageToTexture` | Not provided. Native Chromium 156 has them with shapes that differ from the explainer. |

## How content is laid out

Native browsers lay out canvas children in place. The polyfill can't, so it
moves the children into a sibling *host* element (`div[data-hic-host]`). The
host gets the same content box and inherited styles as the canvas, sits
exactly on top of it, and is invisible (`filter: opacity(0)`, so drawn
elements still count as visible to `checkVisibility({ opacityProperty: true })`,
as natively). Only elements with geometry are hit-testable.

Like native Chromium, each direct child is laid out on its own at the
content-box origin. Children overlap, their width shrinks to fit, and
percentages resolve against the canvas content box. The polyfill does this
by positioning each child absolutely at the host origin. As a result:

- The computed `position` of a direct child reads `absolute`, where native
  reads `static`, and authored `position`, offsets and `float` are ignored.
- A direct child is the containing block for its absolutely positioned
  descendants.
- The host's filter makes it the containing block for `position: fixed`
  descendants too: they're placed against the canvas content box, not the
  viewport, and clipped to it.

Consequences of the move:

- The canvas's `class` attribute is mirrored onto the host, so selectors
  such as `.chart .label` still match. Selectors that name the canvas
  element or its id (`canvas > .item`, `#chart .item`) no longer match.
- `canvas.children`, `firstElementChild`, `lastElementChild`,
  `childElementCount`, `querySelector()` and `querySelectorAll()` list the
  moved children. A moved child's `parentElement` is the canvas, and
  `closest()` from inside the host continues from the canvas, so
  `el.closest('canvas')` finds it. Node-level reads (`childNodes`,
  `firstChild`, `parentNode`, `contains()`) see the real tree.
- Children are moved with `moveBefore()` where available, so focus, iframes
  and animations survive the move. Content moved into the canvas is adopted
  on the next mutation callback, or immediately when it's passed to
  `updateElementGeometry()`.
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
explainer says it should. As natively, `getComputedStyle()` doesn't: it
reports the authored `transform`, `z-index`, `position`, `clip-path`,
`pointer-events` and related properties of elements with geometry. Those
authored values are read together, once per element per task, and read again
after any DOM change. A stylesheet edited through the CSSOM (`insertRule`,
`rule.style`) later in the same task isn't seen until the next task.

No stylesheet can override a declaration the page sets inline with
`!important`. When the page locks `transform` that way (Underglass does on its
layers, for example), the polyfill places the element with the individual
`translate`, `rotate` and `scale` properties instead. That covers any 2D
geometry without skew. When the page also locks one of those properties, or
the geometry is 3D or skewed, the element is not hit-testable
rather than hit in the wrong place. Locked `translate`, `rotate`, `scale` and
`transform-origin` are taken into account. The page's own inline declarations
are never changed.

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
- Uploads work in a worker that imports the worker entry, from an
  `ElementImage` transferred to it (see [Workers](#workers)).
- When snapshots taint canvases (see `getStatus().limitations`), uploads throw
  `SecurityError`. Such a snapshot can't reach a worker at all: browsers
  refuse to clone or transfer a non-origin-clean `ImageBitmap`, so posting it
  throws `DataCloneError` on the sending side.

## Workers

Natively, an `ElementImage` is `[Transferable]`: post it with
`postMessage(message, [image])` and the worker can draw it into an
`OffscreenCanvas` or upload it with WebGL or WebGPU, with no code of its own.
The polyfill's `ElementImage` is a script object, so the worker needs the
polyfill too:

```js
// worker.js (module worker)
import '@underglass/html-in-canvas-polyfill/worker';
// classic worker: importScripts('…/html-in-canvas-polyfill.worker.iife.js');
```

The worker entry revives received images and installs `drawElementImage` on
`OffscreenCanvasRenderingContext2D`, `texElementSubImage2D` on WebGL
contexts, `drawElementImageToTexture` on `GPUQueue`, and
`getElementImageDefaultSize` on `OffscreenCanvas`. It does nothing in a worker
with native support.

How it works: the main entry (and the worker entry) wrap `postMessage` on
`Worker`, `MessagePort`, `ServiceWorker`, `Client`, the window and the worker
global, and `structuredClone`. When the transfer list contains an
`ElementImage`, each one in the message is replaced by a plain *envelope*
that carries a clone of its snapshot bitmap and its sizes, and the source is
closed, as a native transfer detaches it. On the receiving side,
`MessageEvent.data` turns envelopes back into `ElementImage`s. Messages whose
transfer list has no `ElementImage` are passed through untouched, and are
not walked when received.

As natively:

- An `ElementImage` that isn't in the transfer list makes the post throw
  `DataCloneError`, and so does a closed or duplicated one. The image stays
  open.
- A transferred image is closed: drawing it throws `InvalidStateError`.
- Images arrive in objects, arrays, Maps and Sets at any depth, and an image
  that appears twice arrives as one object.
- Paths that clone without a transfer list throw `DataCloneError`, natively
  too: `BroadcastChannel` and `history.pushState` (tested), and IndexedDB,
  which uses the same structured clone.
- An `ElementImage` is a snapshot from capture time; the caret doesn't blink
  in it.

Differences:

- A worker without the worker entry receives the envelope instead: a plain
  object `{ __hicElementImage: 1, bitmap, width, height, cssWidth,
  cssHeight, defaultWidth, defaultHeight }` with an `ImageBitmap` it can draw
  with `drawImage`, and the top-level message object gains
  `__hicElementImage: 2`. It has no `close()`.
- As natively, an `ElementImage` is only drawn, uploaded with WebGL, or sized
  with `getElementImageDefaultSize` by the canvas it was captured from (or
  the `OffscreenCanvas` transferred from it); others throw
  `InvalidStateError`. The polyfill can't check this for an image received
  from another thread, so a worker accepts any canvas. Native WebGPU uploads
  also need that canvas to have a rendering context; the polyfill doesn't
  check that.
- Geometry from a worker doesn't reach the main thread yet:
  `updateElementGeometry`, `clearElementGeometry` and the automatic geometry of
  `drawElementImage` in a worker do nothing. Set geometry on the main thread
  with `canvas.updateElementGeometry`, as Underglass does. See
  [WORKERS.md](WORKERS.md#phase-2-geometry-from-a-worker) for the plan.
- A transfer copies the snapshot. Natively it moves it. Posting eight
  400×300 snapshots blocks the sender for about 9 ms in Chromium, 1 ms in
  Firefox and 1–2 ms in WebKit.
- `window.postMessage` to a frame, and `ServiceWorker`/`Client` messages, revive
  images only where the polyfill is installed.
- `ReadableStream`/`WritableStream` chunks and other transfer paths that don't
  go through `postMessage` or `structuredClone` aren't covered.

## Snapshots

Each `drawable` element is serialized into an SVG `foreignObject` with inlined
computed styles, fonts, images, and form state, then decoded into an
`ImageBitmap`. In practice:

- Snapshots are asynchronous. A drawn image lags DOM changes by two or three
  frames (about 35–50 ms for a 40-element panel), where native paints in
  the same frame. Drawing before the first `paint` throws, as in native.
- Drawables that change together are painted together, as natively: a
  `paint` waits for every snapshot that started in the same frame. A small
  drawable that changes along with a large one therefore appears when the
  large one is ready.
- Serialization costs about 5–50 ms for complex trees: fine for forms, menus,
  and labels, not for animating large subtrees every frame. It grows with the
  number of elements in the drawable (about 1 ms per element in Chromium), not
  with the size of the change.
- A running CSS animation or transition is drawn natively every frame. Here,
  captures that only follow it wait three times the last capture's cost, so
  they use about a quarter of the main thread. A small drawable still updates
  every frame, while a spinner inside a 500-element panel updates about once a
  second. Its end state, and any other change, is captured at once. Keep
  endless animations in a drawable of their own to draw them smoothly.
- Changes are detected with MutationObserver, ResizeObserver, input, change,
  focus, pointer, scroll, load, CSS transition/animation events, and
  `document.fonts`. Changes those can't see (animations started with
  `element.animate()`, pixels of a nested canvas) aren't picked up until
  something else changes. `requestPaint()` fires `paint` but doesn't take
  new snapshots; to force one, change an attribute on the element.
- The selection highlight and the caret are drawn, using `::selection`
  colors (or the `Highlight` system color) and `caret-color`. The caret
  blinks every 500 ms while the document has focus, firing `paint` on each
  blink, like native. Only the first selection range is drawn; selections
  inside shadow trees and IME composition aren't. Selections in a text
  control are measured on a hidden copy of its text and blended over it;
  that ignores transforms between the control and the drawn element.
- Text inputs are drawn at their horizontal scroll position. Password inputs
  are drawn as dots, without putting the value in the snapshot. Textareas are
  drawn unscrolled; indeterminate checkboxes and file inputs' chosen file names
  aren't drawn.
- `:hover` and `:active` are drawn for elements with geometry, because
  pointer events take new snapshots. `:active` set from the keyboard (Space
  on a button) isn't, and neither is `:active` that ends when the pointer is
  released outside the canvas.
- A pointer moving inside a drawable takes a new snapshot only when a `:hover`
  rule now matches a different set of elements in the drawable or its
  ancestors. Moves over elements that no `:hover` rule targets cost
  nothing. Every move takes a snapshot when the page's rules can't be read:
  cross-origin stylesheets without CORS, nested CSS or `@scope` rules that
  use `:hover`, `:host`/`::part`/`::slotted` with `:hover`, or shadow roots
  inside the drawable. A `:hover` rule inserted into an existing `@media` or
  `@layer` block is only noticed when the stylesheet's top-level rule count
  changes.
- Snapshots don't read properties that can't change a still image
  (animations, transitions, scrolling, cursor, pointer and caret properties),
  or SVG-only properties on HTML elements.
- Snapshots are incremental ([INCREMENTAL.md](INCREMENTAL.md)). An element
  whose style can't have changed since the last snapshot reuses its
  declarations, and only its sizes and positions are read again. A DOM
  change, a state pseudo-class or `:has()` matching differently, a running
  animation, or a query container changing size re-reads the affected
  elements; a stylesheet, viewport, font or ancestor change re-reads them all.
  Some changes take no new snapshot at all, with or without reuse: a
  stylesheet edited in place through the CSSOM (`rule.style.color = …`), a
  media query that flips without a resize (`prefers-color-scheme`), or a
  change to an ancestor's sibling that a selector depends on
  (`.open ~ main .card`). They're drawn when something else takes one. That
  snapshot may still reuse the stale style, but the reused elements are
  re-read in idle time afterwards (a few milliseconds at a time), and a
  difference takes a new snapshot, usually within a second.
  `install({ incremental: false })` reads every element in full.
- An attribute change on an element that contains a canvas (a theme class
  on a wrapper, for example) takes new snapshots of that canvas.
- Cross-origin images and fonts without CORS are left out. Iframes and
  `<video>` render empty. A `<canvas>` inside a drawable is copied when the
  snapshot is taken (skipped if tainted), and isn't re-copied when only its
  pixels change.
- Open shadow roots are drawn, with slotted content. Closed shadow roots
  can't be read, so their host's light children are drawn instead. Rules for
  opaque pseudo-elements (below) are only copied from document stylesheets.
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
| WebGPU tests | Pass | Pass, except the jelly slider: WebKit's WGSL-to-Metal compiler rejects its shaders | Skipped: Playwright's Firefox has no WebGPU adapter, even with `dom.webgpu.enabled` |

The path from SVG to bitmap is chosen by a feature test, not by user-agent
sniffing. If both paths taint the canvas, `limitations` says so.

On Linux, WebKitGTK resolves generic font families (`sans-serif`, …) inside
the snapshot to a different font than the page uses, so text in that port can
be wider or narrower than the live DOM. Safari on macOS is not affected. CI
runs on GPU-less Linux runners: WebGL and WebGPU tests skip when the browser
has no usable adapter, and text-heavy pixel budgets are looser there.
