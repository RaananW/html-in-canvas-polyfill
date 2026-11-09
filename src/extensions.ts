// Features with an entry point of their own (`./messaging`) register here, so
// the main entry doesn't bundle them. A registered feature is applied
// whenever the polyfill patches the page, at once when it registers after
// install(). Its patches go through define(), so uninstall() undoes them too.

type Extension = () => void;

const extensions = new Set<Extension>();
let active = false;

export function extend(apply: Extension): void {
  if (extensions.has(apply)) return;
  extensions.add(apply);
  if (active) apply();
}

/** Applies every registered feature, and any registered from now on. */
export function applyExtensions(): void {
  active = true;
  for (const apply of extensions) apply();
}

/** The polyfill was uninstalled: features registered from now on wait for the next install. */
export function pauseExtensions(): void {
  active = false;
}
