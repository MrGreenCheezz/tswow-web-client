// 10.20: what moving a generator family onto the persistent worker buys, measured.
//
//   node bench/generators.mjs [--count=N] [--families=item-icon,spell-icon,terrain-splat,visual-tile,horizon,wmo,preload]
//
// For each family, N keys taken from the real dataset are published twice into two empty temporary
// trees: once by the command-line generator, one process per key (what `runAssetGenerator` does
// and what `ASSET_WORKERS=0` still does), and once by one `tools/asset-worker.mjs` child fed the
// same keys one at a time (what the gateway's `AssetWorkers` does). It prints the median, p90 and
// max milliseconds of each, the worker's first job separately (it pays for opening the chain), the
// worker's resident memory after the run, and whether the two trees are byte-identical. `wmo`
// publishes the same city WMO twice in the worker with an empty shared texture cache and then
// again with a warm one (10.20 slice 3). `preload` (not in the default list) times a 7.23 stub splat
// (process and worker) and what the 10.22 preloader pays to learn a city tile's models. Nothing is
// written outside the temporary directories.
//
// Node only, no gateway, no browser. Keep N small on a machine someone is playing on: each process
// key opens the whole archive chain (~0.2 s of disk and CPU).

import { execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { openDbcFile } from "../tools/dbc.mjs";
import { clientDirectory, dbcDirectory, repositoryRoot } from "../tools/paths.mjs";

const run = promisify(execFile);
const option = (name, fallback) => {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const count = Math.max(1, Number.parseInt(option("count", "5"), 10));
// The process side can be held to fewer keys than the worker (a 200-job memory check would
// otherwise spawn 200 processes); the byte comparison covers the keys both sides published.
const processCount = Math.max(1, Math.min(count, Number.parseInt(option("process-count", String(count)), 10)));
const families = option("families", "item-icon,spell-icon,terrain-splat,visual-tile,horizon,wmo").split(",");

const DIRECTORY_VARIABLES = [
  "ITEM_ICON_DIR", "SPELL_ICON_DIR", "CREATURE_ICON_DIR", "TERRAIN_TEXTURE_DIR", "TERRAIN_LAYER_DIR",
  "VISUAL_TILE_DIR", "WMO_DOODAD_CACHE_DIR", "HORIZON_DIR", "TEXTURE_DIR", "VISUAL_MODEL_DIR",
];

function environment(root) {
  const env = { ...process.env, CLIENT_DIR: clientDirectory(), CLIENT_PACK_DIR: "", DBC_DIR: dbcDirectory() };
  for (const variable of DIRECTORY_VARIABLES) env[variable] = join(root, variable.toLowerCase());
  return env;
}

async function keysOf(family) {
  if (family === "item-icon") {
    const table = await openDbcFile(dbcDirectory(), "ItemDisplayInfo");
    const keys = [];
    for (const row of table.rows()) if (table.string(row, "InventoryIcon", 0)) keys.push(table.id(row));
    // Spread over the table rather than its first rows, which share a handful of icons.
    const stride = Math.max(1, Math.floor(keys.length / count));
    return keys.filter((_, index) => index % stride === 0).slice(0, count);
  }
  if (family === "spell-icon") {
    const table = await openDbcFile(dbcDirectory(), "SpellIcon");
    const keys = [];
    for (const row of table.rows()) if (table.string(row, "TextureFilename")) keys.push(table.id(row));
    const stride = Math.max(1, Math.floor(keys.length / count));
    return keys.filter((_, index) => index % stride === 0).slice(0, count);
  }
  if (family === "terrain-splat" || family === "visual-tile") {
    // Around Goldshire: Elwynn, all with ADTs.
    const tiles = [[49, 31], [48, 31], [49, 32], [48, 32], [50, 31], [50, 32], [47, 31], [47, 32]];
    return tiles.slice(0, count).map(([x, y]) => [0, x, y]);
  }
  if (family === "horizon") return [0, 1, 530, 571, 609].slice(0, count);
  return [];
}

function processArguments(family, key) {
  switch (family) {
    case "item-icon": return ["generate-item-icon.mjs", [String(key)]];
    case "spell-icon": return ["generate-spell-icons.mjs", [String(key)]];
    case "terrain-splat": return ["generate-terrain-splat.mjs", key.map(String)];
    case "visual-tile": return ["generate-visual-tile.mjs", key.map(String)];
    case "horizon": return ["generate-horizon.mjs", [String(key)]];
    default: throw new Error(family);
  }
}

function workerJob(family, key) {
  switch (family) {
    case "item-icon": return { kind: "item-icon", displayId: key };
    case "spell-icon": return { kind: "spell-icon", iconId: key };
    case "terrain-splat": return { kind: "terrain-splat", map: key[0], gridX: key[1], gridY: key[2] };
    case "visual-tile": return { kind: "visual-tile", map: key[0], gridX: key[1], gridY: key[2] };
    case "horizon": return { kind: "horizon", map: key };
    default: throw new Error(family);
  }
}

/** One persistent worker, fed one job at a time, as `AssetWorker` feeds it. */
function startWorker(env) {
  const child = fork(resolve(repositoryRoot, "tools/asset-worker.mjs"), [], {
    cwd: repositoryRoot, env, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { errors = (errors + data).slice(-4096); });
  let next = 1;
  const waiting = new Map();
  child.on("message", (message) => {
    const job = waiting.get(message.id);
    waiting.delete(message.id);
    job?.(message);
  });
  child.once("exit", (code) => {
    for (const job of waiting.values()) job({ ok: false, message: `worker exited ${code}: ${errors}` });
  });
  return {
    run(job) {
      const id = next++;
      return new Promise((done) => {
        waiting.set(id, done);
        child.send({ id, ...job });
      });
    },
    close() {
      child.disconnect();
    },
  };
}

async function hashes(root) {
  const result = new Map();
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else result.set(relative(root, path), createHash("sha1").update(await readFile(path)).digest("hex"));
    }
  };
  if (existsSync(root)) await walk(root);
  return result;
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { median: at(0.5), p90: at(0.9), max: sorted.at(-1) };
}

const round = (value) => Math.round(value * 10) / 10;
const results = [];

for (const family of families.filter((name) => name !== "wmo")) {
  const keys = await keysOf(family);
  if (keys.length === 0) continue;
  const processRoot = await mkdtemp(join(tmpdir(), `bench-gen-${family}-process-`));
  const workerRoot = await mkdtemp(join(tmpdir(), `bench-gen-${family}-worker-`));
  try {
    const processTimes = [];
    for (const key of keys.slice(0, processCount)) {
      const [script, args] = processArguments(family, key);
      const started = performance.now();
      try {
        await run(process.execPath, [resolve(repositoryRoot, "tools", script), ...args],
          { cwd: repositoryRoot, env: environment(processRoot) });
      } catch {
        // A key the client lacks costs the same process; it is timed all the same.
      }
      processTimes.push(performance.now() - started);
    }
    const worker = startWorker(environment(workerRoot));
    const workerTimes = [];
    let rss = 0;
    for (const key of keys) {
      const started = performance.now();
      const answer = await worker.run(workerJob(family, key));
      workerTimes.push(performance.now() - started);
      rss = answer.rss ?? rss;
    }
    worker.close();
    const [left, right] = await Promise.all([hashes(processRoot), hashes(workerRoot)]);
    const identical = (processCount < keys.length || left.size === right.size)
      && [...left].every(([name, hash]) => right.get(name) === hash);
    const warm = summary(workerTimes.slice(1).length ? workerTimes.slice(1) : workerTimes);
    const cold = summary(processTimes);
    results.push({
      family, keys: keys.length, processKeys: processCount,
      processMs: { median: round(cold.median), p90: round(cold.p90), max: round(cold.max) },
      workerFirstMs: round(workerTimes[0]),
      workerWarmMs: { median: round(warm.median), p90: round(warm.p90), max: round(warm.max) },
      ratio: Math.round((warm.median / cold.median) * 1000) / 1000,
      workerRssMb: Math.round(rss / 1048576),
      files: left.size,
      identical,
    });
  } finally {
    await rm(processRoot, { recursive: true, force: true });
    await rm(workerRoot, { recursive: true, force: true });
  }
}

if (families.includes("wmo")) {
  // Gundrak's buildings, which 10.20 named (853 ms, 580 of them textures, for the city, 29.09).
  const paths = option("wmo", [
    "world/wmo/dungeon/nd_gundrak/gundrak.wmo", "world/wmo/dungeon/nd_gundrak/gundrakinterior.wmo",
    "world/wmo/dungeon/nd_gundrak/gundrak_entrance.wmo", "world/wmo/dungeon/nd_gundrak/gundrakgrate.wmo",
  ].join(",")).split(",");
  const root = await mkdtemp(join(tmpdir(), "bench-gen-wmo-"));
  try {
    const worker = startWorker(environment(root));
    // The first job also opens the chain; a tiny texture first keeps that out of the numbers.
    await worker.run({ kind: "texture", path: "Interface/Icons/INV_Misc_QuestionMark.blp" });
    const publish = async (salt) => {
      const times = [];
      for (const path of paths) {
        const hash = createHash("sha1").update(`${salt}\0${path.toLowerCase()}`).digest("hex");
        const started = performance.now();
        const answer = await worker.run({ kind: "visual-model", path, hash });
        times.push(performance.now() - started);
        if (!answer.ok) throw new Error(answer.message);
      }
      return times;
    };
    // Empty shared cache: every texture is decoded once (as before 10.20, plus the link).
    const cold = await publish("cold");
    // The same buildings under other hashes: every texture is already in the shared cache.
    const warm = await publish("warm");
    worker.close();
    results.push({
      family: "wmo", paths,
      coldSharedCacheMs: cold.map(round), warmSharedCacheMs: warm.map(round),
      coldTotalMs: round(cold.reduce((sum, value) => sum + value, 0)),
      warmTotalMs: round(warm.reduce((sum, value) => sum + value, 0)),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (families.includes("preload")) {
  // 7.23 and 10.22: what a stub tile costs now, and what the preloader pays to learn a tile's models.
  const root = await mkdtemp(join(tmpdir(), "bench-gen-preload-"));
  try {
    const env = environment(root);
    const stubs = [[604, 27, 29], [604, 28, 30], [604, 29, 31]];
    const stubProcessMs = [];
    for (const key of stubs) {
      const started = performance.now();
      const exit = await run(process.execPath, [resolve(repositoryRoot, "tools/generate-terrain-splat.mjs"), ...key.map(String)],
        { cwd: repositoryRoot, env }).then(() => 0, (error) => error.code);
      stubProcessMs.push({ ms: round(performance.now() - started), exit });
    }
    const worker = startWorker(env);
    const stubWorkerMs = [];
    for (const key of stubs) {
      const started = performance.now();
      const answer = await worker.run({ kind: "terrain-splat", map: key[0], gridX: key[1], gridY: key[2] });
      stubWorkerMs.push({ ms: round(performance.now() - started), missing: answer.missing === true });
    }
    // A city tile: the full placements against the list beside them.
    const tile = [0, 49, 31];
    const published = await worker.run({ kind: "visual-tile", map: tile[0], gridX: tile[1], gridY: tile[2] });
    if (!published.ok) throw new Error(published.message);
    const tiles = join(root, "visual_tile_dir", "0");
    const timed = async (work) => {
      const times = [];
      let value;
      for (let repeat = 0; repeat < 5; repeat++) {
        const started = performance.now();
        value = await work();
        times.push(performance.now() - started);
      }
      return { value, median: round(summary(times).median) };
    };
    const { tileModelNames } = await import("../tools/tile-models.mjs");
    const full = await timed(async () => tileModelNames(JSON.parse(await readFile(join(tiles, "49-31.json"), "utf8"))));
    const list = await timed(async () => JSON.parse(await readFile(join(tiles, "49-31.models.json"), "utf8")));
    await rm(join(tiles, "49-31.models.json"));
    const started = performance.now();
    const job = await worker.run({ kind: "tile-models", map: tile[0], gridX: tile[1], gridY: tile[2] });
    const jobMs = round(performance.now() - started);
    worker.close();
    results.push({
      family: "preload",
      stubSplatProcess: stubProcessMs, stubSplatWorker: stubWorkerMs,
      tile: tile.join("/"),
      tileBytes: (await readFile(join(tiles, "49-31.json"))).length,
      modelsBytes: (await readFile(join(tiles, "49-31.models.json"))).length,
      models: list.value.length,
      parseFullTileMs: full.median, parseModelListMs: list.median, tileModelsWorkerJobMs: jobMs,
      sameList: JSON.stringify(full.value) === JSON.stringify(list.value) && JSON.stringify(job.result) === JSON.stringify(list.value),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ node: process.version, count, results }, null, 2));
