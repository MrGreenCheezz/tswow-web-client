import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const directory = resolve('bench/results', stamp);
await mkdir(directory, { recursive: true });
const bundle = await build({ entryPoints: ['bench/additive-scene.mjs'], bundle: true,
  format: 'esm', write: false, sourcemap: 'inline', keepNames: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cache = JSON.parse(await readFile('bench/cache/index.json', 'utf8'));
const gateway = new URL(process.env.BENCH_GATEWAY_URL ?? 'http://127.0.0.1:8090');
if (!['localhost', '127.0.0.1', '[::1]'].includes(gateway.hostname)) throw new Error('Probe gateway must be loopback');
const pending = new Map(), requests = new Map(), errors = [];
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<style>body{margin:0}</style><script type="module" src="/probe.js"></script>'); return; }
    if (req.url === '/probe.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); return; }
    if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (!/^\/(?:visual\/(?:model|animations)|texture)\?/.test(req.url)) throw new Error('Unexpected probe route');
    const key = req.url;
    if (!pending.has(key)) pending.set(key, (async () => {
      let entry = cache[key], bytes;
      if (entry) bytes = await readFile(resolve('bench/cache', entry.sha256));
      else {
        const response = await fetch(new URL(key, gateway), {
          headers: { Origin: 'http://127.0.0.1:5173' }, signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`Probe asset HTTP ${response.status}: ${key}`);
        bytes = Buffer.from(await response.arrayBuffer());
        entry = { status: response.status, type: response.headers.get('content-type'), sha256: sha(bytes), bytes: bytes.length };
        await writeFile(resolve('bench/cache', entry.sha256), bytes);
        cache[key] = entry;
      }
      if (sha(bytes) !== entry.sha256) throw new Error('Probe asset hash mismatch');
      requests.set(key, entry.sha256);
      return { entry, bytes };
    })());
    const { entry, bytes } = await pending.get(key);
    res.writeHead(entry.status, { 'content-type': entry.type ?? 'application/octet-stream' }).end(bytes);
  } catch (error) { errors.push(error.message); res.writeHead(500).end('Probe asset failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const hostLoad = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', resolve('bench/host-load.ps1')],
  { encoding: 'utf8', windowsHide: true }));
try {
  const loadBefore = hostLoad();
  browser = await puppeteer.launch({ executablePath: process.env.BENCH_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--disable-frame-rate-limit', '--disable-gpu-vsync'],
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, protocolTimeout: 300000 });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.probeResult || window.probeError, { timeout: 300000 });
  const payload = await page.evaluate(() => ({ result: window.probeResult, error: window.probeError }));
  if (payload.error) throw new Error(payload.error);
  const { images, ...measurements } = payload.result;
  for (const [name, data] of Object.entries(images)) {
    await writeFile(resolve(directory, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
  }
  await browser.close(); browser = undefined;
  const loadAfter = hostLoad();
  const result = { kind: 'additive-pass-probe', timestamp: stamp, diagnostic: true, comparable: false,
    reason: 'Isolated effects and instrumentation; timings are not full-world FPS or an optimization acceptance test.',
    hostLoad: { before: loadBefore, after: loadAfter }, sourceHash: sha(bundle.outputFiles[0].contents),
    assets: Object.fromEntries(requests), ...measurements, errors };
  const output = `${directory}.json`;
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  await writeFile('bench/cache/index.json', JSON.stringify(cache, null, 2));
  console.log(JSON.stringify({ output, passed: result.passed, visual: result.visualSummary,
    counters: result.counterSummary, cpu: result.cpuSummary, errors }, null, 2));
  if (errors.length || !result.passed) process.exitCode = 1;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
