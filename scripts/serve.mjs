// Minimal static server for examples and browser tests.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.env.PORT ?? 4173);
// Pages that get the polyfill injected; `?force` polyfills even native support.
const injected = [join(root, 'examples', 'wicg'), join(root, 'examples', 'underglass')];

/** Adds the polyfill to a page, right after its doctype. */
function withPolyfill(html, force) {
  const tag = `<script src="/dist/html-in-canvas-polyfill.iife.js"${force ? ' data-force' : ''}></script>`;
  return html.replace(/^(<!doctype html>\s*)?/i, (doctype) => `${doctype}${tag}\n`);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) throw new Error('outside root');
    let body;
    if (file.endsWith('.bundle.js')) {
      // `name.bundle.js` is `name.js` bundled with its npm imports.
      const result = await build({
        entryPoints: [file.replace(/\.bundle\.js$/, '.js')],
        bundle: true,
        format: 'esm',
        target: 'es2022',
        write: false,
        logLevel: 'silent',
      });
      body = result.outputFiles[0].contents;
    } else {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      body = await readFile(file);
      if (injected.some((dir) => file.startsWith(dir)) && extname(file) === '.html') {
        body = withPolyfill(body.toString(), url.searchParams.has('force'));
      }
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (error) {
    if (req.url?.includes('.bundle.js')) console.error(error);
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
