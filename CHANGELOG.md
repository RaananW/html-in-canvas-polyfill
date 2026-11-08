# Changelog

All notable changes to `@underglass/html-in-canvas-polyfill`. The polyfill
does nothing in browsers with native HTML-in-Canvas support, so these changes
only affect browsers without it.

## 0.3.0 (2026-11-08)

### Changed

- **An `ElementImage` is only drawn into the canvas it was captured from**,
  as natively. Drawing it with `drawElementImage` into another canvas or
  `OffscreenCanvas`, uploading it with WebGL `texElementSubImage2D`, or
  passing it to another canvas's `getElementImageDefaultSize` now throws
  `InvalidStateError: The source was captured from a different canvas.` The
  `OffscreenCanvas` transferred from the capture canvas counts as the same
  canvas. WebGPU uploads aren't checked, as natively, and neither are images
  received from another thread.
- **The host is hidden with `filter: opacity(0)` instead of `opacity: 0`**, so
  drawn elements are visible to `checkVisibility({ opacityProperty: true })`,
  as natively. As a side effect, `position: fixed` descendants of drawn
  elements are placed against the canvas content box instead of the viewport.
- **Drawables that change together are painted together**, in one `paint`
  event, as natively. A `paint` now waits for every snapshot that started in
  the same frame, so a small drawable that changes along with a large one
  appears when the large one is ready.
- **`getComputedStyle` on elements with geometry is cheaper.** The authored
  geometry properties (`transform`, `position`, `z-index`, …) are read
  together, once per element per task, and read again after any DOM change.
  On the Underglass compare demo in Chromium, that time drops from 199–314 ms
  to 23–38 ms over a fixed pointer path. A stylesheet edited through the
  CSSOM later in the same task isn't seen until the next task.
- The main entry is 20.94 KB min+gzip, up from 20.24 KB.

### Fixed

These made Underglass's Strata gallery draw differently from native; with
them, every Strata tab matches native to within 0.1% of its pixels.

- Radios styled with `appearance: none` and `border-radius: 50%` are drawn
  round, disabled fields keep their page background, and nested lists keep
  `list-style-type: none`. UA defaults are now read in the element's own
  state (`:disabled`, `appearance`) and context (a list inside a list).
- Sizes are written in the engine's layout unit (1/64 px in Blink and WebKit,
  1/60 px in Gecko), so a shrink-to-fit row no longer wraps its last item.
- A table with a caption sizes from its rows, instead of spreading the
  caption's height over them in Blink and WebKit.
- The test "hover and active states are drawn, including on enclosing
  drawables" no longer fails intermittently in WebKit; it was the paint
  ordering above.

## 0.2.0 (2026-11-08)

### Added

- **`ElementImage` in workers.** An `ElementImage` from
  `canvas.captureElementImage()` can be transferred with
  `postMessage(message, [image])` or `structuredClone(value, { transfer })`,
  as natively. A worker that imports `@underglass/html-in-canvas-polyfill/worker`
  (or loads `html-in-canvas-polyfill.worker.iife.js` with `importScripts`)
  receives it as an `ElementImage`. There it can draw it with
  `OffscreenCanvasRenderingContext2D.drawElementImage`, or upload it with
  `texElementSubImage2D` or `GPUQueue.drawElementImageToTexture`. Images can
  also go back to the page and through a `MessageChannel`, and they arrive at
  any depth in objects, arrays, Maps and Sets. The transferred source is
  closed, as natively. See [docs/WORKERS.md](docs/WORKERS.md) and the Workers
  section of [docs/LIMITATIONS.md](docs/LIMITATIONS.md#workers).
- `OffscreenCanvas.getElementImageDefaultSize`, on the main thread and in
  workers.
- New package exports: `./worker` and `./worker/iife`.

### Changed

- **Hovering is much cheaper.** A pointer moving inside a drawable only takes
  a new snapshot when a `:hover` rule now matches different elements. Moves
  over elements that no `:hover` rule targets cost nothing. When the page's
  stylesheets can't be read (cross-origin without CORS, for example), every
  move still takes a snapshot, as before.
- **Snapshots read fewer styles.** Properties that can't change a still image
  (animations, transitions, scrolling, cursor, pointer and caret) and
  SVG-only properties on HTML elements are skipped: 21% fewer style reads in
  Chromium, 18% in Firefox, 24% in WebKit. Together, these two changes cut
  main-thread time by about two thirds while hovering over the Underglass
  compare demo in Chromium (7.3–8.1 s down to 2.7–2.9 s over a fixed pointer
  path), and long tasks from 42–69 to 0–2.
- **Cloning an `ElementImage` throws `DataCloneError`**, as natively, when it
  isn't in the transfer list. This covers `postMessage` without a transfer
  list, `structuredClone`, `BroadcastChannel`, IndexedDB and
  `history.pushState`. It used to clone silently as an empty object.
  Transferring a closed or duplicated `ElementImage` also throws
  `DataCloneError`.
- `ElementImage` instances have an enumerable own property, `__elementImage`,
  which makes them fail structured clone. `Object.prototype.toString` now
  reports `[object ElementImage]`.
- The main entry is 20.24 KB min+gzip, up from 17.91 KB. The worker entry is
  3.67 KB.

### Known limitations

- A worker that doesn't import the worker entry receives a plain object,
  `{ __hicElementImage: 1, bitmap, width, height, … }`, instead of an
  `ElementImage`.
- `updateElementGeometry`, `clearElementGeometry` and the automatic geometry
  of `drawElementImage` in a worker don't reach the main thread yet. Set
  geometry on the main thread with `canvas.updateElementGeometry`.
- A transfer copies the snapshot's pixels instead of moving them: about 9 ms
  for eight 400×300 snapshots in Chromium, 1–2 ms in Firefox and WebKit.
- The polyfill doesn't check that an `ElementImage` is drawn into the canvas
  it was captured from, or that a WebGPU upload's canvas has a rendering
  context. Native Chromium throws in both cases.

## 0.1.1 (2026-11-08)

### Fixed

- Elements whose `transform` the page locks inline with `!important` (as
  Underglass does on its layers) are placed for hit testing with the
  individual `translate`, `rotate` and `scale` properties.
- `VERSION` and the published status report the package version.
- Captures that only follow a running animation are paced by their cost, so
  they use about a quarter of the main thread.

## 0.1.0 (2026-11-05)

First release: `content="drawable"`, `paint` and `requestPaint()`,
`drawElementImage`, `captureElementImage` and `ElementImage`,
`getElementImageDefaultSize`, element geometry, `texElementSubImage2D` and
`GPUQueue.drawElementImageToTexture` in Chromium, WebKit and Firefox, checked
against native Chromium.
