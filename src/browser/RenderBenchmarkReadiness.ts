import type { RenderTelemetrySnapshot } from "./RenderStats.js";

export const RENDER_BENCHMARK_STABLE_RESIDENCY_MS = 2_000;
export const RENDER_BENCHMARK_MIN_STABLE_SAMPLES = 3;

/** Renderer-owned work which is not visible in the terrain/environment client queues. */
export interface BenchmarkRendererReadinessInput {
  readonly renderFrameActive: boolean;
  readonly gpuQueriesPending: number;
  readonly modelTexturesPending: number;
  readonly worldTexturesPending: number;
  readonly groundCoverModelsPending: number;
  /** Model and spell texture terminal failures/current settle revisions. */
  readonly modelTexturesErrors: number;
  readonly modelTexturesGeneration: number;
  /** Generic world texture terminal failures/current settle revisions. */
  readonly worldTexturesErrors: number;
  readonly worldTexturesGeneration: number;
  /** Finite spell visuals which are not part of the fixed world snapshot. */
  readonly transientVisuals: number;
  /** Persistent state visuals are not part of the fixed world snapshot and are terminal. */
  readonly persistentStateVisuals: number;
  readonly pendingVisualAnimations: number;
  readonly pendingUnitActions: number;
  readonly pendingGameObjectAnimations: number;
  /** Character body atlas work is renderer-triggered but lives in its own cache/client. */
  readonly characterAtlasPending: number;
  readonly characterAtlasErrors: number;
  /** Atlas image/composition settle revision, including requests too short to observe as pending. */
  readonly characterAtlasGeneration: number;
}

/** Exact counters for one renderer-triggered asynchronous owner. */
export interface BenchmarkAsyncReadinessStats {
  readonly pending: number;
  readonly success: number;
  readonly error: number;
  /** Monotonic settle/cache revision; unlike pending, it catches short requests between samples. */
  readonly generation: number;
}

/** Live readiness state for asynchronous owners which can be reached by world rendering. */
export interface BenchmarkClientReadinessInput {
  readonly light: Readonly<BenchmarkAsyncReadinessStats>;
  readonly liquids: Readonly<BenchmarkAsyncReadinessStats>;
  readonly groundCover: Readonly<BenchmarkAsyncReadinessStats>;
  readonly horizon: Readonly<BenchmarkAsyncReadinessStats>;
  readonly transportPaths: Readonly<BenchmarkAsyncReadinessStats>;
  readonly creatureModels: Readonly<BenchmarkAsyncReadinessStats>;
  readonly creatureMetadata: Readonly<BenchmarkAsyncReadinessStats>;
  readonly gameObjectMetadata: Readonly<BenchmarkAsyncReadinessStats>;
  readonly itemMetadata: Readonly<BenchmarkAsyncReadinessStats>;
  readonly collision: Readonly<BenchmarkAsyncReadinessStats>;
}

export type BenchmarkReadinessBlockingReason =
  | "renderer-telemetry-missing"
  | "terrain-stats-missing"
  | "terrain-active"
  | "terrain-splat-stats-missing"
  | "terrain-splat-active"
  | "environment-stats-missing"
  | "environment-tiles-active"
  | "environment-models-queued"
  | "environment-models-deferred"
  | "environment-models-active"
  | "environment-groups-queued"
  | "environment-groups-active"
  | "environment-groups-deferred"
  | "environment-groups-failed"
  | "environment-animations-queued"
  | "environment-animations-deferred"
  | "environment-animations-active"
  | "terrain-failed"
  | "terrain-splat-failed"
  | "environment-tiles-failed"
  | "environment-models-failed"
  | "environment-animations-failed"
  | "asset-warmup-stats-missing"
  | "asset-warmup-queued"
  | "asset-warmup-active"
  | "resource-accounting-missing"
  | "renderer-readiness-missing"
  | "renderer-frame-active"
  | "gpu-queries-pending"
  | "model-textures-pending"
  | "world-textures-pending"
  | "model-textures-errors"
  | "world-textures-errors"
  | "ground-cover-models-pending"
  | "transient-visuals-active"
  | "persistent-state-visuals-active"
  | "visual-animations-pending"
  | "unit-actions-pending"
  | "game-object-animations-pending"
  | "character-atlas-pending"
  | "character-atlas-errors"
  | "light-pending"
  | "liquids-pending"
  | "ground-cover-pending"
  | "horizon-pending"
  | "transport-paths-pending"
  | "creature-models-pending"
  | "creature-metadata-pending"
  | "game-object-metadata-pending"
  | "item-metadata-pending"
  | "collision-pending"
  | "light-errors"
  | "liquids-errors"
  | "ground-cover-errors"
  | "horizon-errors"
  | "transport-paths-errors"
  | "creature-models-errors"
  | "creature-metadata-errors"
  | "game-object-metadata-errors"
  | "item-metadata-errors"
  | "collision-errors"
  | "client-readiness-missing"
  | "resource-signature-changing"
  | "stable-window-incomplete";

export interface BenchmarkReadinessObservation {
  readonly capturedAt: number;
  readonly ready: boolean;
  readonly stableForMs: number;
  readonly stableSamples: number;
  /** Canonical JSON over residency and async generations; clocks and per-frame draw counters are excluded. */
  readonly resourceSignature: string;
  readonly blockingReasons: readonly BenchmarkReadinessBlockingReason[];
}

interface BenchmarkReadinessOptions {
  readonly stableResidencyMs?: number;
  readonly minimumStableSamples?: number;
}

function requireNonNegativeFinite(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function requireCount(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function cloneRendererReadiness(input: BenchmarkRendererReadinessInput): BenchmarkRendererReadinessInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("rendererReadiness must be an object");
  }
  if (typeof input.renderFrameActive !== "boolean") {
    throw new TypeError("rendererReadiness.renderFrameActive must be boolean");
  }
  return Object.freeze({
    renderFrameActive: input.renderFrameActive,
    gpuQueriesPending: requireCount("rendererReadiness.gpuQueriesPending", input.gpuQueriesPending),
    modelTexturesPending: requireCount(
      "rendererReadiness.modelTexturesPending",
      input.modelTexturesPending,
    ),
    worldTexturesPending: requireCount(
      "rendererReadiness.worldTexturesPending",
      input.worldTexturesPending,
    ),
    groundCoverModelsPending: requireCount(
      "rendererReadiness.groundCoverModelsPending",
      input.groundCoverModelsPending,
    ),
    transientVisuals: requireCount("rendererReadiness.transientVisuals", input.transientVisuals),
    persistentStateVisuals: requireCount(
      "rendererReadiness.persistentStateVisuals", input.persistentStateVisuals,
    ),
    pendingVisualAnimations: requireCount(
      "rendererReadiness.pendingVisualAnimations",
      input.pendingVisualAnimations,
    ),
    pendingUnitActions: requireCount(
      "rendererReadiness.pendingUnitActions",
      input.pendingUnitActions,
    ),
    modelTexturesErrors: requireCount(
      "rendererReadiness.modelTexturesErrors", input.modelTexturesErrors,
    ),
    modelTexturesGeneration: requireCount(
      "rendererReadiness.modelTexturesGeneration", input.modelTexturesGeneration,
    ),
    worldTexturesErrors: requireCount(
      "rendererReadiness.worldTexturesErrors", input.worldTexturesErrors,
    ),
    worldTexturesGeneration: requireCount(
      "rendererReadiness.worldTexturesGeneration", input.worldTexturesGeneration,
    ),
    pendingGameObjectAnimations: requireCount(
      "rendererReadiness.pendingGameObjectAnimations", input.pendingGameObjectAnimations,
    ),
    characterAtlasPending: requireCount(
      "rendererReadiness.characterAtlasPending", input.characterAtlasPending,
    ),
    characterAtlasErrors: requireCount(
      "rendererReadiness.characterAtlasErrors", input.characterAtlasErrors,
    ),
    characterAtlasGeneration: requireCount(
      "rendererReadiness.characterAtlasGeneration", input.characterAtlasGeneration,
    ),
  });
}

const CLIENT_READINESS_KEYS = [
  "light", "liquids", "groundCover", "horizon", "transportPaths", "creatureModels",
  "creatureMetadata", "gameObjectMetadata", "itemMetadata", "collision",
] as const;

function cloneAsyncReadinessStats(value: unknown, label: string): Readonly<BenchmarkAsyncReadinessStats> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  return Object.freeze({
    pending: requireCount(`${label}.pending`, input.pending),
    success: requireCount(`${label}.success`, input.success),
    error: requireCount(`${label}.error`, input.error),
    generation: requireCount(`${label}.generation`, input.generation),
  });
}

function cloneClientReadiness(input: BenchmarkClientReadinessInput): Readonly<BenchmarkClientReadinessInput> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("clientReadiness must be an object");
  }
  return Object.freeze({
    light: cloneAsyncReadinessStats(input.light, "clientReadiness.light"),
    liquids: cloneAsyncReadinessStats(input.liquids, "clientReadiness.liquids"),
    groundCover: cloneAsyncReadinessStats(input.groundCover, "clientReadiness.groundCover"),
    horizon: cloneAsyncReadinessStats(input.horizon, "clientReadiness.horizon"),
    transportPaths: cloneAsyncReadinessStats(input.transportPaths, "clientReadiness.transportPaths"),
    creatureModels: cloneAsyncReadinessStats(input.creatureModels, "clientReadiness.creatureModels"),
    creatureMetadata: cloneAsyncReadinessStats(input.creatureMetadata, "clientReadiness.creatureMetadata"),
    gameObjectMetadata: cloneAsyncReadinessStats(input.gameObjectMetadata, "clientReadiness.gameObjectMetadata"),
    itemMetadata: cloneAsyncReadinessStats(input.itemMetadata, "clientReadiness.itemMetadata"),
    collision: cloneAsyncReadinessStats(input.collision, "clientReadiness.collision"),
  });
}

function resourceSignature(
  telemetry: Pick<RenderTelemetrySnapshot, "renderer" | "resources">,
  clientReadiness: BenchmarkClientReadinessInput | undefined,
  rendererReadiness: BenchmarkRendererReadinessInput | undefined,
): string {
  const renderer = telemetry.renderer;
  const resources = telemetry.resources;
  return canonicalJson({
    renderer: renderer === undefined ? null : {
      textureCount: renderer.textureCount,
      geometryCount: renderer.geometryCount,
      groundCoverResidentMeshes: renderer.groundCoverResidentMeshes,
    },
    terrain: resources.terrain ?? null,
    terrainSplat: resources.terrainSplat ?? null,
    environment: resources.environment ?? null,
    assetWarmup: resources.assetWarmup ?? null,
    accounting: resources.accounting ?? null,
    // Generations are intentionally included while live pending counts are blockers below. This
    // catches a request which starts and settles between two observations.
    clients: clientReadiness
      ? Object.fromEntries(CLIENT_READINESS_KEYS.map((key) => [key, clientReadiness[key].generation]))
      : null,
    rendererAsync: rendererReadiness === undefined ? null : {
      characterAtlasGeneration: rendererReadiness.characterAtlasGeneration,
      modelTexturesGeneration: rendererReadiness.modelTexturesGeneration,
      worldTexturesGeneration: rendererReadiness.worldTexturesGeneration,
    },
  });
}

function canonicalJson(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("resource residency numbers must be finite");
  }
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("resource residency must be JSON-safe");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function queueBlockers(
  telemetry: Pick<RenderTelemetrySnapshot, "renderer" | "resources">,
  rendererReadiness: BenchmarkRendererReadinessInput | undefined,
  clientReadiness: BenchmarkClientReadinessInput | undefined,
  clientReadinessMissing = false,
): BenchmarkReadinessBlockingReason[] {
  const blockers: BenchmarkReadinessBlockingReason[] = [];
  const resources = telemetry.resources;
  if (telemetry.renderer === undefined) blockers.push("renderer-telemetry-missing");

  if (resources.terrain === undefined) blockers.push("terrain-stats-missing");
  else {
    if (resources.terrain.active > 0) blockers.push("terrain-active");
    if (resources.terrain.failed > 0) blockers.push("terrain-failed");
  }

  if (resources.terrainSplat === undefined) blockers.push("terrain-splat-stats-missing");
  else {
    if (resources.terrainSplat.active > 0) blockers.push("terrain-splat-active");
    if (resources.terrainSplat.failed > 0) blockers.push("terrain-splat-failed");
  }

  const environment = resources.environment;
  if (environment === undefined) blockers.push("environment-stats-missing");
  else {
    if (environment.activeTiles > 0) blockers.push("environment-tiles-active");
    if (environment.failedTiles > 0) blockers.push("environment-tiles-failed");
    if (environment.queuedModels > 0) blockers.push("environment-models-queued");
    if (environment.deferredModels > 0) blockers.push("environment-models-deferred");
    if (environment.activeModels > 0) blockers.push("environment-models-active");
    if (environment.failedModels > 0) blockers.push("environment-models-failed");
    if (environment.queuedGroups > 0) blockers.push("environment-groups-queued");
    if (environment.activeGroups > 0) blockers.push("environment-groups-active");
    if (environment.deferredGroups > 0) blockers.push("environment-groups-deferred");
    if (environment.failedGroups > 0) blockers.push("environment-groups-failed");
    if (environment.queuedAnimations > 0) blockers.push("environment-animations-queued");
    if (environment.deferredAnimations > 0) blockers.push("environment-animations-deferred");
    if (environment.activeAnimations > 0) blockers.push("environment-animations-active");
    if (environment.failedAnimations > 0) blockers.push("environment-animations-failed");
  }

  if (resources.assetWarmup === undefined) blockers.push("asset-warmup-stats-missing");
  else {
    if (resources.assetWarmup.queued > 0) blockers.push("asset-warmup-queued");
    if (resources.assetWarmup.active > 0) blockers.push("asset-warmup-active");
  }
  if (resources.accounting === undefined) blockers.push("resource-accounting-missing");

  if (rendererReadiness === undefined) {
    blockers.push("renderer-readiness-missing");
  } else {
    const renderer = cloneRendererReadiness(rendererReadiness);
    if (renderer.renderFrameActive) blockers.push("renderer-frame-active");
    if (renderer.gpuQueriesPending > 0) blockers.push("gpu-queries-pending");
    if (renderer.modelTexturesPending > 0) blockers.push("model-textures-pending");
    if (renderer.worldTexturesPending > 0) blockers.push("world-textures-pending");
    if (renderer.modelTexturesErrors > 0) blockers.push("model-textures-errors");
    if (renderer.worldTexturesErrors > 0) blockers.push("world-textures-errors");
    if (renderer.groundCoverModelsPending > 0) blockers.push("ground-cover-models-pending");
    if (renderer.transientVisuals > 0) blockers.push("transient-visuals-active");
    if (renderer.persistentStateVisuals > 0) blockers.push("persistent-state-visuals-active");
    if (renderer.pendingVisualAnimations > 0) blockers.push("visual-animations-pending");
    if (renderer.pendingUnitActions > 0) blockers.push("unit-actions-pending");
    if (renderer.pendingGameObjectAnimations > 0) blockers.push("game-object-animations-pending");
    if (renderer.characterAtlasPending > 0) blockers.push("character-atlas-pending");
    if (renderer.characterAtlasErrors > 0) blockers.push("character-atlas-errors");
  }
  if (clientReadinessMissing) {
    blockers.push("client-readiness-missing");
  } else if (clientReadiness !== undefined) {
    const clients = cloneClientReadiness(clientReadiness);
    const pendingBlockers: ReadonlyArray<readonly [keyof BenchmarkClientReadinessInput, BenchmarkReadinessBlockingReason]> = [
      ["light", "light-pending"],
      ["liquids", "liquids-pending"],
      ["groundCover", "ground-cover-pending"],
      ["horizon", "horizon-pending"],
      ["transportPaths", "transport-paths-pending"],
      ["creatureModels", "creature-models-pending"],
      ["creatureMetadata", "creature-metadata-pending"],
      ["gameObjectMetadata", "game-object-metadata-pending"],
      ["itemMetadata", "item-metadata-pending"],
      ["collision", "collision-pending"],
    ];
    const errorBlockers: ReadonlyArray<readonly [keyof BenchmarkClientReadinessInput, BenchmarkReadinessBlockingReason]> = [
      ["light", "light-errors"],
      ["liquids", "liquids-errors"],
      ["groundCover", "ground-cover-errors"],
      ["horizon", "horizon-errors"],
      ["transportPaths", "transport-paths-errors"],
      ["creatureModels", "creature-models-errors"],
      ["creatureMetadata", "creature-metadata-errors"],
      ["gameObjectMetadata", "game-object-metadata-errors"],
      ["itemMetadata", "item-metadata-errors"],
      ["collision", "collision-errors"],
    ];
    for (const [key, reason] of pendingBlockers) {
      if (clients[key].pending > 0) blockers.push(reason);
    }
    for (const [key, reason] of errorBlockers) {
      if (clients[key].error > 0) blockers.push(reason);
    }
  }
  return blockers;
}

/**
 * Stateful warm-up barrier. It never starts work: callers feed snapshots from their existing
 * cadence, and readiness is reached only after multiple strictly ordered, idle, identical samples.
 */
export class RenderBenchmarkReadinessTracker {
  readonly #stableResidencyMs: number;
  readonly #minimumStableSamples: number;
  #lastCapturedAt: number | undefined;
  #stableSince: number | undefined;
  #stableSamples = 0;
  #signature = "";

  constructor(options: BenchmarkReadinessOptions = {}) {
    this.#stableResidencyMs = requireNonNegativeFinite(
      "stableResidencyMs",
      options.stableResidencyMs ?? RENDER_BENCHMARK_STABLE_RESIDENCY_MS,
    );
    const minimumStableSamples = options.minimumStableSamples ?? RENDER_BENCHMARK_MIN_STABLE_SAMPLES;
    if (!Number.isSafeInteger(minimumStableSamples) || minimumStableSamples < 2) {
      throw new RangeError("minimumStableSamples must be a safe integer of at least two");
    }
    this.#minimumStableSamples = minimumStableSamples;
  }

  observe(
    telemetry: Pick<RenderTelemetrySnapshot, "capturedAt" | "renderer" | "resources" | "benchmarkClients">,
    rendererReadiness?: BenchmarkRendererReadinessInput,
    clientReadiness?: BenchmarkClientReadinessInput,
  ): Readonly<BenchmarkReadinessObservation> {
    const capturedAt = requireNonNegativeFinite("telemetry.capturedAt", telemetry.capturedAt);
    if (this.#lastCapturedAt !== undefined && capturedAt <= this.#lastCapturedAt) {
      throw new RangeError("telemetry.capturedAt must be strictly increasing");
    }

    const liveClients = clientReadiness ?? telemetry.benchmarkClients;
    // Normalize before building the signature. Otherwise an omitted required generation reaches
    // canonical JSON as `undefined` and reports a misleading residency serialization error.
    const normalizedRenderer = rendererReadiness === undefined
      ? undefined : cloneRendererReadiness(rendererReadiness);
    const normalizedClients = liveClients === undefined
      ? undefined : cloneClientReadiness(liveClients);
    const signature = resourceSignature(telemetry, normalizedClients, normalizedRenderer);
    // Every formal capture must include the complete aggregate. A hand-built/legacy snapshot
    // without it is indistinguishable from a healthy world, so it fails closed explicitly.
    const clientReadinessMissing = liveClients === undefined;
    const blockers = queueBlockers(
      telemetry, normalizedRenderer, normalizedClients, clientReadinessMissing,
    );
    // Validation above is deliberately transactional: a rejected/incomplete snapshot must not
    // consume a timestamp and make the next valid observation fail the strict-order check.
    this.#lastCapturedAt = capturedAt;
    const queuesIdle = blockers.length === 0;
    let signatureChanged = false;
    if (!queuesIdle) {
      this.#stableSince = undefined;
      this.#stableSamples = 0;
      this.#signature = signature;
    } else if (this.#stableSince === undefined || signature !== this.#signature) {
      signatureChanged = this.#stableSince !== undefined;
      this.#stableSince = capturedAt;
      this.#stableSamples = 1;
      this.#signature = signature;
    } else {
      this.#stableSamples++;
    }

    const stableForMs = this.#stableSince === undefined ? 0 : capturedAt - this.#stableSince;
    if (queuesIdle && signatureChanged) blockers.push("resource-signature-changing");
    const enoughSamples = this.#stableSamples >= this.#minimumStableSamples;
    const enoughTime = stableForMs >= this.#stableResidencyMs;
    if (queuesIdle && (!enoughSamples || !enoughTime)) blockers.push("stable-window-incomplete");
    const ready = blockers.length === 0;
    return Object.freeze({
      capturedAt,
      ready,
      stableForMs,
      stableSamples: this.#stableSamples,
      resourceSignature: signature,
      blockingReasons: Object.freeze(blockers),
    });
  }

  reset(): void {
    this.#lastCapturedAt = undefined;
    this.#stableSince = undefined;
    this.#stableSamples = 0;
    this.#signature = "";
  }
}
