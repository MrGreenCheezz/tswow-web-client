/**
 * 22.10 ARC-2 S6a: the render worker of `bench/run.mjs --renderbridge worker` — the bench's renderer half in a
 * DedicatedWorker drawing into the page's canvas (an OffscreenCanvas). The page (WorkerBenchPage.ts) keeps the world
 * and posts each frame (RenderWorkerProtocol.ts); here the frames are applied to a mirror and drawn:
 *
 * * a frame with a `draw` call (preparation, settling, views) is drawn as soon as it arrives and answered, with the
 *   readiness or the screenshot it asked for — the in-page harness's lockstep, one draw per page frame;
 * * during `runStart`…`runEnd` the worker draws on its own animation frames with the latest world it received, on its
 *   own clock, and records the measured row of each (the in-page harness's columns, plus the bridge's five).
 *
 * After every draw the RenderResults record (with the GPU, budget and patch-chain reports) goes to the page, which
 * applies the reports and keeps the rows. Nothing here reads the page: everything it knows was pushed in `init`.
 */

import type * as THREE from "three";
import { WorldRenderer3D, type RenderFrameTime } from "../WorldRenderer3D.js";
import { ENVIRONMENT_STREAM_RANGE } from "../Terrain.js";
import { frameBudgetProbe } from "../FrameBudgetProbe.js";
import { applyGatewayGenerationPush } from "../GatewayGeneration.js";
import { setPatchChainSuspectSink } from "../PatchChainSuspect.js";
import { patchChainSuspectQueue } from "../RendererReports.js";
import { setRenderClockOffset, toMainTime } from "../RenderClock.js";
import { WorkerRenderHost } from "../WorkerRenderHost.js";
import { emptyFrameApplied, RenderFrameReceiver, type RenderFrameApplied } from "../RenderWorkerBridge.js";
import {
  clearPostedReports, type PageToRenderWorker, type RenderWorkerCall, type RenderWorkerFrame, type RenderWorkerInit,
  type RenderWorkerToPage,
} from "../RenderWorkerProtocol.js";
import { pngDataUrl, readDrawingBuffer } from "../PixelPng.js";
import { nextBenchmarkFrame } from "./FrameClock.js";
import { installKnownMissingTextureLedger } from "./KnownMissingTextures.js";
import { benchPhaseNames, benchScenario, type BenchConfig, type BenchScenario } from "./BenchScene.js";
import { benchReadiness, configureBenchRenderer, createBenchClients, type BenchClients } from "./BenchRenderSide.js";

/** The bench's part of `init` (RenderWorkerInit `driver`). */
export interface BenchWorkerDriver {
  readonly config: BenchConfig;
  readonly scenario: string;
}

/** A lockstep frame's wishes (the `draw` call's one argument). */
export interface BenchDrawRequest {
  readonly readiness?: boolean;
  readonly png?: boolean;
}

interface WorkerScope {
  postMessage(message: RenderWorkerToPage, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "unhandledrejection", listener: (event: PromiseRejectionEvent) => void): void;
  requestAnimationFrame(callback: (time: number) => void): number;
  crossOriginIsolated?: boolean;
  __THREE_DEVTOOLS__?: unknown;
}

const scope = globalThis as unknown as WorkerScope;
const post = (message: RenderWorkerToPage, transfer: Transferable[] = []) => scope.postMessage(message, transfer);
const errorText = (error: unknown) => String((error as Error)?.stack ?? error);

let session: Promise<BenchRenderSession> | undefined;
scope.addEventListener("message", (event) => {
  const data = event.data as PageToRenderWorker;
  if (data.type === "init") {
    session = startSession(data as RenderWorkerInit<BenchWorkerDriver>);
    session.then((started) => post({ type: "ready", crossOriginIsolated: started.crossOriginIsolated }),
      (error: unknown) => post({ type: "error", message: errorText(error) }));
    return;
  }
  if (session === undefined) {
    post({ type: "error", message: `render worker: ${data.type} before init` });
    return;
  }
  // Callbacks on one promise run in registration order, so the messages are handled in the order they came.
  void session.then((started) => started.handle(data));
});
// Uncaught errors reach the page, which raises them as page errors (WorkerBenchPage.ts).
scope.addEventListener("error", (event) => post({ type: "error", message: String(event.message) }));
scope.addEventListener("unhandledrejection", (event) => post({ type: "error", message: errorText(event.reason) }));

async function startSession(init: RenderWorkerInit<BenchWorkerDriver>): Promise<BenchRenderSession> {
  const { config } = init.driver;
  // The bench's renderer registry, as the bench page's inline script fills it through three's devtools hook.
  const renderers: THREE.WebGLRenderer[] = [];
  scope.__THREE_DEVTOOLS__ = {
    dispatchEvent(event: { detail?: THREE.WebGLRenderer & { isWebGLRenderer?: boolean } }) {
      if (event.detail?.isWebGLRenderer) renderers.push(event.detail);
    },
  };
  // The in-page harness's seeded Math.random: this realm's renderer draws the random numbers.
  let randomState = config.seed;
  Math.random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  // Render time minus main time for one instant (RenderClock.ts).
  setRenderClockOffset(init.mainTimeOrigin - performance.timeOrigin);
  applyGatewayGenerationPush(init.gatewayGeneration);
  const missingTextures = installKnownMissingTextureLedger(globalThis, init.baseUrl); // 06.10-P1-00b
  const host = new WorkerRenderHost(init.host, frameBudgetProbe);
  const world = new WorldRenderer3D(init.canvas, host);
  setPatchChainSuspectSink(patchChainSuspectQueue(world.results));
  const renderer = renderers.at(-1);
  if (!renderer?.info) throw new Error("Three.js renderer observation failed in the render worker");
  return new BenchRenderSession(init, host, world, renderer, missingTextures);
}

class BenchRenderSession {
  readonly crossOriginIsolated = scope.crossOriginIsolated === true;
  readonly #config: BenchConfig;
  readonly #scene: BenchScenario;
  readonly #phaseNames: string[];
  readonly #clients: BenchClients;
  readonly #receiver = new RenderFrameReceiver();
  readonly #queue: RenderWorkerFrame[] = [];
  #queryMs = 0;
  #run: Promise<unknown> | undefined;

  constructor(readonly init: RenderWorkerInit<BenchWorkerDriver>, readonly host: WorkerRenderHost,
    readonly world: WorldRenderer3D, readonly renderer: THREE.WebGLRenderer,
    readonly missingTextures: ReturnType<typeof installKnownMissingTextureLedger>) {
    this.#config = init.driver.config;
    this.#scene = benchScenario(this.#config, init.driver.scenario);
    if (!this.#scene.movement) throw new Error("The render worker draws the world scenarios only");
    this.#phaseNames = benchPhaseNames(this.#scene);
    this.#clients = createBenchClients(init.baseUrl);
    configureBenchRenderer(world, this.#config, this.#scene.graphics, this.#clients.cover);
  }

  handle(message: PageToRenderWorker): void {
    if (message.type === "frame") {
      this.#queue.push(message);
      if (message.call !== undefined) this.#answer(message.call, () => this.#drawNow(message.call!));
    } else if (message.type === "host") {
      this.host.update(message.host);
    } else if (message.type === "call") {
      this.#answer(message, () => this.#call(message));
    }
  }

  #answer(call: RenderWorkerCall, run: () => unknown): void {
    void (async () => {
      try {
        post({ type: "reply", id: call.id, result: await run() });
      } catch (error) {
        post({ type: "reply", id: call.id, error: errorText(error) });
      }
    })();
  }

  #call(call: RenderWorkerCall): unknown {
    const world = this.world;
    switch (call.method) {
      case "reset": {
        world.resetReplayEpoch(this.#config.seed);
        // The replay reset forgets the weather packet, as a fresh world would; a lookdev still wants it.
        if ((call.args[0] as { weather?: boolean } | undefined)?.weather && this.#config.weather) {
          world.setWeather(this.#config.weather);
        }
        return null;
      }
      case "readiness": return this.#readiness();
      case "hardware": return this.#hardware();
      case "lookdev": {
        const overrides = call.args[0] as Partial<BenchConfig>;
        Object.assign(this.#config, overrides);
        if ("weather" in overrides) world.setWeather(overrides.weather ?? { state: 0, intensity: 0, abrupt: true });
        return null;
      }
      case "shadowStats": return { cascades: world.shadowCascadeStats, calls: this.renderer.info.render.calls };
      case "runStart": return this.#runStart(call.args[0] as number);
      case "runEnd": {
        if (this.#run === undefined) throw new Error("runEnd without runStart");
        const run = this.#run;
        this.#run = undefined;
        return run;
      }
      default: throw new Error(`render worker: unknown call ${call.method}`);
    }
  }

  /** Applies every queued frame message in order. */
  #applyQueued(applied: RenderFrameApplied): void {
    const queue = this.#queue;
    for (const message of queue) {
      this.#receiver.apply(message, applied);
      if (message.inputs !== undefined) this.world.setRenderInputs(this.#receiver.inputs);
    }
    queue.length = 0;
  }

  /** One draw of the latest world: the scenery and light around the player, then the renderer's frame. */
  #draw(frameTime: RenderFrameTime | undefined): void {
    const receiver = this.#receiver;
    const args = receiver.args;
    if (args === undefined || args.map === undefined) throw new Error("render worker: no frame to draw");
    const world = this.world;
    const mirror = receiver.world;
    const map = args.map;
    const self = mirror.selfGuid === undefined ? undefined : mirror.objects.get(mirror.selfGuid)?.position;
    if (self === undefined) throw new Error("render worker: the frame has no player position");
    const { terrain, environment, splat, lighting, liquids, horizon } = this.#clients;
    const halfMinute = this.#config.halfMinute;
    const queryAt = performance.now();
    environment.beginResourceFrame();
    try {
      // The player stands on the route point the in-page harness queries (BenchCrowd `place`).
      const scenery = environment.objectsAround(map, self.x, self.y, ENVIRONMENT_STREAM_RANGE);
      world.updateLighting(lighting.sample(map, self.x, self.y, halfMinute, 0, self.z), halfMinute);
      this.#queryMs = performance.now() - queryAt;
      world.setRenderLookups(receiver.lookups);
      world.beginRenderFrame();
      try {
        world.draw(mirror, map, (x, y) => terrain.heightAt(map, x, y), terrain, scenery, environment,
          args.cameraYaw, args.cameraPitch, args.cameraDistance, splat, liquids, undefined, horizon,
          args.cameraAnchorDistance, args.cameraPivotHeight, args.wmoFloor, frameTime ?? args.frameTime);
      } finally { world.endRenderFrame(); }
    } finally { environment.endResourceFrame(); }
  }

  /** The record after a draw, to the page; its report queues are the page's from here on. */
  #postResults(row: Float64Array | undefined): void {
    const results = this.world.results;
    post({ type: "results", results, row }, row === undefined ? [] : [row.buffer]);
    clearPostedReports(results);
  }

  /** A lockstep frame: everything queued (this frame last), drawn now with the page's clock. */
  async #drawNow(call: RenderWorkerCall): Promise<unknown> {
    this.#applyQueued(emptyFrameApplied());
    this.#draw(undefined);
    // The drawing buffer is cleared once this task ends: read it in the task that drew it.
    const pixels = (call.args[0] as BenchDrawRequest | undefined)?.png
      ? readDrawingBuffer(this.renderer.getContext()) : undefined;
    this.#postResults(undefined);
    const request = (call.args[0] ?? {}) as BenchDrawRequest;
    return { readiness: request.readiness ? this.#readiness() : undefined,
      png: pixels === undefined ? undefined : await pngDataUrl(pixels) };
  }

  #readiness() {
    return benchReadiness(this.world, this.#clients, this.missingTextures);
  }

  #hardware() {
    const renderer = this.renderer;
    const gl = renderer.getContext(), ext = gl.getExtension("WEBGL_debug_renderer_info");
    const canvas = this.init.canvas;
    return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
      gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string : gl.getParameter(gl.RENDERER) as string,
      webgl: gl.getParameter(gl.VERSION) as string, antialias: gl.getContextAttributes()?.antialias,
      canvas: [canvas.width, canvas.height], pixelRatio: renderer.getPixelRatio(),
      crossOriginIsolated: this.crossOriginIsolated, renderWorker: true };
  }

  /**
   * The measured run's start: the seed frame was drawn (lockstep) before this call. The worker takes its next
   * animation frame as the start, answers with it on the page's clock, and records until `durationSeconds` passed.
   */
  async #runStart(durationSeconds: number): Promise<{ startMain: number }> {
    const world = this.world;
    world.poseWorkerStats(true);
    // P1-12: the rest-radius counters are cumulative; the measured frames are the difference.
    const wmoRangeAtStart = world.telemetry.wmoRange ?? null;
    const nextFrame = () => new Promise<number>((resolve) => scope.requestAnimationFrame(resolve));
    const start = await nextFrame();
    // P2-02b: the cascades' counters are cumulative too.
    const shadowCascadesAtStart = world.shadowCascadeStats ?? null;
    this.#run = this.#record(start, durationSeconds, nextFrame).then((tail) => ({
      ...tail, wmoRangeAtStart, shadowCascadesAtStart,
    }));
    // Surfaces on `runEnd`; never unhandled meanwhile.
    this.#run.catch(() => {});
    return { startMain: toMainTime(start) };
  }

  async #record(start: number, durationSeconds: number, nextFrame: () => Promise<number>) {
    const world = this.world;
    const renderer = this.renderer;
    const config = this.#config;
    const crowdClock = this.#scene.worldCrowd || this.#scene.city;
    const phaseNames = this.#phaseNames;
    let previous = start, frame = 1, repeatedRafCallbacks = 0, frames = 0;
    while (previous - start < durationSeconds * 1000) {
      const next = await nextBenchmarkFrame(previous, nextFrame);
      const now = next.timestamp;
      repeatedRafCallbacks += next.repeatedCallbacks;
      const seconds = (now - start) / 1000;
      const at = performance.now();
      const applied = emptyFrameApplied();
      this.#applyQueued(applied);
      // The worker's own clock: a page that stalls leaves the world where it was, never the animation.
      this.#draw({ nowMs: (crowdClock ? config.warmupSeconds + seconds : seconds) * 1000,
        elapsedSeconds: (now - previous) / 1000, frameIndex: frame++ });
      const cpuMs = performance.now() - at;
      const phase: Readonly<Record<string, number>> = { query: this.#queryMs, ...world.drawPhaseMs }, info = renderer.info;
      const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
      const row = Float64Array.of(now - start, now - previous, cpuMs, ...phaseNames.map((name) => phase[name] ?? 0),
        info.render.calls, info.render.triangles, info.programs?.length ?? 0,
        info.memory.geometries, info.memory.textures, heap,
        applied.encodeMs, applied.postMs, applied.decodeMs, applied.bytes, applied.frameBytes, applied.messages);
      this.#postResults(row);
      frames++;
      previous = now;
    }
    return { frames, repeatedRafCallbacks, readiness: this.#readiness(), hardware: this.#hardware(),
      telemetry: world.telemetry ?? null, poseWorker: world.poseWorkerStats() ?? null,
      shadowCascades: world.shadowCascadeStats ?? null };
  }
}
