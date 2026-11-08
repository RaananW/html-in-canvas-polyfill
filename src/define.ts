// Patching helpers that remember how to undo each patch.

type Restore = () => void;
const restores: Restore[] = [];

export function define(target: object, name: string, descriptor: PropertyDescriptor): void {
  const previous = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, enumerable: true, ...descriptor });
  restores.push(() => {
    if (previous) Object.defineProperty(target, name, previous);
    else delete (target as Record<string, unknown>)[name];
  });
}

export function method(target: object, name: string, fn: (...args: never[]) => unknown): void {
  define(target, name, { value: fn, writable: true, enumerable: true });
}

/** Undoes every patch, newest first. */
export function restoreAll(): void {
  for (const restore of restores.splice(0).reverse()) restore();
}
