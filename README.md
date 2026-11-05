# html-in-canvas-polyfill

An open-source, engine-agnostic polyfill for the WICG
[HTML-in-Canvas](https://github.com/WICG/html-in-canvas) proposal. It aims to
work as well as possible in browsers without native support, and it documents
its limitations clearly.

> **Status:** planning. There is no implementation yet. See
> [docs/PLAN.md](docs/PLAN.md).

## Goals

- Implement the spec API surface: `content="drawable"`, `drawable`, `paint` /
  `requestPaint()`, `drawElementImage`, `captureElementImage`,
  `texElementSubImage2D`, `drawElementImageToTexture`, and element geometry.
- Never override native support.
- Work with any engine or plain 2D canvas, WebGL and WebGPU.
- Keep limitations explicit. They will be listed in `docs/LIMITATIONS.md`.

## License

MIT
