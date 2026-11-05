// Phase 0 spike runner: snapshots each fixture with every method in Chromium,
// Firefox, and WebKit, then records latency, taint/upload results, and pixel
// fidelity against a screenshot of the live DOM.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const METHODS = ['own-data-img', 'own-data-canvas', 'own-blob-img', 'own-blob-canvas', 'modern-screenshot', 'html-to-image'];
const DPRS = [1, 2];
const WARM_RUNS = 5;
const BROWSERS = { chromium, firefox, webkit };
const only = process.env.BROWSERS?.split(',');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serve(xorigin) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const path = normalize(join('public', url.pathname === '/' ? 'index.html' : url.pathname));
      if (!path.startsWith('public')) return res.writeHead(403).end();
      try {
        let body = await readFile(path);
        const headers = { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
        if (url.searchParams.has('cors')) headers['access-control-allow-origin'] = '*';
        if (path.endsWith('index.html')) body = body.toString().replaceAll('__XORIGIN__', xorigin());
        res.writeHead(200, headers).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let assetPort;
const main = await serve(() => `http://localhost:${assetPort}`);
const assets = await serve(() => '');
assetPort = assets.address().port;
const BASE = `http://127.0.0.1:${main.address().port}/`;

function diff(truthBuf, testBuf, diffPath) {
  const a = PNG.sync.read(truthBuf);
  const b = PNG.sync.read(testBuf);
  if (a.width !== b.width || a.height !== b.height) return { mismatch: null, note: `size ${b.width}x${b.height} vs ${a.width}x${a.height}` };
  const out = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: 0.1 });
  return { mismatch: +((100 * n) / (a.width * a.height)).toFixed(2), write: () => writeFile(diffPath, PNG.sync.write(out)) };
}

async function openPage(browser, dpr) {
  const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1000, height: 1800 } });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(String(e)));
  await page.goto(BASE);
  await page.waitForFunction(() => 'spike' in window);
  await page.evaluate(() => window.spike.ready());
  return { page, context, logs };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = { date: new Date().toISOString(), browsers: {}, native: null };
const chromiumImages = new Map();

for (const [name, type] of Object.entries(BROWSERS)) {
  if (only && !only.includes(name)) continue;
  let browser;
  try {
    browser = await type.launch(name === 'chromium' ? { channel: 'chromium', args: ['--enable-unsafe-webgpu'] } : {});
  } catch (e) {
    results.browsers[name] = { error: e.message.split('\n')[0] };
    console.log(`\n== ${name} launch failed: ${results.browsers[name].error}`);
    continue;
  }
  const entry = { version: browser.version(), runs: [], native: null };
  results.browsers[name] = entry;
  console.log(`\n== ${name} ${entry.version}`);

  for (const dpr of DPRS) {
    const dir = `results/${name}-dpr${dpr}`;
    await mkdir(dir, { recursive: true });
    const truthPage = await openPage(browser, dpr);
    const fixtures = await truthPage.page.evaluate(() => window.spike.fixtures());
    if (dpr === 1) entry.native = await truthPage.page.evaluate(() => window.spike.probeNative());
    const truth = {};
    for (const fx of fixtures) {
      truth[fx] = await truthPage.page.locator(`#${fx}`).screenshot();
      await writeFile(`${dir}/${fx}-truth.png`, truth[fx]);
    }
    await truthPage.context.close();

    for (const method of METHODS) {
      const { page, context, logs } = await openPage(browser, dpr);
      for (const fx of fixtures) {
        const cold = await page.evaluate(([m, f, d]) => window.spike.run(m, f, d), [method, fx, dpr]);
        const row = { browser: name, dpr, method, fixture: fx, ok: cold.ok, error: cold.error, coldMs: cold.totalMs, coldTimings: cold.timings, usage: cold.usage, nonEmpty: cold.nonEmpty, svgBytes: cold.svgBytes, warnings: cold.warnings };
        if (cold.ok) {
          await page.evaluate(([f, d]) => window.spike.show(f, d), [fx, dpr]);
          const coldShot = await page.locator('#out').screenshot();
          row.coldMismatch = diff(truth[fx], coldShot).mismatch;
          const warm = [];
          let last;
          for (let i = 0; i < WARM_RUNS; i++) {
            last = await page.evaluate(([m, f, d]) => window.spike.run(m, f, d, false), [method, fx, dpr]);
            if (last.ok) warm.push(last.totalMs);
          }
          row.warmMs = warm.length ? median(warm) : null;
          row.warmTimings = last?.timings;
          await page.evaluate(([f, d]) => window.spike.show(f, d), [fx, dpr]);
          const shot = await page.locator('#out').screenshot();
          await writeFile(`${dir}/${fx}-${method}.png`, shot);
          if (name === 'chromium') chromiumImages.set(`${dpr}/${fx}/${method}`, shot);
          const d = diff(truth[fx], shot, `${dir}/${fx}-${method}-diff.png`);
          row.mismatch = d.mismatch;
          row.mismatchNote = d.note;
          await d.write?.();
        }
        if (logs.length) row.consoleErrors = logs.splice(0);
        entry.runs.push(row);
        console.log(
          `${name} dpr${dpr} ${method.padEnd(17)} ${fx.padEnd(10)} ${row.ok ? 'ok ' : 'ERR'} cold=${row.coldMs?.toFixed(1) ?? '-'}ms warm=${row.warmMs?.toFixed(1) ?? '-'}ms diff=${row.mismatch ?? '-'}% (cold ${row.coldMismatch ?? '-'}%) 2d=${row.usage?.readback2d ?? '-'} gl=${row.usage?.webgl ?? '-'} gpu=${row.usage?.webgpu ?? '-'} ${row.error ?? ''}`,
        );
      }
      await context.close();
    }
  }
  await browser.close();
}

// Native baseline: Chromium with the HTML-in-Canvas runtime flag enabled.
if (!only || only.includes('native')) {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-blink-features=CanvasDrawElement'] });
  const native = { version: browser.version(), flag: 'CanvasDrawElement', runs: [] };
  results.native = native;
  console.log(`\n== native chromium ${native.version} (--enable-blink-features=CanvasDrawElement)`);
  for (const dpr of DPRS) {
    const dir = `results/native-dpr${dpr}`;
    await mkdir(dir, { recursive: true });
    const { page, context } = await openPage(browser, dpr);
    if (dpr === 1) native.probe = await page.evaluate(() => window.spike.probeNative());
    const fixtures = await page.evaluate(() => window.spike.fixtures());
    for (const fx of fixtures) {
      await page.evaluate(() => window.spike.resetNative());
      const truthShot = await page.locator(`#${fx}`).screenshot();
      const r = await page.evaluate(([f, d]) => window.spike.nativeRender(f, d), [fx, dpr]);
      const row = { dpr, fixture: fx, ok: r.ok, api: r.api, error: r.error };
      if (r.ok) {
        const shot = await page.locator('#native').screenshot();
        await writeFile(`${dir}/${fx}-native.png`, shot);
        row.mismatchVsLiveDom = diff(truthShot, shot, `${dir}/${fx}-native-diff.png`).mismatch;
        row.mismatchVsSnapshot = {};
        for (const method of METHODS) {
          const img =
            chromiumImages.get(`${dpr}/${fx}/${method}`) ??
            (await readFile(`results/chromium-dpr${dpr}/${fx}-${method}.png`).catch(() => null));
          if (img) row.mismatchVsSnapshot[method] = diff(shot, img).mismatch;
        }
      }
      native.runs.push(row);
      const vsOwn = row.mismatchVsSnapshot?.['own-data-canvas'];
      console.log(`native dpr${dpr} ${fx.padEnd(10)} ${r.ok ? 'ok' : 'ERR'} api=${r.api ?? '-'} vsDOM=${row.mismatchVsLiveDom ?? '-'}% vsOwn=${vsOwn ?? '-'}% ${r.error ?? ''}`);
    }
    await context.close();
  }
  await browser.close();
}

main.close();
assets.close();
await writeFile(`results/results${only ? `-${only.join('_')}` : ''}.json`, JSON.stringify(results, null, 2));
console.log('\nwrote results/');
