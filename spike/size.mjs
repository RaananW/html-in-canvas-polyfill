// Minified + gzipped size of each snapshot approach, bundled the way a
// consumer would ship it (one entry point that uses the snapshot function).
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const entries = {
  'own serializer': `import { snapshot } from './src/serializer.ts'; globalThis.f = snapshot;`,
  'modern-screenshot (domToCanvas)': `import { domToCanvas } from 'modern-screenshot'; globalThis.f = domToCanvas;`,
  'html-to-image (toCanvas)': `import { toCanvas } from 'html-to-image'; globalThis.f = toCanvas;`,
};

const rows = [];
for (const [name, contents] of Object.entries(entries)) {
  const out = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    write: false,
  });
  const code = out.outputFiles[0].contents;
  rows.push({ name, min: code.length, gzip: gzipSync(code, { level: 9 }).length });
}

console.log('| Approach | min | min+gzip |\n|---|---:|---:|');
for (const r of rows) console.log(`| ${r.name} | ${(r.min / 1024).toFixed(1)} KB | ${(r.gzip / 1024).toFixed(1)} KB |`);
