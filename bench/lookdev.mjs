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
 * (movement scenario); `@x/y/map` on the first frame also loads that map (1: Kalimdor). The camera yaw is relative to the player, who faces west (orientation π):
 * yaw 4.712 looks west, toward the setting sun, and 1.571 east, toward the rising one. `--settings enhanced` is the «Улучшенная графика» preset over
 * the defaults; a path reads a settings file the way `bench/run.mjs --settings` does. `--population`
 * caps the city crowd (default 12: the crowd is not what a still is for). `--frames` is how many
 * frames each still lets run before its pixels are read (default 90; rain needs ~300 for its veil).
 * Missing assets are fetched from the gateway on `BENCH_GATEWAY_URL` (default 127.0.0.1:8090) and
 * kept in the cache, as the bench does.
 *
 * 23.10 (6.27): `--spell <Spell.dbc id>` or `--kit <SpellVisualKit id>` turns each frame into a spell-visual
 * strip: the visual is cast on the bench player (caster and target, as SMSG_SPELL_GO for a self-buff) and a
 * frame is read at every `--shots ms,ms,...` after the cast (default 0,150,300,500,800,1200,1800); the stills
 * are `<frame>-<ms>.png` and, with `--crop WxH[+dy]` (a box around the canvas centre), `<frame>-strip.png`.
 * Use `--scenario city --population 1` so nothing else walks through the shot.
 * 25.10 (6.27): `--from dx,dy` casts from a point beside the player at the player (Fireball's bolt flies into the
 * shot and lands on the chest); `--phase cast` plays the precast for `--cast-ms` (default 1000) before the GO, and
 * `--phase state` the aura's StateKit (Power Word: Shield's bubble).
 *
 * 23.10 (7.48): `--hd-textures [dir]` serves effect textures from the HD sets `tools/upscale-textures.mjs` built
 * (default `.runtime/hd-textures`) straight off the disk, as a gateway with them would, so HD stills need no gateway
 * restart. The page is told an HD generation; it asks with `hd=` only while «Чёткие текстуры эффектов» is on
 * (`--settings enhanced`, or `--set experimentalSharpEffectTextures=false` for the originals in the same setup).
 * 23.10/24.10 (7.48 steps 2–3): the world set's BC7 copies too — ground layers, building textures and (step 3) the
 * scenery models' `/texture` textures — while `--set experimentalSharpWorldTextures=true`.
 *
 * 24.10 (7.50): `--lamp-tables` answers `/visual/wmo-lamps` (the buildings' lamp tables) the way a gateway with the
 * route does, from the artifacts this harness serves; without it that route is the older gateway's 404.
 *
 * 25.10 (7.50): `--lit-models [file]` answers `/visual/lit-models` (the models that declare their own M2 lights) from
 * `tools/generate-lit-model-index.mjs`'s output (default `.runtime/lane-tails/lit-models.json`), as a gateway with the
 * route does; without it that route is the older gateway's 404 (never fetched from the gateway, never cached).
 *
 * 24.10 (7.50): the screen-space lamp pools (`src/browser/LightPools.ts`): `--light-pools off` draws without them,
 * `--forward-lights N` caps the forward set (0: every lamp's pool in screen space), and every still prints the
 * frame's pool counts and the lamps in view by distance (`lightPoolStats`); `--leaf-cost lightPools` times them.
 *
 * 25.10 (7.51): `@x/y/map/z` on a frame and `"z"` in a `--light-trace` spec stand the player on a floor over the
 * terrain — Dalaran's streets are at z ≈ 648, the ground of its map under them at ≈ 160 (`@5804/624/571/648`).
 */
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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

/** 23.10 (6.27): a TypeScript module bundled on the fly, for a worktree without `dist/code`. */
async function importSource(path) {
  const { build } = await import('esbuild');
  const result = await build({ entryPoints: [path], bundle: true, format: 'esm', platform: 'neutral', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
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
      // 22.10 (7.30): `@x/y/map` also picks the map (the first frame's map is the one loaded).
      // 25.10 (7.51): `@x/y/map/z` stands the player on a floor over the terrain (Dalaran).
      const [x, y, map, z] = part.slice(1).split('/').map(Number);
      if (![x, y].every(Number.isFinite)) throw new Error(`Bad position in --frame ${spec}`);
      at = Number.isInteger(map) ? { x, y, map, ...(Number.isFinite(z) ? { z } : {}) } : { x, y };
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
  const { buildBenchmarkBundle, buildRenderWorkerBench, BENCHMARK_SCRIPT_FILES, RENDER_WORKER_SCRIPT_FILES } = await import('./build.mjs');
  const args = process.argv.slice(2);
  const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const values = (flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
  const config = JSON.parse(await readFile('bench/config.json', 'utf8'));
  const scenario = value('--scenario', 'city');
  if (!['city', 'movement'].includes(scenario)) throw new Error('--scenario must be city or movement');
  if (scenario === 'city') {
    config.city = JSON.parse(await readFile('bench/city.json', 'utf8'));
    config.city.population = Number(value('--population', 12));
    // 23.10 (7.46): `--city-at x/y/z` stands the city crowd and player elsewhere on the city floor.
    const cityAt = value('--city-at');
    if (cityAt) {
      const [x, y, z] = cityAt.split('/').map(Number);
      if (![x, y, z].every(Number.isFinite)) throw new Error(`--city-at expects x/y/z: ${cityAt}`);
      Object.assign(config.city, { x, y, z });
    }
    if (config.city.viewport) { config.width = config.city.viewport.width; config.height = config.city.viewport.height; }
  }
  config.width = Number(value('--width', config.width));
  config.height = Number(value('--height', config.height));
  config.viewFrames = Number(value('--frames', 90));
  const settingsArg = value('--settings');
  if (settingsArg === 'enhanced') {
    // The preset the page applies with «Улучшенная графика» (src/browser/ui/EnhancedGraphics.ts),
    // read from the compiled module so the stills use the same leaves the player gets.
    // 23.10 (6.27): a worktree has no dist/code; the preset is then bundled from the source.
    const { ENHANCED_GRAPHICS_OVERRIDES } = await import('../dist/code/browser/ui/EnhancedGraphics.js')
      .catch(() => importSource('src/browser/ui/EnhancedGraphics.ts'));
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
  // 24.10 (7.50): `--light-trace spec.json` (repeatable): when each light first appears on a night run or after a
  // teleport (src/browser/bench/LightTrace.ts); the movement scenario. Without `--frame` the first trace's first
  // waypoint (or its `from`) and time of day prepare the scene.
  // 24.10 (7.50): `--light-catalog <name>` keeps the lamp catalog in the profile's IndexedDB under that name, and
  // `--user-data-dir <dir>` keeps the profile between runs: a second run is a second session.
  if (value('--light-catalog')) config.lightCatalogGeneration = value('--light-catalog');
  // 25.10 (7.51): `--allow-unsettled` goes on with a scene still loading at the deadline; `--settle-seconds N` sets it.
  if (args.includes('--allow-unsettled')) config.allowUnsettled = true;
  config.timeoutSeconds = Number(value('--settle-seconds', config.timeoutSeconds));
  const traces = await Promise.all(values('--light-trace').map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
  if (frames.length === 0 && traces.length > 0) {
    const [x, y] = traces[0].from ?? traces[0].path[0];
    frames.push({ name: 'trace', halfMinute: traces[0].halfMinute, view: { yaw: 0, pitch: -0.2, orbit: 12 }, weather: null,
      at: { x, y, map: traces[0].map ?? 0, ...(traces[0].z !== undefined ? { z: traces[0].z } : {}) } }); // 25.10 (7.51): + z
  }
  // 23.10 (7.48): HD effect textures straight from the generated sets.
  // 25.10 (7.47): `--neural-relief [dir]` answers `/terrain-relief/<id>.bin` from tools/neural-relief.mjs's set
  // (default `.runtime/neural-relief`) as a gateway with the route does; the page asks only with
  // `--set experimentalNeuralRelief=true`. Without it the route is the older gateway's 404 (never fetched or cached).
  const neuralIndex = args.indexOf('--neural-relief');
  const neuralDirectory = neuralIndex < 0 ? undefined
    : resolve(args[neuralIndex + 1] && !args[neuralIndex + 1].startsWith('--') ? args[neuralIndex + 1] : '.runtime/neural-relief');
  let neuralServed = 0;
  const hdIndex = args.indexOf('--hd-textures');
  const hdDirectory = hdIndex < 0 ? undefined
    : resolve(args[hdIndex + 1] && !args[hdIndex + 1].startsWith('--') ? args[hdIndex + 1] : '.runtime/hd-textures');
  const hdSets = hdDirectory ? (await readdir(hdDirectory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && /^[a-z0-9-]{1,32}$/.test(entry.name)).map((entry) => resolve(hdDirectory, entry.name)) : [];
  if (hdDirectory) {
    if (hdSets.length === 0) throw new Error(`--hd-textures: no set under ${hdDirectory}`);
    const manifests = await Promise.all(hdSets.map((set) => readFile(resolve(set, 'manifest.json')).catch(() => Buffer.alloc(0))));
    config.hdTextureGeneration = createHash('sha1').update(Buffer.concat(manifests)).digest('hex').slice(0, 20);
  }
  let hdServed = 0;
  // 24.10 (7.50): `--lamp-tables` answers `/visual/wmo-lamps` as a gateway with the route does — the table built by the
  // shared module (src/world/WmoLampTable.ts) from the WMO's root and groups as this harness serves them — so a first
  // visit can be traced without a gateway restart. Without it the route is a 404, as from an older gateway.
  // 25.10 (6.27): `--local-visuals` answers `/dbc/spell-visuals` and `/dbc/spell-visual-kits` from this worktree's gateway
  // code over the dataset's DBCs (tools/paths.mjs), as a gateway with that code would — a new kit field (CharProc tints)
  // without a gateway restart. Never cached.
  const localVisuals = args.includes('--local-visuals') ? await (async () => {
    const { build } = await import('esbuild');
    const result = await build({ entryPoints: ['src/gateway/SpellVisual.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
    const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    const { dbcDirectory } = await import('../tools/paths.mjs');
    const directory = dbcDirectory();
    return { visuals: await module.loadSpellVisuals(directory), kits: await module.loadSpellVisualKits(directory), served: 0 };
  })() : undefined;
  const lampTables = args.includes('--lamp-tables')
    ? { ...(await importSource('src/world/WmoLampTable.ts')), ...(await importSource('src/browser/Wvm.ts').then(({ VISUAL_MODEL_ROUTE_VERSION }) => ({ VISUAL_MODEL_ROUTE_VERSION }))),
      built: new Map(), served: 0, ms: 0 }
    : undefined;
  // 25.10 (7.50): `--lit-models [file]`: the lit-model index a gateway with the route serves.
  const litIndex = args.indexOf('--lit-models');
  const litModels = litIndex < 0 ? undefined : { file: resolve(args[litIndex + 1] && !args[litIndex + 1].startsWith('--')
    ? args[litIndex + 1] : '.runtime/lane-tails/lit-models.json'), served: 0 };
  if (litModels) litModels.bytes = await readFile(litModels.file);
  // 23.10 (7.48 step 2): the world set's compressed copies (`<id>.wht`), found as the gateway finds them
  // (gateway/HdTextures.ts): a ground layer by its id, a building texture by the digest of its original PNG.
  const worldSetDirectory = hdSets.find((set) => /[\\/]world$/.test(set));
  let worldIndex;
  if (worldSetDirectory) {
    const manifest = JSON.parse(await readFile(resolve(worldSetDirectory, 'manifest.json'), 'utf8'));
    worldIndex = { terrainLayers: new Map(), buildingPngs: new Map(), modelTextures: new Set() };
    for (const [path, entry] of Object.entries(manifest.entries ?? {})) {
      if (!entry?.compressed) continue;
      if (path.startsWith('tileset\\')) {
        for (const namespace of ['terrain-layer-v1', 'terrain-layer-v2']) {
          worldIndex.terrainLayers.set(createHash('sha1').update(`${namespace}\0${path}`).digest('hex'), path);
        }
        continue;
      }
      worldIndex.modelTextures.add(path); // 24.10 (7.48 step 3): `/texture?path=…&hd=` for a scenery model
      if (entry.compressed.originalPng) worldIndex.buildingPngs.set(entry.compressed.originalPng, path);
    }
  }
  let hdWorldServed = 0;
  /** 23.10 (7.48 step 2): bytes of the compressed copies served, and of the originals they replaced. */
  const hdWorldBytes = { hd: 0, original: 0 };
  // 23.10 (6.27): a spell-visual strip per frame.
  const spellArg = value('--spell');
  const kitArg = value('--kit');
  // 6.27 review: `--model <path>@dx,dy` stands any M2 beside the player for the strip.
  const modelArg = value('--model');
  const modelSpec = modelArg ? (() => { const [path, at = '-4,2'] = modelArg.split('@'); const [dx, dy] = at.split(',').map(Number); return { path, dx, dy }; })() : undefined;
  const strip = spellArg !== undefined || kitArg !== undefined || modelSpec ? {
    ...(spellArg !== undefined ? { spell: Number(spellArg) } : kitArg !== undefined ? { kit: Number(kitArg) } : { model: modelSpec }),
    shotsMs: value('--shots', '0,150,300,500,800,1200,1800').split(',').map(Number),
    // 25.10 (6.27): `--from dx,dy` casts from beside the player at the player (a missile flies in); `--phase
    // cast|state` plays the precast for `--cast-ms` then the GO, or the aura's state kit.
    ...(value('--from') ? { from: (([dx, dy]) => ({ dx, dy }))(value('--from').split(',').map(Number)) } : {}),
    ...(value('--phase') ? { phase: value('--phase') } : {}),
    ...(value('--cast-ms') ? { castMs: Number(value('--cast-ms')) } : {}),
    ...(args.includes('--effect-debug') ? { debug: true } : {}),
  } : undefined;
  const cropArg = value('--crop');
  if (strip && cropArg) {
    const match = /^(\d+)x(\d+)([+-]\d+)?$/.exec(cropArg);
    if (!match) throw new Error(`--crop expects WxH[+dy]: ${cropArg}`);
    strip.crop = { width: Number(match[1]), height: Number(match[2]), dy: Number(match[3] ?? 0) };
  }
  if (strip && ((!strip.model && !Number.isInteger(strip.spell ?? strip.kit)) || !strip.shotsMs.every(Number.isFinite))) {
    throw new Error('--spell/--kit expects an id and --shots a list of milliseconds');
  }
  if (frames.length === 0) throw new Error('At least one --frame name=halfMinute,yaw,pitch,orbit[,weather:intensity]');
  const out = resolve(value('--out', `bench/results/lookdev-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`));
  await mkdir(out, { recursive: true });
  await mkdir('bench/build', { recursive: true });
  await mkdir('bench/cache', { recursive: true });
  // 23.10 (7.46): `--cache dir` keeps its own index and new blobs there (reading the shared blobs
  // too), so a still can take the gateway's current artifacts without rewriting the bench's cache.
  const cacheDir = resolve(value('--cache', 'bench/cache'));
  await mkdir(cacheDir, { recursive: true });
  const variantDir = value('--variant');
  const bundle = await buildBenchmarkBundle('bench/build', variantDir);
  // 23.10 (7.46): `--worker` draws the stills in the render worker, as the Electron client does.
  const worker = args.includes('--worker');
  if (worker) await buildRenderWorkerBench('bench/build', variantDir, bundle.bundleOptions);

  const sha = data => createHash('sha256').update(data).digest('hex');
  const cacheFile = resolve(cacheDir, 'index.json');
  const cache = JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}'));
  let cacheMisses = 0;
  const gateway = new URL(process.env.BENCH_GATEWAY_URL ?? 'http://127.0.0.1:8090');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname)) throw new Error('Lookdev gateway must be loopback');
  const allowed = /^(?:\/dbc\/(?:creature-models|character-appearance|light\/\d+|ground-effects|liquid-types|spell-visuals|spell-visual-kits)|\/terrain\/|\/visual\/|\/texture(?:\?|$)|\/terrain-splat\/|\/terrain-layer\/|\/ground-cover\/|\/liquid\/|\/horizon\/|\/minimap\/\d+\/index\.json|\/environment\/)/; // 22.10 (7.44): minimap index
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
          blobTasks.set(entry.sha256, writeFile(resolve(cacheDir, entry.sha256), bytes).then(() => bytes));
        }
        await blobTasks.get(entry.sha256);
        cache[key] = entry;
      }
      if (!blobTasks.has(entry.sha256)) blobTasks.set(entry.sha256, readFile(resolve(cacheDir, entry.sha256)).catch(() => readFile(resolve('bench/cache', entry.sha256))));
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
          </head><body><canvas></canvas><script type="module" src="${worker ? '/bench-page.js' : '/harness.js'}"></script></body></html>`);
      } else if (url.pathname === '/config.json') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(config));
      } else if (Object.hasOwn(BENCHMARK_SCRIPT_FILES, url.pathname)) {
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(resolve('bench/build', BENCHMARK_SCRIPT_FILES[url.pathname])));
      } else if (worker && Object.hasOwn(RENDER_WORKER_SCRIPT_FILES, url.pathname)) { // 23.10 (7.46)
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(resolve('bench/build', RENDER_WORKER_SCRIPT_FILES[url.pathname])));
      } else if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
      } else if (/^\/textures\/water\/[A-Za-z]+_N\.jpg$/.test(url.pathname)) {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
          .end(await readFile(resolve('public', url.pathname.slice(1))));
      } else if (hdDirectory && url.pathname === '/texture' && url.searchParams.has('hd')) {
        // 23.10 (7.48): the HD copy when a set holds it (gateway/HdTextures.ts names it the same way), else the original.
        const path = (url.searchParams.get('path') ?? '').replaceAll('/', '\\').toLowerCase();
        const id = createHash('sha1').update(`hd-texture-v1\0${path}`).digest('hex');
        let hd;
        for (const set of hdSets) {
          if (set === worldSetDirectory) continue; // 24.10 (7.48): its PNGs are the compressor's input, as on the gateway
          hd = await readFile(resolve(set, `${id}.png`)).catch(() => undefined);
          if (hd) break;
        }
        // 24.10 (7.48 step 3): a scenery model's texture — the world set's compressed copy.
        const modelHd = !hd && worldIndex?.modelTextures.has(path)
          ? await readFile(resolve(worldSetDirectory, `${id}.wht`)).catch(() => undefined) : undefined;
        if (hd) {
          hdServed++;
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(hd);
        } else if (modelHd) {
          url.searchParams.delete('hd');
          const original = await asset(url.pathname + url.search);
          hdServed++;
          hdWorldServed++;
          hdWorldBytes.hd += modelHd.length;
          hdWorldBytes.original += original.bytes.length;
          res.writeHead(200, { 'content-type': 'application/x-webclient-hd-texture', 'cache-control': 'no-store' }).end(modelHd);
        } else {
          url.searchParams.delete('hd');
          const { entry, bytes } = await asset(url.pathname + url.search);
          res.writeHead(entry.status, { 'content-type': entry.type, 'cache-control': 'no-store' }).end(bytes);
        }
      } else if (worldIndex && url.searchParams.has('hd')
        && (url.pathname.startsWith('/terrain-layer/') || url.pathname.startsWith('/visual/texture/'))) {
        // 23.10 (7.48 step 2): the compressed HD copy when the world set holds one, else the original.
        url.searchParams.delete('hd');
        const original = await asset(url.pathname + url.search);
        const layer = /^\/terrain-layer\/([0-9a-f]{40})\.png$/.exec(url.pathname);
        const path = layer ? worldIndex.terrainLayers.get(layer[1])
          : worldIndex.buildingPngs.get(createHash('sha1').update(original.bytes).digest('hex'));
        const id = path && createHash('sha1').update(`hd-texture-v1\0${path}`).digest('hex');
        const hd = id && await readFile(resolve(worldSetDirectory, `${id}.wht`)).catch(() => undefined);
        if (hd) {
          hdServed++;
          hdWorldServed++;
          hdWorldBytes.hd += hd.length;
          hdWorldBytes.original += original.bytes.length;
          res.writeHead(200, { 'content-type': 'application/x-webclient-hd-texture', 'cache-control': 'no-store' }).end(hd);
        } else {
          res.writeHead(original.entry.status, { 'content-type': original.entry.type, 'cache-control': 'no-store' }).end(original.bytes);
        }
      } else if (localVisuals && (url.pathname === '/dbc/spell-visuals' || url.pathname === '/dbc/spell-visual-kits')) {
        // 25.10 (6.27): `--local-visuals`, BigInt-free JSON as the gateway writes it.
        const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0);
        const body = url.pathname === '/dbc/spell-visuals'
          ? ids.map((id) => localVisuals.visuals.get(id) ?? { id })
          : ids.map((id) => { const kit = localVisuals.kits.get(id); return kit ? { id, kit } : { id }; });
        localVisuals.served++;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
      } else if (url.pathname === '/visual/wmo-lamps') {
        // 24.10 (7.50): a building's lamp table (`--lamp-tables`), else the older gateway's 404 — never cached.
        const path = url.searchParams.get('path') ?? '';
        if (!lampTables || url.searchParams.get('v') !== String(lampTables.WMO_LAMP_TABLE_VERSION) || !/\.wmo$/i.test(path)) {
          res.writeHead(404, { 'cache-control': 'no-store' }).end();
          return;
        }
        const modelKey = (group) => `/visual/model?path=${encodeURIComponent(path)}${group === undefined ? '' : `&group=${group}`}&v=${lampTables.VISUAL_MODEL_ROUTE_VERSION}`;
        let table = lampTables.built.get(path.toLowerCase());
        if (!table) {
          const started = performance.now();
          const root = await asset(modelKey());
          if (root.entry.status !== 200) { res.writeHead(404, { 'cache-control': 'no-store' }).end(); return; }
          const view = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          table = Buffer.from(JSON.stringify(await lampTables.buildWmoLampTable(view(root.bytes), async (group) => {
            const answer = await asset(modelKey(group));
            if (answer.entry.status !== 200) throw new Error(`Lamp table: group ${group} of ${path} answered ${answer.entry.status}`);
            return view(answer.bytes);
          })));
          lampTables.ms += performance.now() - started;
          lampTables.built.set(path.toLowerCase(), table);
        }
        lampTables.served++;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(table);
      } else if (url.pathname === '/visual/lit-models') {
        // 25.10 (7.50): the lit-model index (`--lit-models`), else the older gateway's 404 — never cached.
        if (!litModels || url.searchParams.get('v') !== '1') {
          res.writeHead(404, { 'cache-control': 'no-store' }).end();
          return;
        }
        litModels.served++;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(litModels.bytes);
      } else if (/^\/terrain-relief\/[0-9a-f]{40}\.bin$/.test(url.pathname)) { // 25.10 (7.47)
        const bytes = neuralDirectory
          ? await readFile(resolve(neuralDirectory, 'terrain', url.pathname.slice('/terrain-relief/'.length))).catch(() => undefined)
          : undefined;
        if (bytes) neuralServed++;
        if (bytes) res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }).end(bytes);
        else res.writeHead(404, { 'cache-control': 'no-store' }).end();
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
  // 24.10 (7.50): `--port` keeps the page's origin, and with it IndexedDB and the HTTP cache of `--user-data-dir`.
  server.listen(Number(value('--port', 0)), '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.BENCH_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const headed = args.includes('--headed');
  const userDataDir = value('--user-data-dir'); // 24.10 (7.50)
  const browser = await puppeteer.launch({ executablePath, headless: !headed, ...(userDataDir ? { userDataDir: resolve(userDataDir) } : {}),
    args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    defaultViewport: { width: config.width, height: config.height, deviceScaleFactor: config.pixelRatio }, protocolTimeout: 600000 });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(config.timeoutSeconds * 1000);
    page.on('pageerror', error => console.error(`Page error: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    // 23.10 (7.46): the render worker's errors too.
    page.on('workercreated', w => w.on('console', message => { if (message.type() === 'error') console.error(message.text()); }));
    // The first frame's time, camera and weather are in place before the scene settles, so its
    // assets (the rain textures, a night light table) are part of the preparation.
    const route = { ...config.route };
    const routeFor = (frame) => frame.at ? { ...route, ...frame.at, dx: 0, dy: 0 } : route;
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
    // 24.10 (7.50): the screen-space pools' switches, before the traces and the first still.
    if (value('--light-pools') === 'off') await page.evaluate(() => window.__bench.lightPools?.(false));
    // `--light-pools show|lit|albedo`: the pool light, the light the pass believes a surface took, or its albedo estimate.
    const poolShow = { show: 1, lit: 2, albedo: 3 }[value('--light-pools')];
    if (poolShow) await page.evaluate((mode) => window.__bench.lightPoolShow?.(mode), poolShow);
    // `--pool-max-rank N`: no screen-space pool past N yards (with `--forward-lights 0`: the forward set's own lamps).
    if (value('--pool-max-rank') !== undefined) await page.evaluate((rank) => window.__bench.lightPoolMaxRank?.(rank), Number(value('--pool-max-rank')));
    if (value('--forward-lights') !== undefined) {
      await page.evaluate((limit) => window.__bench.lightPoolForward?.(limit), Number(value('--forward-lights')));
    }
    const written = [];
    for (const spec of traces) { // 24.10 (7.50)
      const started = Date.now();
      const result = await page.evaluate((value) => window.__bench.lightTrace(value), spec);
      await writeFile(resolve(out, `trace-${spec.name}.json`), JSON.stringify(result, null, 1));
      const { lights: _lights, timeline: _timeline, ...summary } = result;
      console.log(`trace ${spec.name} (${((Date.now() - started) / 1000).toFixed(0)} s): ${JSON.stringify(summary)}`);
      written.push({ trace: spec.name });
    }
    if (traces.length > 0) frames.length = 0;
    for (const frame of frames) {
      await page.evaluate((overrides) => window.__bench.lookdev(overrides),
        { halfMinute: frame.halfMinute, view: frame.view, weather: frame.weather, route: routeFor(frame) });
      if (strip && args.includes('--cost-rounds')) {
        // 23.10 (6.27): the living leaf's cost, on and off alternated inside one page.
        const sides = await page.evaluate((spec, rounds) => window.__bench.spellCost(spec, rounds), strip, Number(value('--cost-rounds')));
        console.log(`${frame.name}: cost ${JSON.stringify(sides)}`);
        written.push({ cost: sides });
        continue;
      }
      if (strip) {
        // 23.10 (6.27): the spell strip instead of one still.
        const result = await page.evaluate((spec) => window.__bench.spellStrip(spec), strip);
        for (const shot of result.shots) {
          const path = resolve(out, `${frame.name}-${String(shot.atMs).padStart(4, '0')}.png`);
          await writeFile(path, Buffer.from(shot.png.split(',')[1], 'base64'));
          written.push({ path });
          if (shot.emitters) console.log(`${frame.name} ${shot.atMs} ms: ${JSON.stringify(shot.emitters)}`); // 25.10 (6.27)
        }
        if (result.strip) {
          const path = resolve(out, `${frame.name}-strip.png`);
          await writeFile(path, Buffer.from(result.strip.split(',')[1], 'base64'));
          written.push({ path });
          console.log(`${frame.name}: ${path}`);
        }
        console.log(`${frame.name}: ${result.shots.length} shots, pending ${JSON.stringify(result.readiness?.pending)}, timing ${JSON.stringify(result.timing)}`);
        written.push({ timing: result.timing });
        continue;
      }
      const result = await page.evaluate(() => window.__bench.view(0));
      const png = Buffer.from(result.png.split(',')[1], 'base64');
      const path = resolve(out, `${frame.name}.png`);
      await writeFile(path, png);
      const shadows = await page.evaluate(() => window.__bench.shadowStats());
      // 23.10 (7.48 step 2): resident texture bytes after the still (ResourceAccounting.ts), when the page reports them.
      const textures = await page.evaluate(() => window.__bench.textureMemory?.());
      // 23.10 (7.48 step 2): `--gpu-frames N` times N frames of the still on the GPU (after 30 untimed), median ms.
      const gpuFrames = Number(value('--gpu-frames', 0));
      let gpuMs;
      let cpuMs; // 25.10 (7.51)
      if (gpuFrames > 0) {
        const samples = (await page.evaluate((count) => window.__bench.gpuView(count, 30), gpuFrames)).sort((a, b) => a - b);
        gpuMs = samples.length ? samples[Math.floor(samples.length / 2)] : undefined;
        // 25.10 (7.51): and the CPU of the same frames (`viewCpu`), median.
        const cpu = ((await page.evaluate(() => window.__bench.viewCpu?.())) ?? []).sort((a, b) => a - b);
        cpuMs = cpu.length ? cpu[Math.floor(cpu.length / 2)] : undefined;
        console.log(`  GPU median ${gpuMs?.toFixed(2)} ms, CPU median ${cpuMs?.toFixed(2)} ms over ${samples.length} frames`);
      }
      // 23.10 (7.47 stage 3): the doodads' relief (materials drawing it, maps and their bytes), when the page has it.
      const m2Relief = await page.evaluate(() => window.__bench.m2ReliefStats?.());
      const lightPools = await page.evaluate(() => window.__bench.lightPoolStats?.()); // 24.10 (7.50)
      written.push({ path, shadows, textures, gpuMs, cpuMs, m2Relief, lightPools });
      console.log(`${frame.name}: ${path} (${png.length} bytes) shadows ${JSON.stringify(shadows)}`);
      if (lightPools) console.log(`  light pools: ${JSON.stringify(lightPools)}`);
      if (m2Relief) console.log(`  doodad relief: ${JSON.stringify(m2Relief)}`);
      // 23.10 (7.47 stage 3): `--leaf-cost <hook> --leaf-rounds N` — a leaf's cost at this still, off and on
      // alternated ABBA inside the page (`__bench[hook](enabled)`, e.g. m2Relief), `--gpu-frames` timed frames
      // (default 120) after 240 untimed ones per side (the toggled doodads rebuild and their maps arrive).
      const leafHook = value('--leaf-cost');
      if (leafHook) {
        const rounds = Number(value('--leaf-rounds', 4));
        const timed = Number(value('--gpu-frames', 0)) || 120;
        const median = (values) => values.length ? [...values].sort((a, b) => a - b)[values.length >> 1] : undefined;
        const sides = { off: { gpu: [], cpu: [] }, on: { gpu: [], cpu: [] } };
        for (let round = 0; round < rounds; round++) {
          for (const on of round % 2 === 0 ? [false, true] : [true, false]) {
            await page.evaluate((hook, enabled) => window.__bench[hook](enabled), leafHook, on);
            const gpu = await page.evaluate((count) => window.__bench.gpuView(count, 240), timed);
            const cpu = await page.evaluate(() => window.__bench.viewCpu());
            sides[on ? 'on' : 'off'].gpu.push(median(gpu));
            sides[on ? 'on' : 'off'].cpu.push(median(cpu));
          }
        }
        const summary = Object.fromEntries(Object.entries(sides).map(([side, { gpu, cpu }]) => [side, {
          gpuMs: median(gpu), cpuMs: median(cpu), gpuRounds: gpu.map((ms) => ms?.toFixed(2)), cpuRounds: cpu.map((ms) => ms?.toFixed(2)),
        }]));
        console.log(`  leaf ${leafHook} cost: ${JSON.stringify(summary)}`);
        written.push({ leafCost: { hook: leafHook, ...summary, stats: await page.evaluate(() => window.__bench.m2ReliefStats?.()) } });
      }
      if (textures) {
        const mb = (value) => (value / 1048576).toFixed(1);
        console.log(`  textures: all ${mb(textures.all.estimatedLogicalTextureBytes)} MB, ground ${mb(textures.ground.estimatedLogicalTextureBytes)} MB; ${JSON.stringify(textures.extensions)}`);
        if (textures.hdTiles) console.log(`  HD ground tiles: ${JSON.stringify(textures.hdTiles)}`);
      }
    }
    if (litModels) console.log(`Lit-model index: served ${litModels.served} time(s) from ${litModels.file}`); // 25.10 (7.50)
    if (lampTables) console.log(`Lamp tables: ${lampTables.built.size} built (${lampTables.ms.toFixed(0)} ms), ${lampTables.served} served`); // 24.10 (7.50)
    if (neuralDirectory) console.log(`Neural relief maps served from ${neuralDirectory}: ${neuralServed}`); // 25.10 (7.47)
    if (hdDirectory) console.log(`HD textures served from ${hdDirectory}: ${hdServed} (world, compressed: ${hdWorldServed}, ${(hdWorldBytes.hd / 1048576).toFixed(1)} MB in place of ${(hdWorldBytes.original / 1048576).toFixed(1)} MB)`); // 23.10 (7.48)
    await writeFile(resolve(out, 'lookdev.json'), JSON.stringify({ scenario, config, frames, written, cacheMisses, hdServed, failures }, null, 2));
    if (failures.length) console.error(`Asset failures:\n${failures.join('\n')}`);
  } finally {
    await browser.close().catch(() => {});
    server.close();
    if (cacheMisses > 0) await writeFile(cacheFile, JSON.stringify(cache, null, 1));
  }
}
