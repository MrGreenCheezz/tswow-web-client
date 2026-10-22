// 22.10 ARC-2 S6b — the client's world renderer in a worker (`?renderworker=1`): the page's proxy
// (RenderWorkerClient.ts) forwards the renderer calls the page makes and applies the worker's results in the loop's
// order; the start (RenderWorkerStart.ts) hands the page back on a failure; the build makes ES workers; the worker
// entry (RenderWorker.worker.ts) pulls no page-only module.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { RenderWorkerClient } from "../dist/code/browser/RenderWorkerClient.js";
import { applyRenderCommand } from "../dist/code/browser/RenderWorkerCommands.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";
import {
  renderWorkerRequested, renderWorkerSupported, startRenderWorker,
} from "../dist/code/browser/RenderWorkerStart.js";
import { RenderFrameReceiver, emptyFrameApplied } from "../dist/code/browser/RenderWorkerBridge.js";
import { createRenderResults } from "../dist/code/browser/RenderResults.js";
import { DEFAULT_ATMOSPHERE_PROFILE } from "../dist/code/browser/AtmosphereEffects.js";
import { NO_RENDER_INPUTS } from "../dist/code/browser/RenderInputs.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** A Worker stand-in: what `postMessage(message, transfer)` delivers, cloned with the transfer list honoured. */
function port() {
  const delivered = [];
  return { delivered, postMessage(message, transfer) { delivered.push(structuredClone(message, { transfer })); } };
}

/** A renderer that records every call, in order. */
function recorder() {
  const calls = [];
  const target = new Proxy({}, {
    get(_, method) {
      if (method === "then") return undefined;
      return (...args) => { calls.push({ method, args }); return undefined; };
    },
  });
  return { calls, target };
}

function noSteps(log = []) {
  const step = (name) => (...args) => log.push([name, ...args]);
  return {
    log,
    steps: {
      recordFrameInterval: step("interval"), afterDraw: step("afterDraw"), requestCollisionModels: step("collision"),
      requestUnitModels: step("units"), acceptSeats: (results) => log.push(["seats", results.seatFrame]),
      recordRendererFrame: step("cpu"),
      acceptReports: (results) => log.push(["reports", results.gpuEvents.splice(0).length]),
      drainPortraits: (results) => log.push(["portraits", results.portraits.splice(0).length]),
      workerFrame: (report) => log.push(["workerFrame", report.cpuMs]),
    },
  };
}

function manualTasks() {
  const tasks = [];
  return { tasks, queueTask: (run) => tasks.push(run), run: () => { for (const task of tasks.splice(0)) task(); } };
}

function client(options = {}) {
  const target = port();
  const tasks = manualTasks();
  const { log, steps } = noSteps();
  const proxy = new RenderWorkerClient(target, { clientsUrl: () => "ws://127.0.0.1:8090/auth", steps,
    queueTask: tasks.queueTask, ...options });
  return { proxy, target, tasks, log };
}

/** Every command posted, in order, out of commands and frame messages alike. */
function postedCommands(delivered) {
  return delivered.flatMap((message) => message.commands ?? []);
}

test("each forwarded call, applied in the worker, is the call the in-page renderer gets", () => {
  const { proxy, target, tasks } = client();
  const mainCover = { kind: "page ground cover" }, workerCover = { kind: "worker ground cover" };
  const weather = { state: 1, intensity: 0.5, abrupt: false };
  const sample = { fogStart: 10, fogEnd: 500, colours: { sky: { r: 1, g: 0.5, b: 0.25 } } };
  const plan = { instances: [{ path: "a.m2", startedAt: 10, endsAt: 20 }], animations: [], sounds: [] };
  const calls = [
    ["setRenderScale", 0.75], ["setLightingQuality", 2], ["setExperimentalShaderProfile", { aerialHeightFog: true }],
    ["setWeather", weather], ["setIndoors", true], ["updateLighting", sample, 1440, false],
    ["setSelection", { guid: 5n, colour: 0xff0000 }, undefined], ["setGroundTargetPreview", undefined],
    ["setDuelRing", { x: 1, y: 2, z: 3, inBounds: true }], ["setUnitAuraAppearance", new Map([[7n, { stealth: true }]])],
    ["setStateVisuals", new Map([[7n, [{ path: "s.m2", scale: 1, attachment: 0 }]]])],
    ["playSpellVisual", plan, 11], ["retimeSpellVisual", 11, 30], ["playUnitEmote", 9n, 10, 0],
    ["playUnitAction", 9n, "attack", 0, 4], ["setMeleeTargets", new Set([9n]), 2], ["playMountSpecial", 9n],
    ["playGameObjectAnimation", 12n, 1], ["cancelSpellVisual", 11], ["clearPortraits"], ["clearTerrain"],
  ];
  for (const [method, ...args] of calls) proxy[method](...args);
  proxy.setGroundCover(mainCover, 50, true, 2);
  tasks.run();
  const forwarded = recorder();
  for (const command of postedCommands(target.delivered)) {
    applyRenderCommand(forwarded.target, command, (present) => present ? workerCover : undefined);
  }
  const direct = recorder();
  for (const [method, ...args] of calls) direct.target[method](...args);
  direct.target.setGroundCover(workerCover, 50, true, 2);
  assert.deepEqual(forwarded.calls, structuredClone(direct.calls));
  assert.equal(proxy.playUnitAction(9n, "attack", 0, 6), 6, "a swing's id comes back as the renderer's would");
});

test("a setting that repeats is not sent; the weather by identity, objects never; the realm's end forgets", () => {
  const { proxy, target, tasks } = client();
  const weather = { state: 1, intensity: 0.5, abrupt: false };
  const selection = { guid: 1n, colour: 1 };
  for (let frame = 0; frame < 3; frame++) {
    proxy.setWeather(weather);
    proxy.setIndoors(false);
    proxy.setGroundTargetPreview(undefined);
    proxy.setSelection(selection, undefined); // refilled in place by a caller: always sent
  }
  proxy.setWeather({ ...weather });
  proxy.clearWorldResources();
  proxy.setIndoors(false);
  tasks.run();
  assert.deepEqual(postedCommands(target.delivered).map((command) => command.method), [
    "setWeather", "setIndoors", "setGroundTargetPreview", "setSelection", "setSelection", "setSelection", "setWeather",
    "clearWorldResources", "setIndoors",
  ]);
  for (const [method, kind] of Object.entries(RENDER_WORKER_COMMANDS)) {
    assert.ok(["setting", "state", "action"].includes(kind), method);
  }
});

test("a frame carries what was queued before it; a page frame without a draw stops the worker's draws", () => {
  const { proxy, target, tasks } = client();
  const terrain = {};
  const state = { objects: new Map(), selfGuid: undefined, predictedGuid: undefined };
  const draw = () => proxy.draw(state, 0, undefined, terrain, [], undefined, 1, -0.3, 20, undefined, undefined,
    undefined, undefined, 20, 1.6, undefined, undefined);
  proxy.markFrameNotRendered();
  proxy.setWeather(undefined);
  proxy.setRenderInputs({ ...NO_RENDER_INPUTS, publishStatus: true });
  proxy.queryEnvironmentAt(-8840, 626);
  draw();
  tasks.run(); // the queued flush finds nothing left
  assert.equal(target.delivered.length, 1);
  const [frame] = target.delivered;
  assert.equal(frame.type, "frame");
  assert.deepEqual(frame.commands.map((command) => command.method), ["setWeather"]);
  assert.deepEqual(frame.clients, { key: 1, url: "ws://127.0.0.1:8090/auth" });
  assert.deepEqual(frame.environmentAt, [-8840, 626]);
  const receiver = new RenderFrameReceiver();
  receiver.apply(frame, emptyFrameApplied());
  assert.equal(receiver.args.cameraYaw, 1);
  assert.equal(receiver.inputs.publishStatus, true);

  proxy.markFrameNotRendered(); // the next page frame draws again: nothing to say
  draw();
  assert.equal(target.delivered.at(-1).clients.key, 1, "the same page clients, the same key");
  proxy.markFrameNotRendered(); // this page frame draws nothing…
  proxy.markFrameNotRendered(); // …which the next one says once
  proxy.markFrameNotRendered();
  tasks.run();
  assert.deepEqual(postedCommands(target.delivered.slice(2)).map((command) => command.method), ["#idle"]);
  proxy.draw(state, 0, undefined, {}, [], undefined);
  assert.equal(target.delivered.at(-1).clients.key, 2, "another terrain client is another world entry");
});

function results(overrides = {}) {
  return Object.assign(createRenderResults(DEFAULT_ATMOSPHERE_PROFILE), overrides);
}

test("each results message replaces the record and runs the after-draw work in the loop's order, once", () => {
  const { proxy, log } = client();
  const first = results({ frameInterval: 6.9, rendererFrameMs: 3.5, seatFrame: 4 });
  first.portraits.push({ kind: "clear", canvas: 1 });
  first.gpuEvents.push({ kind: "sample", milliseconds: 1 });
  proxy.accept(structuredClone({ type: "results", results: first, row: undefined,
    report: { collisionWants: ["w.wmo"], unitWants: [7n], drawPhaseMs: { units: 1 }, drawSubmitStats: { programs: 0,
      textures: 0, geometries: 0 }, cpuMs: 4, at: 100 } }));
  assert.deepEqual(log, [["interval", 6.9], ["afterDraw"], ["collision", ["w.wmo"]], ["units", [7n]], ["seats", 4],
    ["cpu", 3.5], ["reports", 1], ["portraits", 1], ["workerFrame", 4]]);
  assert.equal(proxy.results.seatFrame, 4);
  assert.equal(proxy.results.frameInterval, undefined, "recorded here, so the loop's read records nothing");
  assert.equal(proxy.results.rendererFrameMs, undefined);
  assert.deepEqual(proxy.drawPhaseMs, { units: 1 });
  assert.equal(proxy.collisionModelWants().size, 0, "asked on arrival, not again by the loop");

  log.length = 0;
  // A message without a draw (portrait clears outside a world) applies the queues only.
  const second = results();
  second.portraits.push({ kind: "clear", canvas: 2 });
  proxy.accept(structuredClone({ type: "results", results: second, row: undefined }));
  assert.deepEqual(log, [["reports", 0], ["portraits", 1]]);
  assert.equal(proxy.resultsApplied, 2);
});

test("operations a previous record still held go first; a frame error is counted, not thrown", () => {
  const { log } = noSteps();
  const kept = [];
  const proxy = new RenderWorkerClient(port(), { clientsUrl: () => undefined, steps: {
    ...noSteps(log).steps, drainPortraits: (record) => kept.push(record.portraits.map((output) => output.canvas)),
  } });
  const first = results();
  first.portraits.push({ kind: "clear", canvas: 1 });
  const thrower = new RenderWorkerClient(port(), { clientsUrl: () => undefined, steps: {
    ...noSteps().steps, drainPortraits: () => { throw new Error("canvas gone"); } } });
  const errors = console.error;
  console.error = () => {};
  try {
    thrower.accept({ type: "results", results: first, row: undefined });
    const second = results();
    second.portraits.push({ kind: "clear", canvas: 2 });
    thrower.accept({ type: "results", results: second, row: undefined });
    assert.deepEqual(thrower.results.portraits.map((output) => output.canvas), [1, 2], "kept in order");
    proxy.accept({ type: "results", results: results(), row: undefined, report: { collisionWants: [], unitWants: [],
      drawPhaseMs: {}, drawSubmitStats: {}, cpuMs: 1, at: 1, frameError: "boom" } });
    assert.equal(proxy.frameErrors, 1);
  } finally {
    console.error = errors;
  }
  assert.deepEqual(kept, [[]]);
});

function fakeWorker() {
  const listeners = new Map();
  const worker = {
    posted: [], terminated: 0,
    postMessage(message, transfer) { worker.posted.push({ message, transfer }); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    terminate() { worker.terminated++; },
    emit(type, event) { listeners.get(type)?.(event); },
  };
  return worker;
}

function startOptions(worker, fallbacks, canvas = { transferControlToOffscreen: () => ({ offscreen: true }) }) {
  return {
    canvas, createWorker: () => worker, host: () => ({ devicePixelRatio: 1, cssWidth: 800, cssHeight: 600, query: "" }),
    baseUrl: "http://127.0.0.1:5173", gatewayGeneration: { revision: 0 }, mainTimeOrigin: 1,
    client: { clientsUrl: () => undefined, steps: noSteps().steps, queueTask: (run) => run() },
    fallback: (reason, failed) => fallbacks.push({ reason, failed }),
  };
}

test("a worker that fails hands the page back once: closed, terminated, its settings replayed in-page", () => {
  const worker = fakeWorker();
  const fallbacks = [];
  const proxy = startRenderWorker(startOptions(worker, fallbacks));
  assert.ok(proxy);
  assert.equal(worker.posted[0].message.type, "init");
  assert.deepEqual(worker.posted[0].transfer, [worker.posted[0].message.canvas], "the canvas is transferred");
  proxy.setRenderScale(0.5);
  proxy.setGroundCover({ page: true }, 40, false, 1);
  proxy.playUnitEmote(1n, 2, 0); // an action: not replayed
  worker.emit("error", { message: "Failed to load module script" });
  worker.emit("error", { message: "again" });
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].reason, "Failed to load module script");
  assert.equal(worker.terminated, 1);
  const posted = worker.posted.length;
  proxy.setRenderScale(0.25);
  assert.equal(worker.posted.length, posted, "a closed proxy posts nothing");
  const inPage = recorder();
  fallbacks[0].failed.replayOnto(inPage.target);
  assert.deepEqual(inPage.calls, [{ method: "setRenderScale", args: [0.5] },
    { method: "setGroundCover", args: [{ page: true }, 40, false, 1] }], "the page's own client, not a flag");

  // The renderer's constructor threw in the worker: its `error` message.
  const second = fakeWorker();
  const more = [];
  startRenderWorker(startOptions(second, more));
  second.emit("message", { data: { type: "error", message: "WebGL2 unavailable" } });
  assert.deepEqual(more.map((entry) => entry.reason), ["WebGL2 unavailable"]);

  // A canvas that refuses the transfer: nothing started, nothing to fall back from.
  const third = fakeWorker();
  const none = [];
  const refused = startRenderWorker(startOptions(third, none,
    { transferControlToOffscreen: () => { throw new Error("context exists"); } }));
  assert.equal(refused, undefined);
  assert.deepEqual(none, []);
  assert.equal(third.terminated, 1);
});

test("the flag is opt-in and needs OffscreenCanvas, a transferable canvas and module workers", () => {
  assert.equal(renderWorkerRequested(""), false);
  assert.equal(renderWorkerRequested("?renderworker=0"), false);
  assert.equal(renderWorkerRequested("?legacy-login&renderworker=1"), true);
  class ModuleWorker { constructor(_url, options) { void options?.type; } terminate() {} }
  class ClassicWorker { constructor() {} terminate() {} }
  const canvas = { prototype: { transferControlToOffscreen() {} } };
  assert.equal(renderWorkerSupported({ OffscreenCanvas: class {}, HTMLCanvasElement: canvas, Worker: ModuleWorker }), true);
  assert.equal(renderWorkerSupported({ OffscreenCanvas: class {}, HTMLCanvasElement: canvas, Worker: ClassicWorker }), false);
  assert.equal(renderWorkerSupported({ HTMLCanvasElement: canvas, Worker: ModuleWorker }), false);
  assert.equal(renderWorkerSupported({ OffscreenCanvas: class {}, HTMLCanvasElement: { prototype: {} },
    Worker: ModuleWorker }), false);
});

test("the build makes every worker an ES module, so the render worker can start its own", async () => {
  const config = await import(pathToFileURL(path.join(ROOT, "vite.config.mjs")).href);
  assert.equal(config.RENDER_WORKER_FORMAT, "es");
  const resolved = config.default({ mode: "production", command: "build" });
  assert.equal(resolved.worker?.format, "es");
});

/** Relative value imports of one source file (type-only imports vanish from the bundle). As tests/render-worker.test.mjs. */
function relativeImports(source) {
  const found = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) if (!match[1]) found.push(match[2]);
  for (const match of source.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) found.push(match[1]);
  return found;
}

async function importClosure(start) {
  const parent = new Map([[start, undefined]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const specifier of relativeImports(await readFile(file, "utf8"))) {
      const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
      if (!existsSync(resolved) || parent.has(resolved)) continue;
      parent.set(resolved, file);
      queue.push(resolved);
    }
  }
  return parent;
}

test("the client render worker imports no page-only module and reads no page global", async () => {
  const entry = path.join(SRC, "browser", "RenderWorker.worker.ts");
  const parent = await importClosure(entry);
  for (const reached of ["WorldRenderer3D.ts", "TransportPath.ts", "RenderWorkerSession.ts", "PageVisibility.ts"]) {
    assert.ok(parent.has(path.join(SRC, "browser", reached)), `the walk reached ${reached}`);
  }
  assert.ok(parent.size > 150, `the walk followed the imports (${parent.size} files)`);
  for (const banned of ["browser/SimpleScene.ts", "browser/NamePlate.ts", "browser/ui/IconImage.ts", "browser/ui/Dom.ts",
    "browser/main.ts", "browser/game/Loop.ts", "browser/game/Context.ts", "browser/app/RenderWorkerMount.ts",
    "browser/RenderWorkerClient.ts", "browser/RenderWorkerStart.ts", "browser/PatchChainChanged.ts",
    "browser/game/RendererReportsMain.ts", "browser/ui/Portraits.ts", "browser/bench/Harness.ts"]) {
    const file = path.join(SRC, ...banned.split("/"));
    const chain = [];
    for (let at = file; at !== undefined && parent.has(at); at = parent.get(at)) chain.push(path.relative(SRC, at));
    assert.equal(parent.has(file), false, `${banned} is imported: ${chain.join(" <- ")}`);
  }
  const code = (text) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
  for (const file of ["RenderWorker.worker.ts", "RenderWorkerSession.ts", "RenderWorkerClients.ts", "RenderWorkerCommands.ts",
    "RenderWorkerClientProtocol.ts", "RenderWorkerClient.ts", "RenderWorkerStart.ts"]) {
    const source = code(await readFile(path.join(SRC, "browser", file), "utf8"));
    for (const pattern of [/\bwindow\./, /\bdocument\./, /(?<![.\w])location\./, /\.clientWidth\b/, /new ResizeObserver\b/]) {
      assert.doesNotMatch(source, pattern, file);
    }
  }
});

test("the page starts the render worker only behind the flag, with the in-page path unchanged", async () => {
  const main = await readFile(path.join(SRC, "browser", "main.ts"), "utf8");
  assert.match(main, /if \(renderWorkerRequested\(location\.search\)\) \{\s*\/\/[^\n]*\n\s*game\.renderer = mountWorldRenderWorker\(world3dCanvas\);\s*\} else \{\s*const renderer = new WorldRenderer3D\(world3dCanvas\);/);
  const mount = await readFile(path.join(SRC, "browser", "app", "RenderWorkerMount.ts"), "utf8");
  assert.match(mount, /new Worker\(new URL\("\.\.\/RenderWorker\.worker\.ts", import\.meta\.url\), \{\s*type: "module"/);
});
