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

/** The canvas each image was captured from. Images received from another thread have none. */
const origins = new WeakMap<ElementImage, HTMLCanvasElement>();

/** Wraps a record in a new ElementImage, which holds its own reference. */
export function createElementImage(record: SnapshotRecord, origin?: HTMLCanvasElement): ElementImage {
  const image = new ElementImage(token, record);
  if (origin) origins.set(image, origin);
  return image;
}

/**
 * The record, once `canvas` is checked against the one the image was
 * captured from. As natively, the closed check comes first.
 */
export function imageRecordFor(
  image: ElementImage,
  canvas: HTMLCanvasElement | undefined,
  message = 'The source was captured from a different canvas.',
): SnapshotRecord {
  const record = elementImageRecord(image);
  const origin = origins.get(image);
  if (origin && origin !== canvas) throw invalidState(message);
  return record;
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
