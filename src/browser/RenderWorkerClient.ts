/**
 * 22.10 ARC-2 S6b: the page's stand-in for a world renderer that runs in a DedicatedWorker (`?renderworker=1`,
 * RenderWorkerStart.ts). It is what `game.renderer` holds then, with the in-page renderer's surface (ClientRenderer.ts):
 *
 * * every command is queued in call order and posted with the next frame message, or on its own at the end of the
 *   task that made it (RenderWorkerClientProtocol.ts `commands`); a setting that repeats its arguments is not sent;
 * * `draw` encodes the world (RenderWorkerBridge.ts `RenderFrameSender`) with the pushed records, the portrait
 *   targets, the resource clients' key and where the environment was asked for, and posts it; the loop's own frame
 *   calls around it (begin/end, portraits, cadence) happen in the worker, around its draw;
 * * each results message the worker sends replaces `results` and runs the page's after-draw work, in the order the
 *   loop runs it after an in-page draw (`RenderWorkerResultSteps`) — once per worker frame, whatever the page's;
 * * reads the in-page renderer answers from its state (telemetry, warm-up, shadows…) answer the worker's last report.
 *
 * Nothing here touches the DOM, so the test drives it with a fake port.
 */

import { captureBenchmarkWebGl, type BenchmarkEnvironmentInput } from "./BenchmarkManifest.js";
import { DEFAULT_ATMOSPHERE_PROFILE } from "./AtmosphereEffects.js";
import type { ClientRenderer, ClientRendererCommand, ProgramWarmupCounters } from "./ClientRenderer.js";
import type { GpuTimerUnavailableReason } from "./GpuTimer.js";
import type { PortraitTargetInputs } from "./PortraitTargetData.js";
import { createRenderResults, type RenderResults } from "./RenderResults.js";
import type { RenderInputs } from "./RenderInputs.js";
import type { RenderLookups } from "./RenderLookups.js";
import { RenderFrameSender } from "./RenderWorkerBridge.js";
import {
  RENDER_WORKER_COMMANDS, type ClientFrameExtra, type ClientRenderResults, type RenderCommand,
  type RenderWorkerFrameReport, type RenderWorkerLog, type RenderWorkerOwnCommand, type RenderWorkerSlowReport,
} from "./RenderWorkerClientProtocol.js";
import type { RenderWorkerHostValues, RenderWorkerToPage } from "./RenderWorkerProtocol.js";
import type { ShaderProgramEvent } from "./ShaderProgramTrace.js";
import type { WorldStandInReport } from "./StandIn.js";
import type { WorldRenderer3D } from "./WorldRenderer3D.js";
import type { ModelLoadPriority } from "./Terrain.js";
import { RenderWorkerReadinessTracker, type RenderWorkerStatus } from "./RenderWorkerLoading.js"; // 22.10 (12.14)

/** The worker as the page posts to it (a Worker, or a fake in tests). */
export interface RenderWorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** What one results message brought besides the record. */
export interface RenderWorkerArrival {
  readonly frameInterval: number | undefined;
  readonly rendererFrameMs: number | undefined;
  readonly report: RenderWorkerFrameReport | undefined;
}

/**
 * The page's after-draw work (game/Loop.ts), in the order the loop runs it around an in-page draw: the cadence the
 * frame opened with, the swing cues, the collision and unit-model asks, the seats, the renderer's CPU span, the
 * reports (budget, GPU, patch chain), the portrait canvases.
 */
export interface RenderWorkerResultSteps {
  recordFrameInterval(interval: number): void;
  afterDraw(): void;
  requestCollisionModels(wants: readonly string[]): void;
  requestUnitModels(wants: readonly bigint[]): void;
  acceptSeats(results: RenderResults): void;
  recordRendererFrame(milliseconds: number): void;
  acceptReports(results: RenderResults): void;
  drainPortraits(results: RenderResults): void;
  /** The freeze recording's worker-frame column (game/PerformanceCapture.ts). */
  workerFrame?(report: RenderWorkerFrameReport): void;
  /** 22.10 (12.14): the worker's resource clients' messages, onto the page's status lines (app/ResourceStatusLines.ts). */
  acceptStatuses?(statuses: readonly RenderWorkerStatus[]): void;
}

export interface RenderWorkerClientOptions {
  /** The gateway URL the page's resource clients were built from (EnterWorld.ts), for the worker's own. */
  readonly clientsUrl: () => string | undefined;
  readonly steps: RenderWorkerResultSteps;
  /** Where a batch of commands made outside a frame is posted from; the end of the current task by default. */
  readonly queueTask?: (run: () => void) => void;
}

type Args<M extends keyof WorldRenderer3D> = WorldRenderer3D[M] extends (...args: infer A) => unknown ? A : never;

const NO_COLLISION_WANTS: ReadonlySet<string> = new Set();
const NO_UNIT_WANTS: readonly bigint[] = Object.freeze([]);
const NO_PHASES: Readonly<Record<string, number>> = Object.freeze({});
const NO_SUBMIT = Object.freeze({ programs: 0, textures: 0, geometries: 0 });
/** The stand-in report is computed in the worker only while someone keeps asking (the diagnostics window). */
const STAND_IN_REQUEST_MS = 1_000;

/**
 * Settings whose object arguments are compared by identity: the weather packet (the renderer itself tells a new packet
 * from the same one by identity, and a clone is always new) and the ground cover's client (only its presence crosses).
 * Every other setting repeats only with the same primitive arguments: an object may have been refilled in place.
 */
const IDENTITY_SETTINGS: ReadonlySet<string> = new Set(["setWeather", "setGroundCover"]);

function sameArgs(method: string, a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  const identity = IDENTITY_SETTINGS.has(method);
  for (let index = 0; index < a.length; index++) {
    const value = b[index];
    if (!Object.is(a[index], value)) return false;
    if (!identity && typeof value === "object" && value !== null) return false;
  }
  return true;
}

export class RenderWorkerClient implements ClientRenderer {
  readonly #port: RenderWorkerPort;
  readonly #options: RenderWorkerClientOptions;
  readonly #sender = new RenderFrameSender();
  #commands: RenderCommand[] = [];
  #flushQueued = false;
  /** A setting's last arguments as called (by identity), so a repeat is not sent. */
  readonly #lastSent = new Map<string, readonly unknown[]>();
  /** Settings and states as called, replayed onto an in-page renderer that takes over. */
  readonly #sticky = new Map<string, readonly unknown[]>();
  #inputs: RenderInputs | undefined;
  #lookups: RenderLookups | undefined;
  #portraitTargets: PortraitTargetInputs | undefined;
  #environmentAt: readonly [number, number] | undefined;
  #clientsOf: unknown;
  #clientsKey = 0;
  /** The worker is drawing (a frame went since the last `#idle`), and whether this page frame posted one. */
  #drawing = false;
  #postedSinceMark = false;
  /** 22.10 ARC-2 S7: this page frame's time (`observeFrame`). */
  #frameAt: number | undefined;
  #results: RenderResults = createRenderResults(DEFAULT_ATMOSPHERE_PROFILE);
  #report: RenderWorkerFrameReport | undefined;
  #slow: RenderWorkerSlowReport | undefined;
  #standIns: WorldStandInReport | undefined;
  #standInsAskedAt = Number.NEGATIVE_INFINITY;
  #shaderEvents: ShaderProgramEvent[] | undefined;
  #lastFrameError = "";
  #closed = false;
  /** 22.10 (12.14): worker frames drawn with its terrain ready under the view subject (ui/LoadingScreen.ts). */
  readonly drawReadiness = new RenderWorkerReadinessTracker();
  /** Worker draws that threw, and results messages applied (diagnostics, tests). */
  frameErrors = 0;
  resultsApplied = 0;
  /** Told once: the worker is ready, or it failed (its `error` message) and the page should take over. */
  onReady: (() => void) | undefined;
  onFailure: ((reason: string) => void) | undefined;

  constructor(port: RenderWorkerPort, options: RenderWorkerClientOptions) {
    this.#port = port;
    this.#options = options;
  }

  /** The brand ClientRenderer.ts checks (`inPageRenderer`) and the loop's way to `queryEnvironmentAt`. */
  get renderWorker(): RenderWorkerClient {
    return this;
  }

  // ---- commands -------------------------------------------------------------------------------------------

  setRenderScale(...args: Args<"setRenderScale">): void { this.#send("setRenderScale", args); }
  setLightingQuality(...args: Args<"setLightingQuality">): void { this.#send("setLightingQuality", args); }
  setWmoOcclusion(...args: Args<"setWmoOcclusion">): void { this.#send("setWmoOcclusion", args); }
  setCharacterAtlasAnisotropy(...args: Args<"setCharacterAtlasAnisotropy">): void {
    this.#send("setCharacterAtlasAnisotropy", args);
  }
  setExperimentalShaderProfile(...args: Args<"setExperimentalShaderProfile">): void {
    this.#send("setExperimentalShaderProfile", args);
  }
  setUnderwaterOverlay(...args: Args<"setUnderwaterOverlay">): void { this.#send("setUnderwaterOverlay", args); }
  setTerrainRelief(...args: Args<"setTerrainRelief">): void { this.#send("setTerrainRelief", args); } // 22.10 (7.47)
  setWmoRelief(...args: Args<"setWmoRelief">): void { this.#send("setWmoRelief", args); } // 22.10 (7.47 stage 2)
  setLivingSpells(...args: Args<"setLivingSpells">): void { this.#send("setLivingSpells", args); } // 23.10 (6.27)
  setFullscreenGlow(...args: Args<"setFullscreenGlow">): void { this.#send("setFullscreenGlow", args); }
  setGodRays(...args: Args<"setGodRays">): void { this.#send("setGodRays", args); }
  setGodRayStrength(...args: Args<"setGodRayStrength">): void { this.#send("setGodRayStrength", args); }
  setCinematicProfile(...args: Args<"setCinematicProfile">): void { this.#send("setCinematicProfile", args); }
  setCinematicStrength(...args: Args<"setCinematicStrength">): void { this.#send("setCinematicStrength", args); }
  setAtmosphereEffects(...args: Args<"setAtmosphereEffects">): void { this.#send("setAtmosphereEffects", args); }
  setEnvironmentDetail(...args: Args<"setEnvironmentDetail">): void { this.#send("setEnvironmentDetail", args); }
  /** The page's ground-cover client stays here: the worker draws with its own (RenderWorkerClients.ts), or none. */
  setGroundCover(...args: Args<"setGroundCover">): void {
    const [client, radius, dense, density] = args;
    this.#send("setGroundCover", [client !== undefined, radius, dense, density], args);
  }
  invalidateGroundCover(): void { this.#send("invalidateGroundCover", []); }
  clearPortraits(): void { this.#send("clearPortraits", []); }
  clearTerrain(): void { this.#send("clearTerrain", []); }
  clearWorldResources(): void {
    // What the renderer forgets with the realm (the weather packet and the like) is sent again when it repeats.
    this.#lastSent.clear();
    this.#send("clearWorldResources", []);
  }
  setWeather(...args: Args<"setWeather">): void { this.#send("setWeather", args); }
  setIndoors(...args: Args<"setIndoors">): void {
    this.#send("setIndoors", args);
    // The in-page renderer publishes it at once (`results.indoors`); the next results would, a frame later.
    this.#results.indoors = args[0];
  }
  updateLighting(...args: Args<"updateLighting">): void { this.#send("updateLighting", args); }
  setUnderwaterSurface(...args: Args<"setUnderwaterSurface">): void { this.#send("setUnderwaterSurface", args); }
  setSelection(...args: Args<"setSelection">): void { this.#send("setSelection", args); }
  setGroundTargetPreview(...args: Args<"setGroundTargetPreview">): void { this.#send("setGroundTargetPreview", args); }
  setGameObjectPreview(...args: Args<"setGameObjectPreview">): void { this.#send("setGameObjectPreview", args); }
  setDuelRing(...args: Args<"setDuelRing">): void { this.#send("setDuelRing", args); }
  setUnitAuraAppearance(...args: Args<"setUnitAuraAppearance">): void { this.#send("setUnitAuraAppearance", args); }
  setStateVisuals(...args: Args<"setStateVisuals">): void { this.#send("setStateVisuals", args); }
  playSpellVisual(...args: Args<"playSpellVisual">): void { this.#send("playSpellVisual", args); }
  cancelSpellVisual(...args: Args<"cancelSpellVisual">): void { this.#send("cancelSpellVisual", args); }
  retimeSpellVisual(...args: Args<"retimeSpellVisual">): void { this.#send("retimeSpellVisual", args); }
  clearSpellVisuals(): void { this.#send("clearSpellVisuals", []); }
  prewarmSpellModels(...args: Args<"prewarmSpellModels">): void { this.#send("prewarmSpellModels", args); }
  /** The id comes back at once, as the in-page renderer's would for a swing it queued; a refusal publishes no row. */
  playUnitAction(...args: Args<"playUnitAction">): number | undefined {
    this.#send("playUnitAction", args);
    return args[3];
  }
  releaseUnitAction(...args: Args<"releaseUnitAction">): void { this.#send("releaseUnitAction", args); }
  setMeleeTargets(...args: Args<"setMeleeTargets">): void { this.#send("setMeleeTargets", args); }
  playUnitReaction(...args: Args<"playUnitReaction">): void { this.#send("playUnitReaction", args); }
  playUnitEmote(...args: Args<"playUnitEmote">): void { this.#send("playUnitEmote", args); }
  cancelUnitAction(...args: Args<"cancelUnitAction">): void { this.#send("cancelUnitAction", args); }
  playMountSpecial(...args: Args<"playMountSpecial">): void { this.#send("playMountSpecial", args); }
  playGameObjectAnimation(...args: Args<"playGameObjectAnimation">): void {
    this.#send("playGameObjectAnimation", args);
  }
  showEnvironmentStandInMarkers(...args: Args<"showEnvironmentStandInMarkers">): void {
    this.#send("showEnvironmentStandInMarkers", args);
  }
  setWorldSubmissionCapture(...args: Args<"setWorldSubmissionCapture">): void {
    this.#send("setWorldSubmissionCapture", args);
  }
  setShaderProgramCapture(...args: Args<"setShaderProgramCapture">): void {
    this.#shaderEvents = args[0] ? [] : undefined;
    this.#send("setShaderProgramCapture", args);
  }
  resetFrameCadence(): void { this.#send("resetFrameCadence", []); }
  /** The epoch restarts in the worker; the reason is the one its last report gave. */
  resetGpuTimingEpoch(): GpuTimerUnavailableReason | undefined {
    this.#send("resetGpuTimingEpoch", []);
    const gpu = this.#slow?.telemetry.gpu;
    return gpu?.status === "unavailable" ? gpu.reason : undefined;
  }

  // ---- the frame ----------------------------------------------------------------------------------------------

  /**
   * The cadence is the worker's own (its results carry `fps` and the interval). 22.10 ARC-2 S7: the page frame's time
   * stamps the frame's world (RenderWorkerProtocol.ts `at`), the moment the loop advanced it to.
   */
  observeFrame(now?: number): number | undefined {
    this.#frameAt = now;
    return undefined;
  }
  /** Called at every page frame's start: a page frame before it that drew nothing stops the worker's draws. */
  markFrameNotRendered(): void {
    if (this.#drawing && !this.#postedSinceMark) {
      this.#drawing = false;
      this.#queue({ method: "#idle", args: [] });
    }
    this.#postedSinceMark = false;
  }
  beginRenderFrame(): void {}
  endRenderFrame(): number | undefined { return undefined; }
  renderPortraits(): number { return 0; }

  setRenderInputs(inputs: RenderInputs | undefined): void {
    this.#inputs = inputs;
    if (inputs === undefined) this.#queue({ method: "#clearInputs", args: [] });
  }

  setRenderLookups(lookups: RenderLookups | undefined): void {
    this.#lookups = lookups;
    if (lookups === undefined) this.#queue({ method: "#clearLookups", args: [] });
  }

  /** Posted with the next frame (the record is the bridge's own, refilled per frame). */
  setPortraitTargets(inputs: PortraitTargetInputs): void {
    this.#portraitTargets = inputs;
  }

  /** 22.10 (12.14): a model the page's warm-up wants, for the worker's environment client (app/WarmModelTarget.ts). */
  warmModel(path: string, priority: ModelLoadPriority): void {
    this.#queue({ method: "#warmModels", args: [path, priority] });
  }

  /** Where game/Loop.ts asked `objectsAround` this frame; the worker asks its own environment client there. */
  queryEnvironmentAt(x: number, y: number): void {
    const at = this.#environmentAt;
    if (at === undefined || at[0] !== x || at[1] !== y) this.#environmentAt = [x, y];
  }

  /**
   * The frame's world and value arguments, with everything queued before it. The clients, the height sampler and the
   * environment list stay on the page; the worker draws with its own, built from `clientsUrl` once per set of page
   * clients (a new terrain client is a new world entry).
   */
  draw(...args: Args<"draw">): ReturnType<WorldRenderer3D["draw"]> {
    const [state, map, , terrainClient, , , cameraYaw, cameraPitch, cameraDistance, , , , , cameraAnchorDistance,
      cameraPivotHeight, wmoFloor, frameTime] = args;
    if (this.#closed) return undefined;
    if (terrainClient !== this.#clientsOf) {
      this.#clientsOf = terrainClient;
      this.#clientsKey++;
    }
    const url = terrainClient === undefined ? undefined : this.#options.clientsUrl();
    const commands = this.#commands;
    this.#commands = [];
    const extra: ClientFrameExtra = {
      commands, clients: url === undefined ? undefined : { key: this.#clientsKey, url },
      environmentAt: this.#environmentAt, portraitTargets: this.#portraitTargets,
    };
    try {
      this.#sender.post(this.#port, state, { map, cameraYaw, cameraPitch, cameraDistance, cameraAnchorDistance,
        cameraPivotHeight, wmoFloor, frameTime }, this.#lookups, this.#inputs, undefined, extra, this.#frameAt);
    } catch (error) {
      // The frame is lost (logged once per message, as the loop logs a failed frame); its commands are not.
      this.#frameFailed(`frame not posted: ${errorText(error)}`);
      this.#postCommands(commands);
      return undefined;
    }
    this.#drawing = true;
    this.#postedSinceMark = true;
    return undefined;
  }

  // ---- reads ----------------------------------------------------------------------------------------------------

  get results(): RenderResults { return this.#results; }
  /** Asked for on arrival (`RenderWorkerResultSteps`); the loop's own after-draw asks find nothing. */
  collisionModelWants(): ReadonlySet<string> { return NO_COLLISION_WANTS; }
  unitModelWants(): readonly bigint[] { return NO_UNIT_WANTS; }
  get drawPhaseMs(): Readonly<Record<string, number>> { return this.#report?.drawPhaseMs ?? NO_PHASES; }
  get drawSubmitStats(): Readonly<{ programs: number; textures: number; geometries: number }> {
    return this.#report?.drawSubmitStats ?? NO_SUBMIT;
  }
  get telemetry(): WorldRenderer3D["telemetry"] | undefined { return this.#slow?.telemetry; }
  get programWarmup(): ProgramWarmupCounters | undefined { return this.#slow?.programWarmup; }
  get shadowCascadeStats(): RenderWorkerSlowReport["shadowCascadeStats"] { return this.#slow?.shadowCascadeStats; }
  get benchmarkGraphicsConfiguration(): RenderWorkerSlowReport["graphics"] | undefined { return this.#slow?.graphics; }
  get pixelRatio(): number | undefined { return this.#slow?.pixelRatio; }
  /** The resources live in the worker: the page's accounting walk does not reach them. */
  visitRetainedResources(): void {}
  poseWorkerStats(reset = false): RenderWorkerSlowReport["poseWorker"] {
    if (reset) this.#queue({ method: "#poseReset", args: [] });
    return this.#slow?.poseWorker;
  }
  webGlIdentity(): { readonly version?: string; readonly adapter?: string } { return this.#slow?.identity ?? {}; }
  benchmarkWebGl(): BenchmarkEnvironmentInput["webgl"] { return this.#slow?.webgl ?? captureBenchmarkWebGl(undefined); }
  drainShaderProgramCapture(): readonly ShaderProgramEvent[] | undefined {
    const events = this.#shaderEvents;
    if (events === undefined) return undefined;
    this.#shaderEvents = [];
    return events;
  }
  /** The worker's last report; asking keeps the worker computing it for a second. */
  standInReport(): WorldStandInReport | undefined {
    const now = performance.now();
    if (now - this.#standInsAskedAt >= STAND_IN_REQUEST_MS / 2) {
      this.#standInsAskedAt = now;
      this.#queue({ method: "#standIns", args: [STAND_IN_REQUEST_MS] });
    }
    return this.#standIns;
  }

  // ---- the worker's messages ------------------------------------------------------------------------------------

  /** One message from the worker. */
  accept(message: RenderWorkerToPage | ClientRenderResults | RenderWorkerLog): void {
    if (this.#closed) return;
    if (message.type === "results") this.#acceptResults(message as ClientRenderResults);
    else if (message.type === "log") console.warn(`[render worker] ${message.message}`);
    else if (message.type === "ready") this.onReady?.();
    else if (message.type === "error") this.onFailure?.(message.message);
  }

  /** The page's canvas size, pixel ratio, query and visibility (WorkerRenderHost.ts `update`). */
  postHost(host: RenderWorkerHostValues): void {
    if (!this.#closed) this.#post({ type: "host", host });
  }

  /** Stops posting (the worker is gone); queued commands are dropped. */
  close(): void {
    this.#closed = true;
    this.#commands = [];
  }

  /** Every setting and state as last called, onto an in-page renderer taking over from the worker. */
  replayOnto(renderer: ClientRenderer): void {
    const target = renderer as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const [method, args] of this.#sticky) target[method]!(...args);
  }

  #acceptResults(message: ClientRenderResults): void {
    const results = message.results;
    // Queues a previous record still held (its steps threw) keep their place in front of this one's.
    const previous = this.#results;
    if (previous.portraits.length > 0) results.portraits.unshift(...previous.portraits.splice(0));
    if (previous.gpuEvents.length > 0) results.gpuEvents.unshift(...previous.gpuEvents.splice(0));
    if (previous.patchChainSuspects.length > 0) results.patchChainSuspects.unshift(...previous.patchChainSuspects.splice(0));
    // Recorded once here, from this message; the loop's own reads of the record find nothing to record again.
    const frameInterval = results.frameInterval;
    const rendererFrameMs = results.rendererFrameMs;
    results.frameInterval = undefined;
    results.rendererFrameMs = undefined;
    this.#results = results;
    this.resultsApplied++;
    const report = message.report;
    if (report !== undefined) {
      this.#report = report;
      this.drawReadiness.observe(report.readiness, this.#clientsKey); // 22.10 (12.14)
      if (report.shaderPrograms !== undefined) this.#shaderEvents?.push(...report.shaderPrograms);
      if (report.frameError !== undefined) this.#frameFailed(report.frameError);
    }
    if (message.slow !== undefined) {
      this.#slow = message.slow;
      if (message.slow.standIns !== undefined) this.#standIns = message.slow.standIns;
    }
    const steps = this.#options.steps;
    try {
      if (frameInterval !== undefined) steps.recordFrameInterval(frameInterval);
      if (report !== undefined) {
        steps.afterDraw();
        steps.requestCollisionModels(report.collisionWants);
        steps.requestUnitModels(report.unitWants);
        steps.acceptSeats(results);
      }
      if (rendererFrameMs !== undefined) steps.recordRendererFrame(rendererFrameMs);
      steps.acceptReports(results);
      steps.drainPortraits(results);
      if (report !== undefined) steps.workerFrame?.(report);
      if (message.statuses !== undefined) steps.acceptStatuses?.(message.statuses); // 22.10 (12.14)
    } catch (error) {
      console.error("[render worker] the page's after-draw work failed", error);
    }
  }

  #frameFailed(message: string): void {
    this.frameErrors++;
    if (message === this.#lastFrameError) return;
    this.#lastFrameError = message;
    console.error(`[render worker] frame ${this.frameErrors}: ${message}`);
  }

  #send(method: ClientRendererCommand, args: readonly unknown[], called: readonly unknown[] = args): void {
    if (this.#closed) return;
    const kind = RENDER_WORKER_COMMANDS[method];
    if (kind === "setting") {
      const last = this.#lastSent.get(method);
      if (last !== undefined && sameArgs(method, last, called)) return;
      this.#lastSent.set(method, called);
    }
    if (kind !== "action") this.#sticky.set(method, called);
    this.#queue({ method, args });
  }

  #queue(command: { readonly method: ClientRendererCommand | RenderWorkerOwnCommand; readonly args: readonly unknown[] }): void {
    if (this.#closed) return;
    this.#commands.push(command);
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    (this.#options.queueTask ?? queueMicrotask)(() => {
      this.#flushQueued = false;
      const commands = this.#commands;
      if (commands.length === 0 || this.#closed) return;
      this.#commands = [];
      this.#postCommands(commands);
    });
  }

  #postCommands(commands: readonly RenderCommand[]): void {
    if (commands.length === 0) return;
    if (this.#post({ type: "commands", commands })) return;
    // One argument that cannot be cloned must not take the batch with it: each alone, the bad ones named.
    for (const command of commands) {
      if (!this.#post({ type: "commands", commands: [command] })) console.error(`[render worker] ${command.method} dropped`);
    }
  }

  #post(message: unknown): boolean {
    try {
      this.#port.postMessage(message);
      return true;
    } catch (error) {
      console.error("[render worker] message not posted", error);
      return false;
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
