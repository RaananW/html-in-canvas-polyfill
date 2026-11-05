import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

mkdirSync('public/assets', { recursive: true });
copyFileSync('node_modules/@fontsource/lobster/files/lobster-latin-400-normal.woff2', 'public/assets/lobster.woff2');
// Strata (@underglass/ui): a real design system with cascade layers, token
// custom properties, an embedded @font-face and SVG mask images.
copyFileSync('node_modules/@underglass/ui/dist/css/strata.css', 'public/assets/strata.css');

// Deterministic 64x64 test image: hue gradient with a checker overlay.
const png = new PNG({ width: 64, height: 64 });
for (let y = 0; y < 64; y++) {
  for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4;
    const checker = ((x >> 3) + (y >> 3)) % 2 === 0;
    png.data[i] = x * 4;
    png.data[i + 1] = y * 4;
    png.data[i + 2] = checker ? 255 : 96;
    png.data[i + 3] = 255;
  }
}
writeFileSync('public/assets/photo.png', PNG.sync.write(png));

await build({
  entryPoints: ['src/harness.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outfile: 'public/dist/harness.js',
  logLevel: 'warning',
});
