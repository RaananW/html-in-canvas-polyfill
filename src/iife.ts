import { extend } from './extensions.js';
import { install } from './index.js';
import { patchMessaging } from './transfer.js';

// The script-tag build has everything, messaging included.
extend(patchMessaging);

const script = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;
install({ force: script?.hasAttribute('data-force') ?? false });
