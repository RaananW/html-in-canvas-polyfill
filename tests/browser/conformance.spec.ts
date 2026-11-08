import { expect, test } from '@playwright/test';
import { BASIC, load } from './helpers';

// Runs against native Chromium (project "native") and the polyfill in every
// other project. Expectations are the native behavior unless noted.
test.beforeEach(async ({ page }, info) => {
  await load(page, info.project.name === 'native');
});

test('reflects the content attribute', async ({ page }) => {
  const result = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const values: string[] = [c.content];
    c.setAttribute('content', 'DRAWABLE');
    values.push(c.content);
    c.setAttribute('content', 'bogus');
    values.push(c.content);
    c.content = 'drawable';
    values.push(c.getAttribute('content')!);
    return values;
  });
  expect(result).toEqual(['fallback', 'drawable', 'fallback', 'drawable']);
});

test('fires paint and draws grid-sized snapshots', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const event = await new Promise<CanvasPaintEvent>((r) => c.addEventListener('paint', r as EventListener, { once: true }));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawElementImage(a, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return {
      type: event.constructor.name,
      bubbles: event.bubbles,
      changed: event.changedElements.map((e) => e.id).sort(),
      inside: px(98, 38),
      outside: px(102, 42),
      image: (() => {
        const img = c.captureElementImage(a);
        return [img.width, img.height];
      })(),
    };
  }, BASIC);
  expect(result.type).toBe('CanvasPaintEvent');
  expect(result.bubbles).toBe(false);
  expect(result.changed).toEqual(['a', 'b']);
  expect(result.inside).toEqual([255, 0, 0, 255]);
  expect(result.outside).toEqual([0, 0, 0, 0]);
  expect(result.image).toEqual([100, 40]);
});

// Libraries skip elements that checkVisibility reports hidden (Underglass's
// Strata draws no relief for them): drawn children must stay visible to it.
test('drawn children stay visible to checkVisibility', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `
      <canvas id="c" width="400" height="200" content="drawable">
        <div id="a" drawable style="width:50px;height:20px"><span id="inner">text</span><span id="faded" style="opacity:0">x</span></div>
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const check = (id: string) => document.getElementById(id)!.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    return { a: check('a'), inner: check('inner'), faded: check('faded') };
  });
  expect(result).toEqual({ a: true, inner: true, faded: false });
});

test('maps source rectangles in CSS pixels', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `
      <canvas id="c" width="400" height="200" content="drawable">
        <div id="a" drawable style="width:40px;height:20px;box-sizing:border-box;border-left:20px solid rgb(255,0,0);background:rgb(0,0,255)"></div>
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    // Right half of the element (CSS px 20..40) drawn at the origin.
    ctx.drawElementImage(a, 20, 0, 20, 20, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return { first: px(2, 2), last: px(38, 38), beyond: px(42, 2) };
  });
  expect(result.first).toEqual([0, 0, 255, 255]);
  expect(result.last).toEqual([0, 0, 255, 255]);
  expect(result.beyond).toEqual([0, 0, 0, 0]);
});

test('reports changed elements after a style change and requestPaint', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const next = () =>
      new Promise<string[]>((r) =>
        c.addEventListener('paint', (e) => r((e as CanvasPaintEvent).changedElements.map((x) => x.id)), { once: true }),
      );
    await next();
    const style = next();
    document.getElementById('a')!.style.background = 'rgb(0,255,0)';
    const afterStyle = await style;
    const request = next();
    c.requestPaint();
    const afterRequest = await request;
    return { afterStyle, afterRequest };
  }, BASIC);
  expect(result.afterStyle).toEqual(['a']);
  expect(result.afterRequest).toEqual([]);
});

test('paint after requestPaint has records for children added in the same task', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const n = document.createElement('div');
    n.id = 'n';
    n.setAttribute('drawable', '');
    n.style.cssText = 'width:10px;height:10px;background:rgb(0,0,255)';
    c.append(n);
    c.requestPaint();
    return new Promise<number[] | string>((resolve) =>
      c.addEventListener(
        'paint',
        () => {
          try {
            const ctx = c.getContext('2d', { willReadFrequently: true })!;
            ctx.drawElementImage(n, 0, 0);
            resolve(Array.from(ctx.getImageData(10, 10, 1, 1).data));
          } catch (e) {
            resolve(String(e));
          }
        },
        { once: true },
      ),
    );
  }, BASIC);
  expect(result).toEqual([0, 0, 255, 255]);
});

test('an ElementImage is only drawn into the canvas it was captured from', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `
      <canvas id="c" width="400" height="200" content="drawable"><div id="a" drawable style="width:50px;height:20px;background:red"></div></canvas>
      <canvas id="d" width="400" height="200" content="drawable"><div id="b" drawable style="width:5px;height:5px;background:blue"></div></canvas>
      <canvas id="g" width="400" height="200" content="drawable"></canvas>
      <canvas id="t" width="400" height="200" content="drawable"><div id="f" drawable style="width:5px;height:5px;background:blue"></div></canvas>
      <canvas id="plain" width="10" height="10"></canvas>`;
    const byId = (id: string) => document.getElementById(id) as HTMLCanvasElement;
    const [c, d, t] = [byId('c'), byId('d'), byId('t')];
    await Promise.all([c, d, t].map((x) => new Promise((r) => x.addEventListener('paint', r, { once: true }))));
    const a = document.getElementById('a')!;
    const image = () => c.captureElementImage(a);
    const attempt = (fn: () => unknown) => {
      try {
        fn();
        return 'ok';
      } catch (e) {
        return `${(e as Error).name}: ${(e as Error).message}`;
      }
    };
    const r: Record<string, string> = {
      same: attempt(() => c.getContext('2d')!.drawElementImage(image(), 0, 0)),
      other: attempt(() => d.getContext('2d')!.drawElementImage(image(), 0, 0)),
      plain: attempt(() => byId('plain').getContext('2d')!.drawElementImage(image(), 0, 0)),
    };
    // Native Chromium 156 has no getElementImageDefaultSize.
    if ('getElementImageDefaultSize' in d) r.defaultSize = attempt(() => d.getElementImageDefaultSize(image()));
    const gl = byId('g').getContext('webgl2');
    if (gl) {
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 128, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      r.webgl = attempt(() => gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image()));
    }
    if (typeof OffscreenCanvas !== 'undefined' && 'transferControlToOffscreen' in t) {
      r.fresh = attempt(() => new OffscreenCanvas(10, 10).getContext('2d')!.drawElementImage(image(), 0, 0));
      const offscreen = t.transferControlToOffscreen();
      const ctx = offscreen.getContext('2d')!;
      r.transferred = attempt(() => ctx.drawElementImage(t.captureElementImage(document.getElementById('f')!), 0, 0));
      r.transferredOther = attempt(() => ctx.drawElementImage(image(), 0, 0));
    }
    // The image stays bound to the canvas it was captured from.
    const before = image();
    d.append(a);
    await new Promise((res) => setTimeout(res, 50));
    r.movedOriginal = attempt(() => c.getContext('2d')!.drawElementImage(before, 0, 0));
    r.movedNew = attempt(() => d.getContext('2d')!.drawElementImage(before, 0, 0));
    return r;
  });
  const other = 'InvalidStateError: The source was captured from a different canvas.';
  const message = (s: string) => s.replace(/Failed to execute '[^']+' on '[^']+': /, '');
  const actual = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, message(v)]));
  expect(actual).toEqual({
    same: 'ok',
    other,
    plain: other,
    ...('defaultSize' in result ? { defaultSize: other } : {}),
    ...('webgl' in result ? { webgl: other } : {}),
    ...('fresh' in result ? { fresh: other, transferred: 'ok', transferredOther: other } : {}),
    movedOriginal: 'ok',
    movedNew: other,
  });
});

test('throws InvalidStateError for undrawable sources', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML =
      html +
      '<canvas id="plain" width="10" height="10"></canvas>' +
      '<canvas id="other" width="10" height="10" content="drawable"></canvas>';
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const ctx = c.getContext('2d')!;
    const attempt = (fn: () => void) => {
      try {
        fn();
        return 'ok';
      } catch (e) {
        return `${(e as Error).name}: ${(e as Error).message}`;
      }
    };
    const beforePaint = attempt(() => ctx.drawElementImage(a, 0, 0));
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const other = (document.getElementById('other') as HTMLCanvasElement).getContext('2d')!;
    const wrongCanvas = attempt(() => other.drawElementImage(a, 0, 0));
    const plain = (document.getElementById('plain') as HTMLCanvasElement).getContext('2d')!;
    const notDrawable = attempt(() => plain.drawElementImage(a, 0, 0));
    const image = c.captureElementImage(a);
    image.close();
    const closed = attempt(() => ctx.drawElementImage(image, 0, 0));
    return { beforePaint, wrongCanvas, notDrawable, closed };
  }, BASIC);
  // Native prefixes messages with "Failed to execute ...".
  expect(result.beforePaint).toMatch(/^InvalidStateError: .*No cached paint record for element\.$/);
  expect(result.wrongCanvas).toMatch(
    /^InvalidStateError: .*The element can only be drawn into its nearest ancestor <canvas>\.$/,
  );
  expect(result.notDrawable).toMatch(
    /^InvalidStateError: .*DrawElementImage requires the canvas to have the content=drawable attribute\.$/,
  );
  expect(result.closed).toMatch(/^InvalidStateError: .*The ElementImage has been closed\.$/);
});

test('lays out each child on its own, shrink-to-fit, against the content box', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(6);
    document.body.innerHTML = `
      <style>.chart .label { width: 77px }</style>
      <div style="line-height:1.5">
        <canvas id="c" class="chart" content="drawable" style="display:block;width:300px;height:200px;padding:5px;border:2px solid">
          <div id="margins" drawable style="margin:0 20px">${long}</div>
          <div id="short" drawable>short</div>
          <div id="half" drawable style="height:50%">half</div>
          <div id="max" drawable style="max-width:40%">${long}</div>
          <div id="full" drawable style="box-sizing:border-box;width:100%;padding:10px">full</div>
          <span id="inline" drawable>inline</span>
          <div id="big" drawable style="font-size:30px">big</div>
          <div id="label" class="label" drawable>label</div>
        </canvas>
      </div>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const paint = () => new Promise((r) => c.addEventListener('paint', r, { once: true }));
    await paint();
    const el = (id: string) => document.getElementById(id)!;
    const before = el('label').offsetWidth;
    c.className = '';
    c.requestPaint();
    await paint();
    return {
      margins: el('margins').offsetWidth,
      short: el('short').offsetWidth < 100,
      half: el('half').offsetHeight,
      max: el('max').offsetWidth,
      full: el('full').offsetWidth,
      inline: getComputedStyle(el('inline')).display,
      lineHeight: getComputedStyle(el('big')).lineHeight,
      label: [before, el('label').offsetWidth < 77],
    };
  });
  expect(result).toEqual({
    margins: 260,
    short: true,
    half: 100,
    max: 120,
    full: 300,
    inline: 'block',
    lineHeight: '45px',
    label: [77, true],
  });
});

// A shrink-to-fit wrapping row whose width (273.28125px) computes to a rounded
// "273.281px": drawn on one line, as laid out, not with its last item wrapped.
test('keeps a shrink-to-fit row on one line', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const item = (width: string, colour: string) => `<span style="flex:none;width:${width};height:20px;background:${colour}"></span>`;
    document.body.innerHTML = `
      <canvas id="c" width="600" height="160" style="width:300px;height:80px" content="drawable">
        <div id="row" drawable style="display:flex;flex-wrap:wrap;gap:12px;width:fit-content">
          ${item('34px', 'rgb(255,0,0)')}${item('34px', 'rgb(255,0,0)')}${item('60.921875px', 'rgb(255,0,0)')}${item('62.359375px', 'rgb(255,0,0)')}${item('34px', 'rgb(0,255,0)')}
        </div>
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const row = document.getElementById('row')!;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawElementImage(row, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    // In grid pixels (scale 2): the last item ends the first line, nothing starts a second.
    return { height: row.offsetHeight, last: px(512, 20), second: px(20, 84) };
  });
  expect(result.height).toBe(20);
  expect(result.last).toEqual([0, 255, 0, 255]);
  expect(result.second).toEqual([0, 0, 0, 0]);
});

test('canvas element accessors list the drawable children', async ({ page }) => {
  const result = await page.evaluate(async (html) => {
    document.body.innerHTML = html;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    return [
      Array.from(c.children, (e) => e.id),
      c.childElementCount,
      c.firstElementChild?.id,
      c.lastElementChild?.id,
      c.querySelector('#b')?.id,
      c.querySelectorAll('div').length,
      document.getElementById('a')!.parentElement === c,
      document.getElementById('a')!.closest('canvas') === c,
      document.getElementById('a')!.closest('body') === document.body,
    ];
  }, BASIC);
  expect(result).toEqual([['a', 'b'], 2, 'a', 'b', 'b', 2, true, true, true]);
});

test('element geometry leaves computed styles alone, for nested content added in the same task', async ({ page }) => {
  const supported = await page.evaluate(() => 'updateElementGeometry' in HTMLCanvasElement.prototype);
  test.skip(!supported, 'This build lacks updateElementGeometry');
  const result = await page.evaluate(async () => {
    document.body.innerHTML = '<canvas id="c" width="200" height="100" content="drawable"></canvas>';
    const c = document.getElementById('c') as HTMLCanvasElement;
    const wrap = document.createElement('div');
    const a = document.createElement('div');
    a.setAttribute('drawable', '');
    a.style.cssText = 'width:40px;height:20px';
    wrap.append(a);
    c.append(wrap);
    c.updateElementGeometry(a, { canvasTransform: new DOMMatrix().translate(50, 25).rotate(10), canvasClip: new DOMRect(0, 0, 20, 20) });
    await new Promise(requestAnimationFrame);
    const cs = getComputedStyle(a);
    return [cs.transform, cs.zIndex, cs.position, cs.getPropertyValue('clip-path'), cs.width, a.closest('canvas') === c];
  });
  expect(result).toEqual(['none', 'auto', 'static', 'none', '40px', true]);
});

// Blink and WebKit include a caption in a table's computed height; a specified
// height excludes it, so pinning the computed one would grow the rows.
test('draws a table with a caption at its own row heights', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const row = (colour: string) => `<tr><td style="height:20px;padding:0;background:${colour}"></td></tr>`;
    document.body.innerHTML = `
      <canvas id="c" width="600" height="240" style="width:300px;height:120px" content="drawable">
        <div id="d" drawable style="width:300px;height:120px">
          <table id="t" style="border-spacing:0;width:100px">
            <caption style="height:30px;padding:0">Invoices</caption>${row('rgb(255,0,0)')}${row('rgb(0,255,0)')}
          </table>
        </div>
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const t = document.getElementById('t')!;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawElementImage(document.getElementById('d')!, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    // In grid pixels (scale 2): the rows span 30–70 CSS px, under the caption.
    return { height: t.offsetHeight, first: px(100, 70), second: px(100, 130), below: px(100, 150) };
  });
  expect(result.height).toBe(70);
  expect(result.first).toEqual([255, 0, 0, 255]);
  expect(result.second).toEqual([0, 255, 0, 255]);
  expect(result.below).toEqual([0, 0, 0, 0]);
});

test('computed styles of an element with geometry stay current within a task', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `
      <style>.moved > [drawable] { transform: translateX(3px) }</style>
      <canvas id="c" width="200" height="100" content="drawable"></canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const wrap = document.createElement('div');
    const a = document.createElement('div');
    a.setAttribute('drawable', '');
    a.style.cssText = 'width:40px;height:20px';
    wrap.append(a);
    c.append(wrap);
    c.updateElementGeometry(a, { canvasTransform: new DOMMatrix().translate(50, 25) });
    await new Promise(requestAnimationFrame);
    const cs = getComputedStyle(a);
    const out = [cs.zIndex, cs.position, cs.transform];
    a.style.zIndex = '5';
    out.push(cs.zIndex);
    a.style.position = 'relative';
    out.push(cs.getPropertyValue('position'));
    wrap.classList.add('moved');
    out.push(cs.transform, getComputedStyle(a).getPropertyValue('transform'));
    return out;
  });
  expect(result).toEqual(['auto', 'static', 'none', '5', 'relative', 'matrix(1, 0, 0, 1, 3, 0)', 'matrix(1, 0, 0, 1, 3, 0)']);
});

test('nested drawables keep their space in the parent snapshot', async ({ page }) => {
  const result = await page.evaluate(async () => {
    document.body.innerHTML = `
      <canvas id="c" width="300" height="50" content="drawable" style="width:300px;height:50px">
        <div id="p" drawable style="font:20px monospace;color:#000">AAA<span id="nested" drawable>BBB</span><span id="tail">CCC</span></div>
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawElementImage(document.getElementById('p')!, 0, 0);
    const dark = (el: HTMLElement) => {
      const { data } = ctx.getImageData(el.offsetLeft + 1, 0, el.offsetWidth - 2, 30);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 128) n++;
      return n;
    };
    return { nested: dark(document.getElementById('nested')!), tail: dark(document.getElementById('tail')!) > 20 };
  });
  expect(result).toEqual({ nested: 0, tail: true });
});

test('draws open shadow trees with slotted content, and redraws on shadow changes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    if (!customElements.get('x-shadow-box')) {
      customElements.define(
        'x-shadow-box',
        class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' }).innerHTML = `
              <style>:host { display: block; color: rgb(0, 0, 255) } #s { width: 40px; height: 20px; background: rgb(255, 0, 0) }</style>
              <div id="s"></div><slot></slot><slot name="none"><i style="display:block;height:10px;background:rgb(0,128,0)"></i></slot>`;
          }
        },
      );
    }
    document.body.innerHTML = `
      <canvas id="c" width="200" height="100" content="drawable">
        <x-shadow-box id="a" drawable style="width:50px"><b style="display:block;height:10px;background:currentColor"></b></x-shadow-box>
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const a = document.getElementById('a')!;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const paint = () =>
      new Promise<void>((r) =>
        c.addEventListener('paint', () => {
          ctx.reset();
          ctx.drawElementImage(a, 0, 0);
          r();
        }, { once: true }),
      );
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    await paint();
    const before = { shadow: px(10, 10), slotted: px(10, 25), fallback: px(10, 35), size: [a.offsetWidth, a.offsetHeight] };
    (a.shadowRoot!.getElementById('s') as HTMLElement).style.background = 'rgb(255, 255, 0)';
    // Setup can leave a paint pending; wait for the one with the change.
    for (let i = 0; i < 5 && px(10, 10)[1] !== 255; i++) await paint();
    return { ...before, after: px(10, 10) };
  });
  expect(result).toEqual({
    shadow: [255, 0, 0, 255],
    slotted: [0, 0, 255, 255],
    fallback: [0, 128, 0, 255],
    size: [50, 40],
    after: [255, 255, 0, 255],
  });
});

// Selection highlights and carets. The field is drawn at 2x; with 20px
// monospace text after 5px of border and padding, characters 1-3 span grid
// columns 34-81 and the caret after character 3 covers columns 82-83.
type SelectionScenario = 'div' | 'input' | 'editable-caret' | 'input-caret';
async function selectionScenario(page: import('@playwright/test').Page, kind: SelectionScenario) {
  return page.evaluate(async (kind) => {
    const style = 'font:20px monospace;width:180px;border:1px solid black;padding:4px;outline:none;caret-color:rgb(255,0,0)';
    const field = kind.startsWith('input')
      ? `<input id="f" style="${style}" value="abcdef">`
      : `<div id="f" ${kind === 'div' ? '' : 'contenteditable'} style="${style}">abcdef</div>`;
    document.body.innerHTML = `<canvas id="c" width="400" height="200" content="drawable" style="width:200px;height:100px"><div id="a" drawable style="width:200px;height:100px;background:white">${field}</div></canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const frames: Array<{ t: number; highlight: number[]; outside: number[]; caret: number[] }> = [];
    const t0 = performance.now();
    c.onpaint = () => {
      ctx.reset();
      ctx.drawElementImage(document.getElementById('a')!, 0, 0);
      const data = ctx.getImageData(0, 0, 400, 200).data;
      const px = (x: number, y: number) => Array.from(data.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 3));
      const caret: number[] = [];
      for (let x = 0; x < 400; x++) {
        const [r, g, b] = px(x, 34);
        if (r! > 200 && g! < 60 && b! < 60) caret.push(x);
      }
      frames.push({ t: performance.now() - t0, highlight: px(60, 14), outside: px(100, 14), caret });
    };
    while (frames.length === 0) await new Promise((r) => setTimeout(r, 20));
    const initial = frames.length;
    const f = document.getElementById('f') as HTMLInputElement;
    f.focus();
    const [start, end] = kind.endsWith('caret') ? [3, 3] : [1, 3];
    if (kind.startsWith('input')) f.setSelectionRange(start, end);
    else {
      const r = document.createRange();
      r.setStart(f.firstChild!, start);
      r.setEnd(f.firstChild!, end);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
    }
    await new Promise((r) => setTimeout(r, 1300));
    const after = frames.slice(initial);
    // Clearing the selection removes the highlight.
    if (kind.startsWith('input')) f.setSelectionRange(0, 0);
    getSelection()!.removeAllRanges();
    f.blur();
    await new Promise((r) => setTimeout(r, 300));
    // The browser's Highlight system color over white.
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'Highlight';
    document.body.append(probe);
    const [r, g, b, alpha = 1] = getComputedStyle(probe).backgroundColor.match(/[\d.]+/g)!.map(Number);
    probe.remove();
    const highlight = [r!, g!, b!].map((v) => Math.round(v * alpha + 255 * (1 - alpha)));
    return { hasFocus: document.hasFocus(), highlight, initial: frames[initial - 1], after, cleared: frames.at(-1) };
  }, kind);
}

const WHITE = [255, 255, 255];
const near = (a: number[] | undefined, b: number[]) => !!a && a.every((v, i) => Math.abs(v - b[i]!) <= 4);

for (const kind of ['div', 'input'] as const) {
  test(`draws the selection highlight in ${kind === 'div' ? 'text' : 'a text input'}`, async ({ page }) => {
    const result = await selectionScenario(page, kind);
    expect(near(result.initial?.highlight, WHITE)).toBe(true);
    // rgb(179,215,254) in Chromium and WebKit.
    const selected = result.after.find((f) => near(f.highlight, result.highlight));
    expect(selected, JSON.stringify(result.after)).toBeTruthy();
    expect(near(selected!.outside, WHITE)).toBe(true);
    expect(selected!.caret).toEqual([]);
    expect(near(result.cleared?.highlight, WHITE)).toBe(true);
  });
}

for (const kind of ['input-caret', 'editable-caret'] as const) {
  test(`draws a blinking caret in ${kind === 'input-caret' ? 'a text input' : 'contenteditable'}`, async ({ page }) => {
    const result = await selectionScenario(page, kind);
    test.skip(!result.hasFocus, 'carets are only drawn while the document has focus');
    expect(result.initial?.caret).toEqual([]);
    const on = result.after.findIndex((f) => f.caret.length > 0);
    expect(on, JSON.stringify(result.after)).toBeGreaterThanOrEqual(0);
    expect(result.after[on]!.caret).toEqual([82, 83]);
    // The caret toggles about every 500ms, with a paint event each time.
    const off = result.after.slice(on).find((f) => f.caret.length === 0);
    expect(off).toBeTruthy();
    expect(off!.t - result.after[on]!.t).toBeGreaterThan(350);
    expect(off!.t - result.after[on]!.t).toBeLessThan(700);
    expect(result.cleared?.caret).toEqual([]);
  });
}

test('changes made together are painted together, even when one snapshot is slower', async ({ page }) => {
  const result = await page.evaluate(async () => {
    // #big has 400 children and gains an uncached background image, which the
    // polyfill fetches before decoding, so its snapshot takes far longer than #small's.
    const cells = Array.from({ length: 400 }, (_, i) => `<span style="display:inline-block;width:4px;height:4px;background:rgb(${i % 255},0,0)"></span>`).join('');
    document.body.innerHTML = `
      <canvas id="c" width="400" height="200" content="drawable">
        <div id="big" drawable style="width:160px;line-height:0">${cells}</div>
        <div id="small" drawable style="width:10px;height:10px;background:rgb(0,0,255)"></div>
      </canvas>`;
    const c = document.getElementById('c') as HTMLCanvasElement;
    await new Promise((r) => c.addEventListener('paint', r, { once: true }));
    const paints: string[][] = [];
    c.addEventListener('paint', (e) => paints.push((e as CanvasPaintEvent).changedElements.map((x) => x.id).sort()));
    document.getElementById('big')!.style.background = `rgb(0,255,0) url(/examples/wicg/wolf.jpg?${Math.random()}) no-repeat`;
    document.getElementById('small')!.style.background = 'rgb(255,0,0)';
    const until = performance.now() + 3000;
    while (!paints.some((p) => p.includes('big')) && performance.now() < until) await new Promise((r) => setTimeout(r, 20));
    return paints;
  });
  expect(result[0]).toEqual(['big', 'small']);
});
