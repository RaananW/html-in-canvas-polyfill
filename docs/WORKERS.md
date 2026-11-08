# ElementImage in workers

Natively, an `ElementImage` from `canvas.captureElementImage(element)` can be
posted to a worker in a transfer list. The worker draws it into an
`OffscreenCanvas` with `drawElementImage`, or uploads it with
`texElementSubImage2D` or `GPUQueue.drawElementImageToTexture`. This page
records how the polyfill emulates that, what native Chromium does, and the
plan for the part that isn't done yet: geometry from a worker.

User-facing behavior and differences are in
[LIMITATIONS.md](LIMITATIONS.md#workers).

## Native behavior

Measured in Chromium 156.0.8078.4 (Playwright's build, with
`--enable-blink-features=CanvasDrawElement`) and Chrome Canary 159.0.8149.0
(with `CanvasDrawElement,ElementCanvasTransform` and experimental web
platform features). The explainer declares
`[Exposed=(Window,Worker), Transferable] interface ElementImage { close(); }`.

| | Chromium 156 | Canary 159 |
|---|---|---|
| Transfer to a worker, a `MessagePort`, a window, or with `structuredClone` | Arrives as an `ElementImage` | Same |
| The source after a transfer | Closed: `width` is 0, drawing throws `InvalidStateError: The ElementImage has been closed.` | Closed (no `width`) |
| Clone without a transfer list (`postMessage`, `structuredClone`, `BroadcastChannel`, `history.pushState`) | `DataCloneError: An ElementImage could not be cloned.` | Same |
| Transfer a closed image | `DataCloneError: An ElementImage is closed and could not be cloned.` | Same |
| An image in the transfer list but not in the message | Detached | Same |
| `ElementImage.width` / `height` | Present (grid pixels) | Absent, as in the explainer |
| Draw into the transferred `OffscreenCanvas` in the worker | Works | Works |
| Draw into any other canvas, main thread or worker | `InvalidStateError: The source was captured from a different canvas.` (the closed check comes first) | Same |
| `drawElementImageToTexture` in a worker | Works when the canvas the image was captured from has a rendering context; otherwise `InvalidStateError: No context found for ElementImage.` Any device | Same |
| `OffscreenCanvas.getElementImageDefaultSize` in a worker | Missing | Works |
| `OffscreenCanvas.updateElementGeometry(image, …)` in a worker | No effect | Moves the element's hit region on the main thread |
| `drawElementImage` returns | `DOMMatrix` | `undefined` |

Underglass meets the rendering-context rule because its worker configures
WebGPU on the canvas it was transferred, and the images come from that
canvas.

## How the polyfill does it

The polyfill's `ElementImage` is a script object, so structured clone would
copy it as `{}` and lose its snapshot.

- **Sending.** The messaging entry (on the page) and the worker entry wrap `postMessage` on
  `Worker`, `MessagePort`, `ServiceWorker`, `Client`, the window and the
  worker global (the last two are own properties of the global), and
  `structuredClone`. When the transfer list holds an `ElementImage`, the
  message is copied with each `ElementImage` replaced by an *envelope*:
  `{ __hicElementImage: 1, bitmap, width, height, cssWidth, cssHeight,
  defaultWidth, defaultHeight }`. The walk covers objects (class instances
  too, as clone does), arrays, Maps and Sets, keeps cycles and shared
  references, and leaves typed arrays, buffers and platform objects alone.
  The top-level copy gets `__hicElementImage: 2`. After a successful post the
  sources are closed; a failed post leaves them open, as native.
- **The bitmap is cloned, not transferred,** because the canvas keeps the
  snapshot to draw it again. Images of the same snapshot share one bitmap
  clone and, on arrival, one ref-counted record, so closing one doesn't
  detach the other.
- **Not cloneable, as natively.** Every polyfill `ElementImage` has an
  enumerable own property holding a symbol, so cloning it anywhere the
  polyfill doesn't wrap (`BroadcastChannel`, IndexedDB, `history.pushState`)
  throws `DataCloneError`, as natively. The wrapper therefore only walks
  messages whose transfer list has an `ElementImage`.
- **Receiving.** `MessageEvent.prototype.data` is wrapped: on first read, a
  message flagged `2`, an envelope, or a top-level Map or Set is walked and its
  envelopes replaced by `ElementImage`s, in place; the flag is removed. The
  result is cached per event. Other messages are returned untouched.
- **Drawing and uploading** reuse `src/contexts/*`. The DOM-free part of
  2D drawing is in `contexts/draw.ts`; WebGL and WebGPU take a resolver
  (`texElementSubImage2DWith`, `drawElementImageToTextureWith`): the main
  thread's resolves elements and images, the worker's only images.
  `rasterize` uses an `OffscreenCanvas` where there is no `document`.
- **The messaging entry** (`@underglass/html-in-canvas-polyfill/messaging`)
  holds the page side, so pages that never post an `ElementImage` don't load
  it. It registers with the main entry (`src/extensions.ts`): its wrappers
  are applied by `install()`, or at once when it's imported after it, and
  `uninstall()` removes them. `/auto` and the script-tag build register it
  themselves. Without it, the transfer list holds a plain object, and posting
  throws `DataCloneError` in every browser.
- **The worker entry** (`@underglass/html-in-canvas-polyfill/worker`, or
  `html-in-canvas-polyfill.worker.iife.js` for classic workers) installs
  this. It does nothing in a worker with native support, and `install({
  force: true })` overrides that for testing.

## Spike results

What works, in tests that run the same code against native Chromium 156 and
Canary 159 (`tests/browser/worker.spec.ts`, 13 tests):

- Transfer to a worker, back to the page, through a `MessageChannel` and with
  `structuredClone`; nested in objects, arrays, Maps (keys and values), Sets
  and cycles, with identity kept. The source is closed.
- `DataCloneError` for clones (eight cases across `Worker` and `MessagePort` `postMessage`, `structuredClone`, `BroadcastChannel`, `window.postMessage` and `history.pushState`), closed images and duplicates.
- Drawing in the worker's transferred `OffscreenCanvas`, all overloads, pixels
  checked.
- WebGL 2 `texElementSubImage2D` in the worker, pixels checked.
- WebGPU `drawElementImageToTexture` in the worker, in the message shape
  Underglass sends (`{ type: 'frame', images: [{ slot, width, height, image }] }`
  and `queue.drawElementImageToTexture({ source: image.image }, { texture })`),
  whole and cropped, pixels read back.
- A worker without the worker entry receives the envelope.

On Windows, with Playwright 1.64, across the chromium, webkit, firefox,
native and canary projects, 59 runs pass and 6 skip. The skips are the
polyfill-only test on native and Canary, Firefox's missing WebGPU adapter in
workers, and WebKit, whose Windows build has no `OffscreenCanvas`. WebGPU in a
worker ran in polyfilled Chromium, Chromium 156 and Canary 159.

What doesn't, or differs:

- **The page must import the messaging entry** (or use `/auto` or the script
  tag). Natively it needs nothing.
- **The worker must import the worker entry.** Natively it needs nothing.
  Without it, it receives envelopes. Underglass's worker would reject them
  (`validateWorkerFrame` requires `image.close`), which fails loudly rather
  than drawing nothing.
- **A transfer copies pixels.** Posting eight 400×300 snapshots blocks the
  sender for a median of 9 ms in Chromium, 1 ms in Firefox and 1–2 ms in
  WebKit. For eight raw 400×300 bitmaps, Chromium clones in 5.5 ms but copies
  through an `OffscreenCanvas` and transfers in 0.4 ms; Firefox is the
  reverse (1 ms vs 3 ms). The clone is kept because it is the cheapest
  path in Firefox and WebKit, where the polyfill matters most, and needs no
  `OffscreenCanvas`. Follow-ups: copy through an `OffscreenCanvas` in
  Chromium, or have the snapshot engine make a spare bitmap, off the post
  call, for canvases that call `captureElementImage`, so a transfer can move
  it.
- **Tainted snapshots can't be sent.** Chromium (`Non-origin-clean ImageBitmap
  cannot be cloned/transferred`) and Firefox refuse to clone or transfer a
  non-origin-clean `ImageBitmap`, and so do copies drawn through an
  `OffscreenCanvas`. Posting a tainted snapshot therefore throws
  `DataCloneError` on the sender, and its pixels never reach the worker.
  Natively, snapshots are never tainted. In the browsers tested, the polyfill's
  snapshots aren't either.
- **No canvas checks in workers.** On the main thread the polyfill throws
  "captured from a different canvas" as natively. A received image carries
  no canvas, though, because a worker can't tell which canvas a transferred
  `OffscreenCanvas` came from without changing what an unpolyfilled worker
  receives. So workers accept any canvas, and nobody checks WebGPU's "No
  context found".
- **`width` and `height`** are kept, as in Chromium 156.
- **Geometry from a worker** does nothing yet; see below.

Cost of the wrappers, measured with the polyfill installed and uninstalled:
`postMessage` without an `ElementImage` costs the same (0.5–2 µs per call in
all three browsers). Receiving a 100,000-object message, a 1M-number array
or a 16 MB `Float32Array` reads `event.data` in the same time with and without
the polyfill. Before the top-level flag, the 100,000-object message took 9 ms
(Chromium) to 26 ms (Firefox) longer.

Size: the main entry grows from 17.91 KB to 19.29 KB min+gzip (1.25 KB for
`transfer.ts`, 0.13 KB for the context refactor and the new limitation
text), over the 18 KB budget. The budget is raised to 19.5 KB rather than
squeezing other code. The worker entry is 3.67 KB, with a 4 KB budget.

## Phase 2: geometry from a worker

Natively (Canary 159), `offscreen.updateElementGeometry(image, options)` in a
worker moves the element's hit region on the main thread. The explainer
batches worker updates in a microtask, posts them to the main thread, applies
them there, and fires `elementgeometryupdate` on the placeholder canvas.
`drawElementImage` into a 2D `OffscreenCanvas` does the same automatically,
unless `preserveElementGeometry` is set.

Underglass doesn't need this: it calls `canvas.updateElementGeometry(element,
…)` on the main thread before each transfer and checks it with
`validateAppliedGeometry`. It's still needed for the explainer's own
OffscreenCanvas example.

Plan:

1. **Identity in the envelope.** The main thread gives each element it sends
   an id (a `Map<number, WeakRef<Element>>`, pruned on a miss) and adds
   `element: id` and `channel: id` to the envelope. Envelopes re-encoded in a
   relay worker carry both on, so an image keeps its origin however it
   travels.
2. **One geometry port per destination.** The first transfer to a given
   `Worker` or `MessagePort` creates a `MessageChannel`, keeps one end, and
   puts the other in that envelope (`port`) and in the transfer list. Later
   envelopes only name the channel. The receiving realm keeps
   `Map<channel, MessagePort>`. A port per image would cost a channel per
   frame.
3. **Worker side.** The worker's `OffscreenCanvas.updateElementGeometry` and
   `clearElementGeometry` queue `{ element, transform, clip,
   preserveHitTestOrder }` (or a clear) and post the batch over the channel
   in a microtask. `drawElementImage` queues the grid-pixel matrix from
   `drawMatrix(ctx.getTransform(), …)` (`geometry/matrix.ts` is already
   DOM-free) with the canvas grid size, since only the main thread knows the
   content box.
4. **Main side.** The channel's handler maps ids to elements, converts grid
   matrices with `gridToCanvas` against the element's canvas, applies the
   batch through `queueOffscreenGeometry`, and fires `elementgeometryupdate`
   with the elements that still exist. The canvas is the element's nearest
   canvas. Natively it's the `OffscreenCanvas`'s placeholder, but those are
   the same canvas whenever the native canvas check passes.
5. **Tests.** Worker `updateElementGeometry`/`clearElementGeometry` and
   automatic draw geometry move `getBoundingClientRect` and
   `elementFromPoint` on the main thread, and fire one batched event, checked
   against Canary 159. Chromium 156 doesn't move hit regions for
   `canvasTransform`, so it can't be the oracle.

Expected cost: about 0.4 KB on the main entry and 0.5 KB on the worker entry.
