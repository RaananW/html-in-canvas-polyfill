// Converting a decoded foreignObject SVG image to an ImageBitmap. In Chromium,
// createImageBitmap(img) of such an image taints any canvas it is drawn into,
// while drawing the image into a canvas first stays clean. In WebKit the
// intermediate canvas darkens shadows, so the direct path is preferred
// wherever it is clean.

export type BitmapPath = 'direct' | 'canvas';

let pathPromise: Promise<BitmapPath> | null = null;
let tainted = false;

const PROBE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><foreignObject width="1" height="1">' +
  '<div xmlns="http://www.w3.org/1999/xhtml" style="width:1px;height:1px;background:#f00"></div>' +
  '</foreignObject></svg>';

function isClean(source: CanvasImageSource): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0);
  try {
    ctx.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

async function detectPath(): Promise<BitmapPath> {
  const img = new Image(1, 1);
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PROBE_SVG)}`;
  try {
    await img.decode();
    const direct = await createImageBitmap(img);
    const clean = isClean(direct);
    direct.close();
    if (clean) return 'direct';
    const viaCanvas = await canvasBitmap(img, 1, 1);
    tainted = !isClean(viaCanvas);
    viaCanvas.close();
  } catch {
    // Fall through to the conservative path.
  }
  return 'canvas';
}

function canvasBitmap(img: HTMLImageElement, width: number, height: number): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
  return createImageBitmap(canvas);
}

export function bitmapPath(): Promise<BitmapPath> {
  return (pathPromise ??= detectPath());
}

/** True when every path taints, so drawn snapshots make the canvas unreadable. */
export function snapshotsTaint(): boolean {
  return tainted;
}

export async function toBitmap(img: HTMLImageElement, width: number, height: number): Promise<ImageBitmap> {
  return (await bitmapPath()) === 'direct' ? createImageBitmap(img) : canvasBitmap(img, width, height);
}
