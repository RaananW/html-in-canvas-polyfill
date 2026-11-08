import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

// Each entry is measured on its own, bundled and minified, against its budget in KB (min+gzip).
const entries = [
  // 19.5 KB: the main entry also wraps postMessage and MessageEvent.data so ElementImage can cross into workers (about 1.3 KB; docs/WORKERS.md).
  { entry: 'src/index.ts', budget: Number(process.env.SIZE_BUDGET_KB ?? 19.5) },
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
