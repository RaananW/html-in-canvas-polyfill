export interface CanvasPaintEventInit extends EventInit {
  changedElements?: Element[];
}

const changed = new WeakMap<Event, readonly Element[]>();

export class CanvasPaintEvent extends Event {
  constructor(type: string, init: CanvasPaintEventInit = {}) {
    super(type, init);
    changed.set(this, Object.freeze([...(init.changedElements ?? [])]));
  }

  get changedElements(): readonly Element[] {
    return changed.get(this)!;
  }
}

export interface ElementGeometryUpdateEventInit extends EventInit {
  elements?: Element[];
}

const updated = new WeakMap<Event, readonly Element[]>();

/** Fired on a canvas after geometry updates from its OffscreenCanvas are applied. */
export class ElementGeometryUpdateEvent extends Event {
  constructor(type: string, init: ElementGeometryUpdateEventInit = {}) {
    super(type, init);
    updated.set(this, Object.freeze([...(init.elements ?? [])]));
  }

  get elements(): readonly Element[] {
    return updated.get(this)!;
  }
}
