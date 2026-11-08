// Snapshot benchmark: runs the workloads in bench/workloads.mjs and reports
// what the polyfill spent on them.
//
//   node scripts/bench.mjs [--browser chromium|firefox|webkit] [--runs 3]
//                          [--dist dist] [--only name,...] [--external] [--json file]
//
// --dist serves another build (a directory like dist/) in place of dist/, so
// two builds can be compared. --external adds underglass.dev workloads, with
// the chosen build in place of the site's own polyfill.
//
// Per workload, medians over the runs:
//   snapshots   snapshots taken (the "html-in-canvas snapshot" user timing)
//   snapMs      their main-thread time in total, and the longest one
//   latency     a press, key or scripted change to the next paint, median and max
//   longTasks   long tasks and their total time
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from '@playwright/test';
import { EXTERNAL, WORKLOADS } from '../bench/workloads.mjs';

const { values: args } = parseArgs({
  options: {
    browser: { type: 'string', default: 'chromium' },
    runs: { type: 'string', default: '3' },
    dist: { type: 'string', default: 'dist' },
    only: { type: 'string' },
    external: { type: 'boolean', default: false },
    json: { type: 'string' },
    port: { type: 'string' },
  },
});

const dist = resolve(args.dist);
const runs = Number(args.runs);
// A free port unless one is given, on 127.0.0.1: Firefox and WebKit resolve
// localhost to IPv4 and Chromium to IPv6, which can reach different servers.
const port = args.port ?? (await new Promise((done) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => done(String(free)));
  });
}));
const base = `http://127.0.0.1:${port}`;
const engines = { chromium, firefox, webkit };
const only = args.only?.split(',');
const workloads = [...WORKLOADS, ...(args.external ? EXTERNAL : [])].filter((w) => !only || only.includes(w.name));

/** Measures snapshots, paint latency and long tasks in every page the context opens. */
const PROBE = `(() => {
  const m = { snapshots: [], latencies: [], longTasks: [], since: 0 };
  window.__bench = m;
  window.__benchChange = () => { m.since = performance.now(); };
  const listen = () => {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.name === 'html-in-canvas snapshot') m.snapshots.push(e.duration);
      }).observe({ type: 'measure', buffered: false });
    } catch {}
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) m.longTasks.push(e.duration); }).observe({ type: 'longtask' });
    } catch {}
  };
  listen();
  // Hover moves mostly don't repaint, so latency is measured from presses, keys and scripted changes.
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => { m.since = performance.now(); }, true);
  // paint doesn't bubble; a capturing listener still sees it.
  addEventListener('paint', () => {
    if (m.since) { m.latencies.push(performance.now() - m.since); m.since = 0; }
  }, true);
  m.reset = () => { m.snapshots.length = 0; m.latencies.length = 0; m.longTasks.length = 0; m.since = 0; };
})();`;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};
const round = (n) => (Number.isFinite(n) ? Math.round(n) : '-');

async function runOnce(browser, w) {
  // Playwright's Firefox reloads the first page of a context with a device scale factor.
  const scale = args.browser === 'firefox' ? {} : { deviceScaleFactor: 2 };
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ...scale });
  await context.addInitScript({ content: PROBE });
  if (w.inject) await context.addInitScript({ path: join(dist, 'html-in-canvas-polyfill.iife.js') });
  // The chosen build stands in for dist/ (and for the site's own copy with route).
  await context.route(/\/dist\/[^/]+$/, (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    route.fulfill({ contentType: file.endsWith('.map') ? 'application/json' : 'text/javascript', body: readFileSync(join(dist, file)) });
  });
  if (w.route) {
    await context.route(/\/assets\/(dist-[^/]+|chunk-[^/]+)\.js$/, (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(dist, name.startsWith('dist-') ? 'index.js' : name)) });
    });
  }
  const page = await context.newPage();
  if (w.url) {
    await page.goto(w.url.startsWith('http') ? w.url : base + w.url, { waitUntil: 'networkidle' });
  } else {
    // Playwright's Firefox reports this navigation as interrupted by itself, so
    // wait for the page's own ready flag rather than for load.
    await page.goto(`${base}/bench/index.html`, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__ready);
    await page.evaluate(async (html) => {
      document.body.innerHTML = html;
      const c = document.getElementById('c');
      const ctx = c.getContext('2d');
      const draw = () => {
        ctx.reset();
        for (const el of c.querySelectorAll(':scope > [drawable]')) ctx.drawElementImage(el, 0, 0);
      };
      await new Promise((r) => c.addEventListener('paint', r, { once: true }));
      draw();
      c.addEventListener('paint', draw);
    }, w.html());
  }
  if (w.start) await w.start(page);
  // Most workloads measure what they do; fromLoad ones measure the page loading.
  if (!w.fromLoad) {
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__bench.reset());
  }
  const t0 = Date.now();
  await w.act(page);
  await page.waitForTimeout(500);
  const wallMs = Date.now() - t0;
  const m = await page.evaluate(() => ({ snapshots: [...window.__bench.snapshots], latencies: [...window.__bench.latencies], longTasks: [...window.__bench.longTasks] }));
  await context.close();
  return {
    wallMs,
    snapshots: m.snapshots.length,
    snapMs: m.snapshots.reduce((a, b) => a + b, 0),
    snapMax: Math.max(0, ...m.snapshots),
    latencyMedian: median(m.latencies),
    latencyMax: Math.max(0, ...m.latencies),
    longTasks: m.longTasks.length,
    longMs: m.longTasks.reduce((a, b) => a + b, 0),
  };
}

const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ready) => server.stdout.once('data', ready));
const browser = await engines[args.browser].launch(args.browser === 'chromium' ? { channel: 'chromium', args: ['--enable-unsafe-webgpu'] } : {});
const report = [];
try {
  for (const w of workloads) {
    const results = [];
    for (let i = 0; i < runs; i++) results.push(await runOnce(browser, w));
    const mid = (key) => median(results.map((r) => r[key]));
    report.push({
      workload: w.name,
      snapshots: mid('snapshots'),
      snapMs: round(mid('snapMs')),
      snapMax: round(mid('snapMax')),
      latency: `${round(mid('latencyMedian'))} / ${round(mid('latencyMax'))}`,
      longTasks: `${mid('longTasks')} (${round(mid('longMs'))} ms)`,
    });
    console.error(`${w.name}: done`);
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(`${args.browser}, ${runs} runs, build ${args.dist}`);
console.table(report);
if (args.json) writeFileSync(args.json, JSON.stringify({ browser: args.browser, dist: args.dist, runs, report }, null, 2));
