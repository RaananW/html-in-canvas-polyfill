import type { CanvasPaintEvent as PaintEvent, ElementImage as Image } from '../../src/index';
import '../../src/types';

declare global {
  type CanvasPaintEvent = PaintEvent;
  type ElementImage = Image;
}
