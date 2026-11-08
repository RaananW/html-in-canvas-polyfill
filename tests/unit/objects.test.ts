import { describe, expect, it, vi } from 'vitest';
import { reverseTreeOrder } from '../../src/dom';
import { createElementImage, ElementImage, elementImageRecord } from '../../src/element-image';
import { CanvasPaintEvent } from '../../src/paint/event';
import { SnapshotRecord } from '../../src/snapshot/record';

function fakeRecord() {
  const close = vi.fn();
  const bitmap = { close } as unknown as ImageBitmap;
  const record = new SnapshotRecord(
    { bitmap, width: 100, height: 40, cssWidth: 50, cssHeight: 20 },
    2,
    2,
    document.createElement('div'),
  );
  return { record, close };
}

describe('VERSION', () => {
  it('is the package version', async () => {
    const { VERSION } = await import('../../src/index');
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe('ElementImage', () => {
  it('cannot be constructed directly', () => {
    expect(() => new (ElementImage as unknown as new () => ElementImage)()).toThrow(TypeError);
  });

  it('reports grid-pixel size and keeps the bitmap alive until closed', () => {
    const { record, close } = fakeRecord();
    const image = createElementImage(record);
    expect([image.width, image.height]).toEqual([100, 40]);
    record.release();
    expect(close).not.toHaveBeenCalled();
    image.close();
    expect(close).toHaveBeenCalledOnce();
    expect([image.width, image.height]).toEqual([0, 0]);
    expect(() => elementImageRecord(image)).toThrow('The ElementImage has been closed.');
    image.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('CanvasPaintEvent', () => {
  it('exposes a frozen, stable changedElements array', () => {
    const a = document.createElement('div');
    const event = new CanvasPaintEvent('paint', { changedElements: [a] });
    expect(event.changedElements).toBe(event.changedElements);
    expect(event.changedElements).toEqual([a]);
    expect(Object.isFrozen(event.changedElements)).toBe(true);
    expect(event.bubbles).toBe(false);
    expect(event.cancelable).toBe(false);
    expect(new CanvasPaintEvent('paint').changedElements).toEqual([]);
  });
});

describe('reverseTreeOrder', () => {
  it('puts descendants and later siblings first', () => {
    document.body.innerHTML = '<div id="a"><div id="b"></div></div><div id="c"></div>';
    const [a, b, c] = ['a', 'b', 'c'].map((id) => document.getElementById(id)!);
    expect(reverseTreeOrder([a!, c!, b!]).map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });
});
