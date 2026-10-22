// 22.10 ARC-2 S6a — the world renderer in a DedicatedWorker: the page↔worker messages (RenderWorkerProtocol.ts,
// RenderWorkerBridge.ts), the worker's RenderHost (WorkerRenderHost.ts), the bench's worker build (bench/build.mjs
// `buildRenderWorkerBench`) and the worker entry's import closure staying free of page-only modules.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RenderFrameReceiver, RenderFrameSender, emptyFrameApplied } from "../dist/code/browser/RenderWorkerBridge.js";
import { clearPostedReports, frameTransferList } from "../dist/code/browser/RenderWorkerProtocol.js";
import { WorkerRenderHost } from "../dist/code/browser/WorkerRenderHost.js";
import { pageHostValues, pageRenderHost } from "../dist/code/browser/RenderHost.js";
import { createRenderResults } from "../dist/code/browser/RenderResults.js";
import { DEFAULT_ATMOSPHERE_PROFILE } from "../dist/code/browser/AtmosphereEffects.js";
import {
  drainPatchChainSuspects, mergeRendererBudget, patchChainSuspectQueue, queuedGpuObserver, replayGpuEvents,
} from "../dist/code/browser/RendererReports.js";
import { FrameBudgetProbe, FRAME_BUDGET } from "../dist/code/browser/FrameBudgetProbe.js";
import { NO_RENDER_INPUTS } from "../dist/code/browser/RenderInputs.js";
import { gatewayGenerationPush } from "../dist/code/browser/GatewayGeneration.js";
import { BenchCrowd, BenchUnitModels, benchScenario } from "../dist/code/browser/bench/BenchScene.js";
import { flipRows } from "../dist/code/browser/PixelPng.js";
import { BENCHMARK_SCRIPT_FILES, RENDER_WORKER_SCRIPT_FILES, buildRenderWorkerBench } from "../bench/build.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const CONFIG = {
  seed: 1, width: 64, height: 32, pixelRatio: 1, durationSeconds: 20, warmupSeconds: 5, timeoutSeconds: 10,
  halfMinute: 1440, route: { map: 0, x: -9460, y: -120, dx: -320, dy: 40 },
  graphics: { lightingQuality: 1, grassRadius: 100, grassDense: true, grassDensity: 2, fullscreenGlow: true },
  city: { map: 0, x: -8840, y: 626, z: 93.95, population: 12, spacing: 2.4, walkers: 4, orbit: 18, pitch: -0.35,
    displays: [3167, 5446], graphics: { lightingQuality: 2, grassRadius: 80, grassDense: true, grassDensity: 3,
      fullscreenGlow: true } },
};

/** A Worker stand-in: what `postMessage(message, transfer)` delivers, cloned with the transfer list honoured. */
function channel() {
  const delivered = [];
  return {
    delivered,
    postMessage(message, transfer) { delivered.push(structuredClone(message, { transfer })); },
  };
}

function cityCrowd() {
  const scene = benchScenario(CONFIG, "city");
  const crowd = new BenchCrowd(CONFIG, scene, (i) => CONFIG.city.displays[i % 2]);
  const models = new BenchUnitModels((object) => ({ id: object.fields.get(0x3b) ?? 0, model: "m", textures: [] }));
  return { scene, crowd, models };
}

function frameArgs(seconds) {
  return { map: 0, cameraYaw: seconds, cameraPitch: -0.35, cameraDistance: 18, cameraAnchorDistance: 24,
    cameraPivotHeight: 1.6, wmoFloor: undefined, frameTime: { nowMs: seconds * 1000, elapsedSeconds: 1 / 60, frameIndex: 1 } };
}

test("frame messages cross a real post: the typed arrays are transferred and the mirror follows the page", () => {
  const { crowd, models } = cityCrowd();
  const target = channel();
  const sender = new RenderFrameSender();
  sender.measureBytes = true;
  const receiver = new RenderFrameReceiver();
  const applied = emptyFrameApplied();
  for (const [index, seconds] of [0, 0.5, 1.25].entries()) {
    crowd.place(seconds, seconds / 20, () => undefined);
    models.refresh(crowd.state);
    const posted = sender.post(target, crowd.state, frameArgs(seconds), models.lookups,
      index === 1 ? { ...NO_RENDER_INPUTS, frameBudgetProbe: true } : undefined);
    // The page's copies of the transferred arrays are detached: nothing of them stays behind on the page.
    assert.equal(posted.input.motion.byteLength, 0, "motion transferred");
    assert.equal(posted.input.removed.byteLength, 0, "removed transferred (an empty one has nothing to give)");
    const message = target.delivered.at(-1);
    assert.equal(message.type, "frame");
    receiver.apply(message, applied);
    const mirror = receiver.world;
    assert.equal(mirror.objects.size, crowd.state.objects.size);
    assert.equal(mirror.selfGuid, crowd.state.selfGuid);
    for (const [guid, object] of crowd.state.objects) {
      const copy = mirror.objects.get(guid);
      assert.deepEqual({ ...copy.position }, { ...object.position }, `position of ${guid} at ${seconds}`);
      assert.deepEqual([...copy.fields], [...object.fields]);
    }
    assert.equal(receiver.args.cameraYaw, seconds);
    assert.equal(receiver.lookups.unitModels.size, crowd.state.objects.size, "the unit-model table crossed");
    if (index >= 1) assert.equal(receiver.inputs.frameBudgetProbe, true, "the pushed inputs are kept once sent");
    else assert.equal(receiver.inputs, undefined);
  }
  assert.equal(applied.messages, 3);
  assert.ok(applied.bytes > applied.frameBytes && applied.frameBytes > 0, "the page's byte estimate rides along");
  assert.ok(applied.postMs >= 0 && applied.encodeMs > 0);
});

test("the transfer list names each fresh buffer once and never an empty one", () => {
  const motion = new Float64Array(7), fields = new Float64Array(3), removed = new Int32Array(0);
  const order = new Int32Array(2);
  const list = frameTransferList({ motion, fields, removed, order });
  assert.deepEqual(list, [motion.buffer, fields.buffer, order.buffer]);
  const shared = new Float64Array(8);
  assert.deepEqual(frameTransferList({ motion: shared.subarray(0, 4), fields: shared.subarray(4), removed, order: undefined }),
    [shared.buffer]);
});

test("init and results are structured-clonable; the reports are applied on the page exactly once", () => {
  const init = { type: "init", host: pageHostValues({ clientWidth: 1920, clientHeight: 919 }, 1.25, "?scenario=city"),
    baseUrl: "http://127.0.0.1:1234", gatewayGeneration: gatewayGenerationPush(), mainTimeOrigin: 1234.5,
    driver: { config: CONFIG, scenario: "city" } };
  assert.deepEqual(structuredClone(init), init);

  const results = createRenderResults(DEFAULT_ATMOSPHERE_PROFILE);
  results.units.set(5n, new Float64Array([1.8, 1.2, 1.6, 3]));
  const gpu = queuedGpuObserver(results);
  gpu.onSample(2.5);
  gpu.onUnavailable("no-extension");
  patchChainSuspectQueue(results)("http://127.0.0.1:1234/texture?x");
  results.budgetMs[FRAME_BUDGET.groundCover ?? 0] = 0.75;
  results.budgetPending = true;
  const target = channel();
  const row = Float64Array.of(1, 2, 3);
  target.postMessage({ type: "results", results, row }, [row.buffer]);
  clearPostedReports(results);
  assert.equal(row.byteLength, 0, "the row was transferred");
  assert.deepEqual([results.gpuEvents.length, results.patchChainSuspects.length, results.budgetPending], [0, 0, false],
    "the worker's queues are the page's once posted");
  assert.equal(results.budgetMs.every((ms) => ms === 0), true);

  const message = target.delivered[0];
  assert.deepEqual([...message.results.units.get(5n)], [1.8, 1.2, 1.6, 3]);
  const samples = [], reasons = [], urls = [];
  replayGpuEvents(message.results, { onSample: (ms) => samples.push(ms), onUnavailable: (reason) => reasons.push(reason) });
  const probe = new FrameBudgetProbe(() => 0);
  probe.setEnabled(true);
  probe.frameStart();
  mergeRendererBudget(message.results, probe);
  drainPatchChainSuspects(message.results, (url) => urls.push(url));
  probe.frameStart();
  assert.deepEqual(samples, [2.5]);
  assert.deepEqual(reasons, ["no-extension"]);
  assert.deepEqual(urls, ["http://127.0.0.1:1234/texture?x"]);
  assert.equal(probe.lastBudgetMs, 0.75, "the worker's limiter time closed the page's period");
  assert.deepEqual([...message.row], [1, 2, 3]);
});

function withGlobals(values, run) {
  const previous = new Map(Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    return run();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test("the worker host answers like the page host for the same pushed values", () => {
  const observers = [];
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  withGlobals({ window: { devicePixelRatio: 1.25 }, location: { search: "?scenario=city&poseworker=0" },
    ResizeObserver: FakeResizeObserver }, () => {
    const canvas = { clientWidth: 1920, clientHeight: 919 };
    const page = pageRenderHost(canvas);
    const probe = new FrameBudgetProbe();
    const worker = new WorkerRenderHost(pageHostValues(canvas, window.devicePixelRatio, location.search), probe);
    assert.equal(worker.devicePixelRatio(), page.devicePixelRatio());
    assert.deepEqual(worker.canvasCssSize(), page.canvasCssSize());
    assert.equal(worker.queryFlags().toString(), page.queryFlags().toString());
    assert.equal(worker.loadTexture, page.loadTexture, "the one bitmap texture path");
    assert.equal(worker.createCanvas, page.createCanvas);
    // By design, the two realms' own: the GPU events queue into the results, the sensor is the worker's.
    assert.equal(page.frameBudgetProbe, undefined);
    assert.equal(worker.frameBudgetProbe, probe);
    const results = createRenderResults(DEFAULT_ATMOSPHERE_PROFILE);
    worker.gpuTimerObserver(results).onSample(1.5);
    assert.deepEqual(results.gpuEvents, [{ kind: "sample", milliseconds: 1.5 }]);

    // A resize: the page's observer reports it, the worker's host hears it from the pushed values.
    const pageSizes = [], workerSizes = [];
    page.observeCanvasCssSize((size) => pageSizes.push(size));
    const unsubscribe = worker.observeCanvasCssSize((size) => workerSizes.push(size));
    canvas.clientWidth = 1280;
    canvas.clientHeight = 720;
    observers[0].callback([{ contentRect: { width: 1280, height: 720 } }]);
    worker.update(pageHostValues(canvas, 1.25, location.search));
    worker.update(pageHostValues(canvas, 1.5, location.search));
    assert.deepEqual(workerSizes, pageSizes, "one report per size change, as a ResizeObserver gives");
    assert.deepEqual(worker.canvasCssSize(), page.canvasCssSize());
    assert.equal(worker.devicePixelRatio(), 1.5);
    unsubscribe();
    worker.update({ ...pageHostValues(canvas, 1.5, ""), cssWidth: 10 });
    assert.equal(workerSizes.length, 1, "an unsubscribed listener hears nothing");
  });
});

test("readPixels rows are flipped to an image's top-down order", () => {
  const bottomUp = Uint8Array.of(1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4);
  assert.deepEqual([...flipRows(bottomUp, 2, 2)], [3, 3, 3, 3, 4, 4, 4, 4, 1, 1, 1, 1, 2, 2, 2, 2]);
});

/** Relative value imports of one source file (type-only imports vanish from the bundle). As tests/render-host.test.mjs. */
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

test("the render worker entry imports no page-only module and reads no page global", async () => {
  const entry = path.join(SRC, "browser", "bench", "BenchRender.worker.ts");
  const parent = await importClosure(entry);
  assert.ok(parent.has(path.join(SRC, "browser", "WorldRenderer3D.ts")), "the walk reached the renderer");
  assert.ok(parent.size > 150, `the walk followed the imports (${parent.size} files)`);
  for (const banned of ["browser/SimpleScene.ts", "browser/NamePlate.ts", "browser/ui/IconImage.ts", "browser/ui/Dom.ts",
    "browser/main.ts", "browser/game/Loop.ts", "browser/bench/Harness.ts", "browser/bench/WorkerBenchPage.ts",
    "browser/PatchChainChanged.ts", "browser/game/RendererReportsMain.ts"]) {
    const file = path.join(SRC, ...banned.split("/"));
    const chain = [];
    for (let at = file; at !== undefined && parent.has(at); at = parent.get(at)) chain.push(path.relative(SRC, at));
    assert.equal(parent.has(file), false, `${banned} is imported: ${chain.join(" <- ")}`);
  }
  const code = (text) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
  for (const file of ["bench/BenchRender.worker.ts", "bench/BenchRenderSide.ts", "bench/BenchScene.ts", "WorkerRenderHost.ts",
    "RenderWorkerBridge.ts", "RenderWorkerProtocol.ts", "PixelPng.ts"]) {
    const source = code(await readFile(path.join(SRC, "browser", ...file.split("/")), "utf8"));
    for (const pattern of [/\bwindow\./, /\bdocument\./, /(?<![.\w])location\./, /\.clientWidth\b/, /new ResizeObserver\b/]) {
      assert.doesNotMatch(source, pattern, file);
    }
  }
});

test("the bench's worker build serves the render worker and the workers it starts at their production URLs", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "webclient-render-worker-bench-"));
  try {
    const result = await buildRenderWorkerBench(out);
    const page = await readFile(path.join(out, "bench-page.js"), "utf8");
    assert.match(page, /new URL\("\.\/BenchRender\.worker\.ts", import\.meta\.url\)/);
    assert.ok(RENDER_WORKER_SCRIPT_FILES["/BenchRender.worker.ts"], "run.mjs serves the URL the page starts");
    const worker = await readFile(path.join(out, RENDER_WORKER_SCRIPT_FILES["/BenchRender.worker.ts"]), "utf8");
    // Nested workers resolve against the render worker's own URL (the root): each must be one run.mjs serves.
    const nested = [...worker.matchAll(/new URL\("\.\/([\w.]+\.worker\.ts)", import\.meta\.url\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(nested)].sort(),
      ["EnvironmentTileDecode.worker.ts", "PoseEngine.worker.ts", "WvaAnimationDecode.worker.ts"]);
    for (const name of nested) assert.ok(BENCHMARK_SCRIPT_FILES[`/${name}`], `${name} is served`);
    assert.doesNotMatch(worker, /document\.querySelector/);
    const output = Object.values(result.metafile.outputs)
      .find((value) => value.entryPoint === "src/browser/bench/BenchRender.worker.ts");
    assert.ok(output.inputs["src/browser/WorldRenderer3D.ts"], "the real renderer, not a stub");
  } finally {
    const target = path.resolve(out);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    await rm(target, { recursive: true, force: true });
  }
});

test("bench/run.mjs offers the worker mode and the main-thread load", async () => {
  const run = await readFile(path.join(ROOT, "bench", "run.mjs"), "utf8");
  assert.match(run, /\['direct', 'loopback', 'worker'\]\.includes\(renderBridge\)/);
  assert.match(run, /const mainLoad = args\.includes\('--load'\)/);
  assert.match(run, /workerBridge \? '\/bench-page\.js' : '\/harness\.js'/);
});
