# Changelog

All notable changes to `@underglass/html-in-canvas-polyfill`. The polyfill
does nothing in browsers with native HTML-in-Canvas support, so these changes
only affect browsers without it.

## Unreleased

### Breaking

- **Worker messaging is opt-in in the main entry.** The `postMessage`,
  `structuredClone` and `MessageEvent.data` wrappers that let an
  `ElementImage` cross to a worker moved to
  `@underglass/html-in-canvas-polyfill/messaging`. A page that posts
  ElementImages, or receives them back, now imports it next to the main
  entry. It can come before or after `install()`. Without it, transferring
  an `ElementImage` throws `DataCloneError`. `/auto` and the script-tag
  build include it, so pages using those change nothing.
- The main entry is 21.59 KB min+gzip without messaging. With it, as `/auto`
  ships it, it's 22.69 KB.

### Changed

- **Smaller.** The main entry is 22.58 KB min+gzip, down from 23.46 KB, and
  the worker entry 3.43 KB, down from 3.69 KB. Nothing it does changed:
  - the build targets ES2022, which the polyfill already needed at run time
    (`Object.hasOwn`), so class fields are no longer rewritten into helper
    calls;
  - internal class members are `#private`, so minifiers shorten their names;
  - snapshot warnings nothing read, and duplicated code (error messages,
    selection helpers, message walkers), are gone.

## 0.4.0 (2026-11-08)

### Changed

- **Snapshots are incremental.** An element whose style can't have changed
  since the last snapshot reuses its declarations, and only its sizes,
  margins and padding (plus insets, transforms and grid tracks where they can
  have changed) are read again. Before, every snapshot read about 380
  computed properties of every element in the drawable, whatever changed.
  The cost now follows the size of the change, not the size of the drawable.
  See [docs/INCREMENTAL.md](docs/INCREMENTAL.md).
- An element is read in full again when:
  - a DOM change touches it, an ancestor, or (with `+`/`~` in the page's
    CSS) a preceding sibling;
  - a state pseudo-class (`:hover`, `:focus`, `:checked`, …) or `:has()`
    matches it differently;
  - it's animated, and when its animation starts and ends.

  Everything is read again when stylesheets, the viewport or fonts change,
  when an ancestor outside the canvas changes, or when a query container
  changes size.
- **Reused styles are re-checked in idle time.** After a snapshot, the
  elements it reused are re-read a few milliseconds at a time, and a
  difference takes a new snapshot, usually within a second. This catches
  changes no rule sees, such as a stylesheet edited in place through the
  CSSOM.
- **Results** in Chromium, over the workloads in `bench/` (`pnpm bench`),
  against 0.3.0:
  - one row of a 1,000-row list changing: longest snapshot 338 → 68 ms,
    input to paint 344 → 144 ms;
  - typing into a 40-field form: snapshot time 1,460 → 264 ms, input to
    paint 99 → 40 ms;
  - hovering and clicking a 300-button grid: 4,248 → 1,059 ms;
  - a click in Underglass's Strata gallery (one 502-element layer): longest
    snapshot 246 → 86 ms, click to paint 242 → 56 ms (median).

  Firefox and WebKit improve by similar factors: typing 1,818 → 341 ms and
  645 → 169 ms, the list 4,006 → 696 ms and 3,025 → 679 ms. Changes that
  touch everything, such as a theme switch, cost about what they did.
- The main entry is 23.46 KB min+gzip, up from 20.94 KB.

### Added

- `install({ incremental: false })` turns reuse off and reads every element
  in full, to rule it out when a drawing looks stale.
- Each snapshot is an `html-in-canvas snapshot` user timing, visible in the
  browser's performance panel. Its `detail` gives the elements read in full
  and reused: `{ read, reused }`.

### Fixed

- An attribute change on an element that contains a canvas, such as a theme
  class on a wrapper, takes new snapshots of that canvas. It used to be drawn
  only once something inside the canvas changed.

### Known limitations

- Some changes still take no snapshot of their own, with or without reuse: a
  stylesheet edited in place through the CSSOM, a media query that flips
  without a resize (`prefers-color-scheme`), or a change to an ancestor's
  sibling that a selector depends on. They're drawn when something else takes
  a snapshot.

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
