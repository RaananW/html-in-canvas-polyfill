# Incremental snapshots: design

Status: step 1 of the plan (the cache and its invalidation rules) is
implemented; see [As implemented](#as-implemented-step-1). The idle re-check
(step 2) isn't yet. Measured on 0.3.0 with the benchmark in `bench/`
(`pnpm bench`).

## The problem

A snapshot reads every computed style of every element in the drawable,
diffs it against UA defaults and the parent, writes it onto a copy, and turns
the copy into an SVG image. In Chromium that costs about 0.75 ms per element,
and the cost follows the size of the drawable, not the size of the change.
Reading styles is about 70% of it.

Baseline (0.3.0, Windows; snapshots · main-thread time, longest · latency
median/max, ms):

| Workload | Layer | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| form-typing: 20 keys into one of 40 fields | 121 | 39 · 1460 (58) · 99/135 | 34 · 1818 (150) · 97/210 | 21 · 645 (36) · 48/69 |
| list-update: one row of 1,000, 10 times | 2,001 | 10 · 3164 (338) · 344/371 | 10 · 4006 (465) · 432/481 | 10 · 3025 (327) · 405/408 |
| grid-hover: 40 moves, 5 clicks, `:hover`/`:active` rules | 301 | 86 · 4248 (72) · 96/114 | 95 · 5496 (83) · 84/104 | 123 · 6595 (97) · 101/118 |
| theme-switch: all colours change | 301 | 6 · 326 (66) · 75/95 | 6 · 411 (82) · 97/108 | 6 · 373 (91) · 121/151 |
| large-transition: 300 ms transition, 3 clicks | 503 | 9 · 682 (88) · 114/114 | 6 · 600 (135) · 117/150 | 6 · 547 (105) · 117/130 |
| Underglass Strata: 5 toggle clicks | 503 | 10 · 2359 (246) · 242/258 | – | – |

Firefox and WebKit can't run the Underglass demos in Playwright: Underglass's
GPU mode needs WebGPU and `Element.moveBefore`, and Playwright's Firefox has no
WebGPU adapter, while its WebKit has neither.

## The idea

Keep, for each element of a drawable, what the last snapshot derived from its
computed style. On the next snapshot, re-read in full only the elements whose
style may have changed. For every other element, re-read only the properties
whose values come from layout, and reuse the rest.

## What is kept per element

- The element's declarations (the output of `diffStyle`, before URL
  inlining) without the layout properties below, and its pseudo-element rules.
- The values of the inherited properties, which children diff against
  (about 60 of the ~380), instead of the whole computed style. That bounds
  memory.
- What the element's UA default was read with (tag, `type`, `:disabled`,
  list nesting, `appearance`), so a change there counts as a change.

The cache belongs to the drawable's canvas state and is dropped with it. A
cache entry is used only by the same element in the same drawable.

## Always re-read: layout properties

`getComputedStyle` reports used values for these, so they change whenever
layout changes, anywhere: `width`, `height`, `inline-size`, `block-size`,
`margin-*`, `padding-*`, `top`/`right`/`bottom`/`left`, `inset-*`,
`transform`, `transform-origin`, `perspective-origin`,
`grid-template-columns`, `grid-template-rows`, and their logical forms. That's
about 30 properties per element, roughly 8% of a full read. Form state,
scroll offsets, text, selection and the caret are taken fresh too, as now.

## What makes an element re-read in full

Each rule below adds *dirty roots*. A dirty root and its whole subtree are
re-read, since children inherit from it.

1. **DOM changes inside the drawable**, from the MutationObserver the canvas
   state already has:
   - an attribute change on an element: the element. With sibling
     combinators (`+`, `~`) in the page's CSS, its following siblings too.
   - a child list change: the parent, which covers `:nth-child()`,
     `:empty`, `:first-child` and the like.
   - text changes: nothing beyond the layout properties.
2. **Selectors whose matches change without a DOM change.** These are the
   state pseudo-classes (`:hover`, `:active`, `:focus`, `:focus-visible`,
   `:focus-within`, `:checked`, `:indeterminate`, `:placeholder-shown`,
   `:valid`/`:invalid`, `:user-valid`, `:in-range`, `:target`, `:open`,
   `:popover-open`, `:modal`, `:autofill`, `:default`, `:fullscreen`,
   `:playing`/`:paused`, `:state()`) and `:has()`. At each snapshot, record
   which elements of the drawable and its ancestors match each such selector,
   as `src/snapshot/hover.ts` does for `:hover`. Every element whose match
   changed is a dirty root. Because `querySelectorAll` evaluates `:has()`
   itself, this covers `:has()` without treating it as "anything may change".
3. **Running animations and transitions:** each animation's target (the
   originating element for a pseudo-element).
4. **Everything is re-read** when:
   - the document's stylesheets change (a sheet added or removed, or a
     sheet's top-level rule count);
   - the viewport or the drawable's container size changes;
   - fonts finish loading;
   - an ancestor of the drawable outside it changes (an attribute change seen
     on the path to the document root);
   - the page uses container queries or container units;
   - a stylesheet can't be read (cross-origin without CORS);
   - the drawable holds shadow roots;
   - the canvas grid scale changes.

### What the rules select, measured

An in-page estimator applied these rules to every snapshot of the workloads
above (Chromium). Each cell is the number of elements re-read in full per
snapshot:

| Workload | Layer | Median | Max |
|---|---|---|---|
| form-typing | 121 | 0 | 0 |
| list-update | 2,001 | 1 | 1 |
| grid-hover | 301 | 2 | 2 |
| large-transition | 503 | 0 | 1 |
| theme-switch | 301 | 301 | 301 |
| Underglass compare hover | 66 | 0 | 0 |
| Underglass Strata clicks | 503 | 5 | 14 |

The theme switch re-reads everything, as it should. Treating `:has()` as "re-read
everything" instead of rule 2 would re-read 100% on both Underglass pages,
whose CSS uses it (Strata has 119 such selectors).

The signature for rule 2 is cheap. Strata has 223 state and `:has()`
selectors, and checking all of them against a 609-element subtree takes
2.3 ms, against 211 ms to read every style of that subtree once. Fluent: 284
selectors, 2.9 ms against 76 ms. Compare: 23 selectors, 0.2 ms against 47 ms.

## Safety net

The rules can miss a change. Examples: a stylesheet edited in place through
the CSSOM (`rule.style.color = …`), a change to a sibling of an ancestor that
a selector like `.open ~ main .card` depends on, a media query that flips
without a resize (`prefers-color-scheme`), or anything the list above
overlooks.

So whenever a snapshot reused entries, the polyfill re-checks the reused
elements in idle time, in slices of a few milliseconds
(`requestIdleCallback`, or `setTimeout` where it doesn't exist). It reads
each element in full and compares with the cache. A difference marks the
drawable dirty and drops the stale entries, so a missed change heals within
about a second without a long task. The re-check stops when the page is busy
and resumes later.

## Expected results

With 5–14 of 503 elements re-read, a Strata click should go from ~380 ms of
main-thread work to roughly:

- the layout properties of every element: ~8% of a full read, ~20 ms;
- 5–14 full reads: ~5 ms;
- copying the tree, writing the cached declarations and serializing:
  20–40 ms, to be measured.

That's about 40–60 ms, plus the ~80 ms decode off the main thread: about
120–140 ms from click to paint, Fluent's level. Typing, single-row list
updates and hover should drop by similar factors. A change that touches
everything costs what it costs today, plus the signature (a few ms).

These are estimates. The implementation will be measured with `pnpm bench`
in all three engines before it's merged.

## Verification

- Every existing pixel test (WICG demos, Strata components, form state,
  visual and conformance tests against native) runs unchanged.
- New tests, one per invalidation rule, check that a second snapshot after
  each kind of change draws the change. Each test is also run with the cache
  disabled, and the two must agree.
- A test for the safety net: a change no rule catches (an in-place CSSOM
  edit) is drawn within a bounded time.
- A debug switch turns the cache off, so a suspected stale drawing can be
  confirmed or ruled out in the field.

## Plan

1. Cache and reuse, with rules 1–4 and the layout properties, behind the
   debug switch.
2. The idle re-check.
3. Skip snapshots that change nothing for `:active` and `:focus` too
   (extending `selectors.ts`), so a real click's press and release don't each
   take one.
4. Measure, document in LIMITATIONS, and raise the size budget as needed
   (within 25 KB).

## As implemented (step 1)

The cache lives in `StyleCache` (`src/snapshot/serializer.ts`); the
invalidation rules are in `CanvasState.freshStyles` and `markStyle`
(`src/host/canvas-state.ts`), and the selector analysis is in
`src/snapshot/selectors.ts`, which replaces `hover.ts`. Where it departs
from the design above:

- **Declarations are kept, not only values.** A reused element keeps its
  finished declarations and diffs only its re-read properties against its
  UA default and parent. Diffing ~380 properties per element was the next
  largest cost once styles were reused. The values that differ from the UA
  default are kept too, as the parent values its children diff against.
- **Container queries don't re-read everything.** Both Underglass demos use
  `@container` somewhere, which would have turned reuse off. Instead each
  snapshot records the size of every query container in and above the
  drawable, and everything is re-read only when one of them changed size.
- **Layout values are re-read only where they can have changed**
  (`relayout`). The list above is about 40 properties, and re-reading all of
  them for every element was the largest cost left. A reused element now
  re-reads:
  - `width`, `height`, and the physical margins and padding, always;
  - insets, only when it's positioned (for `position: static`, the reported
    value is the computed one, which doesn't follow layout);
  - `transform`, `transform-origin` and `perspective-origin`, only when its
    size changed (their percentages resolve against its own box);
  - grid tracks, only for grids;
  - `position`, `z-index`, `clip-path`, `translate`, `rotate` and `scale`, the
    properties element geometry overrides, only when it has geometry.

  Logical properties (`margin-inline-start`, `inline-size`, …) are mapped from
  the physical ones for horizontal and vertical writing modes, and read
  otherwise. `line-height` isn't a layout value: it follows `font-size`. A
  typical element re-reads 10 properties instead of about 40.
- **The polyfill's own stylesheet** holds element geometry. It's left out of
  the stylesheet check, so drawing an element doesn't make the next snapshot
  re-read everything.
- **Animations mark their targets when they start and when they end**
  (`animationstart`, `transitionrun`, `animationend`, `transitionend` and the
  cancel events). Once a transition ends, `getAnimations()` no longer lists
  it, and its end state would otherwise be drawn from the last value
  captured mid-transition.
- **Ancestors outside the canvas.** An attribute change on an element that
  contains a canvas's host takes new snapshots of that canvas, re-read in
  full. Before, such a change (a theme class on a wrapper) wasn't drawn
  until something inside the canvas changed.
- **`install({ incremental: false })`** reads every element in full.

Each snapshot's `html-in-canvas snapshot` user timing carries
`{ read, reused }` in its `detail`, and `pnpm bench` reports it.
