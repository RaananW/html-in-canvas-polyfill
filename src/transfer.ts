// ElementImage is [Transferable]. The polyfill's ElementImage is a plain
// object, so messages that transfer one carry a plain *envelope* instead: its
// snapshot's bitmap (cloned, since the canvas keeps the original) and sizes.
// The receiving side, in the main thread or the worker entry, turns
// envelopes back into ElementImages when `MessageEvent.data` is read.
import { define, method } from './define.js';
import { createElementImage, ElementImage, openRecord } from './element-image.js';
import { SnapshotRecord, type SnapshotSize } from './snapshot/record.js';

/**
 * The key that marks an envelope (value 1), and a top-level message object or
 * array that holds envelopes (value 2), so receivers only walk messages that
 * need it. A worker without the polyfill's worker entry receives both as they are.
 */
export const MARKER = '__hicElementImage';
const CARRIES = 2;

export interface Envelope extends SnapshotSize {
  [MARKER]: 1;
  bitmap: ImageBitmap | null;
}

const cloneError = (message: string): DOMException => new DOMException(message, 'DataCloneError');

/** Objects structured clone serializes key by key, including class instances. */
const isRecordLike = (value: object): boolean => Object.prototype.toString.call(value) === '[object Object]';

export interface Encoded {
  message: unknown;
  transfer: unknown[];
  /** The transferred ElementImages, to close once the message is sent. */
  images: ElementImage[];
}

/**
 * Maps `value` through plain objects, arrays, Maps and Sets, replacing each
 * object `swap` returns something for. Cycles and shared references are
 * kept. Other objects (typed arrays, buffers, platform objects, Dates, …) are
 * kept as they are. In place, containers are updated rather than copied.
 */
function mapDeep(value: unknown, swap: (value: object) => unknown, inPlace: boolean): unknown {
  const done = new Map<object, unknown>();
  const walk = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    if (done.has(value)) return done.get(value);
    let out = swap(value);
    if (out !== undefined) {
      done.set(value, out);
    } else if (value instanceof Map || value instanceof Set) {
      const entries = [...value.entries()];
      const map = inPlace ? value : value instanceof Map ? new Map<unknown, unknown>() : new Set<unknown>();
      done.set(value, (out = map));
      map.clear();
      for (const [k, v] of entries) {
        if (map instanceof Map) map.set(walk(k), walk(v));
        else map.add(walk(k));
      }
    } else if (Array.isArray(value) || isRecordLike(value)) {
      const from = value as Record<string, unknown>;
      const to: Record<string, unknown> = inPlace ? from : Array.isArray(value) ? (new Array(value.length) as never) : {};
      done.set(value, (out = to));
      for (const key of Object.keys(from)) to[key] = walk(from[key]);
    } else {
      out = value;
    }
    return out;
  };
  return walk(value);
}

/**
 * Replaces each ElementImage in `message` with an envelope, copying the
 * objects, arrays, Maps and Sets on the way, and drops ElementImages from the
 * transfer list. Returns null when the transfer list has no ElementImage: an
 * ElementImage elsewhere in the message then fails to clone, as natively.
 */
export function encode(message: unknown, transfer: readonly unknown[]): Encoded | null {
  if (!transfer.some((item) => item instanceof ElementImage)) return null;
  const images = new Set<ElementImage>();
  const rest: unknown[] = [];
  transfer.forEach((item, index) => {
    if (!(item instanceof ElementImage)) rest.push(item);
    else if (images.has(item)) throw cloneError(`ElementImage at index ${index} is a duplicate of an earlier ElementImage.`);
    else if (!openRecord(item)) throw cloneError('An ElementImage is closed and could not be cloned.');
    else images.add(item);
  });
  const out = mapDeep(
    message,
    (value) => {
      if (!(value instanceof ElementImage)) return undefined;
      const record = images.has(value) ? openRecord(value) : null;
      if (!record) throw cloneError('An ElementImage could not be cloned.');
      return envelope(record);
    },
    false,
  );
  // A top-level Map or Set can't carry the flag; receivers walk those anyway.
  if (out !== message && typeof out === 'object' && !(out instanceof Map || out instanceof Set)) {
    const top = out as Record<string, unknown>;
    if (top[MARKER] !== 1) top[MARKER] = CARRIES;
  }
  return { message: out, transfer: rest, images: [...images] };
}

function envelope(record: SnapshotRecord): Envelope {
  const { bitmap, width, height, cssWidth, cssHeight, defaultWidth, defaultHeight } = record;
  return { [MARKER]: 1, bitmap, width, height, cssWidth, cssHeight, defaultWidth, defaultHeight };
}

function isEnvelope(value: Record<string, unknown>): value is Envelope & Record<string, unknown> {
  const bitmap = value.bitmap;
  return value[MARKER] === 1 && (bitmap === null || (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap));
}

/**
 * Revives a received message in place, replacing its envelopes with
 * ElementImages. Only messages encode() flagged, or that are envelopes, Maps
 * or Sets, are walked; everything else is returned as is. Deserialized data
 * only holds plain objects, arrays, Maps, Sets and platform objects.
 */
export function reviveMessage(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const flag = (data as Record<string, unknown>)[MARKER];
  if (flag === CARRIES) delete (data as Record<string, unknown>)[MARKER];
  else if (flag !== 1 && !(data instanceof Map || data instanceof Set)) return data;
  // Images of the same snapshot arrive with the same bitmap, so they share a record.
  const shared = new Map<ImageBitmap, SnapshotRecord>();
  const created: SnapshotRecord[] = [];
  const result = mapDeep(
    data,
    (value) => {
      const e = value as Envelope & Record<string, unknown>;
      if (!isRecordLike(value) || !isEnvelope(e)) return undefined;
      let record = e.bitmap && shared.get(e.bitmap);
      if (!record) {
        const scaleX = e.cssWidth ? e.defaultWidth / e.cssWidth : 0;
        const scaleY = e.cssHeight ? e.defaultHeight / e.cssHeight : 0;
        record = new SnapshotRecord(e, scaleX, scaleY, null);
        if (e.bitmap) shared.set(e.bitmap, record);
        created.push(record);
      }
      return createElementImage(record);
    },
    true,
  );
  // Only the images hold references now: closing the last one closes the bitmap.
  for (const record of created) record.release();
  return result;
}

export type Post = (this: unknown, message: unknown, ...rest: unknown[]) => unknown;

const iterable = (value: unknown): value is Iterable<unknown> =>
  typeof value === 'object' && value !== null && Symbol.iterator in value;

/** postMessage's transfer list: `(message, transfer)`, `(message, { transfer })`, or Window's `(message, targetOrigin, transfer)`. */
export function sendWith(post: Post): Post {
  return function (this: unknown, message: unknown, ...rest: unknown[]) {
    const at = typeof rest[0] === 'string' ? 1 : 0;
    const option = rest[at];
    const sequence = iterable(option) ? option : (option as { transfer?: unknown } | undefined)?.transfer;
    if (!iterable(sequence)) return post.call(this, message, ...rest);
    const list = Array.from(sequence);
    const encoded = encode(message, list);
    // A one-shot iterator has been read, so only an array can be passed on as it was.
    if (!encoded && Array.isArray(sequence)) return post.call(this, message, ...rest);
    const transfer = encoded ? encoded.transfer : list;
    rest[at] = iterable(option) ? transfer : { ...(option as object), transfer };
    const result = post.call(this, encoded ? encoded.message : message, ...rest);
    // Natively a transfer detaches the source; a failed post leaves it alone.
    encoded?.images.forEach((image) => image.close());
    return result;
  };
}

function cloneWith(clone: typeof structuredClone): typeof structuredClone {
  return function <T>(value: T, options?: StructuredSerializeOptions): T {
    const sequence = options?.transfer;
    const encoded = iterable(sequence) ? encode(value, Array.from(sequence)) : null;
    if (!encoded) return clone(value, options);
    const result = clone(encoded.message, { ...options, transfer: encoded.transfer as Transferable[] });
    encoded.images.forEach((image) => image.close());
    return reviveMessage(result) as T;
  };
}

/** Wraps the senders and `MessageEvent.data` in this realm (window or worker). */
export function patchMessaging(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const name of ['Worker', 'MessagePort', 'ServiceWorker', 'Client']) {
    const proto = (g[name] as { prototype?: Record<string, unknown> } | undefined)?.prototype;
    const post = proto && Object.getOwnPropertyDescriptor(proto, 'postMessage')?.value as Post | undefined;
    if (proto && typeof post === 'function') method(proto, 'postMessage', sendWith(post));
  }
  // Window's and a worker global's postMessage are own properties of the global.
  if (typeof g.postMessage === 'function') method(g, 'postMessage', sendWith(g.postMessage as Post));
  if (typeof g.structuredClone === 'function') method(g, 'structuredClone', cloneWith(g.structuredClone as typeof structuredClone));
  const get = typeof MessageEvent === 'undefined' ? undefined : Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
  if (get) {
    const revived = new WeakMap<Event, unknown>();
    define(MessageEvent.prototype, 'data', {
      get(this: MessageEvent) {
        if (revived.has(this)) return revived.get(this);
        const data = reviveMessage(get.call(this));
        revived.set(this, data);
        return data;
      },
    });
  }
}
