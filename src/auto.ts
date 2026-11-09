import { extend } from './extensions.js';
import { install } from './index.js';
import { patchMessaging } from './transfer.js';

export * from './index.js';

// Everything, like the script-tag build: messaging included. Registered here,
// not by importing ./messaging, so the call stays in this file, which
// package.json lists as having side effects (a shared chunk isn't).
extend(patchMessaging);
install();
