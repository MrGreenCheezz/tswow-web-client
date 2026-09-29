import { access, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import { summarize } from './metrics.mjs';
import { DEFAULT_BENCHMARK_TARGET, parseBundleOptions } from './run-options.mjs';

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
  const { buildBenchmarkBundle, BENCHMARK_SCRIPT_FILES } = await import('./build.mjs');
  const { PNG } = await import('pngjs');
  const args = process.argv.slice(2);
  const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const config = JSON.parse(await readFile('bench/config.json', 'utf8'));
  const smoke = args.includes('--smoke');
  const prepareOnly = args.includes('--prepare');
  const trace = args.includes('--trace');
  // --links: the harness names the draw behind every program linked inside a measured frame.
  const links = args.includes('--links');
  // Allocation sampling over the measured seconds (CDP HeapProfiler): where the frame's garbage comes
  // from. Its own overhead makes the run incomparable, like --trace.
  const heapProfile = args.includes('--heap-profile');
  const diagnostic = args.includes('--diagnostic');
  const captureAbba = args.includes('--capture-abba');
  // Development runs under background load: the load is still recorded and the result is marked
  // incomparable, so such numbers can guide work but never replace a strict baseline.
  const allowLoad = args.includes('--allow-load');
  if (diagnostic && !trace) throw new Error('--diagnostic requires --trace; diagnostic timings are never comparable');
  if (smoke) { config.durationSeconds = 3; config.warmupSeconds = 1; }
  const scenarios = value('--scenario', config.scenarios.join(',')).split(',');
  if (captureAbba && (scenarios.length !== 1 || scenarios[0] !== 'world-crowd-50'
    || trace || diagnostic || smoke || prepareOnly || args.includes('--baseline'))) {
    throw new Error('--capture-abba requires --scenario world-crowd-50 without --trace, --diagnostic, --smoke, --prepare or --baseline');
  }
  // Development only: --cpu-class slowest pins benchmark Chrome to efficiency cores instead.
  // --cpu-class none leaves Chrome where Windows puts it, as a player's browser runs.
  const cpuClass = value('--cpu-class', 'fastest');
  if (!['fastest', 'slowest', 'none'].includes(cpuClass)) throw new Error('--cpu-class must be fastest, slowest or none');
  // --browser electron runs the scene in the Electron shell (electron/main.cjs), which applies
  // --cpu-class to its own processes; --headed shows Chrome's window instead of headless.
  const browserKind = value('--browser', 'chrome');
  if (!['chrome', 'electron'].includes(browserKind)) throw new Error('--browser must be chrome or electron');
  const headed = args.includes('--headed');
  const cpuPolicy = process.platform !== 'win32' || cpuClass === 'none'
    ? { policy: 'system-default', selected: null, mask: '0' }
    : JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      resolve(browserKind === 'electron' ? 'electron/cpu-policy.ps1' : 'bench/cpu-policy.ps1'), '-Class', cpuClass],
    { encoding: 'utf8', windowsHide: true }));
  config.cpuPolicy = { policy: cpuPolicy.policy, selected: cpuPolicy.selected };
  const supportedScenarios = [...config.scenarios, 'world-crowd-10', 'world-crowd-50',
    'world-crowd-64', 'world-crowd-200', 'city', 'city-arrival'];
  if (scenarios.some(s => !supportedScenarios.includes(s))) throw new Error('Unknown scenario');
  // Only a city run carries the city block, so every other scenario keeps its existing config hash.
  if (scenarios.some(isCityScenario)) {
    config.city = JSON.parse(await readFile('bench/city.json', 'utf8'));
    // The city is measured at the live client's canvas size, so it runs on its own.
    if (scenarios.length !== 1) throw new Error('The city scenario runs alone');
    if (config.city.viewport) { config.width = config.city.viewport.width; config.height = config.city.viewport.height; }
  }
  // A player's own account settings (the `settings` object of a freeze recording, or a file of just
  // those values): the harness pushes them to the renderer the way the page does
  // (src/browser/RendererGraphicsSettings.ts), over the scenario's own graphics block. Part of the
  // config, so only runs with the same settings share a config hash.
  const settingsFile = value('--settings');
  if (settingsFile) {
    const parsed = JSON.parse(await readFile(settingsFile, 'utf8'));
    config.settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const out = resolve('bench/results', stamp);
  await mkdir(out, { recursive: true });
  await mkdir('bench/build', { recursive: true });
  await mkdir('bench/cache', { recursive: true });
  const variantDir = value('--variant');
  // --target modules rebuilds the pre-MEM-1 production form (an A/B side; the run is invalid).
  const bundle = await buildBenchmarkBundle('bench/build', variantDir, parseBundleOptions(args));
  if (variantDir && bundle.variantFiles.length === 0) throw new Error(`--variant ${variantDir} replaced no source file`);
  const bundleTarget = bundle.bundleOptions.target;
  console.log(`Bundle target: ${[bundleTarget].flat().join(',')}${bundleTarget === DEFAULT_BENCHMARK_TARGET ? '' : ' (not the production target: the result is not valid)'}`);
  const sha = data => createHash('sha256').update(data).digest('hex');
  const sourceHashes = {};
  for (const path of Object.keys(bundle.metafile.inputs).sort()) {
    // A module only the variant has (see bench/build.mjs) is covered by its `variant:` hash below.
    sourceHashes[path] = await readFile(path).then(sha, () => 'variant-only');
  }
  // A variant file replaces its working-tree source in the bundle, so it is what the hash covers.
  for (const path of bundle.variantFiles) sourceHashes[`variant:${path}`] = sha(await readFile(path));
  const sourceHash = sha(JSON.stringify(sourceHashes));
  // How the sources were built, beside their hashes but outside sourceHash: two sides of an A/B that
  // differ only in --target keep one sourceHash and differ in `bundle`.
  sourceHashes['bundle-options'] = sha(JSON.stringify(bundle.bundleOptions));
  const configHash = sha(JSON.stringify(config));
  // The asset cache depends on scenes and views, never on which CPUs run the browser.
  const preparationHash = sha(JSON.stringify({ ...config, cpuPolicy: undefined }));
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
  // The page is cross-origin isolated like the dev server (vite.config.mjs), so the crowd pose
  // worker gets its SharedArrayBuffer. --no-isolation measures the page without it (dev only).
  const isolation = !args.includes('--no-isolation');
  // Electron and the dev server allow the JS Self-Profiling API (Document-Policy: js-profiling) for
  // the freeze recording. --js-profiling serves the bench page the same way, to measure its cost.
  const jsProfiling = args.includes('--js-profiling');
  // V8 switches for a diagnostic browser (--js-flags "--allow-natives-syntax"): the run is never valid.
  const jsFlags = value('--js-flags');
  const server = createServer(async (req, res) => {
    try {
      if (isolation) {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      }
      if (jsProfiling) res.setHeader('Document-Policy', 'js-profiling');
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
      } else if (Object.hasOwn(BENCHMARK_SCRIPT_FILES, url.pathname)) {
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(resolve('bench/build', BENCHMARK_SCRIPT_FILES[url.pathname])));
      } else if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
      } else if (/^\/textures\/water\/[A-Za-z]+_N\.jpg$/.test(url.pathname)) {
        // The repo's own ripple normal maps (public/), which the water leaves of a player's settings
        // (--settings) fetch from the page origin, as they do from Vite in the client.
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
          .end(await readFile(resolve('public', url.pathname.slice(1))));
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
  if (browserKind === 'electron') {
    const electronPath = resolve('electron/node_modules/electron/dist/electron.exe');
    try { await access(electronPath); executablePath = electronPath; } catch {}
    if (!executablePath) { server.close(); throw new Error('Electron not found; run npm install in electron/'); }
  } else {
    for (const path of executableCandidates) { try { await access(path); executablePath = path; break; } catch {} }
    if (!executablePath) { server.close(); throw new Error('Chrome not found; set BENCH_CHROME_PATH'); }
  }
  // The shell's --uncapped sets the same frame-rate and vsync switches; its main.cjs adds the
  // two backgrounding switches itself.
  const chromeArgs = browserKind === 'electron'
    ? [resolve('electron'), `--cpu-class=${cpuClass}`, `--window=${config.width}x${config.height}`, '--uncapped',
      ...(jsFlags ? [`--js-flags=${jsFlags}`] : [])]
    : ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--enable-precise-memory-info',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...(jsFlags ? [`--js-flags=${jsFlags}`] : [])];
  let browser;
  const result = { schemaVersion: 1, timestamp: stamp, label: value('--label', smoke ? 'smoke' : trace ? 'trace' : 'measurement'),
    smoke, trace, diagnostic, captureAbba, config, configHash, sourceHash, sourceHashes, bundle: bundle.bundleOptions,
    git: { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), dirty: Boolean(git('status', '--porcelain')) },
    host: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length,
      memoryBytes: os.totalmem(), node: process.version, cpuPolicy },
    browser: { kind: browserKind, headed: browserKind === 'electron' || headed, executablePath, args: chromeArgs,
      crossOriginIsolationHeaders: isolation, jsProfilingHeader: jsProfiling },
    scenarios: [], artifacts: `bench/results/${stamp}`, errors: [] };
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
  /** Starts the desktop shell on the scene and attaches over its DevTools port. */
  async function launchElectron(url) {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    probe.close();
    const child = spawn(executablePath, [...chromeArgs, `--webclient-url=${url}`, `--remote-debugging-port=${port}`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => process.stdout.write(`[electron] ${data}`));
    child.stderr.on('data', data => process.stderr.write(`[electron] ${data}`));
    let connected;
    for (let attempt = 0; attempt < 120 && !connected; attempt++) {
      if (child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}`);
      try {
        connected = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 300000 });
      } catch { await new Promise(done => setTimeout(done, 500)); }
    }
    if (!connected) { child.kill(); throw new Error('Electron DevTools endpoint did not answer'); }
    const disconnectAndClose = connected.close.bind(connected);
    connected.close = async () => {
      await disconnectAndClose().catch(() => {});
      if (child.exitCode === null) {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      }
    };
    return connected;
  }
  async function open(scenario) {
    const sceneUrl = `${origin}/?scenario=${scenario}${diagnostic ? '&diagnostic=1' : ''}${links ? '&links=1' : ''}`;
    let page;
    if (browserKind === 'electron') {
      browser = await launchElectron(sceneUrl);
      for (let attempt = 0; attempt < 60 && !page; attempt++) {
        page = (await browser.pages()).find(candidate => candidate.url().startsWith(origin));
        if (!page) await new Promise(done => setTimeout(done, 250));
      }
      if (!page) throw new Error('Electron window did not open the scene');
      await page.setViewport({ width: config.width, height: config.height, deviceScaleFactor: config.pixelRatio });
    } else {
      browser = await puppeteer.launch({ executablePath, headless: !headed, args: chromeArgs,
        defaultViewport: { width: config.width, height: config.height, deviceScaleFactor: config.pixelRatio }, protocolTimeout: 300000 });
      page = await browser.newPage();
    }
    result.browser.version = await browser.version();
    page.setDefaultTimeout(config.timeoutSeconds * 1000);
    const pageErrors = [];
    page.on('pageerror', error => { pageErrors.push(error.message); console.error(`Page error: ${error.message}`); });
    page.on('console', message => { if (message.type() === 'error') { pageErrors.push(message.text()); console.error(message.text()); } });
    await page.goto(sceneUrl, { waitUntil: 'load' });
    // The shell has already pinned itself; re-applying its own policy here verifies the mask on
    // every process it owns. With --cpu-class none nothing is touched.
    if (process.platform === 'win32' && cpuClass !== 'none') {
      const session = await browser.target().createCDPSession();
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      await session.detach();
      const policyArgs = browserKind === 'electron'
        ? ['-File', resolve('electron/cpu-policy.ps1'), '-Class', cpuClass, '-ProcessName', 'electron']
        : ['-File', resolve('bench/cpu-policy.ps1'), '-Class', cpuClass];
      const applied = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
        ...policyArgs, '-ProcessIds', processInfo.map(p => p.id).join(',')],
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
    if (prepareOnly || (!smoke && (preparedCache.configHash !== preparationHash
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
      await writeFile('bench/cache/prepared.json', JSON.stringify({ configHash: preparationHash, scenarios }));
      console.log(`Asset preparation complete (${Object.keys(cache).length} cached URLs).`);
    }
    if (captureAbba) {
      const scenario = scenarios[0];
      const preflightLoad = await hostLoad();
      if (preflightLoad?.externalCpuCores > 2) {
        result.host.blockedLoad = preflightLoad;
        throw new Error(`External CPU load ${preflightLoad.externalCpuCores.toFixed(2)} cores exceeds 2.0`);
      }
      const { page, pageErrors, prepared } = await open(scenario);
      const runs = [];
      result.captureAbbaResult = { scenario, prepared, runs, pageErrors };
      for (const [index, enabled] of [false, true, true, false].entries()) {
        const before = await hostLoad();
        if (before?.externalCpuCores > 2) {
          result.host.blockedLoad = before;
          throw new Error(`External CPU load before run ${index + 1}: ${before.externalCpuCores.toFixed(2)} cores`);
        }
        await page.evaluate(captureEnabled => window.__bench.setWorldSubmissionCapture(captureEnabled), enabled);
        const missesBefore = cacheMisses;
        const raw = await page.evaluate(() => window.__bench.run());
        const summary = summarize(raw);
        const after = await hostLoad();
        const measurementCacheMisses = cacheMisses - missesBefore;
        runs.push({ order: index + 1, captureEnabled: enabled, raw, summary,
          hostLoad: { before, after }, measurementCacheMisses });
        console.log(`ABBA ${index + 1}/4 capture=${enabled}: ${summary.averageFps.toFixed(2)} FPS; CPU ${summary.cpuMs.mean.toFixed(2)}ms; GPU ${summary.gpuMs.mean?.toFixed(2) ?? 'unavailable'}ms; heap peak ${summary.peakJsHeapBytes ?? 'unavailable'}`);
        if (after?.externalCpuCores > 2) result.errors.push(`ABBA run ${index + 1}: external CPU load exceeds 2.0 cores`);
        if (measurementCacheMisses) result.errors.push(`ABBA run ${index + 1}: ${measurementCacheMisses} uncached assets`);
        if (raw.routeHeightMissing) result.errors.push(`ABBA run ${index + 1}: ${raw.routeHeightMissing} frames without route height`);
        if (raw.readiness.pending || raw.readiness.errors) result.errors.push(`ABBA run ${index + 1}: scene not ready`);
        await writeFile(resultPath, JSON.stringify({ ...result, incomplete: true }, null, 2));
      }
      if (pageErrors.length) result.errors.push(...pageErrors.map(error => `ABBA: ${error}`));
      await browser.close(); browser = undefined;
    } else if (!prepareOnly) {
      const preparationRetries = new Map();
      for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
        const scenario = scenarios[scenarioIndex];
        console.log(`Starting ${scenario} (${config.durationSeconds}s measured)…`);
        const missesBefore = cacheMisses;
        const preflightLoad = await hostLoad();
        if (preflightLoad?.externalCpuCores > 2 && !diagnostic && !allowLoad) {
          result.host.blockedLoad = preflightLoad;
          throw new Error(`External CPU load ${preflightLoad.externalCpuCores.toFixed(2)} cores exceeds 2.0; benchmark conditions are not comparable`);
        }
        const { page, pageErrors, prepared } = await open(scenario);
        const loadBefore = await hostLoad();
        if (loadBefore?.externalCpuCores > 2 && !diagnostic && !allowLoad) {
          result.host.blockedLoad = loadBefore;
          throw new Error(`External CPU load ${loadBefore.externalCpuCores.toFixed(2)} cores exceeds 2.0; benchmark conditions are not comparable`);
        }
        const client = await page.createCDPSession();
        if (trace) await page.evaluate(() => {
          window.__benchProgramEvents = [];
          const renderer = window.__benchRenderers.at(-1);
          const seen = new Set(renderer.info.programs.map(p => p.id));
          window.__benchProgramEvents.push({ atMs: performance.now(), method: 'prepared',
            parallelShaderCompile: renderer.extensions.has('KHR_parallel_shader_compile'),
            checkShaderErrors: renderer.debug.checkShaderErrors,
            programs: renderer.info.programs.map(p => ({ id: p.id, type: p.type, cacheKey: p.cacheKey })) });
          // The first draw of every program created during the measurement: how long that draw
          // took (a program still linking makes it wait for the driver) and what drew it.
          window.__benchProgramFirstUse = [];
          window.__benchCompileCalls = [];
          // Free-form diagnostic records a --variant may push while traced (never read otherwise).
          window.__benchDebug = [];
          const firstUse = new Set(seen);
          const renderBufferDirect = renderer.renderBufferDirect;
          renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
            const start = performance.now();
            const result = renderBufferDirect.call(this, camera, scene, geometry, material, object, group);
            const program = renderer.properties.get(material)?.currentProgram;
            if (program && !firstUse.has(program.id)) {
              firstUse.add(program.id);
              const chain = [];
              for (let node = object; node && chain.length < 6; node = node.parent) chain.push(node.name || node.type);
              window.__benchProgramFirstUse.push({ atMs: start, id: program.id, drawMs: performance.now() - start,
                material: material.type, materialName: material.name, object: chain.join(' < '),
                shadow: scene === null || material.isMeshDepthMaterial === true || material.isMeshDistanceMaterial === true });
            }
            return result;
          };
          for (const method of ['compile', 'render']) {
            const original = renderer[method].bind(renderer);
            renderer[method] = (...args) => {
              const target = renderer.getRenderTarget();
              const began = performance.now();
              const result = original(...args);
              // Every warm-pass compile call: when, how many materials it prepared, how long it took.
              if (method === 'compile') window.__benchCompileCalls.push([began, result?.size ?? -1, performance.now() - began]);
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
        if (heapProfile) {
          await client.send('HeapProfiler.enable');
          await client.send('HeapProfiler.startSampling', { samplingInterval: 16384,
            includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        }
        const missesAtMeasurement = cacheMisses;
        const raw = await page.evaluate(() => window.__bench.run());
        if (heapProfile) {
          const sampled = await client.send('HeapProfiler.stopSampling');
          await writeFile(join(out, `${scenario}.heapprofile`), JSON.stringify(sampled.profile));
        }
        if (trace) raw.programEvents = await page.evaluate(() => window.__benchProgramEvents);
        if (trace) raw.programFirstUse = await page.evaluate(() => window.__benchProgramFirstUse);
        if (trace) raw.compileCalls = await page.evaluate(() => window.__benchCompileCalls);
        if (trace) raw.debug = await page.evaluate(() => window.__benchDebug);
        // performance.now() of the measurement start mark: aligns atMs above with frames[].rafAtMs.
        if (trace) raw.benchStartMs = await page.evaluate(() => performance.getEntriesByName('bench-start').at(-1)?.startTime ?? null);
        if (diagnostic) raw.sceneStats = await page.evaluate(() => window.__bench.sceneStats());
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
        if (scenario.startsWith('world-crowd-') || isCityScenario(scenario)) {
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
          screenshotPolicy: scenario.startsWith('world-crowd-') || isCityScenario(scenario) ? 'fresh-prepared-scene-v1' : 'after-measurement-v1',
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
    result.allowLoad = allowLoad;
    result.variant = variantDir ? { dir: variantDir, files: bundle.variantFiles } : null;
    // A player-style run (no pinning, a visible window or the desktop shell) answers a different
    // question than the strict P-core headless baseline, so it never replaces one.
    result.valid = result.errors.length === 0 && !smoke && !prepareOnly && !diagnostic && !allowLoad && !variantDir
      && browserKind === 'chrome' && !headed && cpuClass !== 'none' && isolation && !jsProfiling && !jsFlags
      && bundleTarget === DEFAULT_BENCHMARK_TARGET;
    result.comparable = result.valid && !trace && !captureAbba && !heapProfile;
    await writeFile(resultPath, JSON.stringify(result, null, 2));
    console.log(`Result: ${resultPath}`);
    if (result.errors.length) { console.error(result.errors.slice(0, 8).join('\n')); process.exitCode = 1; }
  }
}

/** The Stormwind square (bench/city.json): built before timing, or arriving during it. */
function isCityScenario(scenario) {
  return scenario === 'city' || scenario === 'city-arrival';
}

function movementFractions(scenario) {
  return scenario === 'movement' ? [0, .5, 1] : scenario.startsWith('world-crowd-') || isCityScenario(scenario) ? [0, .5] : [0, 1];
}
