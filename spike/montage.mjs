// Builds side-by-side comparison sheets: truth | method... per fixture.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';
const [dir, ...methods] = process.argv.slice(2);
const fixtures = [...new Set(readdirSync(dir).filter((f) => f.endsWith('-truth.png')).map((f) => f.replace('-truth.png', '')))];
for (const fx of fixtures) {
  const imgs = ['truth', ...methods].map((m) => {
    const p = `${dir}/${fx}-${m}.png`;
    return existsSync(p) ? PNG.sync.read(readFileSync(p)) : null;
  });
  const h = Math.max(...imgs.map((i) => i?.height ?? 0));
  const w = imgs.reduce((s, i) => s + (i?.width ?? 0) + 8, 0);
  const out = new PNG({ width: w, height: h });
  out.data.fill(80);
  let x = 0;
  for (const img of imgs) {
    if (!img) continue;
    PNG.bitblt(img, out, 0, 0, img.width, img.height, x, 0);
    x += img.width + 8;
  }
  writeFileSync(`${dir}/sheet-${fx}.png`, PNG.sync.write(out));
}
