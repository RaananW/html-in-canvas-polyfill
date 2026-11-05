import { patch, unpatch } from './api';
import { start, stop } from './runtime';
import { snapshotsTaint } from './snapshot/bitmap';

export { ElementImage } from './element-image';
export { CanvasPaintEvent, type CanvasPaintEventInit } from './paint/event';

export const VERSION = '0.0.0';

export interface InstallOptions {
  /** Install even when the browser supports HTML-in-Canvas natively (testing only). */
  force?: boolean;
}

export interface PolyfillStatus {
  /** The browser implements the API itself. */
  readonly native: boolean;
  /** The polyfill is active. */
  readonly polyfilled: boolean;
  readonly version: string;
  /** Known gaps of the active implementation. Empty when native. */
  readonly limitations: readonly string[];
}

const BASE_LIMITATIONS = [
  'Snapshots are taken asynchronously; drawn images lag DOM changes by at least one frame.',
  'Canvas children are moved into a sibling host element; selectors such as `canvas > *` no longer match them.',
  'No caret, selection highlight, or IME composition in snapshots.',
  'Cross-origin images and fonts without CORS are omitted from snapshots.',
  ':hover and :active styles are not reflected in snapshots.',
  'Form controls are drawn without platform theming in WebKit and Firefox.',
  'Element geometry, hit testing, WebGL, and WebGPU are not implemented yet.',
];

let installed = false;
let status: PolyfillStatus = Object.freeze({ native: false, polyfilled: false, version: VERSION, limitations: [] });

/** True when the browser implements the current HTML-in-Canvas API. */
export function hasNativeSupport(): boolean {
  return (
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof CanvasRenderingContext2D !== 'undefined' &&
    'requestPaint' in HTMLCanvasElement.prototype &&
    'drawElementImage' in CanvasRenderingContext2D.prototype
  );
}

function publish(next: PolyfillStatus): PolyfillStatus {
  status = next;
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).HTMLInCanvasPolyfill = { ...next, install, uninstall, getStatus };
  }
  return status;
}

export function getStatus(): PolyfillStatus {
  if (status.polyfilled && snapshotsTaint() && !status.limitations.some((l) => l.includes('taint'))) {
    status = Object.freeze({
      ...status,
      limitations: [...status.limitations, 'Drawing snapshots taints the canvas in this browser.'],
    });
  }
  return status;
}

/** Installs the polyfill unless the browser has native support. Idempotent. */
export function install(options: InstallOptions = {}): PolyfillStatus {
  if (installed) return getStatus();
  const native = hasNativeSupport();
  if (native && !options.force) return publish(Object.freeze({ native, polyfilled: false, version: VERSION, limitations: [] }));
  installed = true;
  patch();
  start();
  return publish(Object.freeze({ native, polyfilled: true, version: VERSION, limitations: BASE_LIMITATIONS }));
}

/** Removes the polyfill, moving canvas content back into each canvas. */
export function uninstall(): void {
  if (!installed) return;
  installed = false;
  stop();
  unpatch();
  publish(Object.freeze({ native: hasNativeSupport(), polyfilled: false, version: VERSION, limitations: [] }));
}
