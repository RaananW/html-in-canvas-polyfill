import { readFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

// Stale code-split chunks would otherwise ship in the package.
await rm('dist', { recursive: true, force: true });

const { version } = JSON.parse(await readFile('package.json', 'utf8'));

const common = {
  bundle: true,
  target: 'es2020',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
  // `VERSION` and the published status report the package version.
  define: { __HIC_VERSION__: JSON.stringify(version) },
};

await Promise.all([
  build({
    ...common,
    entryPoints: { index: 'src/index.ts', auto: 'src/auto.ts', worker: 'src/worker.ts' },
    format: 'esm',
    splitting: true,
    outdir: 'dist',
  }),
  build({
    ...common,
    entryPoints: ['src/iife.ts'],
    format: 'iife',
    minify: true,
    outfile: 'dist/html-in-canvas-polyfill.iife.js',
  }),
  // For classic workers: importScripts('…/html-in-canvas-polyfill.worker.iife.js').
  build({
    ...common,
    entryPoints: ['src/worker.ts'],
    format: 'iife',
    minify: true,
    outfile: 'dist/html-in-canvas-polyfill.worker.iife.js',
  }),
]);
