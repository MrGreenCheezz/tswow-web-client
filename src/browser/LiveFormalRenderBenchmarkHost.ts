import {
  cloneWorldReplaySnapshot,
  hydrateWorldReplaySnapshot,
  validateWorldReplayObservation,
  type HydratedWorldReplayCameraFrameV1,
  type HydratedWorldReplaySnapshot,
  type WorldReplayCameraFrameV1,
  type WorldReplayObservation,
  type WorldReplaySnapshotV1,
} from "./BenchmarkReplay.js";
import {
  cloneBenchmarkEnvironment,
  type BenchmarkEnvironmentMetadata,
  type BenchmarkJsonObject,
  type BenchmarkJsonValue,
} from "./BenchmarkManifest.js";
import type {
  FormalBenchmarkBarrier,
  FormalBenchmarkEpochIdentity,
  FormalBenchmarkExclusiveLease,
  FormalBenchmarkGpuDrain,
  FormalBenchmarkSubmissionReceipt,
  FormalRenderBenchmarkHost,
} from "./FormalRenderBenchmarkRunner.js";
import type { GpuTimerDropReason, GpuTimerObserver, GpuTimerUnavailableReason } from "./GpuTimer.js";
import {
  acquireFormalRenderBenchmarkExclusiveLease,
  assertFormalRenderBenchmarkExclusiveLease,
  type FormalRenderBenchmarkExclusiveLease as CoordinatorLease,
} from "./RenderBenchmarkExclusiveLease.js";
import type { BenchmarkVariantConfiguration } from "./RenderBenchmarkIdentity.js";
import type { BenchmarkVariant } from "./RenderBenchmarkPairing.js";
import {
  RenderBenchmarkReadinessTracker,
  type BenchmarkClientReadinessInput,
  type BenchmarkReadinessBlockingReason,
  type BenchmarkReadinessObservation,
} from "./RenderBenchmarkReadiness.js";
import type { BenchmarkGpuUnavailableReason, BenchmarkResourceCheckpointInput } from "./RenderBenchmarkRun.js";
import {
  acquireRenderBenchmarkFormalGpuObserver,
  benchmarkResourceCheckpoint,
  renderBenchmarkRuntime,
  type RenderBenchmarkGpuObserverLease,
} from "./RenderBenchmarkRuntime.js";
import type { RenderTelemetrySnapshot } from "./RenderStats.js";
import { ENVIRONMENT_RANGE, type EnvironmentObject } from "./Terrain.js";
import type { UnitModel } from "./CreatureModelClient.js";
import type { WorldObjectState } from "../world/WorldState.js";
import { createCamera } from "./SimpleScene.js";
import { eyeUnderCollisionModelLiquid } from "./game/CollisionLiquid.js";
import { FLOOR_SEARCH_DEPTH, STEP_HEIGHT, eyeUnderwater } from "./game/Physics.js";
import { game, type GameContext } from "./game/Context.js";
import type {
  ExperimentalShaderProfile,
  FormalRenderSurfaceStamp,
  StateVisual,
  WorldRenderer3D,
  WorldSubmissionReceipt,
} from "./WorldRenderer3D.js";
import type { PortraitSlot, PortraitTarget } from "./PortraitRenderer.js";

const DEFAULT_PREWARM_CHUNK_FRAMES = 30;
const DEFAULT_PREWARM_TIMEOUT_MS = 180_000;
const DEFAULT_GPU_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 2_000;
const REQUIRED_GPU_SAMPLES = 5_400;
const LIVE_FORMAL_RENDER_BENCHMARK_HOSTS = new WeakSet<object>();

class FormalFrameDeadlineError extends Error {}

const ACTIVE_RESOURCE_KEYS = [
  "renderer", "terrain", "terrainSplat", "groundCover", "light", "liquids", "environment",
  "assetWarmup", "creatureModels", "creatureMetadata", "itemMetadata", "factions",
  "gameObjectMetadata", "transportPaths", "horizon", "collision",
] as const;

const RENDERER_MUTATORS = [
  "beginFormalBenchmarkIsolation", "endFormalBenchmarkIsolation",
  "updateLighting",
  "observeFrame", "resetFrameCadence", "resetRenderEvolutionClock", "resetReplayEpoch", "endReplayEpoch",
  "playSpellVisual", "clearSpellVisuals", "cancelSpellVisual", "retimeSpellVisual", "setStateVisuals",
  "setWeather", "setIndoors", "setCollisionModels", "setGroundCover", "invalidateGroundCover", "setSelection",
  "setPortraitTargets", "renderPortraits", "clearPortraits",
  "markFrameNotRendered", "beginRenderFrame", "endRenderFrame", "resetGpuTimingEpoch", "draw",
  "playGameObjectAnimation", "playUnitAction", "playUnitEmote", "cancelUnitAction",
  "setLightingQuality", "setWmoOcclusion", "setCharacterAtlasAnisotropy", "setExperimentalShaderProfile", "setRenderScale",
] as const;

type RendererMutatorName = typeof RENDERER_MUTATORS[number];

const VOLATILE_RENDERER_COUNTERS = new Set([
  "renderer.drawCalls",
  "renderer.triangles",
  "renderer.unitsDrawn",
  "renderer.unitsDropped",
  "renderer.gameObjectsDrawn",
  "renderer.gameObjectsDropped",
  "renderer.effectsDrawn",
  "renderer.effectsDropped",
  "renderer.groundCoverDrawn",
  "renderer.groundCoverSelected",
  "renderer.groundCoverSelectionDroppedCells",
  "renderer.wmoPortalModels",
  "renderer.wmoPortalCandidates",
  "renderer.wmoPortalCulled",
]);

const TERMINAL_READINESS_BLOCKERS = new Set<BenchmarkReadinessBlockingReason>([
  "renderer-telemetry-missing",
  "terrain-stats-missing",
  "terrain-splat-stats-missing",
  "environment-stats-missing",
  "asset-warmup-stats-missing",
  "resource-accounting-missing",
  "renderer-readiness-missing",
  "client-readiness-missing",
  "terrain-failed",
  "terrain-splat-failed",
  "environment-tiles-failed",
  "environment-models-failed",
  "environment-animations-failed",
  "character-atlas-errors",
  "model-textures-errors",
  "world-textures-errors",
  "persistent-state-visuals-active",
  "light-errors",
  "liquids-errors",
  "ground-cover-errors",
  "horizon-errors",
  "transport-paths-errors",
  "creature-models-errors",
  "creature-metadata-errors",
  "game-object-metadata-errors",
  "item-metadata-errors",
  "collision-errors",
]);

export interface LiveFormalRenderGraphicsConfiguration {
  readonly lighting: number;
  readonly settings: BenchmarkJsonObject;
}

interface UserGraphicsSettings {
  readonly lightingQuality: number;
  readonly renderScalePercent: number;
  readonly wmoOcclusion: boolean;
  readonly characterAtlasAnisotropy: boolean;
  readonly experimentalAerialHeightFog: boolean;
  readonly experimentalTerrainMicroNormals: boolean;
  readonly experimentalWaterFresnel: boolean;
  readonly experimentalWaterMicroWaves: boolean;
  readonly experimentalWaterSunSparkle: boolean;
  readonly experimentalFantasyGlow: boolean;
  readonly grassRadius: number;
  readonly grassDense: boolean;
}

interface RendererMutationInterception {
  readonly restore: () => void;
}

interface RendererMutationAuthorization {
  readonly name: RendererMutatorName;
  claimed: boolean;
}

interface LiveHostBindings {
  readonly captureTelemetry: (capturedAt: number) => Readonly<RenderTelemetrySnapshot>;
  readonly captureClientReadiness: () => Readonly<BenchmarkClientReadinessInput> | undefined;
  readonly captureUserGraphics: () => Readonly<UserGraphicsSettings>;
  readonly unitModel: (object: WorldObjectState) => UnitModel | undefined;
  readonly mountModel: (object: WorldObjectState) => UnitModel | undefined;
  readonly selectionRingColour: (
    object: WorldObjectState | undefined,
    self: WorldObjectState | undefined,
  ) => number;
}

export interface LiveFormalRenderBenchmarkHostOptions {
  readonly context?: GameContext;
  readonly now?: () => number;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly scheduleWake?: (callback: () => void, delayMs: number) => number;
  readonly cancelWake?: (handle: number) => void;
  readonly prewarmChunkFrames?: number;
  readonly prewarmTimeoutMs?: number;
  readonly gpuDrainTimeoutMs?: number;
  readonly waitTimeoutMs?: number;
  /** Test seam. Live construction resolves omitted bindings from the existing loop/UI owners. */
  readonly bindings?: Partial<LiveHostBindings>;
}

type CaptureEnvironment = (
  configuration: Readonly<LiveFormalRenderGraphicsConfiguration>,
) => unknown;

interface ActiveResources {
  readonly renderer: WorldRenderer3D;
  readonly terrain: NonNullable<GameContext["terrain"]>;
  readonly terrainSplat: NonNullable<GameContext["terrainSplat"]>;
  readonly groundCover: NonNullable<GameContext["groundCover"]>;
  readonly light: NonNullable<GameContext["light"]>;
  readonly liquids: NonNullable<GameContext["liquids"]>;
  readonly environment: NonNullable<GameContext["environment"]>;
  readonly assetWarmup: NonNullable<GameContext["assetWarmup"]>;
  readonly creatureModels: NonNullable<GameContext["creatureModels"]>;
  readonly creatureMetadata: NonNullable<GameContext["creatureMetadata"]>;
  readonly itemMetadata: NonNullable<GameContext["itemMetadata"]>;
  readonly factions: NonNullable<GameContext["factions"]>;
  readonly gameObjectMetadata: NonNullable<GameContext["gameObjectMetadata"]>;
  readonly transportPaths: NonNullable<GameContext["transportPaths"]>;
  readonly horizon: NonNullable<GameContext["horizon"]>;
  readonly collision: NonNullable<GameContext["collision"]>;
}

interface GpuCollection {
  readonly samples: number[];
  reason: BenchmarkGpuUnavailableReason | undefined;
  observerDropped: number;
  attempted: number;
  collecting: boolean;
}

interface PreparedFrame {
  readonly observation: Readonly<WorldReplayObservation>;
  readonly receipt: Readonly<WorldSubmissionReceipt> | undefined;
}

function requirePositiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
  return value;
}

function requirePositiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function requireGeneration(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} generation must be a non-negative safe integer`);
  }
  return value;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneJson(value: BenchmarkJsonValue): BenchmarkJsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJson));
  const copy: Record<string, BenchmarkJsonValue> = {};
  for (const [key, child] of Object.entries(value)) copy[key] = cloneJson(child);
  return Object.freeze(copy);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;
}

function cloneStateVisuals(
  source: ReadonlyMap<bigint, readonly StateVisual[]>,
): ReadonlyMap<bigint, readonly StateVisual[]> {
  const copy = new Map<bigint, readonly StateVisual[]>();
  for (const [guid, effects] of source) {
    copy.set(guid, Object.freeze(effects.map((effect) => Object.freeze({ ...effect }))));
  }
  return copy;
}

function clonePortraitTargets(
  source: ReadonlyMap<PortraitSlot, Readonly<PortraitTarget>>,
): ReadonlyMap<PortraitSlot, Readonly<PortraitTarget>> {
  const copy = new Map<PortraitSlot, Readonly<PortraitTarget>>();
  for (const [slot, target] of source) copy.set(slot, Object.freeze({ ...target }));
  return copy;
}

function sameSurfaceStamp(
  left: Readonly<FormalRenderSurfaceStamp>,
  right: Readonly<FormalRenderSurfaceStamp>,
): boolean {
  return left.cssWidth === right.cssWidth
    && left.cssHeight === right.cssHeight
    && left.backingWidth === right.backingWidth
    && left.backingHeight === right.backingHeight
    && Object.is(left.systemDpr, right.systemDpr)
    && Object.is(left.effectivePixelRatio, right.effectivePixelRatio)
    && left.contextLost === right.contextLost
    && left.contextGeneration === right.contextGeneration;
}

function cloneConfiguration(
  configuration: Readonly<BenchmarkVariantConfiguration>,
): Readonly<LiveFormalRenderGraphicsConfiguration> {
  if (!Number.isFinite(configuration.lighting)) throw new TypeError("benchmark lighting must be finite");
  return Object.freeze({
    lighting: configuration.lighting,
    settings: cloneJson(configuration.settings) as BenchmarkJsonObject,
  });
}

function numberSetting(configuration: Readonly<LiveFormalRenderGraphicsConfiguration>, key: string): number {
  const value = configuration.settings[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`formal configuration settings.${key} must be finite number`);
  }
  return value;
}

function booleanSetting(configuration: Readonly<LiveFormalRenderGraphicsConfiguration>, key: string): boolean {
  const value = configuration.settings[key];
  if (typeof value !== "boolean") throw new TypeError(`formal configuration settings.${key} must be boolean`);
  return value;
}

function optionalBooleanSetting(
  configuration: Readonly<LiveFormalRenderGraphicsConfiguration>,
  key: string,
): boolean {
  const value = configuration.settings[key];
  return value === undefined ? false : booleanSetting(configuration, key);
}

function profileFromConfiguration(
  configuration: Readonly<LiveFormalRenderGraphicsConfiguration>,
): Readonly<ExperimentalShaderProfile> {
  return Object.freeze({
    aerialHeightFog: optionalBooleanSetting(configuration, "experimentalAerialHeightFog"),
    terrainMicroNormals: optionalBooleanSetting(configuration, "experimentalTerrainMicroNormals"),
    waterFresnel: optionalBooleanSetting(configuration, "experimentalWaterFresnel"),
    waterMicroWaves: optionalBooleanSetting(configuration, "experimentalWaterMicroWaves"),
    waterSunSparkle: optionalBooleanSetting(configuration, "experimentalWaterSunSparkle"),
    fantasyGlow: optionalBooleanSetting(configuration, "experimentalFantasyGlow"),
  });
}

function profileFromUserGraphics(
  graphics: Readonly<Partial<UserGraphicsSettings>>,
): Readonly<ExperimentalShaderProfile> {
  return Object.freeze({
    aerialHeightFog: graphics.experimentalAerialHeightFog === true,
    terrainMicroNormals: graphics.experimentalTerrainMicroNormals === true,
    waterFresnel: graphics.experimentalWaterFresnel === true,
    waterMicroWaves: graphics.experimentalWaterMicroWaves === true,
    waterSunSparkle: graphics.experimentalWaterSunSparkle === true,
    fantasyGlow: graphics.experimentalFantasyGlow === true,
  });
}

function normalizeUserGraphics(
  graphics: Readonly<UserGraphicsSettings>,
): Readonly<UserGraphicsSettings> {
  const profile = profileFromUserGraphics(graphics);
  return Object.freeze({
    lightingQuality: graphics.lightingQuality,
    renderScalePercent: graphics.renderScalePercent,
    wmoOcclusion: graphics.wmoOcclusion,
    characterAtlasAnisotropy: graphics.characterAtlasAnisotropy,
    experimentalAerialHeightFog: profile.aerialHeightFog,
    experimentalTerrainMicroNormals: profile.terrainMicroNormals,
    experimentalWaterFresnel: profile.waterFresnel,
    experimentalWaterMicroWaves: profile.waterMicroWaves,
    experimentalWaterSunSparkle: profile.waterSunSparkle,
    experimentalFantasyGlow: profile.fantasyGlow,
    grassRadius: graphics.grassRadius,
    grassDense: graphics.grassDense,
  });
}

function profileFromRendererReadback(value: unknown): Readonly<ExperimentalShaderProfile> {
  if (value === undefined) {
    return Object.freeze({
      aerialHeightFog: false, terrainMicroNormals: false,
      waterFresnel: false, waterMicroWaves: false, waterSunSparkle: false,
      fantasyGlow: false,
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("renderer experimental shader profile readback must be an object");
  }
  const profile = value as Record<string, unknown>;
  const read = (key: keyof ExperimentalShaderProfile): boolean => {
    if (profile[key] === undefined) return false;
    if (typeof profile[key] !== "boolean") {
      throw new TypeError(`renderer experimental shader profile ${key} readback must be boolean`);
    }
    return profile[key] as boolean;
  };
  return Object.freeze({
    aerialHeightFog: read("aerialHeightFog"),
    terrainMicroNormals: read("terrainMicroNormals"),
    waterFresnel: read("waterFresnel"),
    waterMicroWaves: read("waterMicroWaves"),
    waterSunSparkle: read("waterSunSparkle"),
    fantasyGlow: read("fantasyGlow"),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

/** Residency-only resource evidence: frame admission/draw counters are intentionally excluded. */
export function formalBenchmarkResourceCheckpoint(
  telemetry: Pick<RenderTelemetrySnapshot, "renderer" | "resources">,
): Readonly<BenchmarkResourceCheckpointInput> {
  const raw = benchmarkResourceCheckpoint(telemetry);
  const counters: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.counters ?? {})) {
    if (!VOLATILE_RENDERER_COUNTERS.has(key)) counters[key] = value;
  }
  return deepFreeze({ counters, bytes: { ...(raw.bytes ?? {}) } });
}

/** Every async client generation plus the renderer-owned character-atlas generation. */
export function formalBenchmarkActivityStamp(
  clients: Readonly<BenchmarkClientReadinessInput>,
  rendererGenerations: Readonly<{
    characterAtlasGeneration: number;
    modelTexturesGeneration: number;
    worldTexturesGeneration: number;
  }>,
): string {
  return canonicalJson({
    renderer: {
      characterAtlas: requireGeneration("character atlas", rendererGenerations.characterAtlasGeneration),
      modelTextures: requireGeneration("model textures", rendererGenerations.modelTexturesGeneration),
      worldTextures: requireGeneration("world textures", rendererGenerations.worldTexturesGeneration),
    },
    clients: {
      collision: requireGeneration("collision", clients.collision.generation),
      creatureMetadata: requireGeneration("creature metadata", clients.creatureMetadata.generation),
      creatureModels: requireGeneration("creature models", clients.creatureModels.generation),
      gameObjectMetadata: requireGeneration("game object metadata", clients.gameObjectMetadata.generation),
      groundCover: requireGeneration("ground cover", clients.groundCover.generation),
      horizon: requireGeneration("horizon", clients.horizon.generation),
      itemMetadata: requireGeneration("item metadata", clients.itemMetadata.generation),
      light: requireGeneration("light", clients.light.generation),
      liquids: requireGeneration("liquids", clients.liquids.generation),
      transportPaths: requireGeneration("transport paths", clients.transportPaths.generation),
    },
  });
}

/** Runtime provenance guard used by the formal runner before it trusts live renderer evidence. */
export function isLiveFormalRenderBenchmarkHost(value: unknown): value is LiveFormalRenderBenchmarkHost {
  return value !== null && typeof value === "object" && LIVE_FORMAL_RENDER_BENCHMARK_HOSTS.has(value);
}

/** The only constructor path which mints live formal provenance; injected seam instances stay untrusted. */
export function createLiveFormalRenderBenchmarkHost(
  captureEnvironment: CaptureEnvironment,
): LiveFormalRenderBenchmarkHost {
  const host = new LiveFormalRenderBenchmarkHost(captureEnvironment);
  LIVE_FORMAL_RENDER_BENCHMARK_HOSTS.add(host);
  return host;
}

function gpuUnavailableReason(reason: GpuTimerUnavailableReason): BenchmarkGpuUnavailableReason {
  return reason;
}

function gpuDropReason(reason: GpuTimerDropReason): BenchmarkGpuUnavailableReason {
  if (reason === "queue-full") return "queue-drop";
  if (reason === "epoch-reset") return "pending-at-finish";
  return "query-discard";
}

function exactFrame(
  actual: Readonly<WorldReplayCameraFrameV1>,
  expected: Readonly<WorldReplayCameraFrameV1>,
): boolean {
  return actual.frameIndex === expected.frameIndex
    && actual.yaw === expected.yaw
    && actual.pitch === expected.pitch
    && actual.distance === expected.distance
    && actual.view === expected.view
    && actual.viewPitch === expected.viewPitch
    && actual.zoom === expected.zoom
    && actual.wallView === expected.wallView
    && actual.terrainView === expected.terrainView
    && actual.pivotHeight === expected.pivotHeight
    && actual.eyeHeight === expected.eyeHeight;
}

function validateEpochIdentity(value: unknown): asserts value is Readonly<FormalBenchmarkEpochIdentity> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.isFrozen(value)) {
    throw new TypeError("formal benchmark epoch identity must be a frozen object");
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  if (keys.length !== 2 || keys[0] !== "epochNonce" || keys[1] !== "suiteNonce") {
    throw new TypeError("formal benchmark epoch identity must contain exactly suiteNonce and epochNonce");
  }
  for (const key of keys) {
    if (typeof source[key] !== "string" || source[key].trim().length === 0) {
      throw new TypeError(`formal benchmark ${key} must be a non-empty string`);
    }
  }
}

/** Live adapter from the formal runner contract to the one renderer and its fixed replay world. */
export class LiveFormalRenderBenchmarkHost implements FormalRenderBenchmarkHost {
  readonly #captureEnvironment: CaptureEnvironment;
  readonly #context: GameContext;
  readonly #now: () => number;
  readonly #requestFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelFrame: (handle: number) => void;
  readonly #scheduleWake: (callback: () => void, delayMs: number) => number;
  readonly #cancelWake: (handle: number) => void;
  readonly #prewarmChunkFrames: number;
  readonly #prewarmTimeoutMs: number;
  readonly #gpuDrainTimeoutMs: number;
  readonly #waitTimeoutMs: number;
  readonly #bindingOverrides: Partial<LiveHostBindings>;
  readonly #gpuObserver: Readonly<GpuTimerObserver>;

  #coordinatorLease: Readonly<CoordinatorLease> | undefined;
  #publicLease: Readonly<FormalBenchmarkExclusiveLease> | undefined;
  #gpuObserverLease: Readonly<RenderBenchmarkGpuObserverLease> | undefined;
  #bindings: Readonly<LiveHostBindings> | undefined;
  #resources: Readonly<ActiveResources> | undefined;
  #userGraphics: Readonly<UserGraphicsSettings> | undefined;
  #observedGraphics: Readonly<UserGraphicsSettings> | undefined;
  #observedGroundCover: GameContext["groundCover"];
  #rendererMutationInterception: Readonly<RendererMutationInterception> | undefined;
  #rendererMutationAuthorization: RendererMutationAuthorization | undefined;
  #externalRendererMutation: RendererMutatorName | undefined;
  #externalUserGraphics: Readonly<UserGraphicsSettings> | undefined;
  #suppressedVisualHandleId = -1;
  #deferredClearSpellVisuals = false;
  #deferredStateVisuals: ReadonlyMap<bigint, readonly StateVisual[]> | undefined;
  #deferredClearPortraits = false;
  #deferredPortraitTargets: ReadonlyMap<PortraitSlot, Readonly<PortraitTarget>> | undefined;
  #rendererIsolationActive = false;
  #leaseContextGeneration: number | undefined;
  #expectedSurfaceStamp: Readonly<FormalRenderSurfaceStamp> | undefined;
  #configuration: Readonly<LiveFormalRenderGraphicsConfiguration> | undefined;
  #variant: BenchmarkVariant | undefined;
  #suiteNonce: string | undefined;
  #epoch: Readonly<FormalBenchmarkEpochIdentity> | undefined;
  readonly #usedEpochNonces = new Set<string>();
  #snapshot: Readonly<WorldReplaySnapshotV1> | undefined;
  #snapshotCanonical: string | undefined;
  #replay: HydratedWorldReplaySnapshot | undefined;
  #readiness = new RenderBenchmarkReadinessTracker();
  #lastObservation: Readonly<WorldReplayObservation> | undefined;
  #lastBarrierAt: number | undefined;
  #replayEpochActive = false;
  #measurementEndCaptured = false;
  #gpu: GpuCollection | undefined;

  constructor(captureEnvironment: CaptureEnvironment, options: LiveFormalRenderBenchmarkHostOptions = {}) {
    if (typeof captureEnvironment !== "function") throw new TypeError("captureEnvironment must be a function");
    this.#captureEnvironment = captureEnvironment;
    this.#context = options.context ?? game;
    this.#now = options.now ?? (() => performance.now());
    this.#requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.#cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.#scheduleWake = options.scheduleWake
      ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number);
    this.#cancelWake = options.cancelWake
      ?? ((handle) => globalThis.clearTimeout(handle));
    this.#prewarmChunkFrames = requirePositiveSafeInteger(
      "prewarmChunkFrames", options.prewarmChunkFrames ?? DEFAULT_PREWARM_CHUNK_FRAMES,
    );
    this.#prewarmTimeoutMs = requirePositiveFinite(
      "prewarmTimeoutMs", options.prewarmTimeoutMs ?? DEFAULT_PREWARM_TIMEOUT_MS,
    );
    this.#gpuDrainTimeoutMs = requirePositiveFinite(
      "gpuDrainTimeoutMs", options.gpuDrainTimeoutMs ?? DEFAULT_GPU_DRAIN_TIMEOUT_MS,
    );
    this.#waitTimeoutMs = requirePositiveFinite(
      "waitTimeoutMs", options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    );
    this.#bindingOverrides = options.bindings ?? {};
    this.#gpuObserver = Object.freeze({
      onSample: (milliseconds: number): void => {
        const gpu = this.#gpu;
        if (!gpu?.collecting) return;
        if (!Number.isFinite(milliseconds) || milliseconds < 0) {
          gpu.reason ??= "query-error";
          return;
        }
        gpu.samples.push(milliseconds);
        if (gpu.samples.length > REQUIRED_GPU_SAMPLES) gpu.reason ??= "sample-cap";
      },
      onUnavailable: (reason: GpuTimerUnavailableReason): void => {
        const gpu = this.#gpu;
        if (gpu?.collecting) gpu.reason ??= gpuUnavailableReason(reason);
      },
      onDropped: (count: number, reason: GpuTimerDropReason): void => {
        const gpu = this.#gpu;
        if (!gpu?.collecting || count <= 0) return;
        gpu.observerDropped += count;
        gpu.reason ??= gpuDropReason(reason);
      },
    });
  }

  async acquireExclusiveLease(signal?: AbortSignal): Promise<FormalBenchmarkExclusiveLease> {
    throwIfAborted(signal);
    if (this.#publicLease !== undefined) throw new Error("this formal benchmark host already owns a lease");
    if (renderBenchmarkRuntime.active) {
      throw new Error("cannot acquire formal renderer while a live diagnostic benchmark is active");
    }

    const coordinator = acquireFormalRenderBenchmarkExclusiveLease();
    this.#coordinatorLease = coordinator;
    let acquired = false;
    try {
      const resources = this.#captureActiveResources();
      this.#resources = resources;
      this.#observedGroundCover = resources.groundCover;
      // Own every public imperative ingress before module resolution yields. The ordinary RAF is
      // already gated by the coordinator, but event handlers and disconnect cleanup can still call
      // the renderer synchronously while the dynamic imports below are pending.
      this.#rendererMutationInterception = this.#interceptRendererMutators(resources.renderer);
      this.#withRendererMutationAuthorization("beginFormalBenchmarkIsolation", () => {
        resources.renderer.beginFormalBenchmarkIsolation();
      });
      this.#rendererIsolationActive = true;
      const surface = this.#readSurfaceStamp();
      if (surface.contextLost) throw new Error("formal renderer WebGL context is lost");
      this.#leaseContextGeneration = surface.contextGeneration;
      this.#withRendererMutationAuthorization("resetRenderEvolutionClock", () => {
        resources.renderer.resetRenderEvolutionClock();
      });
      this.#withRendererMutationAuthorization("resetFrameCadence", () => {
        resources.renderer.resetFrameCadence();
      });
      this.#withRendererMutationAuthorization("resetGpuTimingEpoch", () => {
        resources.renderer.resetGpuTimingEpoch();
      });
      this.#gpuObserverLease = acquireRenderBenchmarkFormalGpuObserver(this.#gpuObserver);
      this.#bindings = await this.#resolveBindings();
      this.#assertExclusiveIntegrity();
      this.#userGraphics = normalizeUserGraphics(this.#bindings.captureUserGraphics());
      this.#observedGraphics = Object.freeze({ ...this.#userGraphics });
      throwIfAborted(signal);

      let released = false;
      const lease = Object.freeze({
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          await this.#release(coordinator);
        },
      });
      this.#publicLease = lease;
      acquired = true;
      return lease;
    } finally {
      if (!acquired) await this.#release(coordinator);
    }
  }

  applyVariant(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    variant: BenchmarkVariant,
    configurationInput: Readonly<BenchmarkVariantConfiguration>,
    signal?: AbortSignal,
  ): void {
    this.#assertLease(lease);
    throwIfAborted(signal);
    // Validate identity before touching either the renderer or the host's committed epoch. A
    // rejected/reused runner token is a caller error, not a partially applied variant.
    this.#validateEpochForBegin(epoch);
    if (this.#replayEpochActive) throw new Error("cannot apply a variant during a replay epoch");
    const resources = this.#requireResources();
    const configuration = cloneConfiguration(configurationInput);
    const renderScale = numberSetting(configuration, "renderScale");
    const wmoOcclusion = booleanSetting(configuration, "wmoOcclusion");
    const atlasAnisotropy = booleanSetting(configuration, "characterAtlasAnisotropy");
    const grassRadius = numberSetting(configuration, "grassRadius");
    const grassDense = booleanSetting(configuration, "grassDense");
    const experimentalShaderProfile = profileFromConfiguration(configuration);
    if (configuration.lighting !== 1) throw new Error("formal renderer lighting must equal 1");
    if (renderScale !== 100) throw new Error("formal renderer renderScale must equal 100");

    const setExperimentalShaderProfile = (resources.renderer as unknown as {
      setExperimentalShaderProfile?: (profile: Readonly<ExperimentalShaderProfile>) => void;
    }).setExperimentalShaderProfile;
    const experimentalEnabled = Object.values(experimentalShaderProfile).some((enabled) => enabled);
    if (typeof setExperimentalShaderProfile !== "function") {
      if (experimentalEnabled) throw new Error("formal renderer experimental shader profile setter is unavailable");
    }
    // Commit only after all pure configuration checks above have passed. Once committed, any
    // renderer setter/readback failure must leave no stale epoch or replay state behind, while the
    // lease itself remains owned by the caller for a fresh epoch.
    this.#beginEpoch(epoch);
    try {
      this.#expectedSurfaceStamp = undefined;
      this.#withRendererMutationAuthorization("setLightingQuality", () => {
        resources.renderer.setLightingQuality(configuration.lighting);
      });
      this.#withRendererMutationAuthorization("setRenderScale", () => {
        resources.renderer.setRenderScale(renderScale / 100);
      });
      this.#withRendererMutationAuthorization("setWmoOcclusion", () => {
        resources.renderer.setWmoOcclusion(wmoOcclusion);
      });
      this.#withRendererMutationAuthorization("setCharacterAtlasAnisotropy", () => {
        resources.renderer.setCharacterAtlasAnisotropy(atlasAnisotropy);
      });
      if (typeof setExperimentalShaderProfile === "function") {
        this.#withRendererMutationAuthorization("setExperimentalShaderProfile", () => {
          setExperimentalShaderProfile.call(resources.renderer, experimentalShaderProfile);
        });
      }
      this.#withRendererMutationAuthorization("setGroundCover", () => {
        resources.renderer.setGroundCover(resources.groundCover, grassRadius, grassDense);
      });
      this.#withRendererMutationAuthorization("setSelection", () => {
        resources.renderer.setSelection(undefined, undefined);
      });
      this.#configuration = configuration;
      this.#variant = variant;
      this.#snapshot = undefined;
      this.#snapshotCanonical = undefined;
      this.#replay = undefined;
      this.#lastObservation = undefined;
      this.#measurementEndCaptured = false;
      this.#gpu = undefined;
      this.#readiness.reset();
      this.#assertAppliedConfiguration();
    } catch (error) {
      this.#clearUnfinishedVariantEpoch();
      throw error;
    }
  }

  async prewarm(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    snapshotInput: Readonly<WorldReplaySnapshotV1>,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#assertLease(lease);
    this.#assertEpoch(epoch);
    throwIfAborted(signal);
    this.#requireConfiguration();
    const resources = this.#requireResources();
    if (resources.renderer.replayEpochActive || this.#replayEpochActive) {
      throw new Error("prewarm cannot run inside a deterministic replay epoch");
    }
    const snapshot = cloneWorldReplaySnapshot(snapshotInput);
    const replay = hydrateWorldReplaySnapshot(snapshot);
    this.#snapshot = snapshot;
    this.#snapshotCanonical = canonicalJson(snapshot);
    this.#replay = replay;
    this.#readiness.reset();
    const deadline = this.#now() + this.#prewarmTimeoutMs;

    if (resources.renderer.benchmarkReadiness.persistentStateVisuals > 0) {
      throw new Error("formal prewarm terminal readiness blocker(s): persistent-state-visuals-active");
    }

    for (let start = 0; start < replay.frames.length; start += this.#prewarmChunkFrames) {
      const end = Math.min(replay.frames.length, start + this.#prewarmChunkFrames);
      for (let index = start; index < end; index++) {
        throwIfAborted(signal);
        if (this.#now() >= deadline) throw new Error("formal benchmark prewarm timed out while traversing camera path");
        const prepared = this.#prepareFrame(replay.frames[index]!, undefined, true);
        if (prepared.receipt?.submitted !== true) {
          throw new Error(`formal benchmark prewarm frame ${index} did not submit the fixed world`);
        }
      }
      if (end < replay.frames.length) {
        await this.#nextFrame(
          deadline,
          "formal benchmark prewarm timed out while traversing camera path",
          signal,
        );
      }
    }

    let retryFrameIndex = 0;
    await this.#waitForReady(deadline, signal, "prewarm", () => {
      // A number of live loaders only re-arm a finite-backoff request when the scene asks for the
      // resource again. Keep walking the fixed path while the readiness window is open; merely
      // waiting for RAF would leave those loaders permanently pending after the first traversal.
      // This deliberately stays outside beginRenderFrame/endRenderFrame, so prewarm cannot open a
      // GPU timer query or contaminate the measured sample stream.
      for (let offset = 0; offset < this.#prewarmChunkFrames; offset++) {
        throwIfAborted(signal);
        if (this.#now() >= deadline) {
          throw new Error("formal benchmark prewarm timed out while retrying camera path resources");
        }
        const frameIndex = retryFrameIndex % replay.frames.length;
        retryFrameIndex++;
        const prepared = this.#prepareFrame(replay.frames[frameIndex]!, undefined, true);
        if (prepared.receipt?.submitted !== true) {
          throw new Error(`formal benchmark prewarm retry frame ${frameIndex} did not submit the fixed world`);
        }
      }
    });
  }

  async captureBarrier(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    phase: "start" | "measurement-end" | "post-gpu-drain",
    signal?: AbortSignal,
  ): Promise<Readonly<FormalBenchmarkBarrier>> {
    this.#assertLease(lease);
    this.#assertEpoch(epoch);
    throwIfAborted(signal);
    this.#requireReplay();
    this.#requireConfiguration();
    if (phase === "start" && !this.#replayEpochActive) throw new Error("start barrier requires a replay epoch");
    if (phase === "measurement-end" && !this.#replayEpochActive) {
      throw new Error("measurement-end barrier requires a replay epoch");
    }
    if (phase === "post-gpu-drain" && !this.#measurementEndCaptured) {
      throw new Error("post-GPU-drain barrier requires a measurement endpoint");
    }

    if (phase === "start") {
      this.#expectedSurfaceStamp = this.#assertSurfaceContextEpoch();
    } else {
      this.#assertExpectedSurfaceStamp();
    }

    const evidenceDeadline = this.#now() + this.#waitTimeoutMs;
    let evidence = await this.#captureEvidence(evidenceDeadline, "formal barrier timed out", signal);
    if (phase === "start" && !evidence.readiness.ready) {
      throw new Error(`formal start barrier is not ready: ${evidence.readiness.blockingReasons.join(", ")}`);
    }
    if (phase === "post-gpu-drain" && !evidence.readiness.ready) {
      const readinessDeadline = this.#now() + this.#prewarmTimeoutMs;
      evidence = await this.#waitForReady(readinessDeadline, signal, "post-GPU-drain");
    }
    if (phase === "measurement-end") this.#measurementEndCaptured = true;
    this.#assertExpectedSurfaceStamp();
    return evidence;
  }

  resetReplayEpoch(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    snapshotInput: Readonly<WorldReplaySnapshotV1>,
    signal?: AbortSignal,
  ): void {
    this.#assertLease(lease);
    this.#assertEpoch(epoch);
    throwIfAborted(signal);
    const resources = this.#requireResources();
    const replay = this.#requireReplay();
    const snapshot = cloneWorldReplaySnapshot(snapshotInput);
    if (canonicalJson(snapshot) !== this.#snapshotCanonical) {
      throw new Error("replay reset snapshot differs from the prewarmed fixed snapshot");
    }
    if (resources.renderer.replayEpochActive || this.#replayEpochActive) {
      throw new Error("replay epoch is already active");
    }

    this.#gpu = undefined;
    this.#withRendererMutationAuthorization("resetReplayEpoch", () => {
      resources.renderer.resetReplayEpoch(replay.rngSeed);
    });
    this.#replayEpochActive = true;
    this.#gpu = { samples: [], reason: undefined, observerDropped: 0, attempted: 0, collecting: true };
    const initialReason = this.#withRendererMutationAuthorization(
      "resetGpuTimingEpoch", () => resources.renderer.resetGpuTimingEpoch(),
    );
    if (initialReason !== undefined) this.#gpu.reason ??= gpuUnavailableReason(initialReason);
    this.#measurementEndCaptured = false;
    this.#prepareFrame(replay.frames[0]!, undefined, false);
  }

  endReplayEpoch(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
  ): void {
    this.#assertLease(lease);
    this.#assertEpoch(epoch);
    const renderer = this.#requireResources().renderer;
    // Also closes a renderer epoch established before resetReplayEpoch itself threw. The runner
    // deliberately invokes this boundary after any attempted reset, not only a completed one.
    if (renderer.replayEpochActive) {
      this.#withRendererMutationAuthorization("endReplayEpoch", () => renderer.endReplayEpoch());
    }
    this.#replayEpochActive = false;
    this.#withRendererMutationAuthorization("resetRenderEvolutionClock", () => {
      renderer.resetRenderEvolutionClock();
    });
    this.#epoch = undefined;
  }

  async waitUntil(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    dueAtWallMs: number,
    signal?: AbortSignal,
  ): Promise<number> {
    this.#assertLease(lease);
    this.#assertEpoch(epoch);
    if (!Number.isFinite(dueAtWallMs)) throw new RangeError("formal frame due time must be finite");
    this.#assertAppliedConfiguration();
    if (this.#expectedSurfaceStamp) this.#assertExpectedSurfaceStamp();
    const startedAt = this.#now();
    let current = startedAt;
    while (current < dueAtWallMs) {
      throwIfAborted(signal);
      const remainingBudget = this.#waitTimeoutMs - (current - startedAt);
      if (!(remainingBudget > 0)) throw new Error("formal frame wait timed out");
      await this.#nextWake(Math.min(dueAtWallMs - current, remainingBudget), signal);
      current = this.#now();
      this.#assertAppliedConfiguration();
      if (this.#expectedSurfaceStamp) this.#assertExpectedSurfaceStamp();
    }
    return current;
  }

  renderFrame(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    ticket: Readonly<{ frameIndex: number; nowMs: number; elapsedSeconds: number }>,
    frame: Readonly<WorldReplayCameraFrameV1>,
    signal?: AbortSignal,
  ): Readonly<FormalBenchmarkSubmissionReceipt> {
    this.#assertLease(lease);
    this.#assertEpoch(epoch);
    throwIfAborted(signal);
    const resources = this.#requireResources();
    const replay = this.#requireReplay();
    if (!this.#replayEpochActive || !resources.renderer.replayEpochActive) {
      throw new Error("formal frame requires an active replay epoch");
    }
    const expected = this.#snapshot?.frames[ticket.frameIndex];
    if (!expected || ticket.frameIndex !== frame.frameIndex || !exactFrame(frame, expected)) {
      throw new Error("formal frame does not match its fixed camera ticket");
    }
    const hydratedFrame = replay.frames[ticket.frameIndex];
    if (!hydratedFrame) throw new RangeError("formal frame ticket is outside the fixed replay");
    this.#assertExpectedSurfaceStamp();

    const fullStartedAt = this.#now();
    let rendererFrameCpuMs: number | undefined;
    const gpu = this.#gpu;
    if (!gpu?.collecting) throw new Error("GPU measurement attribution is not active");
    if (gpu.attempted >= REQUIRED_GPU_SAMPLES) throw new RangeError("formal GPU attempt count exceeded frame budget");
    const receipt = this.#prepareFrame(hydratedFrame, ticket, true, (submitWorld) => {
      // Match the live loop exactly: collision/light/selection preparation belongs to full-frame
      // CPU, while the renderer/GPU envelope contains only the actual world submission.
      gpu.attempted++;
      this.#withRendererMutationAuthorization("beginRenderFrame", () => resources.renderer.beginRenderFrame());
      try {
        return submitWorld();
      } finally {
        rendererFrameCpuMs = this.#withRendererMutationAuthorization(
          "endRenderFrame", () => resources.renderer.endRenderFrame(),
        );
      }
    }).receipt;
    const completedAtWallMs = this.#now();
    this.#assertExpectedSurfaceStamp();
    const fullFrameCpuMs = completedAtWallMs - fullStartedAt;
    if (receipt?.submitted !== true) throw new Error("formal renderer did not return a world submission receipt");
    if (rendererFrameCpuMs === undefined) throw new Error("formal renderer did not close its frame timing envelope");
    if (!Number.isFinite(fullFrameCpuMs) || fullFrameCpuMs < 0) {
      throw new Error("formal full-frame CPU measurement is invalid");
    }
    return Object.freeze({
      suiteNonce: epoch.suiteNonce,
      epochNonce: epoch.epochNonce,
      submitted: receipt.submitted,
      frameIndex: ticket.frameIndex,
      submissionSerial: receipt.submissionSerial,
      fullFrameCpuMs,
      rendererFrameCpuMs,
      completedAtWallMs,
    });
  }

  async drainGpu(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    measurementEndedAt: number,
    signal?: AbortSignal,
  ): Promise<Readonly<FormalBenchmarkGpuDrain>> {
    this.#assertLease(lease);
    this.#assertEpoch(epoch);
    throwIfAborted(signal);
    if (!Number.isFinite(measurementEndedAt) || measurementEndedAt < 0) {
      throw new RangeError("GPU measurement endpoint must be non-negative and finite");
    }
    if (!this.#measurementEndCaptured) throw new Error("GPU drain requires a captured measurement endpoint");
    const gpu = this.#gpu;
    const resources = this.#requireResources();
    const bindings = this.#requireBindings();
    if (!gpu?.collecting) throw new Error("GPU measurement attribution is not active");
    const deadline = this.#now() + this.#gpuDrainTimeoutMs;

    for (;;) {
      throwIfAborted(signal);
      this.#assertExclusiveIntegrity();
      const capturedAt = this.#now();
      const telemetry = bindings.captureTelemetry(capturedAt);
      const pending = telemetry.renderer?.gpu.pending ?? resources.renderer.benchmarkReadiness.gpuQueriesPending;
      if (pending === 0) break;
      if (capturedAt >= deadline) {
        gpu.reason ??= "pending-at-finish";
        this.#withRendererMutationAuthorization("resetGpuTimingEpoch", () => {
          resources.renderer.resetGpuTimingEpoch();
        });
        break;
      }
      try {
        await this.#nextFrame(deadline, "formal GPU drain timed out", signal);
      } catch (error) {
        if (!(error instanceof FormalFrameDeadlineError)) throw error;
      }
    }
    gpu.collecting = false;

    const attempted = gpu.attempted;
    const samples = Object.freeze(gpu.samples.slice(0, attempted));
    const dropped = attempted - samples.length;
    if (dropped < 0 || attempted > REQUIRED_GPU_SAMPLES) {
      throw new Error("formal GPU coverage accounting is inconsistent");
    }
    const unavailable = (reason: BenchmarkGpuUnavailableReason): Readonly<FormalBenchmarkGpuDrain> =>
      Object.freeze({ status: "unavailable" as const, reason, samples, attempted, dropped });
    if (gpu.reason !== undefined) return unavailable(gpu.reason);
    if (gpu.observerDropped > 0) return unavailable("queue-drop");
    if (samples.length !== REQUIRED_GPU_SAMPLES || attempted !== REQUIRED_GPU_SAMPLES) {
      return unavailable(samples.length === 0 ? "not-provided" : "mixed-availability");
    }
    return Object.freeze({ status: "available", samples });
  }

  #captureActiveResources(): Readonly<ActiveResources> {
    const context = this.#context;
    const missing: string[] = [];
    for (const key of ACTIVE_RESOURCE_KEYS) {
      if (context[key] === undefined) missing.push(key);
    }
    if (missing.length > 0) throw new Error(`formal renderer dependencies are missing: ${missing.join(", ")}`);
    if (context.factions!.ready !== true) {
      throw new Error("formal renderer faction data is not ready");
    }
    return Object.freeze({
      renderer: context.renderer!,
      terrain: context.terrain!,
      terrainSplat: context.terrainSplat!,
      groundCover: context.groundCover!,
      light: context.light!,
      liquids: context.liquids!,
      environment: context.environment!,
      assetWarmup: context.assetWarmup!,
      creatureModels: context.creatureModels!,
      creatureMetadata: context.creatureMetadata!,
      itemMetadata: context.itemMetadata!,
      factions: context.factions!,
      gameObjectMetadata: context.gameObjectMetadata!,
      transportPaths: context.transportPaths!,
      horizon: context.horizon!,
      collision: context.collision!,
    });
  }

  async #resolveBindings(): Promise<Readonly<LiveHostBindings>> {
    const supplied = this.#bindingOverrides;
    const resources = this.#requireResources();
    const needLoop = supplied.captureTelemetry === undefined || supplied.captureClientReadiness === undefined;
    const needSettings = supplied.captureUserGraphics === undefined;
    const needModels = supplied.unitModel === undefined || supplied.mountModel === undefined;
    const needSelection = supplied.selectionRingColour === undefined;
    const [loop, settingsModule, settingsModel, frames, names] = await Promise.all([
      needLoop ? import("./game/Loop.js") : undefined,
      needSettings ? import("./ui/Settings.js") : undefined,
      needSettings ? import("./ui/SettingsModel.js") : undefined,
      needModels ? import("./ui/Frames.js") : undefined,
      needSelection ? import("./ui/NamePlates.js") : undefined,
    ]);
    const captureUserGraphics = supplied.captureUserGraphics ?? (() => {
      const values = settingsModule!.settings();
      return Object.freeze({
        lightingQuality: settingsModel!.settingNumber(values, "lightingQuality"),
        renderScalePercent: settingsModel!.settingNumber(values, "renderScale"),
        wmoOcclusion: settingsModel!.settingBoolean(values, "wmoOcclusion"),
        characterAtlasAnisotropy: settingsModel!.settingBoolean(values, "characterAtlasAnisotropy"),
        experimentalAerialHeightFog: settingsModel!.settingBoolean(values, "experimentalAerialHeightFog"),
        experimentalTerrainMicroNormals: settingsModel!.settingBoolean(values, "experimentalTerrainMicroNormals"),
        experimentalWaterFresnel: settingsModel!.settingBoolean(values, "experimentalWaterFresnel"),
        experimentalWaterMicroWaves: settingsModel!.settingBoolean(values, "experimentalWaterMicroWaves"),
        experimentalWaterSunSparkle: settingsModel!.settingBoolean(values, "experimentalWaterSunSparkle"),
        experimentalFantasyGlow: settingsModel!.settingBoolean(values, "experimentalFantasyGlow"),
        grassRadius: settingsModel!.settingNumber(values, "grassRadius"),
        grassDense: settingsModel!.settingBoolean(values, "grassDense"),
      });
    });
    return Object.freeze({
      captureTelemetry: supplied.captureTelemetry ?? loop!.captureRenderTelemetry,
      captureClientReadiness: supplied.captureClientReadiness ?? loop!.captureBenchmarkClientReadiness,
      captureUserGraphics,
      unitModel: supplied.unitModel
        ?? ((object: WorldObjectState) => frames!.unitModelFor(
          object, resources.creatureModels, resources.itemMetadata,
        )),
      mountModel: supplied.mountModel
        ?? ((object: WorldObjectState) => frames!.mountModelFor(object, resources.creatureModels)),
      selectionRingColour: supplied.selectionRingColour
        ?? ((object: WorldObjectState | undefined, self: WorldObjectState | undefined) =>
          names!.selectionRingColourFor(object, self, resources.factions)),
    });
  }

  #prepareFrame(
    frame: Readonly<HydratedWorldReplayCameraFrameV1>,
    frameTime: Readonly<{ frameIndex: number; nowMs: number; elapsedSeconds: number }> | undefined,
    submit: boolean,
    submissionEnvelope?: (
      submitWorld: () => Readonly<WorldSubmissionReceipt> | undefined,
    ) => Readonly<WorldSubmissionReceipt> | undefined,
  ): Readonly<PreparedFrame> {
    const snapshot = this.#snapshot;
    const replay = this.#requireReplay();
    const resources = this.#requireResources();
    const bindings = this.#requireBindings();
    this.#assertAppliedConfiguration();
    this.#assertSurfaceContextEpoch();
    if (frameTime !== undefined) this.#assertExpectedSurfaceStamp();
    if (!snapshot) throw new Error("formal replay snapshot is not owned");
    const player = replay.state.selfGuid === undefined ? undefined : replay.state.objects.get(replay.state.selfGuid);
    const position = player?.position;
    if (!player || !position) throw new Error("fixed replay self has no drawable position");

    // Formal replay bypasses the ordinary Loop.animate() wrapper, so own the same exact
    // resource-frame transaction here. This keeps terminal/deferred animation state tied to the
    // frame that requested it and guarantees that a failed preparation cannot leave the client in
    // an open frame.
    // The reset-only preparation samples frame zero to seed deterministic state but deliberately
    // does not draw it. Do not commit that empty demand set over the prewarm footprint; only a
    // preparation that owns an actual submission may replace the active pins.
    const resourceFrame = submit;
    if (resourceFrame) resources.environment.beginResourceFrame();
    try {
      resources.collision.refresh(replay.mapId, position.x, position.y);
      const heightAt = (x: number, y: number): number | undefined => resources.terrain.heightAt(replay.mapId, x, y);
      const environment: readonly EnvironmentObject[] = resources.environment.objectsAround(
        replay.mapId, position.x, position.y, ENVIRONMENT_RANGE,
      );
    resources.assetWarmup.tick({ player, environment, actionButtons: [] });
    this.#withRendererMutationAuthorization("setWeather", () => resources.renderer.setWeather(replay.weather));
    const indoors = resources.collision.world.indoorsAt(
      position.x, position.y, position.z + STEP_HEIGHT, position.z - FLOOR_SEARCH_DEPTH,
    );
    this.#withRendererMutationAuthorization("setIndoors", () => resources.renderer.setIndoors(indoors));
    const lightCamera = createCamera(
      position, frame.yaw, frame.viewPitch, frame.view, { pivotHeight: frame.pivotHeight },
    );
    const cameraWmoFloor = resources.collision.staticWmoFloorUnder(
      replay.mapId,
      lightCamera.position.x,
      lightCamera.position.y,
      lightCamera.position.z,
      lightCamera.position.z - FLOOR_SEARCH_DEPTH,
    );
    const terrainUnderwater = eyeUnderwater(
      lightCamera.position.z,
      resources.terrain.liquidAt(replay.mapId, lightCamera.position.x, lightCamera.position.y),
    );
    const collisionModel = cameraWmoFloor
      ? resources.collision.models.model(cameraWmoFloor.placement.modelName)
      : undefined;
    const wmoUnderwater = Boolean(cameraWmoFloor && collisionModel
      && eyeUnderCollisionModelLiquid(
        collisionModel.groups,
        cameraWmoFloor.groupIndex,
        cameraWmoFloor.placement,
        lightCamera.position,
      ));
    const underwater = terrainUnderwater || wmoUnderwater;
    const light = resources.light.sample(
      replay.mapId,
      position.x,
      position.y,
      replay.halfMinute,
      resources.renderer.weatherStorm,
      position.z,
      undefined,
      1,
      undefined,
      undefined,
      underwater,
    );
    this.#withRendererMutationAuthorization("updateLighting", () => {
      resources.renderer.updateLighting(light, replay.halfMinute, underwater);
    });
    const targetGuid = replay.targetGuid;
    const focusGuid = replay.focusGuid === targetGuid ? undefined : replay.focusGuid;
    this.#withRendererMutationAuthorization("setSelection", () => {
      resources.renderer.setSelection(
        targetGuid === undefined
          ? undefined
           : { guid: targetGuid, colour: bindings.selectionRingColour(replay.state.objects.get(targetGuid), player) },
        focusGuid === undefined
          ? undefined
           : { guid: focusGuid, colour: bindings.selectionRingColour(replay.state.objects.get(focusGuid), player) },
      );
    });
    const observation = deepFreeze({
      indoors,
      underwater,
      weather: { ...replay.weather },
    });
    validateWorldReplayObservation(snapshot, observation);
    this.#lastObservation = observation;

    const submitWorld = (): Readonly<WorldSubmissionReceipt> | undefined =>
      this.#withRendererMutationAuthorization("draw", () => resources.renderer.draw(
          replay.state,
          replay.mapId,
          heightAt,
          resources.terrain,
          environment,
          resources.environment,
          (displayId) => resources.gameObjectMetadata.get(displayId),
          frame.yaw,
          frame.viewPitch,
          frame.view,
          bindings.unitModel,
          resources.terrainSplat,
          resources.liquids,
          resources.transportPaths,
          resources.horizon,
          frame.distance,
          (displayId) => resources.creatureModels.get(displayId) !== undefined,
          frame.pivotHeight,
          bindings.mountModel,
          cameraWmoFloor,
          frameTime,
          resources.gameObjectMetadata.revision,
        ));
    const receipt = submit
      ? (submissionEnvelope === undefined ? submitWorld() : submissionEnvelope(submitWorld))
      : undefined;
    this.#assertSurfaceContextEpoch();
    if (frameTime !== undefined) this.#assertExpectedSurfaceStamp();
      return Object.freeze({ observation, receipt });
    } finally {
      if (resourceFrame) resources.environment.endResourceFrame();
    }
  }

  async #captureEvidence(
    deadline: number,
    timeoutMessage: string,
    signal?: AbortSignal,
  ): Promise<Readonly<FormalBenchmarkBarrier>> {
    throwIfAborted(signal);
    this.#assertAppliedConfiguration();
    const bindings = this.#requireBindings();
    const resources = this.#requireResources();
    const configuration = this.#requireConfiguration();
    const observation = this.#lastObservation;
    if (!observation) throw new Error("formal scene has not produced an observation");
    let capturedAt = this.#now();
    while (this.#lastBarrierAt !== undefined && capturedAt <= this.#lastBarrierAt) {
      capturedAt = await this.#nextFrame(deadline, timeoutMessage, signal);
    }
    this.#assertSurfaceContextEpoch();
    if (this.#expectedSurfaceStamp) this.#assertExpectedSurfaceStamp();
    const rawEnvironment = this.#captureEnvironment(configuration);
    if (isThenable(rawEnvironment)) {
      throw new TypeError("formal captureEnvironment must be synchronous");
    }
    const environment = cloneBenchmarkEnvironment(rawEnvironment);
    const telemetry = bindings.captureTelemetry(capturedAt);
    if (telemetry.capturedAt !== capturedAt) throw new Error("formal telemetry timestamp changed during capture");
    const clients = telemetry.benchmarkClients ?? bindings.captureClientReadiness();
    if (!clients) throw new Error("formal benchmark client readiness is unavailable");
    const rendererReadiness = resources.renderer.benchmarkReadiness;
    const readiness = this.#readiness.observe(telemetry, rendererReadiness, clients);
    // All evidence above is captured in one JavaScript turn. A callback is allowed to inspect the
    // live canvas and renderer, but never to yield and combine two different renderer states.
    this.#assertAppliedConfiguration();
    if (this.#expectedSurfaceStamp) this.#assertExpectedSurfaceStamp();
    const resourcesCheckpoint = formalBenchmarkResourceCheckpoint(telemetry);
    const activityStamp = formalBenchmarkActivityStamp(
      clients, {
        characterAtlasGeneration: rendererReadiness.characterAtlasGeneration,
        modelTexturesGeneration: rendererReadiness.modelTexturesGeneration,
        worldTexturesGeneration: rendererReadiness.worldTexturesGeneration,
      },
    );
    this.#lastBarrierAt = capturedAt;
    return deepFreeze({
      suiteNonce: this.#epoch!.suiteNonce,
      epochNonce: this.#epoch!.epochNonce,
      capturedAt,
      readiness,
      environment,
      observation: {
        indoors: observation.indoors,
        underwater: observation.underwater,
        weather: { ...observation.weather },
      },
      resourceSignature: readiness.resourceSignature,
      activityStamp,
      resources: resourcesCheckpoint,
    });
  }

  async #waitForReady(
    deadline: number,
    signal: AbortSignal | undefined,
    label: string,
    progress?: () => void,
  ): Promise<Readonly<FormalBenchmarkBarrier>> {
    for (;;) {
      throwIfAborted(signal);
      const evidence = await this.#captureEvidence(
        deadline,
        `formal ${label} readiness timed out waiting for a monotonic capture timestamp`,
        signal,
      );
      const terminal = evidence.readiness.blockingReasons.filter((reason) => TERMINAL_READINESS_BLOCKERS.has(reason));
      if (terminal.length > 0) {
        throw new Error(`formal ${label} terminal readiness blocker(s): ${terminal.join(", ")}`);
      }
      if (evidence.readiness.ready) return evidence;
      if (this.#now() >= deadline) {
        throw new Error(
          `formal ${label} readiness timed out: ${evidence.readiness.blockingReasons.join(", ") || "stable window incomplete"}`,
        );
      }
      await this.#nextFrame(
        deadline,
        `formal ${label} readiness timed out waiting for animation frame`,
        signal,
      );
      progress?.();
    }
  }

  #nextFrame(deadline: number, timeoutMessage: string, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal);
    if (!Number.isFinite(deadline)) throw new RangeError("formal animation frame deadline must be finite");
    if (this.#now() >= deadline) return Promise.reject(new FormalFrameDeadlineError(timeoutMessage));
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let frameHandle: number | undefined;
      let wakeHandle: number | undefined;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (frameHandle !== undefined) this.#cancelFrame(frameHandle);
        if (wakeHandle !== undefined) this.#cancelWake(wakeHandle);
        callback();
      };
      const onAbort = (): void => {
        finish(() => reject(abortError(signal!)));
      };
      const onFrame = (timestamp: number): void => {
        frameHandle = undefined;
        if (this.#now() >= deadline) {
          finish(() => reject(new FormalFrameDeadlineError(timeoutMessage)));
          return;
        }
        finish(() => resolve(timestamp));
      };
      const onWake = (): void => {
        wakeHandle = undefined;
        const remaining = deadline - this.#now();
        if (remaining > 0) {
          wakeHandle = this.#scheduleWake(onWake, remaining);
          return;
        }
        finish(() => reject(new FormalFrameDeadlineError(timeoutMessage)));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const requestedFrame = this.#requestFrame(onFrame);
        if (settled) {
          this.#cancelFrame(requestedFrame);
          return;
        }
        frameHandle = requestedFrame;
        const scheduledWake = this.#scheduleWake(onWake, Math.max(0, deadline - this.#now()));
        if (settled) {
          this.#cancelWake(scheduledWake);
          return;
        }
        wakeHandle = scheduledWake;
        if (signal?.aborted) onAbort();
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  #nextWake(delayMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("formal wake delay must be non-negative");
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let handle: number | undefined;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        if (handle !== undefined) this.#cancelWake(handle);
        finish(() => reject(abortError(signal!)));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      handle = this.#scheduleWake(() => finish(resolve), delayMs);
      if (signal?.aborted) onAbort();
    });
  }

  #restoreUserGraphics(): void {
    const renderer = this.#resources?.renderer;
    let user = this.#externalUserGraphics ?? this.#userGraphics;
    try {
      const captured = this.#bindings?.captureUserGraphics();
      if (captured) user = normalizeUserGraphics(captured);
    } catch {
      // A teardown can remove UI/settings owners before the lease finally unwinds. In that case the
      // last complete external setter snapshot is safer than reverting to the acquisition values.
    }
    if (!renderer || !user || this.#context.renderer !== renderer) return;
    let firstError: unknown;
    const attempt = (operation: () => void): void => {
      try { operation(); } catch (error) { firstError ??= error; }
    };
    attempt(() => this.#withRendererMutationAuthorization(
      "setLightingQuality", () => renderer.setLightingQuality(user.lightingQuality),
    ));
    attempt(() => this.#withRendererMutationAuthorization(
      "setRenderScale", () => renderer.setRenderScale(user.renderScalePercent / 100),
    ));
    attempt(() => this.#withRendererMutationAuthorization(
      "setWmoOcclusion", () => renderer.setWmoOcclusion(user.wmoOcclusion),
    ));
    attempt(() => this.#withRendererMutationAuthorization(
      "setCharacterAtlasAnisotropy", () => renderer.setCharacterAtlasAnisotropy(user.characterAtlasAnisotropy),
    ));
    const setExperimentalShaderProfile = (renderer as unknown as {
      setExperimentalShaderProfile?: (profile: Readonly<ExperimentalShaderProfile>) => void;
    }).setExperimentalShaderProfile;
    if (typeof setExperimentalShaderProfile === "function") {
      attempt(() => this.#withRendererMutationAuthorization(
        "setExperimentalShaderProfile", () => setExperimentalShaderProfile.call(
          renderer, profileFromUserGraphics(user),
        ),
      ));
    }
    // A disconnect clears or replaces realm-owned clients while the lease cleanup is pending. Use
    // the current context identity so releasing the benchmark can never resurrect its captured
    // ground-cover client after clearWorldContext().
    attempt(() => this.#withRendererMutationAuthorization(
      "setGroundCover",
      () => renderer.setGroundCover(this.#context.groundCover, user.grassRadius, user.grassDense),
    ));
    if (firstError !== undefined) throw firstError;
  }

  #interceptRendererMutators(renderer: WorldRenderer3D): Readonly<RendererMutationInterception> {
    const target = renderer as WorldRenderer3D & Record<string, unknown>;
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const installed: RendererMutatorName[] = [];
    try {
      for (const name of RENDERER_MUTATORS) {
        const original = target[name];
        // Test seams can implement only the renderer surface exercised by that test. Production
        // WorldRenderer3D owns every method in this fixed inventory.
        if (typeof original !== "function") continue;
        descriptors.set(name, Object.getOwnPropertyDescriptor(target, name));
        Object.defineProperty(target, name, {
          configurable: true,
          value: (...args: unknown[]): unknown => {
            const authorization = this.#rendererMutationAuthorization;
            if (authorization?.name === name && !authorization.claimed) {
              authorization.claimed = true;
            } else {
              return this.#handleExternalRendererMutation(name, original, renderer, args);
            }
            try {
              return Reflect.apply(original, renderer, args);
            } finally {
              this.#observeRendererMutation(name, args);
            }
          },
          writable: false,
        });
        installed.push(name);
      }
    } catch (error) {
      for (const name of installed.reverse()) {
        const descriptor = descriptors.get(name);
        if (descriptor === undefined) delete target[name];
        else Object.defineProperty(target, name, descriptor);
      }
      throw error;
    }
    let restored = false;
    return Object.freeze({
      restore: (): void => {
        if (restored) return;
        restored = true;
        let firstError: unknown;
        for (const name of installed) {
          try {
            const descriptor = descriptors.get(name);
            if (descriptor === undefined) delete target[name];
            else Object.defineProperty(target, name, descriptor);
          } catch (error) {
            firstError ??= error;
          }
        }
        if (firstError !== undefined) throw firstError;
      },
    });
  }

  #handleExternalRendererMutation(
    name: RendererMutatorName,
    original: (...args: never[]) => unknown,
    renderer: WorldRenderer3D,
    args: readonly unknown[],
  ): unknown {
    // The ordinary RAF is paused, but packet/UI handlers can still deliver short-lived effects.
    // They are irrelevant to the fixed replay and must neither contaminate it nor make a 15-minute
    // suite fail merely because combat continued on the server while the local scene was leased.
    if (name === "playSpellVisual") {
      return Object.freeze({ id: this.#suppressedVisualHandleId-- });
    }
    if (name === "clearSpellVisuals") {
      this.#deferredClearSpellVisuals = true;
      this.#deferredStateVisuals = undefined;
      return undefined;
    }
    if (name === "cancelSpellVisual" || name === "retimeSpellVisual"
      || name === "playGameObjectAnimation" || name === "playUnitAction"
      || name === "playUnitEmote" || name === "cancelUnitAction") {
      return undefined;
    }
    if (name === "setStateVisuals") {
      this.#deferredStateVisuals = cloneStateVisuals(
        args[0] as ReadonlyMap<bigint, readonly StateVisual[]>,
      );
      return undefined;
    }
    if (name === "setPortraitTargets") {
      this.#deferredPortraitTargets = clonePortraitTargets(
        args[0] as ReadonlyMap<PortraitSlot, Readonly<PortraitTarget>>,
      );
      return undefined;
    }
    if (name === "renderPortraits") return 0;
    if (name === "clearPortraits") {
      this.#deferredClearPortraits = true;
      this.#deferredPortraitTargets = undefined;
      return undefined;
    }

    this.#externalRendererMutation ??= name;
    try {
      return Reflect.apply(original, renderer, args);
    } finally {
      this.#observeRendererMutation(name, args);
      this.#observeExternalUserGraphics(name, args);
    }
  }

  #withRendererMutationAuthorization<T>(name: RendererMutatorName, operation: () => T): T {
    if (this.#rendererMutationInterception === undefined) return operation();
    if (this.#rendererMutationAuthorization !== undefined) {
      throw new Error("formal renderer mutation authorization cannot be nested");
    }
    const authorization: RendererMutationAuthorization = { name, claimed: false };
    this.#rendererMutationAuthorization = authorization;
    try {
      const result = operation();
      if (!authorization.claimed) {
        throw new Error(`formal renderer authorized mutator ${name} was not intercepted`);
      }
      return result;
    } finally {
      this.#rendererMutationAuthorization = undefined;
    }
  }

  #observeRendererMutation(name: RendererMutatorName, args: readonly unknown[]): void {
    const current = this.#observedGraphics;
    if (name === "setGroundCover") this.#observedGroundCover = args[0] as GameContext["groundCover"];
    if (!current) return;
    let change: Partial<UserGraphicsSettings> | undefined;
    if (name === "setLightingQuality") change = { lightingQuality: args[0] as number };
    else if (name === "setRenderScale") change = { renderScalePercent: (args[0] as number) * 100 };
    else if (name === "setWmoOcclusion") change = { wmoOcclusion: args[0] as boolean };
    else if (name === "setCharacterAtlasAnisotropy") {
      change = { characterAtlasAnisotropy: args[0] as boolean };
    } else if (name === "setExperimentalShaderProfile") {
      const profile = args[0] as Readonly<Partial<ExperimentalShaderProfile>> | undefined;
      change = {
        experimentalAerialHeightFog: profile?.aerialHeightFog === true,
        experimentalTerrainMicroNormals: profile?.terrainMicroNormals === true,
        experimentalWaterFresnel: profile?.waterFresnel === true,
        experimentalWaterMicroWaves: profile?.waterMicroWaves === true,
        experimentalWaterSunSparkle: profile?.waterSunSparkle === true,
        experimentalFantasyGlow: profile?.fantasyGlow === true,
      };
    } else if (name === "setGroundCover" && args[1] !== undefined && args[2] !== undefined) {
      change = { grassRadius: args[1] as number, grassDense: args[2] as boolean };
    }
    if (change) this.#observedGraphics = Object.freeze({ ...current, ...change });
  }

  #observeExternalUserGraphics(name: RendererMutatorName, args: readonly unknown[]): void {
    const base = this.#externalUserGraphics ?? this.#userGraphics;
    if (!base) return;
    let change: Partial<UserGraphicsSettings> | undefined;
    if (name === "setLightingQuality") change = { lightingQuality: args[0] as number };
    else if (name === "setRenderScale") change = { renderScalePercent: (args[0] as number) * 100 };
    else if (name === "setWmoOcclusion") change = { wmoOcclusion: args[0] as boolean };
    else if (name === "setCharacterAtlasAnisotropy") {
      change = { characterAtlasAnisotropy: args[0] as boolean };
    } else if (name === "setExperimentalShaderProfile") {
      const profile = args[0] as Readonly<Partial<ExperimentalShaderProfile>> | undefined;
      change = {
        experimentalAerialHeightFog: profile?.aerialHeightFog === true,
        experimentalTerrainMicroNormals: profile?.terrainMicroNormals === true,
        experimentalWaterFresnel: profile?.waterFresnel === true,
        experimentalWaterMicroWaves: profile?.waterMicroWaves === true,
        experimentalWaterSunSparkle: profile?.waterSunSparkle === true,
        experimentalFantasyGlow: profile?.fantasyGlow === true,
      };
    } else if (name === "setGroundCover" && args[1] !== undefined && args[2] !== undefined) {
      change = { grassRadius: args[1] as number, grassDense: args[2] as boolean };
    }
    if (change) this.#externalUserGraphics = Object.freeze({ ...base, ...change });
  }

  #assertExclusiveIntegrity(): void {
    const mutation = this.#externalRendererMutation;
    if (mutation !== undefined) {
      const graphicsKey: Partial<Record<RendererMutatorName, keyof UserGraphicsSettings | "experimentalShaderProfile" | "groundCover">> = {
        setLightingQuality: "lightingQuality",
        setRenderScale: "renderScalePercent",
        setWmoOcclusion: "wmoOcclusion",
        setCharacterAtlasAnisotropy: "characterAtlasAnisotropy",
        setExperimentalShaderProfile: "experimentalShaderProfile",
        setGroundCover: "groundCover",
      };
      const key = graphicsKey[mutation];
      if (key !== undefined) {
        throw new Error(`formal renderer graphics configuration drifted at ${key}: external ${mutation}`);
      }
      throw new Error(`formal renderer was externally mutated via ${mutation}`);
    }
    const resources = this.#requireResources();
    if (resources.factions.ready !== true) {
      throw new Error("formal renderer faction data became unavailable");
    }
    const changed = ACTIVE_RESOURCE_KEYS.filter((key) => this.#context[key] !== resources[key]);
    if (changed.length > 0) {
      throw new Error(`formal renderer GameContext resource identity changed: ${changed.join(", ")}`);
    }
  }

  #readSurfaceStamp(): Readonly<FormalRenderSurfaceStamp> {
    const source = this.#requireResources().renderer.formalRenderSurfaceStamp;
    if (source === null || typeof source !== "object") {
      throw new Error("formal renderer surface stamp is unavailable");
    }
    for (const key of ["cssWidth", "cssHeight", "backingWidth", "backingHeight", "contextGeneration"] as const) {
      if (!Number.isSafeInteger(source[key]) || source[key] < 0) {
        throw new Error(`formal renderer surface stamp ${key} is invalid`);
      }
    }
    for (const key of ["systemDpr", "effectivePixelRatio"] as const) {
      if (!Number.isFinite(source[key]) || source[key] <= 0) {
        throw new Error(`formal renderer surface stamp ${key} is invalid`);
      }
    }
    if (typeof source.contextLost !== "boolean") {
      throw new Error("formal renderer surface stamp contextLost is invalid");
    }
    return Object.freeze({ ...source });
  }

  #assertSurfaceContextEpoch(): Readonly<FormalRenderSurfaceStamp> {
    const stamp = this.#readSurfaceStamp();
    if (stamp.contextLost) throw new Error("formal renderer WebGL context is lost");
    if (this.#leaseContextGeneration === undefined) {
      throw new Error("formal renderer WebGL context epoch is unavailable");
    }
    if (stamp.contextGeneration !== this.#leaseContextGeneration) {
      throw new Error("formal renderer WebGL context epoch changed during the suite");
    }
    return stamp;
  }

  #assertExpectedSurfaceStamp(): void {
    const expected = this.#expectedSurfaceStamp;
    if (!expected) throw new Error("formal renderer start surface stamp is unavailable");
    const actual = this.#assertSurfaceContextEpoch();
    if (!sameSurfaceStamp(actual, expected)) {
      throw new Error("formal renderer surface changed during measurement");
    }
  }

  #assertAppliedConfiguration(): void {
    this.#assertExclusiveIntegrity();
    const configuration = this.#requireConfiguration();
    const actual = this.#requireResources().renderer.benchmarkGraphicsConfiguration;
    if (actual === null || typeof actual !== "object") {
      throw new Error("formal renderer graphics readback is unavailable");
    }
    const expectedProfile = profileFromConfiguration(configuration);
    const actualProfile = profileFromRendererReadback(
      (actual as unknown as Record<string, unknown>).experimentalShaderProfile,
    );
    const expected: Readonly<UserGraphicsSettings> = {
      lightingQuality: configuration.lighting,
      renderScalePercent: numberSetting(configuration, "renderScale"),
      wmoOcclusion: booleanSetting(configuration, "wmoOcclusion"),
      characterAtlasAnisotropy: booleanSetting(configuration, "characterAtlasAnisotropy"),
      experimentalAerialHeightFog: expectedProfile.aerialHeightFog,
      experimentalTerrainMicroNormals: expectedProfile.terrainMicroNormals,
      experimentalWaterFresnel: expectedProfile.waterFresnel,
      experimentalWaterMicroWaves: expectedProfile.waterMicroWaves,
      experimentalWaterSunSparkle: expectedProfile.waterSunSparkle,
      experimentalFantasyGlow: expectedProfile.fantasyGlow,
      grassRadius: numberSetting(configuration, "grassRadius"),
      grassDense: booleanSetting(configuration, "grassDense"),
    };
    const actualValues: Readonly<UserGraphicsSettings> = {
      lightingQuality: actual.lightingQuality,
      renderScalePercent: actual.renderScalePercent,
      wmoOcclusion: actual.wmoOcclusion,
      characterAtlasAnisotropy: actual.characterAtlasAnisotropy,
      experimentalAerialHeightFog: actualProfile.aerialHeightFog,
      experimentalTerrainMicroNormals: actualProfile.terrainMicroNormals,
      experimentalWaterFresnel: actualProfile.waterFresnel,
      experimentalWaterMicroWaves: actualProfile.waterMicroWaves,
      experimentalWaterSunSparkle: actualProfile.waterSunSparkle,
      experimentalFantasyGlow: actualProfile.fantasyGlow,
      grassRadius: actual.grassRadius,
      grassDense: actual.grassDense,
    };
    for (const key of Object.keys(expected) as Array<keyof UserGraphicsSettings>) {
      if (!Object.is(actualValues[key], expected[key])) {
        throw new Error(`formal renderer graphics configuration drifted at ${key}`);
      }
    }
    if (this.#observedGroundCover !== this.#requireResources().groundCover) {
      throw new Error("formal renderer graphics configuration drifted at groundCover");
    }
  }

  #flushDeferredRendererMutations(renderer: WorldRenderer3D): void {
    if (this.#deferredClearSpellVisuals) renderer.clearSpellVisuals();
    if (this.#context.renderer === renderer && this.#deferredStateVisuals !== undefined) {
      renderer.setStateVisuals(this.#deferredStateVisuals);
    }
    if (this.#deferredClearPortraits) renderer.clearPortraits();
    if (this.#context.renderer === renderer && this.#deferredPortraitTargets !== undefined) {
      renderer.setPortraitTargets(this.#deferredPortraitTargets);
    }
  }

  async #release(expected: Readonly<CoordinatorLease>): Promise<void> {
    if (this.#coordinatorLease !== expected) return;
    const renderer = this.#resources?.renderer;
    let firstError: unknown;
    const attempt = (operation: () => void): void => {
      try { operation(); } catch (error) { firstError ??= error; }
    };
    try {
      this.#gpu = undefined;
      if (renderer?.replayEpochActive) {
        attempt(() => this.#withRendererMutationAuthorization("endReplayEpoch", () => renderer.endReplayEpoch()));
      }
      this.#replayEpochActive = false;
      // Discard/poll while the formal observer and exclusive RAF gate still own attribution.
      if (renderer) {
        attempt(() => this.#withRendererMutationAuthorization(
          "resetGpuTimingEpoch", () => renderer.resetGpuTimingEpoch(),
        ));
      }
      attempt(() => this.#restoreUserGraphics());
      // Clock rebasing must survive failed setting restores; the RAF gate is released below.
      if (renderer) {
        attempt(() => this.#withRendererMutationAuthorization(
          "resetRenderEvolutionClock", () => renderer.resetRenderEvolutionClock(),
        ));
        attempt(() => this.#withRendererMutationAuthorization(
          "resetFrameCadence", () => renderer.resetFrameCadence(),
        ));
        if (this.#rendererIsolationActive) {
          attempt(() => {
            this.#withRendererMutationAuthorization(
              "endFormalBenchmarkIsolation", () => renderer.endFormalBenchmarkIsolation(),
            );
            this.#rendererIsolationActive = false;
          });
        }
      }
    } finally {
      try {
        if (this.#rendererMutationInterception) attempt(() => this.#rendererMutationInterception!.restore());
        if (this.#gpuObserverLease) attempt(() => this.#gpuObserverLease!.release());
        if (renderer) attempt(() => this.#flushDeferredRendererMutations(renderer));
      } finally {
        this.#gpuObserverLease = undefined;
        this.#publicLease = undefined;
        this.#coordinatorLease = undefined;
        this.#bindings = undefined;
        this.#resources = undefined;
        this.#userGraphics = undefined;
        this.#observedGraphics = undefined;
        this.#observedGroundCover = undefined;
        this.#rendererMutationInterception = undefined;
        this.#rendererMutationAuthorization = undefined;
        this.#externalRendererMutation = undefined;
        this.#externalUserGraphics = undefined;
        this.#suppressedVisualHandleId = -1;
        this.#deferredClearSpellVisuals = false;
        this.#deferredStateVisuals = undefined;
        this.#deferredClearPortraits = false;
        this.#deferredPortraitTargets = undefined;
        this.#rendererIsolationActive = false;
        this.#leaseContextGeneration = undefined;
        this.#expectedSurfaceStamp = undefined;
        this.#configuration = undefined;
        this.#variant = undefined;
        this.#suiteNonce = undefined;
        this.#epoch = undefined;
        this.#usedEpochNonces.clear();
        this.#snapshot = undefined;
        this.#snapshotCanonical = undefined;
        this.#replay = undefined;
        this.#lastObservation = undefined;
        this.#lastBarrierAt = undefined;
        this.#measurementEndCaptured = false;
        this.#readiness.reset();
        attempt(() => expected.release());
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  #assertLease(value: FormalBenchmarkExclusiveLease): void {
    if (value !== this.#publicLease || this.#coordinatorLease === undefined) {
      throw new Error("formal benchmark host lease is not active");
    }
    assertFormalRenderBenchmarkExclusiveLease(this.#coordinatorLease);
    this.#assertExclusiveIntegrity();
    if (this.#leaseContextGeneration !== undefined) this.#assertSurfaceContextEpoch();
  }

  #validateEpochForBegin(epoch: Readonly<FormalBenchmarkEpochIdentity>): void {
    validateEpochIdentity(epoch);
    if (this.#epoch !== undefined) throw new Error("formal benchmark epoch is already active");
    if (this.#suiteNonce !== undefined && epoch.suiteNonce !== this.#suiteNonce) {
      throw new Error("formal benchmark suite nonce changed under one lease");
    }
    if (this.#usedEpochNonces.has(epoch.epochNonce)) {
      throw new Error("formal benchmark epoch nonce was reused");
    }
  }

  #beginEpoch(epoch: Readonly<FormalBenchmarkEpochIdentity>): void {
    this.#validateEpochForBegin(epoch);
    if (this.#suiteNonce === undefined) this.#suiteNonce = epoch.suiteNonce;
    this.#usedEpochNonces.add(epoch.epochNonce);
    this.#epoch = epoch;
  }

  /** Clears only a failed variant transaction; lease and live-user ownership remain intact. */
  #clearUnfinishedVariantEpoch(): void {
    this.#epoch = undefined;
    this.#expectedSurfaceStamp = undefined;
    this.#configuration = undefined;
    this.#variant = undefined;
    this.#snapshot = undefined;
    this.#snapshotCanonical = undefined;
    this.#replay = undefined;
    this.#lastObservation = undefined;
    this.#lastBarrierAt = undefined;
    this.#measurementEndCaptured = false;
    this.#replayEpochActive = false;
    this.#gpu = undefined;
    this.#readiness.reset();
  }

  #assertEpoch(value: Readonly<FormalBenchmarkEpochIdentity>): void {
    if (value !== this.#epoch) throw new Error("formal benchmark epoch identity is not active");
  }

  #requireResources(): Readonly<ActiveResources> {
    if (!this.#resources) throw new Error("formal renderer resources are not acquired");
    return this.#resources;
  }

  #requireBindings(): Readonly<LiveHostBindings> {
    if (!this.#bindings) throw new Error("formal renderer bindings are not acquired");
    return this.#bindings;
  }

  #requireConfiguration(): Readonly<LiveFormalRenderGraphicsConfiguration> {
    if (!this.#configuration || !this.#variant) throw new Error("formal benchmark variant is not applied");
    return this.#configuration;
  }

  #requireReplay(): HydratedWorldReplaySnapshot {
    if (!this.#replay || !this.#snapshot) throw new Error("formal benchmark fixed replay is not hydrated");
    return this.#replay;
  }
}
