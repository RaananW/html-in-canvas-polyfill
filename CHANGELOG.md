# Changelog

All notable changes to `@underglass/html-in-canvas-polyfill`. The polyfill
does nothing in browsers with native HTML-in-Canvas support, so these changes
only affect browsers without it.

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
