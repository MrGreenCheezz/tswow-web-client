/**
 * Lookdev stills of the real world, offline: the bench scene (a real `WorldRenderer3D` over the
 * immutable asset cache) rendered at a chosen time of day, camera and weather, with a player's
 * settings, and written out as PNGs. Nothing is timed and nothing is measured; the frames exist
 * to be looked at side by side — before and after a lighting, shadow, sky or weather change —
 * without a world server.
 *
 *   node bench/lookdev.mjs --scenario city --settings enhanced --out bench/results/lookdev-before
 *       --frame noon=1440,0.6,-0.35,18 --frame sunset=2100,2.2,-0.2,20 --frame rain=1600,0.6,-0.3,18,rain:0.9
 *
 * `--frame name=halfMinute,yaw,pitch,orbit[,weather:intensity][,@x/y]` may repeat; weather is
 * `rain`, `snow`, `thunder`, `fog` or `sand`; `@x/y` stands the player at those world coordinates
 * (movement scenario). The camera yaw is relative to the player, who faces west (orientation π):
 * yaw 4.712 looks west, toward the setting sun, and 1.571 east, toward the rising one. `--settings enhanced` is the «Улучшенная графика» preset over
 * the defaults; a path reads a settings file the way `bench/run.mjs --settings` does. `--population`
 * caps the city crowd (default 12: the crowd is not what a still is for). `--frames` is how many
 * frames each still lets run before its pixels are read (default 90; rain needs ~300 for its veil).
 * Missing assets are fetched from the gateway on `BENCH_GATEWAY_URL` (default 127.0.0.1:8090) and
 * kept in the cache, as the bench does.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const WEATHER_STATES = { rain: 5, snow: 8, thunder: 86, fog: 1, sand: 42 };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (Number(process.versions.node.split('.')[0]) < 22) {
  const localNode = resolve('.runtime/node/node.exe');
  await access(localNode).catch(() => { throw new Error('bench/lookdev.mjs requires Node >=22.15'); });
  const child = spawn(localNode, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  await once(child, 'exit');
} else {
  await main();
}

function parseFrame(spec) {
  const [name, rest] = spec.split('=');
  if (!name || !rest) throw new Error(`--frame expects name=halfMinute,yaw,pitch,orbit[,weather:intensity]: ${spec}`);
  const parts = rest.split(',');
  const [halfMinute, yaw, pitch, orbit] = parts.slice(0, 4).map(Number);
  if (![halfMinute, yaw, pitch, orbit].every(Number.isFinite)) throw new Error(`Bad numbers in --frame ${spec}`);
  let weather = null;
  let at;
  for (const part of parts.slice(4)) {
    if (part.startsWith('@')) {
      // `@x/y`: stand the player here (movement scenario only; the world streams in around them).
      const [x, y] = part.slice(1).split('/').map(Number);
      if (![x, y].every(Number.isFinite)) throw new Error(`Bad position in --frame ${spec}`);
      at = { x, y };
      continue;
    }
    const [kind, intensity] = part.split(':');
    const state = WEATHER_STATES[kind];
    if (state === undefined) throw new Error(`Unknown weather ${kind} in --frame ${spec}`);
    weather = { state, intensity: Number(intensity ?? 1), abrupt: true };
  }
  return { name, halfMinute, view: { yaw, pitch, orbit }, weather, at };
}

async function main() {
  const { default: puppeteer } = await import('puppeteer-core');
  const { buildBenchmarkBundle, BENCHMARK_SCRIPT_FILES } = await import('./build.mjs');
  const args = process.argv.slice(2);
  const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const values = (flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
  const config = JSON.parse(await readFile('bench/config.json', 'utf8'));
  const scenario = value('--scenario', 'city');
  if (!['city', 'movement'].includes(scenario)) throw new Error('--scenario must be city or movement');
  if (scenario === 'city') {
    config.city = JSON.parse(await readFile('bench/city.json', 'utf8'));
    config.city.population = Number(value('--population', 12));
    if (config.city.viewport) { config.width = config.city.viewport.width; config.height = config.city.viewport.height; }
  }
  config.width = Number(value('--width', config.width));
  config.height = Number(value('--height', config.height));
  config.viewFrames = Number(value('--frames', 90));
  const settingsArg = value('--settings');
  if (settingsArg === 'enhanced') {
    // The preset the page applies with «Улучшенная графика» (src/browser/ui/EnhancedGraphics.ts),
    // read from the compiled module so the stills use the same leaves the player gets.
    const { ENHANCED_GRAPHICS_OVERRIDES } = await import('../dist/code/browser/ui/EnhancedGraphics.js');
    config.settings = { ...ENHANCED_GRAPHICS_OVERRIDES };
  } else if (settingsArg) {
    const parsed = JSON.parse(await readFile(settingsArg, 'utf8'));
    config.settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
  }
  for (const pair of values('--set')) {
    // --set key=value: one setting over the preset (numbers and booleans are parsed).
    const [key, raw] = pair.split('=');
    config.settings ??= {};
    config.settings[key] = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  const frames = values('--frame').map(parseFrame);
  if (frames.length === 0) throw new Error('At least one --frame name=halfMinute,yaw,pitch,orbit[,weather:intensity]');
  const out = resolve(value('--out', `bench/results/lookdev-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`));
  await mkdir(out, { recursive: true });
  await mkdir('bench/build', { recursive: true });
  await mkdir('bench/cache', { recursive: true });
  const variantDir = value('--variant');
  await buildBenchmarkBundle('bench/build', variantDir);

  const sha = data => createHash('sha256').update(data).digest('hex');
  const cacheFile = resolve('bench/cache/index.json');
  const cache = JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}'));
  let cacheMisses = 0;
  const gateway = new URL(process.env.BENCH_GATEWAY_URL ?? 'http://127.0.0.1:8090');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname)) throw new Error('Lookdev gateway must be loopback');
  const allowed = /^(?:\/dbc\/(?:creature-models|character-appearance|light\/\d+|ground-effects|liquid-types)|\/terrain\/|\/visual\/|\/texture(?:\?|$)|\/terrain-splat\/|\/terrain-layer\/|\/ground-cover\/|\/liquid\/|\/horizon\/|\/environment\/)/;
  const pending = new Map();
  const blobTasks = new Map();
  async function asset(key) {
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      let entry = cache[key];
      if (!entry) {
        cacheMisses++;
        const response = await fetch(new URL(key, gateway), {
          headers: { Origin: 'http://127.0.0.1:5173' }, signal: AbortSignal.timeout(120000) });
        if (!response.ok && response.status !== 404) throw new Error(`Asset ${response.status}: ${key}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        entry = { status: response.status, type: response.headers.get('content-type') ?? 'application/octet-stream',
          sha256: sha(bytes), bytes: bytes.length };
        if (!blobTasks.has(entry.sha256)) {
          blobTasks.set(entry.sha256, writeFile(resolve('bench/cache', entry.sha256), bytes).then(() => bytes));
        }
        await blobTasks.get(entry.sha256);
        cache[key] = entry;
      }
      if (!blobTasks.has(entry.sha256)) blobTasks.set(entry.sha256, readFile(resolve('bench/cache', entry.sha256)));
      const bytes = await blobTasks.get(entry.sha256);
      if (sha(bytes) !== entry.sha256) throw new Error(`Asset cache hash mismatch: ${key}`);
      return { entry, bytes };
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      const key = url.pathname + url.search;
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><meta charset="utf-8"><title>Lookdev</title>
          <style>html,body{margin:0;overflow:hidden;background:#213243}canvas{display:block;width:${config.width}px;height:${config.height}px}</style>
          <script>window.__benchRenderers=[];window.__THREE_DEVTOOLS__={dispatchEvent(e){if(e.detail?.isWebGLRenderer)window.__benchRenderers.push(e.detail)}};</script>
          </head><body><canvas></canvas><script type="module" src="/harness.js"></script></body></html>`);
      } else if (url.pathname === '/config.json') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(config));
      } else if (Object.hasOwn(BENCHMARK_SCRIPT_FILES, url.pathname)) {
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(resolve('bench/build', BENCHMARK_SCRIPT_FILES[url.pathname])));
      } else if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
      } else if (/^\/textures\/water\/[A-Za-z]+_N\.jpg$/.test(url.pathname)) {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
          .end(await readFile(resolve('public', url.pathname.slice(1))));
      } else if (allowed.test(key)) {
        const { entry, bytes } = await asset(key);
        res.writeHead(entry.status, { 'content-type': entry.type, 'cache-control': 'public,max-age=31536000,immutable' }).end(bytes);
      } else {
        failures.push(`Unexpected route: ${key}`);
        res.writeHead(404).end();
      }
    } catch (error) {
      failures.push(error.message);
      if (!res.headersSent) res.writeHead(500);
      res.end('Lookdev asset failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.BENCH_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const headed = args.includes('--headed');
  const browser = await puppeteer.launch({ executablePath, headless: !headed,
    args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    defaultViewport: { width: config.width, height: config.height, deviceScaleFactor: config.pixelRatio }, protocolTimeout: 600000 });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(config.timeoutSeconds * 1000);
    page.on('pageerror', error => console.error(`Page error: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    // The first frame's time, camera and weather are in place before the scene settles, so its
    // assets (the rain textures, a night light table) are part of the preparation.
    const route = { ...config.route };
    const routeFor = (frame) => frame.at ? { ...route, x: frame.at.x, y: frame.at.y, dx: 0, dy: 0 } : route;
    const first = frames[0];
    config.halfMinute = first.halfMinute;
    config.view = first.view;
    config.weather = first.weather;
    config.route = routeFor(first);
    await page.goto(`${origin}/?scenario=${scenario}`, { waitUntil: 'load' });
    await Promise.race([
      page.waitForFunction(() => Boolean(window.__bench)),
      new Promise((_, reject) => page.once('pageerror', reject)),
    ]);
    const prepared = await page.evaluate(() => window.__bench.prepare());
    console.log(`${scenario}: ready, GPU ${prepared.hardware.gpu}`);
    const written = [];
    for (const frame of frames) {
      await page.evaluate((overrides) => window.__bench.lookdev(overrides),
        { halfMinute: frame.halfMinute, view: frame.view, weather: frame.weather, route: routeFor(frame) });
      const result = await page.evaluate(() => window.__bench.view(0));
      const png = Buffer.from(result.png.split(',')[1], 'base64');
      const path = resolve(out, `${frame.name}.png`);
      await writeFile(path, png);
      const shadows = await page.evaluate(() => window.__bench.shadowStats());
      written.push({ path, shadows });
      console.log(`${frame.name}: ${path} (${png.length} bytes) shadows ${JSON.stringify(shadows)}`);
    }
    await writeFile(resolve(out, 'lookdev.json'), JSON.stringify({ scenario, config, frames, written, cacheMisses, failures }, null, 2));
    if (failures.length) console.error(`Asset failures:\n${failures.join('\n')}`);
  } finally {
    await browser.close().catch(() => {});
    server.close();
    if (cacheMisses > 0) await writeFile(cacheFile, JSON.stringify(cache, null, 1));
  }
}
