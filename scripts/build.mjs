import { build } from 'esbuild';

const common = {
  bundle: true,
  target: 'es2020',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
};

await Promise.all([
  build({
    ...common,
    entryPoints: { index: 'src/index.ts', auto: 'src/auto.ts' },
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
]);
