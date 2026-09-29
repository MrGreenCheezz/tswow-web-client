import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Optional source argument permits comparing an exact saved working-tree baseline, not git HEAD.
const out = resolve(process.argv[2] ?? '.runtime/warmup-probe');
const source = resolve(process.argv[3] ?? 'src/browser/ProgramWarmup.ts');
const entry = (await readFile('tools/performance-warmup-scenario.ts', 'utf8'))
  .replace("'../src/browser/ProgramWarmup.js'", JSON.stringify(source));
await mkdir(out, { recursive: true });
await build({ stdin: { contents: entry, loader: 'ts', resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  outfile: resolve(out, 'warmup-scenario.js') });
await writeFile(resolve(out, 'warmup-scenario.html'), `<!doctype html><html><head>
<meta charset="utf-8"><title>Warmup lifetime probe</title></head>
<body style="background:#15181d;color:#ddd;font:14px monospace">
<h1>Synthetic warmup lifetime probe</h1><canvas></canvas>
<p><button>Run 8 disposal cycles</button></p><pre id="warmup-result"></pre>
<p><button id="compiled-disposal">Dispose compiled program before settling</button></p>
<pre id="compiled-disposal-result"></pre>
<script type="module" src="/warmup-scenario.js"></script></body></html>`);
console.log(`Built synthetic probe: ${out}`);
