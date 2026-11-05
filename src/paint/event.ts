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
