// Minimal static server for examples and browser tests.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { build } from 'esbuild';
import { bunPlugin as typegpu } from 'unplugin-typegpu';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.env.PORT ?? 4173);
// Pages that get the polyfill injected; `?force` polyfills even native support.
const injected = [join(root, 'examples', 'wicg'), join(root, 'examples', 'underglass')];

/**
 * Adds the polyfill to a page, right after its doctype. Root-relative
 * TypeScript entries, as in Vite projects, are resolved against the page.
 */
function withPolyfill(html, force) {
  const tag = `<script src="/dist/html-in-canvas-polyfill.iife.js"${force ? ' data-force' : ''}></script>`;
  return html
    .replace(/^(<!doctype html>\s*)?/i, (doctype) => `${doctype}${tag}\n`)
    .replace(/(<script\b[^>]*\bsrc=")\/([^"/][^"]*\.ts")/g, '$1./$2');
}

// TypeGPU's esbuild plugin parses TypeScript before esbuild strips the types.
// Its Bun plugin strips them first and uses esbuild's plugin API; it only
// needs `Bun.file` to read the source.
globalThis.Bun ??= { file: (path) => ({ text: () => readFile(path, 'utf8') }) };

/** Bundles a module with its npm imports; TypeScript gets TypeGPU's transform. */
async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    plugins: entry.endsWith('.ts') ? [typegpu({})] : [],
  });
  return result.outputFiles[0].contents;
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
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
      body = await bundle(file.replace(/\.bundle\.js$/, '.js'));
    } else if (extname(file) === '.ts' && file.startsWith(join(root, 'examples'))) {
      body = await bundle(file);
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
    if (/\.bundle\.js|\.ts\b/.test(req.url ?? '')) console.error(error);
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
