import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AssetPreloader, parsePreloadEnv } from "../dist/code/gateway/AssetPreloader.js";
import { PRELOAD_PRIORITY, generateOnce, generationLane } from "../dist/code/gateway/GenerationLane.js";
import { startGateway, visualModelCacheNamespace, visualModelHash } from "../dist/code/gateway/Gateway.js";
import { openClientArchives } from "../tools/mpq.mjs";
import { sourceStamp } from "../tools/source-stamp.mjs";

// 10.22: background publication must never stand in front of the player — not in a queue (it runs
// at PRELOAD_PRIORITY), and not on the processor (it starts only when every lane is quiet, one job
// at a time, with a pause after each and a budget per minute and per visit).

const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
};

/** A preloader on a manual clock and manual timers, with fake publishing that takes `jobMs`. */
function harness({ models = () => ["A.m2", "B.m2"], published = () => true, current = () => false, jobMs = 100, fail = () => false, ...extra } = {}) {
  const clock = { now: 1_000_000 };
  const timers = [];
  const lanes = [generationLane(() => clock.now), generationLane(() => clock.now)];
  const log = { models: [], tiles: [], listed: [], starts: [] };
  const preloader = new AssetPreloader({
    lanes,
    now: () => clock.now,
    setTimer: (callback, ms) => {
      const timer = { at: clock.now + ms, callback };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    tileModels: async (map, x, y) => {
      log.listed.push(`${map}/${x}/${y}`);
      return published(map, x, y) ? models(map, x, y) : undefined;
    },
    publishTile: async (map, x, y) => {
      log.starts.push(clock.now);
      log.tiles.push(`${map}/${x}/${y}`);
      clock.now += jobMs;
    },
    modelCurrent: async (path) => current(path),
    publishModel: async (path) => {
      log.starts.push(clock.now);
      log.models.push(path);
      clock.now += jobMs;
      if (fail(path)) throw new Error("broken");
    },
    ...extra,
  });
  /** Moves the clock forward `ms`, firing every timer due on the way. */
  const advance = async (ms) => {
    const end = clock.now + ms;
    for (;;) {
      await settle();
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      clock.now = Math.max(clock.now, next.at);
      next.callback();
    }
    clock.now = Math.max(clock.now, end);
    await settle();
  };
  return { preloader, clock, lanes, log, advance, timers };
}

test("a served tile walks itself and its eight neighbours, centre first, one job at a time with a pause of its own length", async () => {
  const { preloader, log, advance } = harness({ models: (map, x, y) => [`M${x}-${y}.m2`] });
  preloader.noteTile(0, 32, 32);
  await advance(10_000);
  assert.equal(log.listed[0], "0/32/32", "the centre first");
  assert.equal(new Set(log.listed).size, 9);
  assert.equal(log.models.length, 9);
  assert.equal(log.models[0], "M32-32.m2");
  for (let index = 1; index < log.starts.length; index++) {
    assert.ok(log.starts[index] - log.starts[index - 1] >= 200, "a 100 ms job, then at least 100 ms of pause");
  }
  assert.equal(preloader.stats().published, 9);
});

test("models already current cost no job; a corner tile has only its real neighbours", async () => {
  const { preloader, log, advance } = harness({ current: (path) => path === "A.m2" });
  preloader.noteTile(0, 0, 0);
  await advance(10_000);
  assert.deepEqual(new Set(log.listed), new Set(["0/0/0", "0/1/0", "0/0/1", "0/1/1"]));
  assert.deepEqual(log.models, ["B.m2"], "each model once, and not the current one");
  assert.equal(preloader.stats().skipped, 1);
});

test("nothing starts while a lane is busy or within the quiet window after a real job", async () => {
  const { preloader, log, advance, lanes, clock } = harness();
  lanes[1].stats.lastRealAt = clock.now - 100;
  preloader.noteTile(0, 32, 32);
  await advance(100);
  assert.equal(log.models.length, 0, "150 ms left of the quiet window");
  lanes[0].running = true;
  await advance(1_000);
  assert.equal(log.models.length, 0, "a lane is running");
  lanes[0].running = false;
  await advance(300);
  assert.ok(log.models.length >= 1, "starts once everything is quiet");
});

test("an unpublished neighbour is published first, then its models are walked", async () => {
  let tilesPublished = [];
  const { preloader, log, advance } = harness({
    published: (map, x, y) => `${map}/${x}/${y}` === "0/32/32" || tilesPublished.includes(`${map}/${x}/${y}`),
    models: (map, x, y) => [`M${x}-${y}.m2`],
  });
  tilesPublished = log.tiles;
  preloader.noteTile(0, 32, 32);
  await advance(30_000);
  assert.equal(log.tiles.length, 8, "the eight neighbours were published");
  assert.ok(!log.tiles.includes("0/32/32"));
  assert.equal(log.models.length, 9, "and every tile's model followed");
  const neighbour = log.tiles[0];
  const [, x, y] = neighbour.split("/");
  assert.ok(log.models.includes(`M${x}-${y}.m2`));
});

test("budget: at most perMinute jobs a minute, perVisit per neighbourhood", async () => {
  const many = Array.from({ length: 50 }, (_, index) => `N${index}.m2`);
  {
    const { preloader, log, advance } = harness({ models: () => many, perMinute: 5, pace: 0 });
    preloader.noteTile(0, 32, 32);
    await advance(30_000);
    assert.equal(log.models.length, 5, "five in the first minute");
    preloader.noteTile(0, 32, 32);
    await advance(40_000);
    assert.equal(log.models.length, 10, "five more after it");
  }
  {
    const { preloader, log, advance } = harness({ models: () => many, perVisit: 7, pace: 0 });
    preloader.noteTile(0, 32, 32);
    await advance(50_000);
    assert.equal(log.models.length, 7);
  }
});

test("the newest tiles go first and the queues are capped; recycle, close and an idle minute stop it", async () => {
  {
    const { preloader, log, advance } = harness({ models: (map, x, y) => [`M${x}-${y}.m2`] });
    preloader.noteTile(0, 10, 10);
    await advance(500);
    const walked = log.listed.length;
    assert.ok(walked > 0 && walked < 9);
    preloader.noteTile(0, 40, 40);
    await advance(500);
    assert.equal(log.listed[walked], "0/40/40", "the tile just served is walked next");
    await advance(20_000);
    assert.equal(new Set(log.listed).size, 18, "and the rest of the first neighbourhood after it");
  }
  {
    const many = Array.from({ length: 30 }, (_, index) => `N${index}.m2`);
    const { preloader, log, advance } = harness({ models: () => many, perVisit: 10, pace: 0 });
    preloader.noteTile(0, 32, 32);
    await advance(20_000);
    assert.equal(log.models.length, 10);
    assert.ok(log.models.includes("N29.m2") && !log.models.includes("N0.m2"), "the model queue keeps the newest");
    assert.ok(preloader.stats().dropped > 0);
  }
  {
    const { preloader, log, advance } = harness();
    preloader.noteTile(0, 32, 32);
    preloader.recycle();
    await advance(10_000);
    assert.equal(log.models.length, 0, "recycle forgets the plan");
    preloader.noteTile(0, 32, 32);
    preloader.close();
    await advance(10_000);
    assert.equal(log.models.length, 0, "close stops it");
  }
  {
    const many = Array.from({ length: 500 }, (_, index) => `N${index}.m2`);
    const { preloader, log, advance } = harness({ models: () => many, pace: 0, perMinute: 6000 });
    preloader.noteTile(0, 32, 32);
    await advance(61_000);
    const stopped = log.models.length;
    await advance(60_000);
    assert.equal(log.models.length, stopped, "no tile served for a minute: it stops");
    assert.ok(stopped < 500);
  }
});

test("three failures in a row pause it", async () => {
  const many = Array.from({ length: 20 }, (_, index) => `N${index}.m2`);
  const { preloader, log, advance } = harness({ models: () => many, fail: () => true, pace: 0, failurePauseMs: 30_000 });
  preloader.noteTile(0, 32, 32);
  await advance(5_000);
  assert.equal(log.models.length, 3);
  await advance(30_000);
  assert.ok(log.models.length > 3, "and it resumes after the pause");
});

test("«not in the client» is not a failure: a map edge or a missing model does not pause it", async () => {
  // Only the last neighbour (31/33) exists; the other eight tiles have no ADT, and the first models
  // of its list are not in the client either.
  const missing = () => Object.assign(new Error("none"), { exitCode: 3 });
  const { preloader, log, advance } = harness({
    published: (map, x, y) => x === 31 && y === 33,
    models: () => ["Gone1.m2", "Gone2.m2", "Gone3.m2", "Here.m2"],
    fail: () => false,
    pace: 0,
    publishTile: async () => { throw missing(); },
    publishModel: async (path) => {
      log.models.push(path);
      if (path.startsWith("Gone")) throw missing();
    },
  });
  preloader.noteTile(0, 32, 32);
  await advance(5_000);
  assert.ok(log.models.includes("Here.m2"), "no minute-long pause after eight absent tiles and three absent models");
  assert.equal(preloader.stats().failed, 0);
});

test("a background run that failed for this minute's reasons does not refuse the real request after it", async () => {
  const lane = generationLane();
  await assert.rejects(generateOnce(lane, "k", async () => { throw new Error("worker died"); }, PRELOAD_PRIORITY));
  let ran = 0;
  await generateOnce(lane, "k", async () => { ran++; }, 1);
  assert.equal(ran, 1, "the player's request runs the generator instead of inheriting a 500");
  // «Not in the client» stays the truth for everyone, whoever learnt it.
  await assert.rejects(generateOnce(lane, "m", async () => { throw Object.assign(new Error("none"), { exitCode: 3 }); }, PRELOAD_PRIORITY));
  await assert.rejects(generateOnce(lane, "m", async () => { ran++; }, 1), (error) => error.exitCode === 3);
  assert.equal(ran, 1);
  // A real request's own transient failure keeps its 1.5 s memory, as before.
  await assert.rejects(generateOnce(lane, "r", async () => { throw new Error("worker died"); }, 1));
  await assert.rejects(generateOnce(lane, "r", async () => { ran++; }, 1), /failed recently/);
  assert.equal(ran, 1);
});

test("ASSET_PRELOAD is off unless 1; the knobs parse or fail loudly", () => {
  assert.equal(parsePreloadEnv({}), undefined);
  assert.equal(parsePreloadEnv({ ASSET_PRELOAD: "0" }), undefined);
  assert.deepEqual(parsePreloadEnv({ ASSET_PRELOAD: "1" }), { perMinute: 120, pace: 1 });
  assert.deepEqual(parsePreloadEnv({ ASSET_PRELOAD: "1", ASSET_PRELOAD_PER_MINUTE: "30", ASSET_PRELOAD_PACE: "2.5" }), { perMinute: 30, pace: 2.5 });
  assert.throws(() => parsePreloadEnv({ ASSET_PRELOAD: "yes" }), /ASSET_PRELOAD/);
  assert.throws(() => parsePreloadEnv({ ASSET_PRELOAD: "1", ASSET_PRELOAD_PACE: "-1" }), /ASSET_PRELOAD_PACE/);
});

test("visualModelHash is the route's own key", () => {
  for (const path of ["World\\Tree.m2", "World\\wmo\\Town.WMO"]) {
    assert.equal(visualModelHash(path),
      createHash("sha1").update(`${visualModelCacheNamespace(path)}\0${path.toLowerCase()}`).digest("hex"));
  }
});

test("gateway: a served tile preloads its models at background priority; a real request joins the running job", async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-preload-gateway-"));
  const ORIGIN = "http://127.0.0.1:5173";
  const tiles = join(box, "visual-tiles");
  const models = join(box, "visual-models");
  await mkdir(join(tiles, "0"), { recursive: true });
  await mkdir(models, { recursive: true });
  await writeFile(join(tiles, "0", "32-32.json"), "[]");
  await writeFile(join(tiles, "0", "32-32.models.json"), JSON.stringify(["World\\Tree.m2", "World\\Rock.m2"]));
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 9 }, world: { host: "127.0.0.1", port: 9 },
    allowedOrigins: [ORIGIN], visualTilesDirectory: tiles, visualModelsDirectory: models,
    preload: { pace: 0 },
    // Neighbours are not published and stay so: their publication fails as «missing».
    generateVisualTile: async () => { throw Object.assign(new Error("none"), { exitCode: 3 }); },
    listTileModels: async () => undefined,
    generateVisualModel: async (path, hash) => {
      calls.push(path);
      if (path === "World\\Tree.m2") await gate;
      await writeFile(join(models, `${hash}.bin`), "WVM");
    },
  });
  try {
    const tile = await fetch(`http://127.0.0.1:${gateway.port}/visual/environment/0/32/32`, { headers: { origin: ORIGIN } });
    assert.equal(tile.status, 200);
    await tile.arrayBuffer();
    for (let wait = 0; wait < 100 && calls.length === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, ["World\\Tree.m2"], "after it, the first model, alone");
    // The player asks for the very model being preloaded: one run, both answered.
    const real = fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent("World\\Tree.m2")}`, { headers: { origin: ORIGIN } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const response = await real;
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(calls.filter((path) => path === "World\\Tree.m2").length, 1, "the real request joined the running job");
    for (let wait = 0; wait < 100 && !calls.includes("World\\Rock.m2"); wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(calls.includes("World\\Rock.m2"), "and the rest follows");
  } finally {
    await gateway.close();
    await rm(box, { recursive: true, force: true });
  }
});

test("gateway: a model list stamped by an older visual-tile generation is not trusted; the worker lists the tile again", async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-preload-generation-"));
  const ORIGIN = "http://127.0.0.1:5173";
  const tiles = join(box, "visual-tiles");
  const models = join(box, "visual-models");
  const dbc = join(box, "dbc");
  await mkdir(join(tiles, "0"), { recursive: true });
  await mkdir(models, { recursive: true });
  await mkdir(dbc, { recursive: true });
  const stamp = (generation) => JSON.stringify({ generation, chain: "", sources: [], files: [] });
  await writeFile(join(tiles, "0", "32-32.json"), "[]");
  await writeFile(join(tiles, "0", "32-32.json.src"), stamp("visual-tile-v6")); // 05.10-A7b-1; P2-04x: v6
  await writeFile(join(tiles, "0", "32-32.models.json"), JSON.stringify(["World\\Old.m2"]));
  await writeFile(join(tiles, "0", "32-32.models.json.src"), stamp("visual-tile-v3"));
  const calls = [];
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 9 }, world: { host: "127.0.0.1", port: 9 },
    allowedOrigins: [ORIGIN], visualTilesDirectory: tiles, visualModelsDirectory: models,
    dbcDirectory: dbc, datasetPollMs: 0, preload: { pace: 0 },
    generateVisualTile: async () => { throw Object.assign(new Error("none"), { exitCode: 3 }); },
    listTileModels: async (map, x, y) => (x === 32 && y === 32 ? ["World\\New.m2"] : undefined),
    generateVisualModel: async (path, hash) => {
      calls.push(path);
      await writeFile(join(models, `${hash}.bin`), "WVM");
    },
  });
  try {
    const tile = await fetch(`http://127.0.0.1:${gateway.port}/visual/environment/0/32/32`, { headers: { origin: ORIGIN } });
    assert.equal(tile.status, 200);
    await tile.arrayBuffer();
    for (let wait = 0; wait < 100 && calls.length === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, ["World\\New.m2"]);
  } finally {
    await gateway.close();
    await rm(box, { recursive: true, force: true });
  }
});

test("gateway: the archives changing under a running preload drops its plan (recycle), the job in hand finishes", async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-preload-recycle-"));
  const ORIGIN = "http://127.0.0.1:5173";
  const client = join(box, "client");
  const tiles = join(box, "visual-tiles");
  const models = join(box, "visual-models");
  await mkdir(join(client, "Data", "patch-A.MPQ", "World"), { recursive: true });
  await writeFile(join(client, "Data", "patch-A.MPQ", "World", "Seed.txt"), "seed");
  await mkdir(join(tiles, "0"), { recursive: true });
  await mkdir(models, { recursive: true });
  // Stamped against the fixture's chain, so the gateway keeps them as current.
  const archives = await openClientArchives(client);
  let stamp;
  try {
    stamp = JSON.stringify(await sourceStamp(archives, { generation: "visual-tile-v6" })); // 05.10-A7b-1; P2-04x: v6
  } finally {
    archives.close();
  }
  const names = ["World\\A.m2", "World\\B.m2", "World\\C.m2", "World\\D.m2", "World\\E.m2"];
  await writeFile(join(tiles, "0", "32-32.json"), "[]");
  await writeFile(join(tiles, "0", "32-32.json.src"), stamp);
  await writeFile(join(tiles, "0", "32-32.models.json"), JSON.stringify(names));
  await writeFile(join(tiles, "0", "32-32.models.json.src"), stamp);
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 9 }, world: { host: "127.0.0.1", port: 9 },
    allowedOrigins: [ORIGIN], visualTilesDirectory: tiles, visualModelsDirectory: models,
    clientDirectory: client, datasetPollMs: 0, preload: { pace: 0 },
    generateVisualTile: async () => { throw Object.assign(new Error("none"), { exitCode: 3 }); },
    listTileModels: async () => undefined,
    generateVisualModel: async (path, hash) => {
      calls.push(path);
      if (calls.length === 1) await gate;
      await writeFile(join(models, `${hash}.bin`), "WVM");
    },
  });
  try {
    const tile = await fetch(`http://127.0.0.1:${gateway.port}/visual/environment/0/32/32`, { headers: { origin: ORIGIN } });
    assert.equal(tile.status, 200);
    await tile.arrayBuffer();
    for (let wait = 0; wait < 100 && calls.length === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, ["World\\A.m2"], "the first model is running and four wait");
    // A dataset build drops a new patch beside the old one; the next request's poll sees it.
    await mkdir(join(client, "Data", "patch-B.MPQ", "World"), { recursive: true });
    await writeFile(join(client, "Data", "patch-B.MPQ", "World", "New.txt"), "new");
    await (await fetch(`http://127.0.0.1:${gateway.port}/visual/environment/0/63/63`, { headers: { origin: ORIGIN } })).arrayBuffer();
    release();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(calls, ["World\\A.m2"], "nothing planned against the old chain is published after it changed");
  } finally {
    release();
    await gateway.close();
    await rm(box, { recursive: true, force: true });
  }
});
