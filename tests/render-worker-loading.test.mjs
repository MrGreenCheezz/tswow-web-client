// 22.10 (12.14) — loading in worker mode (`?renderworker=1`): the curtain waits for the worker's own terrain and its
// drawn frames (RenderWorkerLoading.ts, ui/LoadingScreen.ts), the worker's clients' messages reach the page's status
// lines (app/ResourceStatusLines.ts), the warm-up's models go to the client that draws (app/WarmModelTarget.ts,
// RenderWorkerModelWarmup.ts), and the page keeps only its own environment tile while the worker streams the band
// (game/PageEnvironmentRange.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { RenderWorkerReadinessTracker, RenderWorkerStatusCollector } from "../dist/code/browser/RenderWorkerLoading.js";
import { RenderWorkerModelWarmup } from "../dist/code/browser/RenderWorkerModelWarmup.js";
import { warmModelTarget } from "../dist/code/browser/app/WarmModelTarget.js";
import { showPageResourceStatus, showWorkerResourceStatuses } from "../dist/code/browser/app/ResourceStatusLines.js";
import { PAGE_ONLY_ENVIRONMENT_RANGE, pageEnvironmentRange } from "../dist/code/browser/game/PageEnvironmentRange.js";
import { ENVIRONMENT_STREAM_RANGE, terrainGridFootprintCells } from "../dist/code/browser/Terrain.js";
import { RenderWorkerClient } from "../dist/code/browser/RenderWorkerClient.js";
import { RenderWorkerSession } from "../dist/code/browser/RenderWorkerSession.js";
import { createRenderResults } from "../dist/code/browser/RenderResults.js";
import { DEFAULT_ATMOSPHERE_PROFILE } from "../dist/code/browser/AtmosphereEffects.js";

const STORMWIND = { map: 0, x: -8840, y: 626 };

test("the curtain's count: consecutive ready worker frames, for this map, tile and set of clients only", () => {
  const tracker = new RenderWorkerReadinessTracker();
  const ready = (overrides = {}) => ({ ...STORMWIND, terrain: true, clients: 1, ...overrides });
  tracker.observe(ready({ terrain: false }), 1);
  assert.equal(tracker.framesReadyAt(STORMWIND.map, STORMWIND.x, STORMWIND.y), 0);
  for (let frame = 0; frame < 3; frame++) tracker.observe(ready(), 1);
  assert.equal(tracker.framesReadyAt(STORMWIND.map, STORMWIND.x, STORMWIND.y), 3);
  assert.equal(tracker.framesReadyAt(STORMWIND.map, STORMWIND.x + 10, STORMWIND.y), 3, "the same tile");
  assert.equal(tracker.framesReadyAt(1, STORMWIND.x, STORMWIND.y), 0, "another map");
  assert.equal(tracker.framesReadyAt(STORMWIND.map, STORMWIND.x + 600, STORMWIND.y), 0, "another tile");
  tracker.observe(ready({ clients: 1 }), 2);
  assert.equal(tracker.framesReadyAt(STORMWIND.map, STORMWIND.x, STORMWIND.y), 0,
    "a report from the last world's clients, still in flight, does not count");
  tracker.observe(ready({ clients: 2 }), 2);
  tracker.observe(ready({ x: STORMWIND.x + 600, clients: 2 }), 2);
  assert.equal(tracker.framesReadyAt(STORMWIND.map, STORMWIND.x + 600, STORMWIND.y), 1, "a new tile starts again");
  tracker.observe(undefined, 2);
  assert.equal(tracker.framesReadyAt(STORMWIND.map, STORMWIND.x + 600, STORMWIND.y), 0, "a frame without the terrain");
});

test("the worker's status messages: routed to the page's two lines, errors kept, the last plain one per line", () => {
  const collector = new RenderWorkerStatusCollector();
  const sources = { terrain: {}, splat: {}, cover: {}, liquids: {}, environment: {} };
  collector.watch(sources);
  sources.terrain.onStatus("Terrain tiles загружено: 1", false);
  sources.splat.onStatus("splat 404", true);
  sources.liquids.onStatus("Terrain tiles загружено: 2", false);
  sources.environment.onStatus("VMAP tiles: 3", false);
  assert.deepEqual(collector.drain(), [
    { line: "terrain", message: "splat 404", error: true },
    { line: "terrain", message: "Terrain tiles загружено: 2", error: false },
    { line: "environment", message: "VMAP tiles: 3", error: false },
  ]);
  assert.equal(collector.drain(), undefined);
  collector.unwatch();
  assert.equal(sources.terrain.onStatus, undefined, "dropped clients say nothing more");
});

function statusTargets() {
  const notices = [];
  return { notices, terrain: { className: "", textContent: "" }, environment: { className: "", textContent: "" },
    notice: (message) => notices.push(message) };
}

test("the status lines speak for the clients that draw: the page's in-page, the worker's in worker mode", () => {
  const targets = statusTargets();
  const worker = { renderWorker: {} };
  showPageResourceStatus(targets, undefined, "terrain", "Terrain tiles загружено: 4", false);
  assert.equal(targets.terrain.textContent, "Terrain: Terrain tiles загружено: 4");
  showPageResourceStatus(targets, worker, "terrain", "page tile failed", true);
  showPageResourceStatus(targets, worker, "environment", "VMAP tiles: 1", false);
  assert.equal(targets.terrain.textContent, "Terrain: Terrain tiles загружено: 4", "the page's own stay off the lines");
  assert.equal(targets.environment.textContent, "");
  assert.deepEqual(targets.notices, []);
  showWorkerResourceStatuses(targets, [{ line: "environment", message: "VMAP tiles: 9", error: false },
    { line: "terrain", message: "Terrain gateway returned 500", error: true }]);
  assert.equal(targets.environment.textContent, "Environment: VMAP tiles: 9");
  assert.equal(targets.environment.className, "success");
  assert.equal(targets.terrain.textContent, "Terrain: Terrain gateway returned 500");
  assert.equal(targets.terrain.className, "error");
  assert.deepEqual(targets.notices, ["Terrain gateway returned 500"]);
});

test("a warmed model goes to the client that draws: the page's in-page, forwarded once to the worker", () => {
  const asked = [];
  const environment = { baseUrl: "http://g", model: (name, priority) => { asked.push([name, priority]); return { name }; } };
  let renderer;
  const forwarded = [];
  const target = warmModelTarget(environment, () => renderer);
  assert.deepEqual(target.model("a.m2", "background"), { name: "a.m2" });
  assert.deepEqual(asked, [["a.m2", "background"]]);
  renderer = { renderWorker: { warmModel: (name, priority) => forwarded.push([name, priority]) } };
  assert.equal(target.model("b.m2", "background"), undefined, "nothing is downloaded or decoded on the page");
  assert.equal(target.model("b.m2", "background"), undefined);
  target.model("b.m2", "critical");
  target.model("b.m2", "normal");
  assert.deepEqual(forwarded, [["b.m2", "background"], ["b.m2", "critical"]], "again only with a higher priority");
  assert.deepEqual(asked, [["a.m2", "background"]]);
  assert.equal(target.baseUrl, "http://g");
});

function fakeEnvironment() {
  const models = new Map();
  const asks = [];
  return {
    asks, models, baseUrl: "http://g",
    model(name, priority) { asks.push([name, priority]); return models.get(name); },
    modelState(name) { return models.has(name) ? "resident" : name.startsWith("gone") ? "missing" : "pending"; },
  };
}

test("the worker asks its own client each frame until the model answers, then warms its textures", async () => {
  const fetched = [];
  const warmup = new RenderWorkerModelWarmup(async (url) => { fetched.push(url); return { ok: true, body: null }; });
  const client = fakeEnvironment();
  warmup.add("tree.m2", "background");
  warmup.add("tree.m2", "critical");
  warmup.add("gone.m2", "normal");
  warmup.apply(client);
  assert.deepEqual(client.asks, [["tree.m2", "critical"], ["gone.m2", "normal"]]);
  assert.equal(warmup.pending, 1, "an absent model leaves the queue; a pending one waits");
  client.models.set("tree.m2", { textureUrl: "http://g/texture?path=tree.blp" });
  warmup.apply(client);
  assert.equal(warmup.pending, 0);
  warmup.add("tree.m2", "critical");
  warmup.apply(client);
  assert.equal(client.asks.length, 3, "a model already answered is not asked again");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(fetched, ["http://g/texture?path=tree.blp"]);
  warmup.dispose();
});

test("in worker mode the page streams its own tile, not the renderer's band", () => {
  assert.equal(pageEnvironmentRange(undefined), ENVIRONMENT_STREAM_RANGE);
  assert.equal(pageEnvironmentRange({}), ENVIRONMENT_STREAM_RANGE);
  assert.equal(pageEnvironmentRange({ renderWorker: {} }), PAGE_ONLY_ENVIRONMENT_RANGE);
  const cells = new Int32Array(4096);
  const band = terrainGridFootprintCells(STORMWIND.x, STORMWIND.y, ENVIRONMENT_STREAM_RANGE, cells);
  const own = terrainGridFootprintCells(STORMWIND.x, STORMWIND.y, PAGE_ONLY_ENVIRONMENT_RANGE, cells);
  // Stormwind's square: the renderer's band is 13 tiles; the page's own tile is one.
  assert.ok(band >= 9, `band ${band}`);
  assert.equal(own, 1);
  console.log(`environment tiles at Stormwind: renderer band ${band}, page in worker mode ${own}`);
});

function port() {
  const delivered = [];
  return { delivered, postMessage(message, transfer) { delivered.push(structuredClone(message, { transfer })); } };
}

const NO_STEPS = {
  recordFrameInterval() {}, afterDraw() {}, requestCollisionModels() {}, requestUnitModels() {}, acceptSeats() {},
  recordRendererFrame() {}, acceptReports() {}, drainPortraits() {},
};

test("the page's proxy: a warmed model is a worker command; results bring statuses and the curtain's frames", () => {
  const target = port();
  const statuses = [];
  const proxy = new RenderWorkerClient(target, { clientsUrl: () => "ws://127.0.0.1:8090/auth",
    steps: { ...NO_STEPS, acceptStatuses: (lines) => statuses.push(...lines) }, queueTask: (run) => run() });
  proxy.warmModel("tree.m2", "background");
  assert.deepEqual(target.delivered.at(-1).commands, [{ method: "#warmModels", args: ["tree.m2", "background"] }]);
  const state = { objects: new Map(), selfGuid: undefined, predictedGuid: undefined };
  proxy.draw(state, 0, undefined, {}, [], undefined, 1, -0.3, 20);
  const report = { collisionWants: [], unitWants: [], drawPhaseMs: {}, drawSubmitStats: { programs: 0, textures: 0,
    geometries: 0 }, cpuMs: 1, at: 1, readiness: { ...STORMWIND, terrain: true, clients: 1 } };
  for (let frame = 0; frame < 2; frame++) {
    proxy.accept({ type: "results", results: createRenderResults(DEFAULT_ATMOSPHERE_PROFILE), row: undefined, report,
      ...(frame === 0 ? { statuses: [{ line: "terrain", message: "ok", error: false }] } : {}) });
  }
  assert.deepEqual(statuses, [{ line: "terrain", message: "ok", error: false }]);
  assert.equal(proxy.drawReadiness.framesReadyAt(STORMWIND.map, STORMWIND.x, STORMWIND.y), 2);
});

/** A renderer that answers every read with nothing and records the draws. */
function fakeRenderer(log, lights = { ready: true }) {
  const known = {
    lightsReadyAround: () => lights.ready, // 24.10 (7.50)
    results: createRenderResults(DEFAULT_ATMOSPHERE_PROFILE), drawPhaseMs: {}, drawSubmitStats: {},
    programWarmup: {}, collisionModelWants: () => [], unitModelWants: () => [],
    draw: () => log.push("draw"),
  };
  return new Proxy(known, { get: (object, key) => (key in object ? object[key] : key === "then" ? undefined : () => undefined) });
}

test("the worker session: warm asks inside its frame, statuses and the terrain's readiness in its results", async () => {
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(null, { status: 404 });
  };
  try {
    const posted = [];
    const ticks = [];
    const log = [];
    const scope = { postMessage: (message) => posted.push(message), requestAnimationFrame: (run) => ticks.push(run) };
    const lights = { ready: false }; // 24.10 (7.50): the lamps around the subject not known yet
    const session = new RenderWorkerSession(scope, {}, fakeRenderer(log, lights));
    const page = port();
    const proxy = new RenderWorkerClient(page, { clientsUrl: () => "ws://127.0.0.1:8090/auth", steps: NO_STEPS,
      queueTask: (run) => run() });
    proxy.warmModel("World/tree.m2", "background");
    proxy.queryEnvironmentAt(STORMWIND.x, STORMWIND.y);
    proxy.draw({ objects: new Map(), selfGuid: undefined, predictedGuid: undefined }, 0, undefined, {}, [], undefined,
      1, -0.3, 20, undefined, undefined, undefined, undefined, 20, 1.6, undefined, undefined);
    for (const message of page.delivered) session.handle(message);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    assert.equal(requested.filter((url) => url.includes("tree")).length, 0, "nothing is asked outside the frame");
    ticks.shift()(16);
    assert.deepEqual(log, ["draw"]);
    const first = posted.at(-1);
    assert.equal(first.report.readiness.terrain, false, "its terrain tile is on its way");
    assert.equal(first.report.readiness.clients, 1);
    await settle();
    assert.ok(requested.some((url) => url.includes("tree")), "the warm ask, made by the worker's frame");
    ticks.shift()(32);
    const middle = posted.at(-1);
    assert.equal(middle.report.readiness.terrain, false, "24.10 (7.50): the terrain is in, the lamps are not yet");
    lights.ready = true;
    ticks.shift()(48);
    const second = posted.at(-1);
    assert.equal(second.report.readiness.terrain, true, "a 404 is the tile's answer");
    assert.ok(middle.statuses?.some((status) => status.line === "terrain" && /не найден/.test(status.message)),
      JSON.stringify(middle.statuses));
    assert.equal(requested.filter((url) => /\/terrain\/0\//.test(url)).length, 1, "the worker's terrain, asked once");
  } finally {
    globalThis.fetch = realFetch;
  }
});
