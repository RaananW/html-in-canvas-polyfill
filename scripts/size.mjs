import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const result = await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2020',
  write: false,
});
const code = result.outputFiles[0].contents;
const gz = gzipSync(code, { level: 9 }).length;
console.log(`min: ${(code.length / 1024).toFixed(1)} KB, min+gzip: ${(gz / 1024).toFixed(1)} KB`);
const budget = Number(process.env.SIZE_BUDGET_KB ?? 16);
if (gz / 1024 > budget) {
  console.error(`over budget (${budget} KB)`);
  process.exit(1);
}
