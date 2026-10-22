/**
 * 22.10 ARC-2 S6b: the client's world renderer in its DedicatedWorker (RenderWorker.worker.ts starts it). The page's
 * messages are applied as they arrive, in their order: the commands (RenderWorkerCommands.ts), then the frame's world
 * into the mirror (RenderWorkerBridge.ts `RenderFrameReceiver`) with its pushed records and portrait targets. On each
 * of its own animation frames, while the page draws a world, it draws the latest one as game/Loop.ts does in the page —
 * the cadence, `beginRenderFrame`, the environment asked around the view subject, `draw` with this worker's own
 * clients, the portraits, `endRenderFrame` — and posts the results with the frame's report.
 */

import { WorldRenderer3D } from "./WorldRenderer3D.js";
import { ENVIRONMENT_STREAM_RANGE, type EnvironmentObject } from "./Terrain.js";
import { toMainTime } from "./RenderClock.js";
import { liftCarrierPose } from "./LiftClock.js";
import { setPushedPageHidden } from "./PageVisibility.js";
import type { WorkerRenderHost } from "./WorkerRenderHost.js";
import { RenderFrameReceiver, emptyFrameApplied } from "./RenderWorkerBridge.js";
import { clearPostedReports, type RenderWorkerHostUpdate } from "./RenderWorkerProtocol.js";
import { RenderWorkerResourceClients } from "./RenderWorkerClients.js";
import { applyRenderCommand } from "./RenderWorkerCommands.js";
import type {
  ClientRenderFrame, ClientRenderResults, RenderCommand, RenderWorkerCommandsMessage, RenderWorkerFrameReport,
  RenderWorkerSlowReport,
} from "./RenderWorkerClientProtocol.js";
import type { ShaderProgramEvent } from "./ShaderProgramTrace.js";
import type { RenderWorkerDrawReadiness } from "./RenderWorkerLoading.js"; // 22.10 (12.14)
import { RenderWorkerModelWarmup } from "./RenderWorkerModelWarmup.js"; // 22.10 (12.14)
import type { ModelLoadPriority } from "./Terrain.js";

/** How often the slower reads go to the page (telemetry, warm-up, shadows, pose worker, graphics). */
const SLOW_REPORT_MS = 500;
const NO_ENVIRONMENT: readonly EnvironmentObject[] = Object.freeze([]);

export interface RenderWorkerSessionScope {
  postMessage(message: ClientRenderResults, transfer?: Transferable[]): void;
  requestAnimationFrame(callback: (time: number) => void): number;
}

export type RenderWorkerMessage = ClientRenderFrame | RenderWorkerCommandsMessage | RenderWorkerHostUpdate;

export class RenderWorkerSession {
  readonly #scope: RenderWorkerSessionScope;
  readonly #host: WorkerRenderHost;
  readonly #renderer: WorldRenderer3D;
  readonly #receiver = new RenderFrameReceiver();
  #clients: RenderWorkerResourceClients | undefined;
  /** The page's last ground-cover call, with whether it had a client: applied with this worker's own. */
  #groundCover: readonly unknown[] | undefined;
  #environmentAt: readonly [number, number] | undefined;
  /** A frame came since the last `#idle`. */
  #drawing = false;
  #standInsUntil = Number.NEGATIVE_INFINITY;
  #slowAt = Number.NEGATIVE_INFINITY;
  #shaderCapture = false;
  /** 22.10 ARC-2 live fix: the page's last render scale, re-applied when the pushed DPR moves. */
  #renderScale: number | undefined;
  #identity: Pick<RenderWorkerSlowReport, "webgl" | "identity"> | undefined;
  /** 22.10 (12.14): the page's warm-up asks. */
  readonly #warmup = new RenderWorkerModelWarmup();

  constructor(scope: RenderWorkerSessionScope, host: WorkerRenderHost, renderer: WorldRenderer3D) {
    this.#scope = scope;
    this.#host = host;
    this.#renderer = renderer;
    scope.requestAnimationFrame(this.#tick);
  }

  handle(message: RenderWorkerMessage): void {
    if (message.type === "host") {
      // 22.10 ARC-2 live fix: the page's settings apply re-derives the in-page ratio from the current DPR on every
      // `setRenderScale`; here that repeat is suppressed (RenderWorkerClient.ts `sameArgs`), so a DPR the page
      // pushes is applied as that repeat would have applied it.
      const dpr = this.#host.devicePixelRatio();
      this.#host.update(message.host);
      setPushedPageHidden(message.host.pageHidden);
      if (this.#renderScale !== undefined && message.host.devicePixelRatio !== dpr) {
        this.#renderer.setRenderScale(this.#renderScale);
      }
      return;
    }
    for (const command of message.commands) this.#command(command);
    if (message.type !== "frame") return;
    this.#receiver.apply(message, emptyFrameApplied());
    if (message.inputs !== undefined) this.#renderer.setRenderInputs(this.#receiver.inputs);
    if (message.lookups !== undefined) this.#renderer.setRenderLookups(this.#receiver.lookups);
    if (message.portraitTargets !== undefined) this.#renderer.setPortraitTargets(message.portraitTargets);
    this.#useClients(message.clients);
    this.#environmentAt = message.environmentAt;
    this.#drawing = true;
  }

  #command(command: RenderCommand): void {
    const renderer = this.#renderer;
    switch (command.method) {
      case "#idle": this.#drawing = false; return;
      case "#clearInputs": renderer.setRenderInputs(undefined); return;
      case "#clearLookups": renderer.setRenderLookups(undefined); return;
      case "#poseReset": renderer.poseWorkerStats(true); return;
      case "#standIns": this.#standInsUntil = performance.now() + Number(command.args[0] ?? 0); return;
      case "setGroundCover": this.#groundCover = command.args; break;
      case "setShaderProgramCapture": this.#shaderCapture = command.args[0] === true; break;
      case "setRenderScale": this.#renderScale = command.args[0] as number; break; // 22.10 ARC-2 live fix
      case "#warmModels": this.#warmup.add(command.args[0] as string, command.args[1] as ModelLoadPriority); return;
      default: break;
    }
    applyRenderCommand(renderer, command, (present) => present ? this.#clients?.cover : undefined);
    if (command.method === "clearTerrain") {
      // The loop clears the splat's pins beside the terrain when the player has no position.
      this.#clients?.splat.setActiveTiles(undefined, []);
    } else if (command.method === "clearWorldResources") {
      // The page drops its clients with the realm (Context.ts `clearWorldContext`); so do these.
      this.#clients?.dispose();
      this.#clients = undefined;
      this.#receiver.smoothing.carrierPose = undefined; // 22.10 ARC-2 S7
    }
  }

  /** Another set of page clients: another set here, and the ground cover moves onto it. */
  #useClients(key: ClientRenderFrame["clients"]): void {
    if (key === undefined || key.key === this.#clients?.key) return;
    this.#clients?.dispose();
    this.#clients = new RenderWorkerResourceClients(key.key, key.url);
    // 22.10 (12.14): the warm-up's asks go to them from now on.
    this.#warmup.clientsChanged();
    // 22.10 ARC-2 S7: passengers of lifts ride the car this worker draws (the page's `startLiftCarriers`).
    this.#receiver.smoothing.carrierPose = liftCarrierPose(this.#clients.transportPaths);
    const cover = this.#groundCover;
    if (cover !== undefined) {
      applyRenderCommand(this.#renderer, { method: "setGroundCover", args: cover },
        (present) => present ? this.#clients?.cover : undefined);
    }
  }

  readonly #tick = (time: number): void => {
    this.#scope.requestAnimationFrame(this.#tick);
    const renderer = this.#renderer;
    const mainTime = toMainTime(time);
    renderer.observeFrame(mainTime);
    renderer.markFrameNotRendered();
    // 22.10 ARC-2 S7: the latest input, advanced and extrapolated when the page is late (RenderInputSmoothing.ts).
    const args = this.#drawing ? this.#receiver.advance(time) : this.#receiver.args;
    if (!this.#drawing || args === undefined || args.map === undefined) {
      // Outside a world the page draws nothing; queued portrait clears and reports still reach it.
      const results = renderer.results;
      if (results.portraits.length > 0 || results.gpuEvents.length > 0 || results.patchChainSuspects.length > 0) {
        this.#post(undefined);
      }
      return;
    }
    const startedAt = performance.now();
    const map = args.map;
    const clients = this.#clients;
    const environment = clients?.environment;
    let collisionWants: readonly string[] = [];
    let unitWants: readonly bigint[] = [];
    let frameError: string | undefined;
    environment?.beginResourceFrame();
    try {
      // 22.10 (12.14): the page's warm-up asks, inside the frame as the page made them inside its own.
      this.#warmup.apply(environment);
      const at = this.#environmentAt;
      const objects = environment !== undefined && at !== undefined
        ? environment.objectsAround(map, at[0], at[1], ENVIRONMENT_STREAM_RANGE) : NO_ENVIRONMENT;
      const terrain = clients?.terrain;
      renderer.beginRenderFrame();
      try {
        try {
          renderer.draw(this.#receiver.world, map, terrain === undefined ? undefined : (x, y) => terrain.heightAt(map, x, y),
            terrain, objects, environment, args.cameraYaw, args.cameraPitch, args.cameraDistance, clients?.splat,
            clients?.liquids, clients?.transportPaths, clients?.horizon, args.cameraAnchorDistance, args.cameraPivotHeight,
            args.wmoFloor, args.frameTime);
        } finally {
          // Copied: the renderer refills both on its next draw.
          collisionWants = [...renderer.collisionModelWants()];
          unitWants = [...renderer.unitModelWants()];
        }
        renderer.renderPortraits(mainTime);
      } finally {
        renderer.endRenderFrame();
      }
    } catch (error) {
      frameError = error instanceof Error ? error.message : String(error);
    } finally {
      environment?.endResourceFrame();
    }
    const shaderPrograms = this.#shaderCapture ? this.#shaderPrograms() : undefined;
    const readiness = this.#readiness(map);
    const report: RenderWorkerFrameReport = {
      collisionWants, unitWants, drawPhaseMs: { ...renderer.drawPhaseMs }, drawSubmitStats: { ...renderer.drawSubmitStats },
      cpuMs: performance.now() - startedAt, at: mainTime,
      ...(frameError === undefined ? {} : { frameError }),
      ...(shaderPrograms === undefined ? {} : { shaderPrograms }),
      ...(readiness === undefined ? {} : { readiness }),
    };
    this.#post(report);
  };

  /**
   * 22.10 (12.14): whether this worker's terrain has answered where the page stands (its `environmentAt`): the page's
   * loading curtain waits for it as it waits for its own (ui/LoadingScreen.ts). Asking starts the tile's load.
   */
  #readiness(map: number): RenderWorkerDrawReadiness | undefined {
    const at = this.#environmentAt;
    const clients = this.#clients;
    if (at === undefined || clients === undefined) return undefined;
    return { map, x: at[0], y: at[1], terrain: clients.terrain.isReady(map, at[0], at[1]), clients: clients.key };
  }

  /** The capture's events since the last frame, on the page's clock. */
  #shaderPrograms(): ShaderProgramEvent[] | undefined {
    const events = this.#renderer.drainShaderProgramCapture();
    if (events === undefined || events.length === 0) return undefined;
    return events.map((event) => ({ ...event, at: toMainTime(event.at) }));
  }

  #post(report: RenderWorkerFrameReport | undefined): void {
    const results = this.#renderer.results;
    const now = performance.now();
    const slow = now - this.#slowAt >= SLOW_REPORT_MS ? this.#slowReport(now) : undefined;
    if (slow !== undefined) this.#slowAt = now;
    this.#scope.postMessage({ type: "results", results, row: undefined,
      ...(report === undefined ? {} : { report }), ...(slow === undefined ? {} : { slow }) });
    clearPostedReports(results);
  }

  #slowReport(now: number): RenderWorkerSlowReport {
    const renderer = this.#renderer;
    const warmup = renderer.programWarmup;
    // The context's identity does not change between reads; asked once.
    this.#identity ??= { webgl: renderer.benchmarkWebGl(), identity: renderer.webGlIdentity() };
    return {
      telemetry: renderer.telemetry,
      programWarmup: {
        programs: warmup.programs, uniformLocations: warmup.uniformLocations, batches: warmup.batches,
        failures: warmup.failures, queued: warmup.queued, depthPrograms: warmup.depthPrograms,
        retainedPrograms: warmup.retainedPrograms, retainedUnitPrograms: warmup.retainedUnitPrograms,
        parallelCompile: warmup.parallelCompile,
      },
      shadowCascadeStats: renderer.shadowCascadeStats,
      poseWorker: renderer.poseWorkerStats(),
      graphics: renderer.benchmarkGraphicsConfiguration,
      pixelRatio: renderer.pixelRatio,
      ...this.#identity,
      ...(now < this.#standInsUntil ? { standIns: renderer.standInReport() } : {}),
    };
  }
}
