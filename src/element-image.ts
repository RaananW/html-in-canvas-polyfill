import { invalidState } from './dom.js';
import type { SnapshotRecord } from './snapshot/record.js';

const token = Symbol('ElementImage');
const records = new WeakMap<ElementImage, SnapshotRecord | null>();

/**
 * A symbol can't be cloned, so structured clone of an ElementImage throws
 * DataCloneError, as natively, on paths the polyfill doesn't wrap
 * (BroadcastChannel, IndexedDB, history.pushState, …). Clone only reads
 * enumerable string keys, so the property has to be one.
 */
const NOT_CLONEABLE = Symbol('ElementImage');

/** A reference to the snapshot of a `drawable` element at capture time. */
export class ElementImage {
  /** @internal */
  constructor(key: symbol, record: SnapshotRecord) {
    if (key !== token) throw new TypeError('Illegal constructor');
    records.set(this, record.retain());
    Object.defineProperty(this, '__elementImage', { value: NOT_CLONEABLE, enumerable: true });
  }

  get width(): number {
    return records.get(this)?.width ?? 0;
  }

  get height(): number {
    return records.get(this)?.height ?? 0;
  }

  close(): void {
    records.get(this)?.release();
    records.set(this, null);
  }

  get [Symbol.toStringTag](): string {
    return 'ElementImage';
  }
}

/** Wraps a record in a new ElementImage, which holds its own reference. */
export function createElementImage(record: SnapshotRecord): ElementImage {
  return new ElementImage(token, record);
}

export function elementImageRecord(image: ElementImage): SnapshotRecord {
  const record = records.get(image);
  if (!record) throw invalidState('The ElementImage has been closed.');
  return record;
}

/** The record, or null once the image is closed or transferred. */
export function openRecord(image: ElementImage): SnapshotRecord | null {
  return records.get(image) ?? null;
}
