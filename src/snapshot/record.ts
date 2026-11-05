import type { SnapshotResult } from './serializer';

/** A ref-counted snapshot shared by the canvas and any ElementImage. */
export class SnapshotRecord {
  readonly bitmap: ImageBitmap | null;
  /** Bitmap size in canvas grid pixels. */
  readonly width: number;
  readonly height: number;
  /** Border-box size in CSS pixels. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** Unrounded border-box size in canvas grid pixels. */
  readonly defaultWidth: number;
  readonly defaultHeight: number;
  private refs = 1;

  constructor(
    result: SnapshotResult,
    scaleX: number,
    scaleY: number,
    /** The element the snapshot was taken of. */
    readonly element: Element,
  ) {
    this.bitmap = result.bitmap;
    this.width = result.width;
    this.height = result.height;
    this.cssWidth = result.cssWidth;
    this.cssHeight = result.cssHeight;
    this.defaultWidth = result.cssWidth * scaleX;
    this.defaultHeight = result.cssHeight * scaleY;
  }

  retain(): this {
    this.refs++;
    return this;
  }

  release(): void {
    if (--this.refs === 0) this.bitmap?.close();
  }
}
