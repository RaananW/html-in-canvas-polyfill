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
| `CanvasRenderingContext2D.drawElementImage` (all overloads) | Full. Returns `undefined`, as in the spec (native Chromium returns a `DOMMatrix`). `preserveElementGeometry` is accepted and ignored until geometry lands. |
| `captureElementImage()`, `ElementImage` | Full on the main thread. `ElementImage` can't be transferred to workers. |
| `getElementImageDefaultSize()` | Full (not yet shipped in native Chromium 156). |
| `OffscreenCanvasRenderingContext2D.drawElementImage` | `ElementImage` sources only. |
| `updateElementGeometry`, `clearElementGeometry`, `getElementTransform`, `elementgeometryupdate` | Not implemented (phase 2). |
| `texElementSubImage2D`, `drawElementImageToTexture` | Not implemented (phase 3). |

## How content is laid out

Native browsers lay out canvas children in place. The polyfill can't, so it
moves the children into a sibling *host* element (`div[data-hic-host]`). The
host gets the same content box and inherited styles as the canvas, sits
exactly on top of it, and is invisible (`opacity: 0`) and not hit-testable.

Consequences:

- Selectors such as `canvas > .item` no longer match, and
  `child.parentElement` is the host, not the canvas.
- Frameworks that own the canvas children (React, Vue, …) will fight the
  move. Use *authoring mode* instead: render the children into your own
  `<div data-hic-host>` immediately after the canvas. The polyfill then lays
  out that element and leaves the DOM alone. When there's more than one
  candidate, `data-hic-host="<canvas id>"` selects the canvas.
- Children are focusable and in the tab order, but they don't receive pointer
  events. Native browsers behave the same way until element geometry is set,
  which the polyfill doesn't support yet.
- `uninstall()` moves the children back into the canvas.

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
| Strata components vs live DOM (mismatched pixels) | 0.03% | 0.67% | Not measured yet |

The path from SVG to bitmap is chosen by a feature test, not by user-agent
sniffing. If both paths taint the canvas, `limitations` says so.
