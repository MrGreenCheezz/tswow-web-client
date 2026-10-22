/**
 * 22.10 ARC-2 S6a: the page of `bench/run.mjs --renderbridge worker`. The world (the crowd, the camera, the unit-model
 * table) stays here, as it will in the client; the renderer runs in BenchRender.worker.ts, drawing into this page's
 * canvas through `transferControlToOffscreen`. Each page frame encodes the world (RenderWorkerBridge.ts) and posts it;
 * the worker answers every draw with RenderResults (whose GPU, budget and patch-chain reports are applied here) and,
 * while measuring, the frame's row.
 *
 * `window.__bench` answers run.mjs as the in-page harness does: `prepare`, `run`, `view`, `state`, `lookdev` and
 * `shadowStats`. Preparation, settling and views draw in lockstep (one worker draw per page frame, answered); `run`
 * lets the worker draw on its own animation frames with the latest world while this page keeps posting — so a
 * stalled page (run.mjs `--load`) stalls the world, not the frames. `--diagnostic`, `--links`, `sceneStats` and the
 * capture A/B read the renderer on the page and are refused here.
 */

import { CREATURE_MODEL_VERSION } from "../CharacterAtlas.js";
import type { UnitModel } from "../CreatureModelClient.js";
import { frameBudgetProbe } from "../FrameBudgetProbe.js";
import { gatewayGenerationPush } from "../GatewayGeneration.js";
import { reportPatchChainSuspect } from "../PatchChainSuspect.js";
import { drainPatchChainSuspects, mergeRendererBudget, replayGpuEvents } from "../RendererReports.js";
import { NO_RENDER_INPUTS, type RenderInputs } from "../RenderInputs.js";
import { TerrainClient } from "../Terrain.js";
import { RenderFrameSender } from "../RenderWorkerBridge.js";
import { summarizeInputStates } from "../RenderInputSmoothing.js";
import type { RenderWorkerCall, RenderWorkerInit, RenderWorkerToPage } from "../RenderWorkerProtocol.js";
import { pageHostValues } from "../RenderHost.js";
import type { GpuTimerObserver, GpuTimerUnavailableReason } from "../GpuTimer.js";
import { errorsAreKnownMissingTextures } from "./KnownMissingTextures.js";
import {
  BenchCrowd, BenchUnitModels, benchCamera, benchFrameTime, benchModelOf, benchPhaseNames, benchScenario,
  type BenchConfig,
} from "./BenchScene.js";
import type { BenchReadiness } from "./BenchRenderSide.js";
import type { BenchDrawRequest, BenchWorkerDriver } from "./BenchRender.worker.js";

/** The in-page harness's bridge columns (its `--renderbridge loopback` five), then how many frame messages a draw applied. */
export const WORKER_BRIDGE_COLUMNS = Object.freeze(['bridgeEncodeMs', 'bridgeCloneMs', 'bridgeDecodeMs', 'bridgeBytes',
  'bridgeFrameBytes', 'bridgeMessages']);
/**
 * 22.10 ARC-2 S7: per worker frame, how old the page's input was when drawn (ms) and what was drawn of it
 * (RenderInputSmoothing.ts: 0 fresh, 1 splines advanced, 2 extrapolated, 3 extrapolation held at its cap).
 */
export const WORKER_INPUT_COLUMNS = Object.freeze(['inputAgeMs', 'inputState']);
const WORKER_TAIL_COLUMNS = Object.freeze([...WORKER_BRIDGE_COLUMNS, ...WORKER_INPUT_COLUMNS]);

const config = await (await fetch('/config.json')).json() as BenchConfig;
const params = new URLSearchParams(location.search);
const scenarioName = params.get('scenario') ?? 'movement';
const budgetProbe = params.has('budgetprobe');
/**
 * When the page posts the world while the worker measures: after each drawn worker frame (`worker`, the default — every
 * worker frame finds a fresh world when the page is free, as every in-page frame has one), or on the page's own
 * animation frames (`raf`, run.mjs `--page-pace raf`): headless Chrome runs the page's rAF near 57 Hz once the canvas
 * belongs to the worker, so there the worker draws the same world two frames in five.
 */
const pagePace = params.get('pagepace') === 'raf' ? 'raf' : 'worker';
if (params.has('diagnostic') || params.has('links')) {
  throw new Error('--renderbridge worker: --diagnostic and --links patch the renderer on the page; run them in-page');
}
const scene = benchScenario(config, scenarioName);
if (!scene.movement) throw new Error('--renderbridge worker draws the world scenarios (movement, world-crowd-*, city*)');
const { worldCrowd, city, arrival, count, map } = scene;
const phaseNames = benchPhaseNames(scene);
const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const baseUrl = location.origin;
async function checked(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Asset ${response.status}: ${url}`);
  return response;
}
const display = (await (await checked(`${baseUrl}/dbc/creature-models?v=${CREATURE_MODEL_VERSION}&ids=49`)).json() as UnitModel[])[0]!;
if (!display?.appearance) throw new Error('Display 49 has no real character appearance');
const cityDisplays = city
  ? await (await checked(`${baseUrl}/dbc/creature-models?v=${CREATURE_MODEL_VERSION}&ids=${config.city.displays.join(',')}`)).json() as UnitModel[]
  : [];
if (city && cityDisplays.length !== config.city.displays.length) throw new Error('City display missing');

// The world, as the in-page harness keeps it (BenchScene.ts).
const crowd = new BenchCrowd(config, scene, (i) => city ? cityDisplays[i % cityDisplays.length]!.id : display.id);
const unitModels = new BenchUnitModels(benchModelOf(scene, display, cityDisplays));
// The page's own terrain for the route's ground heights (the city floor is a constant): the client's main thread
// keeps its own heights too. Made on first use, so a city run fetches nothing here.
let pageTerrain: TerrainClient | undefined;
const heightAt = (x: number, y: number) => (pageTerrain ??= new TerrainClient(baseUrl)).heightAt(map, x, y);
const camera = { yaw: 0, pitch: 0, orbit: 0 };
let lastFraction = 0;
let lastFrame = 0;
let routeHeightMissing = 0;
let preparingWorldCrowd = worldCrowd || city;

// The GPU timer's events and the budget sensor's times arrive with every results record.
const gpuSamplesMs: number[] = [];
let recording = false;
let gpuReason: GpuTimerUnavailableReason | undefined;
const gpuObserver: GpuTimerObserver = { onSample(ms: number) { if (recording) gpuSamplesMs.push(ms); },
  onUnavailable(reason) { gpuReason = reason; } };
let onRow: ((row: Float64Array) => void) | undefined;
/** The pushed records the next frame message carries (the budget sensor's flag), once. */
let pushInputs: RenderInputs | undefined;

// The worker, the canvas it draws into, and the message plumbing.
const canvas = document.querySelector('canvas')!;
const host = pageHostValues(canvas, window.devicePixelRatio, location.search);
const offscreen = canvas.transferControlToOffscreen();
const worker = new Worker(new URL('./BenchRender.worker.ts', import.meta.url), { type: 'module' });
const sender = new RenderFrameSender();
sender.measureBytes = true;
let nextId = 1;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let workerReady: (crossOriginIsolated: boolean) => void;
let workerFailed: (error: Error) => void;
const ready = new Promise<boolean>((resolve, reject) => { workerReady = resolve; workerFailed = reject; });

function fail(message: string): void {
  const error = new Error(`render worker: ${message}`);
  workerFailed(error);
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
  // Raised as a page error, as an uncaught harness error on the page is (run.mjs `pageerror`).
  setTimeout(() => { throw error; });
}

worker.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as RenderWorkerToPage;
  if (data.type === 'results') {
    replayGpuEvents(data.results, gpuObserver);
    mergeRendererBudget(data.results, frameBudgetProbe);
    drainPatchChainSuspects(data.results, reportPatchChainSuspect);
    if (data.row !== undefined) onRow?.(data.row);
  } else if (data.type === 'reply') {
    const entry = pending.get(data.id);
    pending.delete(data.id);
    if (data.error !== undefined) entry?.reject(new Error(data.error));
    else entry?.resolve(data.result);
  } else if (data.type === 'ready') {
    workerReady(data.crossOriginIsolated);
  } else if (data.type === 'error') {
    fail(data.message);
  }
});
worker.addEventListener('error', (event: ErrorEvent) => fail(event.message || 'the worker script failed'));

const init: RenderWorkerInit<BenchWorkerDriver> = {
  type: 'init', canvas: offscreen, host, baseUrl, gatewayGeneration: gatewayGenerationPush(),
  mainTimeOrigin: performance.timeOrigin, driver: { config, scenario: scenarioName },
};
worker.postMessage(init, [offscreen]);
const workerCrossOriginIsolated = await ready;

function newCall(method: string, args: readonly unknown[]): { call: RenderWorkerCall; answer: Promise<unknown> } {
  const id = nextId++;
  const answer = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
  return { call: { type: 'call', id, method, args }, answer };
}

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const { call: message, answer } = newCall(method, args);
  worker.postMessage(message);
  return answer as Promise<T>;
}

/** This page frame's world, encoded and posted; with `request`, drawn at once and answered. */
function post(seconds: number, elapsed: number, frame: number, request?: BenchDrawRequest,
  at?: number): Promise<unknown> | undefined { // 22.10 ARC-2 S7: `at`, the page moment `seconds` stands for
  lastFraction = Math.max(0, Math.min(1, seconds / config.durationSeconds));
  lastFrame = frame;
  if (crowd.place(seconds, lastFraction, heightAt) && recording) routeHeightMissing++;
  unitModels.refresh(crowd.state);
  benchCamera(config, scene, lastFraction, camera);
  const args = { map, cameraYaw: camera.yaw, cameraPitch: camera.pitch, cameraDistance: camera.orbit,
    cameraAnchorDistance: 24, cameraPivotHeight: 1.6, wmoFloor: undefined,
    frameTime: benchFrameTime(config, scene, preparingWorldCrowd, seconds, elapsed, frame) };
  const inputs = pushInputs;
  pushInputs = undefined;
  if (request === undefined) {
    sender.post(worker, crowd.state, args, unitModels.lookups, inputs, undefined, undefined, at);
    return undefined;
  }
  const { call: drawCall, answer } = newCall('draw', [request]);
  sender.post(worker, crowd.state, args, unitModels.lookups, inputs, drawCall);
  return answer;
}

async function drawNow(seconds: number, elapsed: number, frame: number, request: BenchDrawRequest = {}):
  Promise<{ readiness?: BenchReadiness; png?: string }> {
  const answer = await post(seconds, elapsed, frame, request) as { readiness?: BenchReadiness; png?: string };
  return { ...answer, ...(answer.readiness ? { readiness: withPageTerrain(answer.readiness) } : {}) };
}

/** The worker's readiness with the page's own terrain heights (movement routes) counted in. */
function withPageTerrain(status: BenchReadiness): BenchReadiness {
  if (pageTerrain === undefined) return status;
  const t = pageTerrain.stats;
  return { pending: status.pending + t.active, errors: status.errors + t.failed,
    details: { ...(status.details as object), pageTerrain: t } };
}

async function readiness(): Promise<BenchReadiness> {
  return withPageTerrain(await call<BenchReadiness>('readiness'));
}

async function hardware(): Promise<Record<string, unknown>> {
  return { ...await call<Record<string, unknown>>('hardware'), gpuTimerReason: gpuReason ?? null,
    pageCrossOriginIsolated: globalThis.crossOriginIsolated === true, workerCrossOriginIsolated };
}

async function settle(fraction: number): Promise<BenchReadiness> {
  const deadline = performance.now() + config.timeoutSeconds * 1000;
  let stable = 0, frame = 0;
  while (performance.now() < deadline) {
    await nextFrame();
    frame++;
    const { readiness: status } = await drawNow(fraction * config.durationSeconds, 0, frame - 1, { readiness: frame % 10 === 0 });
    if (status === undefined) continue;
    stable = status.pending === 0 ? stable + 1 : 0;
    if (stable >= 6) {
      // 06.10-P1-00b: model-texture errors that are all 404s of the corpus settle like a known-missing tile.
      const details = status.details as { renderer?: { modelTexturesErrors?: number }; knownMissingTextures?: string[];
        textureOtherFailures?: number } | null;
      const ledger = { missing: new Set(details?.knownMissingTextures ?? []), otherFailures: details?.textureOtherFailures ?? 0 };
      if (status.errors && !errorsAreKnownMissingTextures({ errors: status.errors,
        modelTexturesErrors: details?.renderer?.modelTexturesErrors ?? 0 }, ledger)) {
        throw new Error(`Asset errors: ${JSON.stringify(status)}`);
      }
      return status;
    }
  }
  throw new Error(`Scene did not settle: ${JSON.stringify(await readiness())}`);
}

const bench = {
  setWorldSubmissionCapture(): never { throw new Error('Capture A/B reads the renderer on the page; not in worker mode'); },
  sceneStats(): never { throw new Error('sceneStats reads the renderer on the page; not in worker mode'); },
  async prepare() {
    await call('reset');
    // Retained NPCs must have been admitted around the whole square before timing.
    if (worldCrowd || city) for (let i = 0; i < 8; i++) await settle(i / 8);
    await settle(0);
    // Admission happens at zero throughout preparation. Timed/views start after spawn fade,
    // without rewinding admission ages from the later preparation viewpoints into the future.
    preparingWorldCrowd = false;
    const start = await nextFrame();
    let previous = start, frame = 0;
    while (previous - start < config.warmupSeconds * 1000) {
      const now = await nextFrame();
      await drawNow(0, (now - previous) / 1000, frame++); previous = now;
    }
    await settle(0);
    return { scenario: scenarioName, count, hardware: await hardware(), readiness: await readiness() };
  },
  async run() {
    await call('reset');
    routeHeightMissing = 0;
    gpuSamplesMs.length = 0;
    const columns = ['rafAtMs', 'intervalMs', 'cpuMs', ...phaseNames, 'calls', 'triangles', 'programs', 'geometries', 'textures', 'heapBytes',
      ...(budgetProbe ? ['budgetMs', 'budgetsFired'] : []), ...WORKER_TAIL_COLUMNS];
    const capacity = Math.ceil(config.durationSeconds * 2000);
    const samples = new Float64Array(capacity * columns.length);
    const bridgeAt = columns.length - WORKER_TAIL_COLUMNS.length;
    let sampleCount = 0;
    let frame = 0;
    // The seed frame is drawn before timing, as in the page.
    await drawNow(0, 0, frame++);
    // P2-09a: the worker's sensor follows the pushed flag; its times are merged into this one per results record.
    if (budgetProbe) {
      frameBudgetProbe.setEnabled(true);
      frameBudgetProbe.frameStart();
      pushInputs = { ...NO_RENDER_INPUTS, frameBudgetProbe: true };
    }
    let startMain = Number.NaN;
    let previousPost = Number.NaN;
    let pagePosts = 0;
    /** One world update at this page moment (once the worker has started its clock). */
    const postNow = (now: number) => {
      if (!Number.isFinite(startMain)) return;
      const seconds = Math.max(0, now - startMain) / 1000;
      if (arrival) crowd.arrive(seconds);
      post(seconds, Math.max(0, now - (Number.isFinite(previousPost) ? previousPost : startMain)) / 1000, frame++,
        undefined, now);
      pagePosts++;
      previousPost = now;
    };
    onRow = (row) => {
      if (pagePace === 'worker') postNow(performance.now());
      if (sampleCount >= capacity) throw new Error('Frame capacity exceeded');
      const at = sampleCount++ * columns.length;
      const base = row.length - WORKER_TAIL_COLUMNS.length;
      samples.set(row.subarray(0, base), at);
      if (budgetProbe) {
        frameBudgetProbe.frameStart();
        samples[at + base] = frameBudgetProbe.lastBudgetMs;
        samples[at + base + 1] = frameBudgetProbe.lastFired;
      }
      samples.set(row.subarray(base), at + bridgeAt);
    };
    recording = true;
    let pageFrames = 0;
    const pageIntervals: number[] = [];
    let workerRun: Record<string, unknown>;
    try {
      ({ startMain } = await call<{ startMain: number }>('runStart', config.durationSeconds));
      performance.mark('bench-start', { startTime: startMain });
      let finished = false;
      const end = call<Record<string, unknown>>('runEnd').finally(() => { finished = true; });
      // The page keeps its world moving until the worker has measured its seconds; its own frame intervals are kept
      // (the main thread's health, `--load`).
      let previous = startMain;
      for (;;) {
        const now = await Promise.race([nextFrame(), end.then(() => Number.NaN)]);
        if (finished) break;
        if (pagePace === 'raf') postNow(now);
        pageFrames++;
        pageIntervals.push(now - previous);
        previous = now;
      }
      workerRun = await end;
    } finally {
      recording = false;
      onRow = undefined;
      performance.mark('bench-end');
    }
    const budgetReport = budgetProbe ? frameBudgetProbe.report() : undefined; // P2-09a
    if (budgetProbe) {
      frameBudgetProbe.setEnabled(false);
      pushInputs = { ...NO_RENDER_INPUTS, frameBudgetProbe: false };
    }
    const frames = Array.from({ length: sampleCount }, (_, index) =>
      Array.from(samples.subarray(index * columns.length, (index + 1) * columns.length)));
    const { readiness: workerReadiness, hardware: workerHardware, ...rest } = workerRun as
      { readiness: BenchReadiness; hardware: Record<string, unknown> } & Record<string, unknown>;
    return { scenario: scenarioName, count, columns, phaseNames, frames, gpuSamplesMs: [...gpuSamplesMs],
      renderBridge: 'worker', ...(budgetReport ? { budgetProbe: budgetReport } : {}),
      hardware: { ...workerHardware, gpuTimerReason: gpuReason ?? null,
        pageCrossOriginIsolated: globalThis.crossOriginIsolated === true, workerCrossOriginIsolated },
      readiness: withPageTerrain(workerReadiness), routeHeightMissing,
      repeatedRafCallbacks: rest['repeatedRafCallbacks'], telemetry: rest['telemetry'] ?? null,
      wmoRangeAtStart: rest['wmoRangeAtStart'] ?? null, poseWorker: rest['poseWorker'] ?? null,
      shadowCascadesAtStart: rest['shadowCascadesAtStart'] ?? null, shadowCascades: rest['shadowCascades'] ?? null,
      renderWorker: { workerFrames: rest['frames'], pagePace, pagePosts, pageFrames, pageIntervalsMs: pageIntervals,
        inputSmoothing: summarizeInputStates(frames, columns) } }; // 22.10 ARC-2 S7
  },
  async view(fraction: number) {
    if (arrival) crowd.arrive(Number.POSITIVE_INFINITY);
    await settle(fraction);
    // The replay reset forgets the weather packet, as a fresh world would; a lookdev still wants it.
    await call('reset', { weather: true });
    const frames = Math.max(1, Math.floor(config.viewFrames ?? 60));
    let png: string | undefined;
    for (let frame = 0; frame <= frames; frame++) {
      await nextFrame();
      // The worker reads the pixels in the task that drew the last frame (PixelPng.ts).
      ({ png } = await drawNow(fraction * config.durationSeconds, frame === 0 ? 0 : 1 / 60, frame, { png: frame === frames }));
    }
    return { png, readiness: await readiness() };
  },
  async lookdev(overrides: Partial<BenchConfig>) {
    // Time of day, camera and weather for the next `view()`; nothing here is measured.
    Object.assign(config, overrides);
    await call('lookdev', overrides);
  },
  shadowStats: () => call('shadowStats'),
  state: async () => ({ scenario: scenarioName, fraction: lastFraction, frame: lastFrame, readiness: await readiness() }),
};
(window as Window & { __bench?: typeof bench }).__bench = bench;
