# WICG demos

Unmodified copies of the demos in
[WICG/html-in-canvas `Examples/`](https://github.com/WICG/html-in-canvas/tree/5d9d970ebc06d1903aa0f4b99ac78655b9922804/Examples)
(commit `5d9d970`): `complex-text.html`, `nested-sparkles.html`,
`pie-chart.html`, `webGL.html`, `webGLSetup.js` and `wolf.jpg`. The
`webgpu-jelly-slider` demo needs a Vite build and is not included.

The files are byte-identical to upstream. `scripts/serve.mjs` adds the
polyfill to each page as it serves it (`?force` replaces native support), so
`pnpm serve` and then <http://localhost:4173/examples/wicg/pie-chart.html>
runs a demo under the polyfill. `webGL.html` loads gl-matrix from cdnjs; the
browser tests serve the identical npm copy instead.

## License

This directory includes material copied from
[HTML-in-Canvas](https://github.com/WICG/html-in-canvas) (WICG).
Copyright © 2024–2026 [World Wide Web Consortium](https://www.w3.org/).
<https://www.w3.org/copyright/software-license-2023/>

The upstream repository's license statement is in [LICENSE.md](LICENSE.md).
The W3C Software and Document License follows.

> This work is being provided by the copyright holders under the following
> license.
>
> **License**
>
> By obtaining and/or copying this work, you (the licensee) agree that you have
> read, understood, and will comply with the following terms and conditions.
>
> Permission to copy, modify, and distribute this work, with or without
> modification, for any purpose and without fee or royalty is hereby granted,
> provided that you include the following on ALL copies of the work or portions
> thereof, including modifications:
>
> - The full text of this NOTICE in a location viewable to users of the
>   redistributed or derivative work.
> - Any pre-existing intellectual property disclaimers, notices, or terms and
>   conditions. If none exist, the W3C software and document short notice
>   should be included.
> - Notice of any changes or modifications, through a copyright statement on
>   the new code or document such as "This software or document includes
>   material copied from or derived from [title and URI of the W3C document].
>   Copyright © [$year-of-document] World Wide Web Consortium.
>   https://www.w3.org/copyright/software-license-2023/"
>
> **Disclaimers**
>
> THIS WORK IS PROVIDED "AS IS," AND COPYRIGHT HOLDERS MAKE NO REPRESENTATIONS
> OR WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO, WARRANTIES OF
> MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE
> SOFTWARE OR DOCUMENT WILL NOT INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS,
> TRADEMARKS OR OTHER RIGHTS.
>
> COPYRIGHT HOLDERS WILL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, SPECIAL OR
> CONSEQUENTIAL DAMAGES ARISING OUT OF ANY USE OF THE SOFTWARE OR DOCUMENT.
>
> The name and trademarks of copyright holders may NOT be used in advertising or
> publicity pertaining to the work without specific, written prior permission.
> Title to copyright in this work will at all times remain with copyright
> holders.
