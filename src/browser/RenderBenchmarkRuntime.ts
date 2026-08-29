import type {
  GpuTimerDropReason, GpuTimerObserver, GpuTimerUnavailableReason,
} from "./GpuTimer.js";
import type { RenderTelemetrySnapshot } from "./RenderStats.js";
import {
  benchmarkEnvironmentsEqual,
  cloneBenchmarkEnvironment,
  type BenchmarkEnvironmentMetadata,
} from "./BenchmarkManifest.js";
import {
  BenchmarkRunAccumulator,
  type BenchmarkGpuDropReason,
  type BenchmarkResourceCheckpointInput,
  type BenchmarkRunOptions,
  type BenchmarkRunSummary,
} from "./RenderBenchmarkRun.js";

export const RENDER_BENCHMARK_CHECKPOINT_INTERVAL_MS = 1_000;
export const RENDER_BENCHMARK_RUNTIME_MODE = "live-diagnostic" as const;

export interface RenderBenchmarkRuntimeStatus {
  readonly mode: typeof RENDER_BENCHMARK_RUNTIME_MODE;
  readonly formalGateEligible: false;
  readonly active: boolean;
  readonly scenario?: string;
  readonly variant?: string;
  readonly runIndex?: number;
  readonly startedAt?: number;
  readonly lastResourceCheckpointAt?: number;
  readonly frameFailures?: number;
}

export type BenchmarkDiagnosticInvalidReason =
  | "frame-errors"
  | "environment-missing"
  | "environment-changed";

export interface BenchmarkDiagnosticValidity {
  readonly valid: boolean;
  readonly frameSequenceComplete: boolean;
  readonly frameFailures: number;
  /** Reasons remain separate so an environment change is never reported as a frame error. */
  readonly invalidReasons: readonly BenchmarkDiagnosticInvalidReason[];
}

export type LiveRenderBenchmarkSummary = Readonly<BenchmarkRunSummary & {
  readonly mode: typeof RENDER_BENCHMARK_RUNTIME_MODE;
  readonly formalGateEligible: false;
  readonly diagnosticValidity: Readonly<BenchmarkDiagnosticValidity>;
  readonly environment: Readonly<{
    readonly start: Readonly<BenchmarkEnvironmentMetadata> | null;
    readonly finish: Readonly<BenchmarkEnvironmentMetadata> | null;
  }>;
}>;

interface ActiveRun {
  readonly accumulator: BenchmarkRunAccumulator;
  readonly options: BenchmarkRunOptions;
  lastResourceCheckpointAt: number;
  frameFailures: number;
  readonly startEnvironment: Readonly<BenchmarkEnvironmentMetadata> | null;
  endEnvironment: Readonly<BenchmarkEnvironmentMetadata> | null | undefined;
}

interface FormalGpuObserverClaim {
  readonly id: number;
  readonly observer: Readonly<GpuTimerObserver>;
}

export interface RenderBenchmarkGpuObserverLease {
  readonly id: number;
  readonly release: () => void;
}

let formalGpuObserverClaim: FormalGpuObserverClaim | undefined;
let nextFormalGpuObserverId = 1;

function benchmarkDropReason(reason: GpuTimerDropReason): BenchmarkGpuDropReason {
  if (reason === "queue-full") return "queue-drop";
  if (reason === "epoch-reset") return "pending-at-finish";
  return "query-discard";
}

/** Flattens exact live counters and known logical byte estimates; unknown textures stay counters. */
export function benchmarkResourceCheckpoint(
  telemetry: Pick<RenderTelemetrySnapshot, "renderer" | "resources">,
): BenchmarkResourceCheckpointInput {
  const counters: Record<string, number> = {};
  const bytes: Record<string, number> = {};
  const renderer = telemetry.renderer;
  if (renderer) {
    Object.assign(counters, {
      "renderer.drawCalls": renderer.drawCalls,
      "renderer.triangles": renderer.triangles,
      "renderer.unitsDrawn": renderer.unitsDrawn,
      "renderer.unitsDropped": renderer.unitsDropped,
      "renderer.gameObjectsDrawn": renderer.gameObjectsDrawn,
      "renderer.gameObjectsDropped": renderer.gameObjectsDropped,
      "renderer.effectsDrawn": renderer.effectsDrawn,
      "renderer.effectsDropped": renderer.effectsDropped,
      "renderer.groundCoverDrawn": renderer.groundCoverDrawn,
      "renderer.groundCoverSelected": renderer.groundCoverSelected,
      "renderer.groundCoverSelectionDroppedCells": renderer.groundCoverSelectionDroppedCells,
      "renderer.groundCoverResidentMeshes": renderer.groundCoverResidentMeshes,
      "renderer.wmoPortalModels": renderer.wmoPortalModels,
      "renderer.wmoPortalCandidates": renderer.wmoPortalCandidates,
      "renderer.wmoPortalCulled": renderer.wmoPortalCulled,
      "renderer.textureCount": renderer.textureCount,
      "renderer.geometryCount": renderer.geometryCount,
    });
  }
  const terrain = telemetry.resources.terrain;
  if (terrain) {
    counters["terrain.resident"] = terrain.resident;
    counters["terrain.failed"] = terrain.failed;
    counters["terrain.active"] = terrain.active;
    bytes["terrain.typedPayload"] = terrain.typedPayloadBytes;
  }
  const environment = telemetry.resources.environment;
  if (environment) {
    for (const [name, value] of Object.entries(environment)) counters[`environment.${name}`] = value;
  }
  const terrainSplat = telemetry.resources.terrainSplat;
  if (terrainSplat) {
    counters["terrainSplat.resident"] = terrainSplat.resident;
    counters["terrainSplat.failed"] = terrainSplat.failed;
    counters["terrainSplat.active"] = terrainSplat.active;
    counters["terrainSplat.layerRequestEntries"] = terrainSplat.layerRequestEntries;
    bytes["terrainSplat.decodedLayers"] = terrainSplat.decodedLayerBytes;
  }
  const accounting = telemetry.resources.accounting;
  if (accounting) {
    bytes["accounting.cpu.uniqueRetainedBytes"] = accounting.cpu.uniqueRetainedBytes;
    bytes["accounting.gpuBuffers.estimatedGpuBufferBytes"] = accounting.gpuBuffers.estimatedGpuBufferBytes;
    if (accounting.gpuTextures) {
      bytes["accounting.gpuTextures.estimatedLogicalTextureBytes"] =
        accounting.gpuTextures.estimatedLogicalTextureBytes;
      counters["accounting.gpuTextures.knownByteResources"] = accounting.gpuTextures.knownByteResources;
      counters["accounting.gpuTextures.unknownByteResources"] = accounting.gpuTextures.unknownByteResources;
    }
    if (accounting.gpuRenderbuffers) {
      bytes["accounting.gpuRenderbuffers.estimatedLogicalRenderbufferBytes"] =
        accounting.gpuRenderbuffers.estimatedLogicalRenderbufferBytes;
      counters["accounting.gpuRenderbuffers.knownByteResources"] =
        accounting.gpuRenderbuffers.knownByteResources;
      counters["accounting.gpuRenderbuffers.unknownByteResources"] =
        accounting.gpuRenderbuffers.unknownByteResources;
    }
    if (accounting.gpuRenderTargetTopology) {
      counters["accounting.gpuRenderTargetTopology.unknownTopologyResources"] =
        accounting.gpuRenderTargetTopology.unknownTopologyResources;
    }
    for (const [name, snapshot] of Object.entries({
      cpu: accounting.cpu,
      gpuBuffers: accounting.gpuBuffers,
      ...(accounting.gpuTextures ? { gpuTextures: accounting.gpuTextures } : {}),
      ...(accounting.gpuRenderbuffers ? { gpuRenderbuffers: accounting.gpuRenderbuffers } : {}),
      ...(accounting.gpuRenderTargetTopology
        ? { gpuRenderTargetTopology: accounting.gpuRenderTargetTopology } : {}),
      unsupported: accounting.unsupported,
    })) {
      counters[`accounting.${name}.uniqueResources`] = snapshot.uniqueResources;
      counters[`accounting.${name}.owners`] = snapshot.owners;
      counters[`accounting.${name}.references`] = snapshot.references;
      counters[`accounting.${name}.sharedResources`] = snapshot.sharedResources;
    }
    counters["accounting.coverageComplete"] = accounting.coverage.complete ? 1 : 0;
    counters["accounting.coverageGapCount"] = accounting.coverage.gaps.length;
  }
  const assetWarmup = telemetry.resources.assetWarmup;
  if (assetWarmup) {
    counters["assetWarmup.accepted"] = assetWarmup.accepted;
    counters["assetWarmup.queued"] = assetWarmup.queued;
    counters["assetWarmup.active"] = assetWarmup.active;
  }
  return { counters, bytes };
}

/** Owns at most one live diagnostic run and keeps hot-path record methods inactive by default. */
export class RenderBenchmarkRuntime {
  #active: ActiveRun | undefined;
  readonly gpuObserver: Readonly<GpuTimerObserver> = Object.freeze({
    onSample: (milliseconds: number) => this.recordGpuSample(milliseconds),
    onUnavailable: (reason: GpuTimerUnavailableReason) => this.recordGpuUnavailable(reason),
    onDropped: (count: number, reason: GpuTimerDropReason) =>
      this.recordGpuDropped(count, benchmarkDropReason(reason)),
  });

  get active(): boolean {
    return this.#active !== undefined;
  }

  start(
    options: BenchmarkRunOptions,
    startTelemetry?: Pick<RenderTelemetrySnapshot, "renderer" | "resources">,
    initialGpuReason?: GpuTimerUnavailableReason,
    environment?: unknown,
  ): Readonly<RenderBenchmarkRuntimeStatus> {
    if (formalGpuObserverClaim !== undefined) {
      throw new Error("live render benchmark runtime cannot start while formal GPU observer is claimed");
    }
    if (this.#active) throw new Error("a render benchmark run is already active");
    const accumulator = new BenchmarkRunAccumulator(options);
    if (startTelemetry) accumulator.recordResourceStart(benchmarkResourceCheckpoint(startTelemetry));
    if (initialGpuReason) accumulator.addGpuSample({ status: "unavailable", reason: initialGpuReason });
    const startEnvironment = environment === undefined ? null : cloneBenchmarkEnvironment(environment);
    this.#active = {
      accumulator,
      options,
      lastResourceCheckpointAt: options.startedAt,
      frameFailures: 0,
      startEnvironment,
      endEnvironment: undefined,
    };
    return this.status();
  }

  recordFrameInterval(milliseconds: number): void {
    this.#active?.accumulator.addFrameInterval(milliseconds);
  }

  recordFullFrameCpu(milliseconds: number): void {
    this.#active?.accumulator.addFullFrameCpu(milliseconds);
  }

  recordRendererFrameCpu(milliseconds: number): void {
    this.#active?.accumulator.addRendererFrameCpu(milliseconds);
  }

  recordGpuSample(milliseconds: number): void {
    this.#active?.accumulator.addGpuSample({ status: "available", milliseconds });
  }

  recordGpuUnavailable(reason: GpuTimerUnavailableReason): void {
    this.#active?.accumulator.addGpuSample({ status: "unavailable", reason });
  }

  recordGpuDropped(count: number, reason: BenchmarkGpuDropReason = "queue-drop"): void {
    this.#active?.accumulator.addGpuDropped(count, reason);
  }

  recordFrameFailure(): void {
    const active = this.#active;
    if (active) {
      if (active.endEnvironment !== undefined) throw new Error("benchmark measurement is already sealed");
      active.frameFailures++;
    }
  }

  checkpointDue(now: number): boolean {
    const active = this.#active;
    return Boolean(active && Number.isFinite(now)
      && now - active.lastResourceCheckpointAt >= RENDER_BENCHMARK_CHECKPOINT_INTERVAL_MS);
  }

  recordResourceCheckpoint(
    now: number,
    telemetry: Pick<RenderTelemetrySnapshot, "renderer" | "resources">,
  ): void {
    const active = this.#active;
    if (!active || !this.checkpointDue(now)) return;
    active.accumulator.recordResourceCheckpoint(benchmarkResourceCheckpoint(telemetry));
    active.lastResourceCheckpointAt = now;
  }

  sealMeasurement(
    endedAt: number,
    endTelemetry?: Pick<RenderTelemetrySnapshot, "renderer" | "resources">,
    environment?: unknown,
  ): void {
    const active = this.#active;
    if (!active) throw new Error("no render benchmark run is active");
    const endEnvironment = environment === undefined ? null : cloneBenchmarkEnvironment(environment);
    const endCheckpoint = endTelemetry === undefined ? undefined : benchmarkResourceCheckpoint(endTelemetry);
    active.accumulator.sealMeasurement(
      endedAt,
      endCheckpoint,
    );
    active.endEnvironment = endEnvironment;
  }

  finishAfterGpuDrain(): LiveRenderBenchmarkSummary {
    const active = this.#active;
    if (!active) throw new Error("no render benchmark run is active");
    if (active.endEnvironment === undefined) {
      throw new Error("benchmark measurement must be sealed before GPU drain finish");
    }
    const summary = active.accumulator.finishAfterGpuDrain();
    this.#active = undefined;
    const environmentChanged = active.startEnvironment !== null
      && active.endEnvironment !== null
      && !benchmarkEnvironmentsEqual(active.startEnvironment, active.endEnvironment);
    const environmentMissing = active.startEnvironment === null || active.endEnvironment === null;
    const invalidReasons = Object.freeze([
      ...(active.frameFailures > 0 ? ["frame-errors" as const] : []),
      ...(environmentMissing ? ["environment-missing" as const] : []),
      ...(environmentChanged ? ["environment-changed" as const] : []),
    ]);
    const diagnosticValidity = Object.freeze({
      valid: invalidReasons.length === 0,
      frameSequenceComplete: active.frameFailures === 0,
      frameFailures: active.frameFailures,
      invalidReasons,
    });
    const resultEnvironment = Object.freeze({
      start: active.startEnvironment,
      finish: active.endEnvironment,
    });
    return Object.freeze({
      ...summary,
      mode: RENDER_BENCHMARK_RUNTIME_MODE,
      formalGateEligible: false as const,
      diagnosticValidity,
      environment: resultEnvironment,
    });
  }

  finish(
    endedAt: number,
    endTelemetry?: Pick<RenderTelemetrySnapshot, "renderer" | "resources">,
    environment?: unknown,
  ): LiveRenderBenchmarkSummary {
    this.sealMeasurement(endedAt, endTelemetry, environment);
    return this.finishAfterGpuDrain();
  }

  status(): Readonly<RenderBenchmarkRuntimeStatus> {
    const active = this.#active;
    return Object.freeze(active === undefined
      ? { mode: RENDER_BENCHMARK_RUNTIME_MODE, formalGateEligible: false as const, active: false }
      : {
        mode: RENDER_BENCHMARK_RUNTIME_MODE,
        formalGateEligible: false as const,
        active: true,
        scenario: active.options.scenario,
        variant: active.options.variant,
        runIndex: active.options.runIndex,
        startedAt: active.options.startedAt,
        lastResourceCheckpointAt: active.lastResourceCheckpointAt,
        frameFailures: active.frameFailures,
      });
  }
}

export const renderBenchmarkRuntime = new RenderBenchmarkRuntime();

function dispatchGpuObserver(callback: (observer: Readonly<GpuTimerObserver>) => void): void {
  const observer = formalGpuObserverClaim?.observer ?? renderBenchmarkRuntime.gpuObserver;
  try { callback(observer); } catch { /* diagnostics never break rendering */ }
}

/** Claims the shared GPU observer for one formal run until its idempotent release. */
export function acquireRenderBenchmarkFormalGpuObserver(
  observer: Readonly<GpuTimerObserver>,
): Readonly<RenderBenchmarkGpuObserverLease> {
  if (observer === null || typeof observer !== "object") {
    throw new TypeError("formal GPU observer must be an object");
  }
  if (formalGpuObserverClaim !== undefined) throw new Error("formal GPU observer is already claimed");
  if (renderBenchmarkRuntime.active) throw new Error("cannot claim formal GPU observer while live run is active");
  const claim: FormalGpuObserverClaim = { id: nextFormalGpuObserverId++, observer };
  formalGpuObserverClaim = claim;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (formalGpuObserverClaim === claim) formalGpuObserverClaim = undefined;
  };
  return Object.freeze({ id: claim.id, release });
}

/** Stable observer passed once to the GPU timer; every method is a no-op without an active run. */
export const renderBenchmarkGpuObserver: Readonly<GpuTimerObserver> = Object.freeze({
  onSample: (milliseconds: number) => dispatchGpuObserver((observer) => observer.onSample?.(milliseconds)),
  onUnavailable: (reason: GpuTimerUnavailableReason) =>
    dispatchGpuObserver((observer) => observer.onUnavailable?.(reason)),
  onDropped: (count: number, reason: GpuTimerDropReason) =>
    dispatchGpuObserver((observer) => observer.onDropped?.(count, reason)),
});
