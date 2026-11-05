import type { SnapshotResult } from './serializer';

/** A ref-counted snapshot shared by the canvas and any ElementImage. */
export class SnapshotRecord {
  private readonly on: ImageBitmap | null;
  /** The snapshot with its caret hidden, when it has a caret. */
  readonly caretOff: ImageBitmap | null;
  /** The blink phase: true while the caret is hidden. */
  caretHidden = false;
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
    this.on = result.bitmap;
    this.caretOff = result.caretOff ?? null;
    this.width = result.width;
    this.height = result.height;
    this.cssWidth = result.cssWidth;
    this.cssHeight = result.cssHeight;
    this.defaultWidth = result.cssWidth * scaleX;
    this.defaultHeight = result.cssHeight * scaleY;
  }

  /** The bitmap to draw in the current blink phase. */
  get bitmap(): ImageBitmap | null {
    return this.caretHidden && this.caretOff ? this.caretOff : this.on;
  }

  retain(): this {
    this.refs++;
    return this;
  }

  release(): void {
    if (--this.refs === 0) {
      this.on?.close();
      this.caretOff?.close();
    }
  }
}
