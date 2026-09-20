import { access, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import { summarize } from './metrics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
// The repository requires Node >=22.15. A local runtime is already used by source tests on Windows.
if (Number(process.versions.node.split('.')[0]) < 22) {
  const localNode = resolve('.runtime/node/node.exe');
  await access(localNode).catch(() => { throw new Error('npm run bench requires Node >=22.15'); });
  const child = spawn(localNode, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  await once(child, 'exit');
} else {
  await main();
}

async function main() {
  if (process.argv.includes('--additive-probe')) { await import('./additive-probe.mjs'); return; }
  const { default: puppeteer } = await import('puppeteer-core');
  const { build } = await import('esbuild');
  const { PNG } = await import('pngjs');
  const args = process.argv.slice(2);
  const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const config = JSON.parse(await readFile('bench/config.json', 'utf8'));
  const smoke = args.includes('--smoke');
  const prepareOnly = args.includes('--prepare');
  const trace = args.includes('--trace');
  const diagnostic = args.includes('--diagnostic');
  if (diagnostic && !trace) throw new Error('--diagnostic requires --trace; diagnostic timings are never comparable');
  if (smoke) { config.durationSeconds = 3; config.warmupSeconds = 1; }
  const scenarios = value('--scenario', config.scenarios.join(',')).split(',');
  const cpuPolicy = process.platform === 'win32' ? JSON.parse(execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('bench/cpu-policy.ps1')],
    { encoding: 'utf8', windowsHide: true })) : { policy: 'system-default', selected: null };
  config.cpuPolicy = { policy: cpuPolicy.policy, selected: cpuPolicy.selected };
  const supportedScenarios = [...config.scenarios, 'world-crowd-50', 'world-crowd-200'];
  if (scenarios.some(s => !supportedScenarios.includes(s))) throw new Error('Unknown scenario');
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const out = resolve('bench/results', stamp);
  await mkdir(out, { recursive: true });
  await mkdir('bench/build', { recursive: true });
  await mkdir('bench/cache', { recursive: true });
  const bundle = await build({ entryPoints: ['src/browser/bench/Harness.ts'], outfile: 'bench/build/harness.js',
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: false,
    sourcemap: true, metafile: true, keepNames: true });
  const sha = data => createHash('sha256').update(data).digest('hex');
  const sourceHashes = {};
  for (const path of Object.keys(bundle.metafile.inputs).sort()) sourceHashes[path] = sha(await readFile(path));
  const sourceHash = sha(JSON.stringify(sourceHashes));
  const configHash = sha(JSON.stringify(config));
  const git = (...commands) => {
    try { return execFileSync('git', commands, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
  };
  const cacheFile = resolve('bench/cache/index.json');
  const cache = JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}'));
  const preparedCache = JSON.parse(await readFile('bench/cache/prepared.json', 'utf8').catch(() => '{}'));
  const pending = new Map();
  const blobTasks = new Map();
  const requested = new Map();
  const requestFailures = [];
  let cacheMisses = 0;
  const gateway = new URL(process.env.BENCH_GATEWAY_URL ?? 'http://127.0.0.1:8090');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname)) throw new Error('Benchmark gateway must be loopback');
  const allowed = /^(?:\/dbc\/(?:creature-models|character-appearance|light\/\d+|ground-effects|liquid-types)|\/terrain\/|\/visual\/|\/texture(?:\?|$)|\/terrain-splat\/|\/terrain-layer\/|\/ground-cover\/|\/liquid\/|\/horizon\/|\/environment\/)/;
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
        // Distinct URLs may name the same content. One writer per blob prevents a read racing
        // another URL's truncate/write of the same content-addressed file.
        if (!blobTasks.has(entry.sha256)) {
          blobTasks.set(entry.sha256, writeFile(resolve('bench/cache', entry.sha256), bytes).then(() => bytes));
        }
        await blobTasks.get(entry.sha256);
        cache[key] = entry;
      }
      if (!blobTasks.has(entry.sha256)) blobTasks.set(entry.sha256, readFile(resolve('bench/cache', entry.sha256)));
      const bytes = await blobTasks.get(entry.sha256);
      if (sha(bytes) !== entry.sha256) throw new Error(`Asset cache hash mismatch: ${key}`);
      requested.set(key, entry);
      return { entry, bytes };
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      const key = url.pathname + url.search;
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><meta charset="utf-8"><title>Three.js benchmark</title>
          <style>html,body{margin:0;overflow:hidden;background:#213243}canvas{display:block;width:${config.width}px;height:${config.height}px}</style>
          <script>window.__benchRenderers=[];window.__THREE_DEVTOOLS__={dispatchEvent(e){if(e.detail?.isWebGLRenderer)window.__benchRenderers.push(e.detail)}};</script>
          </head><body><canvas></canvas><script type="module" src="/harness.js"></script></body></html>`);
      } else if (url.pathname === '/config.json') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(config));
      } else if (['/harness.js', '/harness.js.map'].includes(url.pathname)) {
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(resolve('bench/build', url.pathname.slice(1))));
      } else if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
      } else if (allowed.test(key)) {
        const { entry, bytes } = await asset(key);
        res.writeHead(entry.status, { 'content-type': entry.type, 'cache-control': 'public,max-age=31536000,immutable' }).end(bytes);
      } else {
        requestFailures.push(`Unexpected route: ${key}`);
        res.writeHead(404).end();
      }
    } catch (error) {
      requestFailures.push(error.message);
      if (!res.headersSent) res.writeHead(500);
      res.end('Benchmark asset failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executableCandidates = [process.env.BENCH_CHROME_PATH,
    process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome',
    '/usr/bin/chromium'].filter(Boolean);
  let executablePath;
  for (const path of executableCandidates) { try { await access(path); executablePath = path; break; } catch {} }
  if (!executablePath) { server.close(); throw new Error('Chrome not found; set BENCH_CHROME_PATH'); }
  const chromeArgs = ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--enable-precise-memory-info',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
  let browser;
  const result = { schemaVersion: 1, timestamp: stamp, label: value('--label', smoke ? 'smoke' : trace ? 'trace' : 'measurement'),
    smoke, trace, diagnostic, config, configHash, sourceHash, sourceHashes,
    git: { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), dirty: Boolean(git('status', '--porcelain')) },
    host: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length,
      memoryBytes: os.totalmem(), node: process.version, cpuPolicy },
    browser: { executablePath, args: chromeArgs }, scenarios: [], artifacts: `bench/results/${stamp}`, errors: [] };
  const resultPath = resolve('bench/results', `${stamp}.json`);
  async function hostLoad() {
    if (process.platform !== 'win32') return null;
    const ids = [process.pid];
    if (browser) {
      const session = await browser.target().createCDPSession();
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      await session.detach();
      ids.push(...processInfo.map(p => p.id));
    }
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', resolve('bench/host-load.ps1'), '-ExcludeProcessIds', ids.join(',')],
    { encoding: 'utf8', windowsHide: true }));
  }
  async function open(scenario) {
    browser = await puppeteer.launch({ executablePath, headless: true, args: chromeArgs,
      defaultViewport: { width: config.width, height: config.height, deviceScaleFactor: config.pixelRatio }, protocolTimeout: 300000 });
    result.browser.version = await browser.version();
    const page = await browser.newPage();
    page.setDefaultTimeout(config.timeoutSeconds * 1000);
    const pageErrors = [];
    page.on('pageerror', error => { pageErrors.push(error.message); console.error(`Page error: ${error.message}`); });
    page.on('console', message => { if (message.type() === 'error') { pageErrors.push(message.text()); console.error(message.text()); } });
    await page.goto(`${origin}/?scenario=${scenario}${diagnostic ? '&diagnostic=1' : ''}`, { waitUntil: 'load' });
    if (process.platform === 'win32') {
      const session = await browser.target().createCDPSession();
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      await session.detach();
      const applied = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', resolve('bench/cpu-policy.ps1'), '-ProcessIds', processInfo.map(p => p.id).join(',')],
      { encoding: 'utf8', windowsHide: true }));
      if (applied.mask !== cpuPolicy.mask || applied.applied.length === 0) throw new Error('CPU policy was not applied');
    }
    await Promise.race([
      page.waitForFunction(() => Boolean(window.__bench)),
      new Promise((_, reject) => page.once('pageerror', reject)),
    ]);
    const prepared = await page.evaluate(() => window.__bench.prepare());
    console.log(`${scenario}: ready, GPU ${prepared.hardware.gpu}`);
    if (/swiftshader|llvmpipe|software rasterizer/i.test(prepared.hardware.gpu)) {
      throw new Error('Software GPU detected; hardware performance target cannot be evaluated');
    }
    return { page, pageErrors, prepared };
  }
  try {
    if (prepareOnly || (!smoke && (preparedCache.configHash !== configHash
      || scenarios.some(s => !preparedCache.scenarios?.includes(s))))) {
      console.log('Preparing immutable asset cache before measurement…');
      for (const scenario of scenarios) {
        const { page } = await open(scenario);
        // Key views alone miss assets only visible between them. Walk the exact timed route in
        // this disposable browser as well; no preparation timings are accepted as measurements.
        if (scenario === 'movement') await page.evaluate(() => window.__bench.run());
        for (const fraction of movementFractions(scenario)) await page.evaluate(f => window.__bench.view(f), fraction);
        await browser.close(); browser = undefined;
      }
      await writeFile('bench/cache/prepared.json', JSON.stringify({ configHash, scenarios }));
      console.log(`Asset preparation complete (${Object.keys(cache).length} cached URLs).`);
    }
    if (!prepareOnly) {
      const preparationRetries = new Map();
      for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
        const scenario = scenarios[scenarioIndex];
        console.log(`Starting ${scenario} (${config.durationSeconds}s measured)…`);
        const missesBefore = cacheMisses;
        const preflightLoad = await hostLoad();
        if (preflightLoad?.externalCpuCores > 2 && !diagnostic) {
          result.host.blockedLoad = preflightLoad;
          throw new Error(`External CPU load ${preflightLoad.externalCpuCores.toFixed(2)} cores exceeds 2.0; benchmark conditions are not comparable`);
        }
        const { page, pageErrors, prepared } = await open(scenario);
        const loadBefore = await hostLoad();
        if (loadBefore?.externalCpuCores > 2 && !diagnostic) {
          result.host.blockedLoad = loadBefore;
          throw new Error(`External CPU load ${loadBefore.externalCpuCores.toFixed(2)} cores exceeds 2.0; benchmark conditions are not comparable`);
        }
        const client = await page.createCDPSession();
        if (trace) await page.evaluate(() => {
          window.__benchProgramEvents = [];
          const renderer = window.__benchRenderers.at(-1);
          const seen = new Set(renderer.info.programs.map(p => p.id));
          window.__benchProgramEvents.push({ atMs: performance.now(), method: 'prepared',
            programs: renderer.info.programs.map(p => ({ id: p.id, type: p.type, cacheKey: p.cacheKey })) });
          for (const method of ['compile', 'render']) {
            const original = renderer[method].bind(renderer);
            renderer[method] = (...args) => {
              const target = renderer.getRenderTarget();
              const result = original(...args);
              const programs = renderer.info.programs.filter(p => !seen.has(p.id));
              for (const p of programs) seen.add(p.id);
              if (programs.length) window.__benchProgramEvents.push({ atMs: performance.now(), method,
                target: target ? { colorSpace: target.texture.colorSpace, type: target.texture.type } : null,
                outputColorSpace: renderer.outputColorSpace, toneMapping: renderer.toneMapping,
                programs: programs.map(p => ({ id: p.id, type: p.type, cacheKey: p.cacheKey })) });
              return result;
            };
          }
        });
        if (trace) await page.tracing.start({ path: join(out, `${scenario}.trace.json`), screenshots: false,
          categories: ['devtools.timeline', 'v8', 'blink.user_timing', 'gpu', 'disabled-by-default-devtools.timeline',
            'disabled-by-default-v8.gc', 'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.timeline.stack'] });
        if (trace) { await client.send('Profiler.enable'); await client.send('Profiler.setSamplingInterval', { interval: 1000 }); await client.send('Profiler.start'); }
        const missesAtMeasurement = cacheMisses;
        const raw = await page.evaluate(() => window.__bench.run());
        if (trace) raw.programEvents = await page.evaluate(() => window.__benchProgramEvents);
        if (trace) {
          const profile = await client.send('Profiler.stop');
          await writeFile(join(out, `${scenario}.cpuprofile`), JSON.stringify(profile.profile));
          await page.tracing.stop();
        }
        raw.hostLoad = { preflight: preflightLoad, before: loadBefore, after: await hostLoad() };
        if (raw.hostLoad.after?.externalCpuCores > 2) result.errors.push(`${scenario}: external CPU load after measurement exceeds 2.0 cores`);
        const measurementMisses = cacheMisses - missesAtMeasurement;
        // Asset demand can vary at frustum edges between preparation frames. These passes only
        // finish populating the immutable cache; never select or discard runs based on FPS.
        if (measurementMisses && !smoke && !trace && (preparationRetries.get(scenario) ?? 0) < 3) {
          preparationRetries.set(scenario, (preparationRetries.get(scenario) ?? 0) + 1);
          console.log(`${scenario}: preparing ${measurementMisses} newly discovered assets; discarding this preparation pass.`);
          await browser.close(); browser = undefined;
          scenarioIndex--;
          continue;
        }
        const summary = summarize(raw);
        const screenshots = [];
        // Timed admission depends on which boundary frames RAF reaches. Recreate world crowd
        // views so their pixels compare fixed preparation, not different streaming histories.
        let screenshotPage = page;
        let screenshotErrors = [];
        if (scenario.startsWith('world-crowd-')) {
          await browser.close(); browser = undefined;
          const fresh = await open(scenario);
          screenshotPage = fresh.page; screenshotErrors = fresh.pageErrors;
        }
        for (const fraction of movementFractions(scenario)) {
          const view = await screenshotPage.evaluate(f => window.__bench.view(f), fraction);
          const name = `${scenario}-${fraction}.png`;
          await writeFile(join(out, name), Buffer.from(view.png.split(',')[1], 'base64'));
          screenshots.push(name);
        }
        pageErrors.push(...screenshotErrors);
        const scenarioResult = { ...raw, summary, prepared, screenshots, pageErrors,
          screenshotPolicy: scenario.startsWith('world-crowd-') ? 'fresh-prepared-scene-v1' : 'after-measurement-v1',
          cacheMisses: cacheMisses - missesBefore, measurementCacheMisses: measurementMisses };
        result.scenarios.push(scenarioResult);
        await writeFile(resultPath, JSON.stringify({ ...result, incomplete: true }, null, 2));
        console.log(`${scenario}: ${summary.averageFps.toFixed(2)} FPS; 1% ${summary.onePercentLowFps.toFixed(2)}; p99 ${summary.p99FrameMs.toFixed(2)}ms; >30ms ${summary.framesOver30Ms}; CPU ${summary.cpuMs.mean.toFixed(2)}ms; GPU ${summary.gpuMs.mean?.toFixed(2) ?? 'unavailable'}ms`);
        await browser.close(); browser = undefined;
        if (pageErrors.length) result.errors.push(...pageErrors.map(error => `${scenario}: ${error}`));
        if (measurementMisses) result.errors.push(`${scenario}: ${measurementMisses} uncached assets during measurement; run npm run bench -- --prepare, then repeat`);
        if (raw.routeHeightMissing) result.errors.push(`${scenario}: ${raw.routeHeightMissing} frames without route height`);
      }
    }
    const baselinePath = value('--baseline');
    if (baselinePath) {
      const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
      if (baseline.configHash !== configHash) throw new Error('Baseline configuration mismatch');
      const baselineDir = resolve(baseline.artifacts);
      result.comparison = { baseline: baselinePath, screenshots: [], metrics: [] };
      for (const current of result.scenarios) {
        const before = baseline.scenarios.find(s => s.scenario === current.scenario);
        if (!before) throw new Error(`Baseline missing ${current.scenario}`);
        if ((before.screenshotPolicy ?? 'after-measurement-v1') !== current.screenshotPolicy) {
          throw new Error(`Screenshot policy changed for ${current.scenario}; capture a matching baseline`);
        }
        result.comparison.metrics.push({ scenario: current.scenario,
          fpsChangePercent: 100 * (current.summary.averageFps / before.summary.averageFps - 1),
          p99ChangePercent: 100 * (current.summary.p99FrameMs / before.summary.p99FrameMs - 1),
          longFramesBefore: before.summary.framesOver30Ms, longFramesAfter: current.summary.framesOver30Ms });
        for (const name of current.screenshots) {
          const a = PNG.sync.read(await readFile(join(baselineDir, name)));
          const b = PNG.sync.read(await readFile(join(out, name)));
          if (a.width !== b.width || a.height !== b.height) throw new Error('Screenshot size mismatch');
          let changedPixels = 0, sumDelta = 0, maxDelta = 0;
          for (let i = 0; i < a.data.length; i += 4) {
            let changed = false;
            for (let c = 0; c < 3; c++) {
              const delta = Math.abs(a.data[i + c] - b.data[i + c]);
              sumDelta += delta; maxDelta = Math.max(maxDelta, delta); changed ||= delta !== 0;
            }
            if (changed) changedPixels++;
          }
          result.comparison.screenshots.push({ name, changedPixels, maxDelta,
            meanChannelDelta: sumDelta / (a.width * a.height * 3) });
        }
      }
    }
  } catch (error) {
    result.errors.push(error.stack ?? String(error));
    console.error(error.stack ?? error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close(); server.closeAllConnections();
    await Promise.allSettled([...pending.values()]);
    await writeFile(cacheFile, JSON.stringify(cache, null, 2));
    result.assetManifest = Object.fromEntries([...requested.entries()].sort(([a], [b]) => a.localeCompare(b)));
    result.assetHash = sha(JSON.stringify(result.assetManifest));
    result.errors.push(...requestFailures);
    result.valid = result.errors.length === 0 && !smoke && !prepareOnly && !diagnostic;
    result.comparable = result.valid && !trace;
    await writeFile(resultPath, JSON.stringify(result, null, 2));
    console.log(`Result: ${resultPath}`);
    if (result.errors.length) { console.error(result.errors.slice(0, 8).join('\n')); process.exitCode = 1; }
  }
}

function movementFractions(scenario) {
  return scenario === 'movement' ? [0, .5, 1] : scenario.startsWith('world-crowd-') ? [0, .5] : [0, 1];
}
