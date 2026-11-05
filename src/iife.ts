import { install } from './index';

const script = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;
install({ force: script?.hasAttribute('data-force') ?? false });
