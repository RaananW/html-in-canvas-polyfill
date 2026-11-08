// Benchmark workloads, run by scripts/bench.mjs. Each one builds a page (or
// opens one), then drives it the way a user would. They cover where snapshot
// cost comes from: layer size, how much of it a change touches, and changes
// that touch everything.

/** One canvas holding `layer` as its only drawable child; the runner redraws it on every paint. */
export function canvasPage(layer, css = '') {
  return `<style>${css}</style><canvas id="c" width="1600" height="1200" content="drawable">${layer}</canvas>`;
}

const repeat = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join('');

/** Clicks the centre of `selector`. */
async function clickOn(page, selector) {
  await page.locator(selector).click();
}

export const WORKLOADS = [
  {
    name: 'form-typing',
    about: 'Type 20 characters into one field of a 40-field form (about 200 elements).',
    html: () =>
      canvasPage(
        `<form id="layer" drawable style="width:760px;display:grid;grid-template-columns:repeat(2,1fr);gap:6px 16px;padding:12px;background:#f6f7f9">
          ${repeat(40, (i) => `<label style="display:flex;flex-direction:column;gap:2px"><span style="color:#445">Field ${i}</span><input id="f${i}" value="Value ${i}" style="padding:4px 6px;border:1px solid #99a;border-radius:4px"></label>`)}
        </form>`,
      ),
    async act(page) {
      await clickOn(page, '#f10');
      await page.waitForTimeout(400);
      for (let i = 0; i < 20; i++) {
        await page.keyboard.type('x');
        await page.waitForTimeout(120);
      }
    },
  },
  {
    name: 'list-update',
    about: 'Change the text of one row of a 1,000-row list, 10 times.',
    html: () =>
      canvasPage(
        `<ul id="layer" drawable style="width:760px;margin:0;padding:8px 8px 8px 28px;columns:4;font-size:11px">
          ${repeat(1000, (i) => `<li id="r${i}" style="color:${i % 2 ? '#333' : '#335'}">Row ${i} <b>${i * 7}</b></li>`)}
        </ul>`,
      ),
    async act(page) {
      for (let i = 0; i < 10; i++) {
        await page.evaluate((n) => {
          window.__benchChange();
          document.querySelector('#r500 b').textContent = String(n * 1000);
        }, i);
        await page.waitForTimeout(250);
      }
    },
  },
  {
    name: 'grid-hover',
    about: 'Move over 40 of 300 buttons with :hover and :active styles, then click 5.',
    html: () =>
      canvasPage(
        `<div id="layer" drawable style="width:780px;display:grid;grid-template-columns:repeat(20,1fr);gap:4px;padding:6px">
          ${repeat(300, (i) => `<button id="b${i}">${i}</button>`)}
        </div>`,
        `#layer button { padding: 6px 0; border: 1px solid #889; border-radius: 4px; background: #eef; font: inherit }
         #layer button:hover { background: #cdf }
         #layer button:active { background: #9bf }`,
      ),
    async act(page) {
      for (let i = 0; i < 40; i++) {
        const box = await page.locator(`#b${(i * 7) % 300}`).boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
        await page.waitForTimeout(60);
      }
      for (let i = 0; i < 5; i++) {
        await clickOn(page, `#b${100 + i * 13}`);
        await page.waitForTimeout(300);
      }
    },
  },
  {
    name: 'theme-switch',
    about: 'Switch the colours of a 300-element layer 6 times: a change that touches everything.',
    html: () =>
      canvasPage(
        `<div id="layer" drawable style="width:760px;padding:8px;display:flex;flex-wrap:wrap;gap:4px">
          ${repeat(300, (i) => `<span class="chip">Item ${i}</span>`)}
        </div>`,
        `#layer { --bg: #fff; --fg: #222; --chip: #eee; background: var(--bg); color: var(--fg) }
         #layer.dark { --bg: #111; --fg: #eee; --chip: #333 }
         .chip { padding: 2px 6px; border-radius: 8px; background: var(--chip) }`,
      ),
    async act(page) {
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => {
          window.__benchChange();
          document.getElementById('layer').classList.toggle('dark');
        });
        await page.waitForTimeout(500);
      }
    },
  },
  {
    name: 'large-transition',
    about: 'Click a button with a 300 ms background transition in a 500-element layer, 3 times.',
    html: () =>
      canvasPage(
        `<div id="layer" drawable style="width:760px;padding:8px">
          <button id="go">Toggle</button>
          <div style="display:grid;grid-template-columns:repeat(10,1fr);gap:2px;margin-top:6px">${repeat(500, (i) => `<i style="height:8px;background:hsl(${i % 360},60%,70%)"></i>`)}</div>
        </div>`,
        `#go { padding: 8px 16px; border: 0; border-radius: 6px; background: #ddd; transition: background 300ms linear }
         #go.on { background: #36f }`,
      ),
    async act(page) {
      await page.evaluate(() => document.getElementById('go').addEventListener('click', (e) => e.target.classList.toggle('on')));
      for (let i = 0; i < 3; i++) {
        await clickOn(page, '#go');
        await page.waitForTimeout(1000);
      }
    },
  },
  ...['complex-text', 'pie-chart', 'nested-sparkles'].map((demo) => ({
    name: `wicg-${demo}`,
    about: `The WICG ${demo}.html demo, from navigation to 3 s later: small layers.`,
    url: `/examples/wicg/${demo}.html?force`,
    fromLoad: true,
    async act(page) {
      await page.waitForTimeout(3000);
    },
  })),
];

/**
 * External pages, with --external: the local build replaces the site's own
 * polyfill copy (compare) or is injected (Strata, which doesn't offer one).
 */
export const EXTERNAL = [
  {
    name: 'underglass-compare-hover',
    about: "Hover 150 points over underglass.dev's compare demo in GPU mode.",
    url: 'https://underglass.dev/examples/compare',
    route: true,
    async start(page) {
      await page.getByRole('button', { name: 'Run GPU mode on the polyfill' }).click();
      await page.waitForFunction(() => document.body.innerText.includes('Running on the HTML-in-Canvas polyfill'), null, { timeout: 30000 });
      await page.waitForTimeout(2000);
    },
    async act(page) {
      const box = await page.locator('canvas').first().boundingBox();
      for (let i = 0; i < 150; i++) {
        const x = box.x + box.width * (0.1 + (0.8 * ((i * 37) % 100)) / 100);
        const y = box.y + box.height * (0.1 + (0.8 * ((i * 53) % 100)) / 100);
        await page.mouse.move(x, y, { steps: 4 });
      }
    },
  },
  {
    name: 'underglass-strata-clicks',
    about: "Click 5 toggle buttons in underglass.dev's Strata gallery (one 502-element layer) in GPU mode.",
    url: 'https://underglass.dev/examples/strata',
    inject: true,
    async start(page) {
      await page.getByRole('button', { name: 'Enable experimental GPU' }).click();
      await page.waitForFunction(() => document.body.innerText.includes('GPU active'), null, { timeout: 30000 });
      await page.waitForTimeout(2000);
    },
    async act(page) {
      for (const label of ['Bold', 'Italic', 'Underline', 'Left', 'Centre']) {
        await page.locator('[data-hic-host] button', { hasText: new RegExp(`^${label}$`) }).first().click();
        await page.waitForTimeout(1500);
      }
    },
  },
];
