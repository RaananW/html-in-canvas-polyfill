import { invalidState } from './dom';
import type { SnapshotRecord } from './snapshot/record';

const token = Symbol('ElementImage');
const records = new WeakMap<ElementImage, SnapshotRecord | null>();

/** A reference to the snapshot of a `drawable` element at capture time. */
export class ElementImage {
  /** @internal */
  constructor(key: symbol, record: SnapshotRecord) {
    if (key !== token) throw new TypeError('Illegal constructor');
    records.set(this, record.retain());
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
}

export function createElementImage(record: SnapshotRecord): ElementImage {
  return new ElementImage(token, record);
}

export function elementImageRecord(image: ElementImage): SnapshotRecord {
  const record = records.get(image);
  if (!record) throw invalidState('The ElementImage has been closed.');
  return record;
}
