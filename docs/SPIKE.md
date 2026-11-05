# Phase 0 spike: foreignObject snapshots

**Decision:** we write our own serializer and take no runtime dependency on
`modern-screenshot` or `html-to-image`.

**Status:** Chromium (flag off), WebKit, and native Chromium (flag on) were
measured. **Firefox is pending.** Playwright's Firefox could not start from
the agent environment, because macOS app-data protection blocks
`~/Library/Application Support/Firefox`. To measure it, run the command under
[Reproduce](#reproduce) with `BROWSERS=firefox` and add the results to this
document.

## Method

`spike/` is a self-contained harness and is not part of the published
package.

- `spike/src/serializer.ts` is a prototype serializer, about 3.9 KB
  min+gzip. It does the following:
  - Clones the subtree.
  - Inlines computed styles as a diff against UA defaults and the parent.
    Only standard property names are enumerated, plus custom properties
    referenced by copied rules.
  - Copies pseudo-elements: `::before`/`::after` are rebuilt from computed
    style. Opaque ones (`::-webkit-slider-thumb`, `::marker`, …) are copied
    as the matching stylesheet rules, verbatim.
  - Carries form state and scroll offsets.
  - Inlines `@font-face` rules (recursing into `@layer` and `@media`) and
    images as data URLs.
- The output is an SVG `<foreignObject>`. The pipeline is: `img.decode()`,
  then an `ImageBitmap`, then an upload to 2D, WebGL, and WebGPU (each
  checked for taint).
- The serializer is compared with `modern-screenshot` 4.7.0 and
  `html-to-image` 1.11.13.
- **Truth:** a Playwright element screenshot of the live DOM. **Diff:**
  pixelmatch with threshold 0.1; the number is the percentage of
  differing pixels.
- **Fixtures:**

  | Fixture | Contents |
  |---|---|
  | `fx-text` | web font, text effects |
  | `fx-form` | typed, checked, and selected state; a range input; a textarea |
  | `fx-box` | shadows, gradients, radii, transforms |
  | `fx-images` | same-origin, data-URL, and no-CORS cross-origin images |
  | `fx-large` | about 1,500 nodes, scrolled |
  | `fx-strata` | the [Underglass](https://github.com/RaananW/underglass) **Strata** design system (`@underglass/ui`): buttons, badge, chip, switch, checkbox, text field, slider, progress, segmented control, display, meter. It has about 300 global custom properties and relies on `@layer` and opaque pseudo-elements. |

- Each fixture runs at DPR 1 and 2. Latency is the cold run and the median
  of the warm runs.

### Reproduce

```sh
cd spike
pnpm install
pnpm exec playwright install chromium webkit firefox
node build.mjs
BROWSERS=chromium,webkit,firefox,native node run.mjs   # results/results-*.json, PNGs + diffs
node montage.mjs results/webkit-dpr1 truth own-data-img own-data-img-diff
node size.mjs
```

## Results

### Taint and GPU upload

| Path | Chromium | WebKit 27.2 |
|---|---|---|
| data URL → `createImageBitmap(img)` | **tainted** | clean |
| data URL → `drawImage` to canvas → `createImageBitmap(canvas)` | clean | clean, but shadows render darker (see below) |
| blob URL (either path) | tainted | tainted |
| `texImage2D` / `copyExternalImageToTexture` from a clean bitmap | ok / ok | ok / ok |

Recommended pipeline: always use a **data URL**, never a blob URL.

- **Chromium:** go through an intermediate canvas.
- **WebKit:** use `createImageBitmap(img)` directly.

Pick the path by feature test: try the direct bitmap and check whether it is
tainted. Don't sniff the user agent.

### Fidelity and latency (own serializer, recommended path, warm)

| Fixture | Chromium dpr1 | Chromium dpr2 | WebKit dpr1 | WebKit dpr2 | Chromium warm | WebKit warm |
|---|---|---|---|---|---|---|
| text | 0% | 0% | 0.01% | 0.34% | 8 ms | 9 ms |
| form | 0.28% | 0.42% | 4.03%¹ | 4.59%¹ | 9 ms | 12 ms |
| box | 0% | 0% | 0.42% | 0.48% | 2.5 ms | 3 ms |
| images | 7.05%² | 7.25%² | 7.05%² | 7.25%² | 3 ms | 4 ms |
| large (~1,500 nodes) | 0.49% | 0.27% | 0% | 0.75% | 95–105 ms | 108 ms |
| strata | 0% | 0% | 0.15% | 0.88% | 30 ms | 35 ms |

¹ WebKit draws form controls inside an SVG image without the platform theme:
no accent colour, and a flat range input and select. A bare checkbox
reproduces this, so it is an engine limitation.
² The no-CORS cross-origin image is omitted on purpose. Native
`drawElementImage` omits it too (`vsOwn` = 0%).

### Libraries (DPR 1, warm)

| Fixture | modern-screenshot, Chromium | modern-screenshot, WebKit | html-to-image, Chromium | html-to-image, WebKit |
|---|---|---|---|---|
| form | 3.45%, 33 ms | 5.66%, 51 ms | 5.53%, 38 ms | 6.25%, 49 ms |
| box | 4.54%, 32 ms | 7.83%, 145 ms | 3.23%, 16 ms | 4.87%, 22 ms |
| images | 7.05%, 22 ms | 7.05%, 556 ms | **error** | **error** |
| large | 0.49%, 545 ms | 0%, 1,023 ms | 1.37%, 971 ms | 2.37%, 1,140 ms |
| strata | 3.05%, 157 ms | 15.97%, 1,395 ms | 3.25%, 184 ms | 15.81%, 201 ms |

Both libraries have these problems:
- They lose checkbox, radio, select, or textarea state, scroll offsets, and
  opaque pseudo-element styling.
- They are 5–40× slower on the token-heavy Strata page.
- html-to-image rejects the whole snapshot when one image fails.

**Size (min+gzip):** own 3.9 KB, modern-screenshot 8.6 KB, html-to-image
5.0 KB.

### Native API (Chromium 156, `--enable-blink-features=CanvasDrawElement`)

- Supported: `content="drawable"` / `layoutsubtree`, `paint` after
  `requestPaint()`, and `ctx.drawElementImage(el, x, y)`.
- Native output matches the DOM: 0% on every fixture except `box`, which is
  about 1% at the shadow edges. It is within 0–0.5% of our snapshot.
- `drawElementImage` already maps CSS pixels to the canvas grid. Callers must
  not apply `ctx.scale(dpr)` themselves.
- The Strata page could serve as the Chrome-with-flag baseline for phase 5.
  Underglass itself detects native support with `"content" in canvas` and
  uses `drawElementImageToTexture`, which makes it a good end-to-end smoke
  test for phases 3 and 5.

## Gotchas found (inputs to phase 1)

Every item below caused a visible bug in the spike and is fixed in the
prototype serializer.

- **Values whose computed form depends on context:**
  - Border, outline, and column-rule widths compute to 0 when the style is
    `none`. Write the width whenever a visible style is written.
  - `min-width` and `min-height` compute `auto` to `0px` outside flex layout,
    so they are always written.
  - UA defaults differ by `<input type>`, so the defaults cache is keyed on
    tag plus type.
  - Inherited properties that the UA sheet resets on a tag (for example
    `font` on `button` and `input`) must be compared against that tag's UA
    default, not the parent's value.
- **WebKit, `viewBox`:** WebKit ignores `viewBox` scaling for
  `foreignObject` content and rasterizes it at 1×. Instead, scale with a CSS
  `transform: scale(dpr)` on the inner wrapper.
- **WebKit, fieldset height:** WebKit's computed `height` for `<fieldset>`
  excludes the rendered legend. Don't pin a fieldset's height.
- **WebKit, placeholder colour:** if `-webkit-text-fill-color` is written
  inline as the resolved `color`, it overrides `::placeholder`. Omit it when
  it equals `color`.
- **WebKit, darker shadows:** drawing the SVG image to a canvas renders
  shadows darker, probably an alpha-premultiplication problem. Use the direct
  bitmap path on WebKit.
- **Opaque pseudo-elements:** `getComputedStyle` cannot read them, so copy
  the matching stylesheet rules into the SVG `<style>`, after evaluating
  `@media` and `@supports`. A rule only matches if its ancestor context is
  inside the snapshot root.
- **Performance:** a design-system page carries hundreds of custom properties
  on `:root`. Enumerating every computed property made each snapshot about 3×
  slower. Read only the standard property names; computed values are already
  resolved from `var()`.
- **Harness note:** stylesheets must be served as `text/css`, or Chromium
  ignores them.

## Plan changes

- Phase 1 builds on `spike/src/serializer.ts` and adds the per-engine bitmap
  path above.
- New known limitations: WebKit form-control theming, and opaque
  pseudo-element rules that depend on ancestors outside the snapshot root.
- Phase 5 uses the Underglass/Strata fixture and the Underglass demo as smoke
  tests.
