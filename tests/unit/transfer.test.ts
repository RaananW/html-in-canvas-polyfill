import { describe, expect, it, vi } from 'vitest';
import { createElementImage, ElementImage, elementImageRecord } from '../../src/element-image';
import { SnapshotRecord } from '../../src/snapshot/record';
import { encode, type Envelope, MARKER, reviveMessage, sendWith } from '../../src/transfer';

// happy-dom's ImageBitmap can't be constructed; envelopes only accept ImageBitmaps.
type FakeBitmap = ImageBitmap & { close: ReturnType<typeof vi.fn> };
const fakeBitmap = (): FakeBitmap => Object.assign(Object.create(ImageBitmap.prototype) as ImageBitmap, { close: vi.fn() });

function image(bitmap: ImageBitmap | null = fakeBitmap()) {
  const record = new SnapshotRecord(
    { bitmap, width: 100, height: 40, cssWidth: 50, cssHeight: 20 },
    2.5,
    2,
    document.createElement('div'),
  );
  const img = createElementImage(record);
  record.release();
  return { img, bitmap };
}

const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === 'object' && value !== null && (value as Record<string, unknown>)[MARKER] === 1;

describe('encode', () => {
  it('leaves messages whose transfer list has no ElementImage alone', () => {
    const { img } = image();
    const message = { img };
    expect(encode(message, [])).toBeNull();
    expect(encode(message, [new ArrayBuffer(1)])).toBeNull();
  });

  it('replaces each ElementImage with an envelope of its bitmap and sizes', () => {
    const { img, bitmap } = image();
    const encoded = encode(img, [img])!;
    expect(encoded.transfer).toEqual([]);
    expect(encoded.images).toEqual([img]);
    expect(encoded.message).toEqual({
      [MARKER]: 1,
      bitmap,
      width: 100,
      height: 40,
      cssWidth: 50,
      cssHeight: 20,
      defaultWidth: 125,
      defaultHeight: 40,
    });
  });

  it('walks objects, arrays, Maps and Sets, keeping identity and cycles, and copies only containers', () => {
    const a = image().img;
    const b = image().img;
    const buffer = new ArrayBuffer(8);
    const typed = new Float32Array(2);
    const date = new Date(0);
    class Payload {
      constructor(readonly inner: ElementImage) {}
    }
    const message: Record<string, unknown> = {
      list: [a, { deep: a }],
      map: new Map<unknown, unknown>([[b, 'key'], ['value', b]]),
      set: new Set([a]),
      instance: new Payload(b),
      typed,
      buffer,
      date,
      text: 'x',
    };
    message.self = message;
    const before = JSON.stringify(Object.keys(message));
    const encoded = encode(message, [a, buffer, b])!;
    const out = encoded.message as Record<string, unknown>;

    expect(encoded.transfer).toEqual([buffer]);
    const list = out.list as unknown[];
    expect(isEnvelope(list[0])).toBe(true);
    expect((list[1] as { deep: unknown }).deep).toBe(list[0]);
    const map = out.map as Map<unknown, unknown>;
    const [key] = [...map.keys()];
    expect(isEnvelope(key)).toBe(true);
    expect(map.get('value')).toBe(key);
    expect([...(out.set as Set<unknown>)][0]).toBe(list[0]);
    expect(isEnvelope((out.instance as { inner: unknown }).inner)).toBe(true);
    expect(out.typed).toBe(typed);
    expect(out.buffer).toBe(buffer);
    expect(out.date).toBe(date);
    expect(out.self).toBe(out);
    // The top-level copy says it carries envelopes.
    expect(out[MARKER]).toBe(2);
    // The sender's message is untouched.
    expect(message.list).toEqual([a, { deep: a }]);
    expect(JSON.stringify(Object.keys(message))).toBe(before);
    expect(out).not.toBe(message);
  });

  it('throws DataCloneError for an ElementImage that is cloned, closed or listed twice', () => {
    const { img } = image();
    const other = image().img;
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return `${(e as DOMException).name}: ${(e as DOMException).message}`;
      }
      return 'no error';
    };
    expect(err(() => encode({ img, other }, [img]))).toBe('DataCloneError: An ElementImage could not be cloned.');
    expect(err(() => encode(img, [img, img]))).toBe(
      'DataCloneError: ElementImage at index 1 is a duplicate of an earlier ElementImage.',
    );
    other.close();
    expect(err(() => encode(other, [other]))).toBe('DataCloneError: An ElementImage is closed and could not be cloned.');
  });
});

describe('revive', () => {
  it('turns envelopes back into ElementImages, in place, keeping identity', () => {
    const { img } = image();
    const message = encode({ a: [img], b: new Map([['k', img]]), c: new Set([img]), typed: new Uint8Array(2) }, [img])!.message;
    const out = reviveMessage(message) as { a: unknown[]; b: Map<string, unknown>; c: Set<unknown>; typed: Uint8Array };
    expect(out).toBe(message);
    expect(MARKER in out).toBe(false);
    const revived = out.a[0] as ElementImage;
    expect(revived).toBeInstanceOf(ElementImage);
    expect([revived.width, revived.height]).toEqual([100, 40]);
    expect(out.b.get('k')).toBe(revived);
    expect([...out.c]).toEqual([revived]);
    const record = elementImageRecord(revived);
    expect([record.cssWidth, record.cssHeight, record.defaultWidth, record.defaultHeight]).toEqual([50, 20, 125, 40]);
    expect(record.element).toBeNull();
  });

  it('survives structured clone', () => {
    const { img } = image(null);
    const out = reviveMessage(structuredClone(encode({ img }, [img])!.message)) as { img: ElementImage };
    expect(out.img).toBeInstanceOf(ElementImage);
    expect(out.img.width).toBe(100);
  });

  it('gives images of one snapshot one record, so the bitmap closes with the last of them', () => {
    const record = new SnapshotRecord(
      { bitmap: fakeBitmap(), width: 4, height: 4, cssWidth: 2, cssHeight: 2 },
      2,
      2,
      null,
    );
    const a = createElementImage(record);
    const b = createElementImage(record);
    record.release();
    const out = reviveMessage(encode([a, b], [a, b])!.message) as ElementImage[];
    const bitmap = elementImageRecord(out[0]!).bitmap as FakeBitmap;
    expect(out[0]).not.toBe(out[1]);
    out[0]!.close();
    expect(bitmap.close).not.toHaveBeenCalled();
    expect(out[1]!.width).toBe(4);
    out[1]!.close();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('only walks flagged messages, envelopes, Maps and Sets', () => {
    const { img } = image(null);
    const envelope = (encode(img, [img])!.message);
    // Unflagged: an envelope inside is left alone, so nothing was walked.
    const plain = { list: [1, { x: 2 }], inner: envelope };
    expect(reviveMessage(plain)).toBe(plain);
    expect(plain.inner).toBe(envelope);
    expect(reviveMessage(envelope)).toBeInstanceOf(ElementImage);
    const map = new Map([['k', { ...(envelope as object) }]]);
    expect((reviveMessage(map) as Map<string, unknown>).get('k')).toBeInstanceOf(ElementImage);
    expect(reviveMessage(7)).toBe(7);
  });

  it('flags top-level arrays, which keep the flag through structured clone', () => {
    const { img } = image(null);
    const out = reviveMessage(structuredClone(encode([img], [img])!.message)) as unknown[];
    expect(out[0]).toBeInstanceOf(ElementImage);
    expect(Object.keys(out)).toEqual(['0']);
  });

  it('ignores look-alikes without a bitmap', () => {
    const data = { [MARKER]: 2, fake: { [MARKER]: 1, bitmap: 'nope' } };
    expect(reviveMessage(data)).toEqual({ fake: { [MARKER]: 1, bitmap: 'nope' } });
  });
});

describe('ElementImage', () => {
  it('fails structured clone with DataCloneError, as natively', () => {
    const { img } = image(null);
    expect(() => structuredClone(img)).toThrow(expect.objectContaining({ name: 'DataCloneError' }));
    expect(() => structuredClone({ nested: [img] })).toThrow(expect.objectContaining({ name: 'DataCloneError' }));
    expect(Object.prototype.toString.call(img)).toBe('[object ElementImage]');
  });
});

describe('sendWith', () => {
  it('passes messages without a transfer list straight through', () => {
    const post = vi.fn();
    const message = { a: 1 };
    sendWith(post)(message);
    sendWith(post)(message, '*');
    expect(post.mock.calls).toEqual([[message], [message, '*']]);
  });

  it('sends envelopes, then closes the transferred images', () => {
    const post = vi.fn();
    const { img } = image();
    const port = new ArrayBuffer(1);
    sendWith(post)({ img }, [img, port]);
    const [message, transfer] = post.mock.calls[0]!;
    expect(isEnvelope((message as { img: unknown }).img)).toBe(true);
    expect(transfer).toEqual([port]);
    expect(img.width).toBe(0);
  });

  it("handles Window's targetOrigin and the options dictionary", () => {
    const post = vi.fn();
    const a = image().img;
    const b = image().img;
    sendWith(post)(a, '*', [a]);
    sendWith(post)(b, { targetOrigin: '/', transfer: [b] });
    expect(post.mock.calls[0]![1]).toBe('*');
    expect(post.mock.calls[0]![2]).toEqual([]);
    expect(post.mock.calls[1]![1]).toEqual({ targetOrigin: '/', transfer: [] });
    expect([a.width, b.width]).toEqual([0, 0]);
  });

  it('leaves the images open when posting fails', () => {
    const { img } = image();
    const post = vi.fn(() => {
      throw new DOMException('nope', 'DataCloneError');
    });
    expect(() => sendWith(post)(img, [img])).toThrow('nope');
    expect(img.width).toBe(100);
  });
});
