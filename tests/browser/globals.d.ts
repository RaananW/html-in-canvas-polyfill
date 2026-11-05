import type {
  CanvasPaintEvent as PaintEvent,
  ElementGeometryUpdateEvent as GeometryEvent,
  ElementImage as Image,
} from '../../src/index';
import '../../src/types';

declare global {
  type CanvasPaintEvent = PaintEvent;
  type ElementImage = Image;
  type ElementGeometryUpdateEvent = GeometryEvent;
  var ElementGeometryUpdateEvent: typeof GeometryEvent;
}
