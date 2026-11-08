// `@underglass/html-in-canvas-polyfill/messaging`: import it on a page that
// sends ElementImages to workers, MessagePorts or structuredClone, or
// receives them back. It wraps postMessage, structuredClone and
// MessageEvent.data while the polyfill is installed (docs/WORKERS.md). It does
// nothing in a browser with native support. `./auto` and the script-tag
// build register it themselves.
import { extend } from './extensions.js';
import { patchMessaging } from './transfer.js';

extend(patchMessaging);
