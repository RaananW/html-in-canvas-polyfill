// The test worker with the polyfill's worker entry, as a polyfilled page needs it.
import '/dist/worker.js';
import './worker.js';
