import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

// Each entry is measured on its own, bundled and minified, against its budget in KB (min+gzip).
const entries = [
  // 19.5 KB: postMessage and MessageEvent.data wrappers for workers (about 1.3 KB; docs/WORKERS.md).
  // 20.5 KB: :hover analysis that skips snapshots pointer moves can't change (about 0.95 KB).
  // 21 KB: batched paints, cached authored styles and ElementImage canvas checks (about 0.3 KB together).
  // 23 KB: incremental snapshots (about 1.4 KB; docs/INCREMENTAL.md). The cap for now is 25 KB.
  { entry: 'src/index.ts', budget: Number(process.env.SIZE_BUDGET_KB ?? 23) },
  { entry: 'src/worker.ts', budget: Number(process.env.WORKER_SIZE_BUDGET_KB ?? 4) },
];

let over = false;
for (const { entry, budget } of entries) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2020',
    write: false,
    define: { __HIC_VERSION__: '"0.0.0"' },
  });
  const code = result.outputFiles[0].contents;
  const gz = gzipSync(code, { level: 9 }).length;
  console.log(`${entry}: min: ${(code.length / 1024).toFixed(1)} KB, min+gzip: ${(gz / 1024).toFixed(2)} KB (budget ${budget} KB)`);
  if (gz / 1024 > budget) {
    console.error(`${entry} is over budget (${budget} KB)`);
    over = true;
  }
}
if (over) process.exit(1);
