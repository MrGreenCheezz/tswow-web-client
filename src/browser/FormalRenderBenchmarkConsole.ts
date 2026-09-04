import {
  captureWorldReplaySnapshot,
  cloneWorldReplaySnapshot,
  hashWorldReplayFrameOrder,
  hashWorldReplaySnapshot,
  type WorldReplayCameraFrameV1,
  type WorldReplaySnapshotV1,
} from "./BenchmarkReplay.js";
import {
  RENDER_BENCHMARK_MANIFEST,
  cloneBenchmarkEnvironment,
  type ApprovedBenchmarkScenario,
  type BenchmarkEnvironmentMetadata,
  type BenchmarkJsonObject,
  type BenchmarkJsonValue,
} from "./BenchmarkManifest.js";
import {
  type FormalRenderBenchmarkDefinition,
  type FormalRenderBenchmarkHost,
  type DiagnosticRenderBenchmarkSuiteResult,
  type FormalRenderBenchmarkSuiteResult,
} from "./FormalRenderBenchmarkRunner.js";
import type { LiveFormalRenderGraphicsConfiguration } from "./LiveFormalRenderBenchmarkHost.js";
import type { CameraRig } from "./game/CameraRig.js";
import type { WorldState } from "../world/WorldState.js";

/** The single comparison is deliberately stable across candidate captures and browser sessions. */
export const FORMAL_BENCHMARK_COMPARISON_ID = "atlas-anisotropy-r1" as const;
export const FORMAL_BENCHMARK_ALLOWED_KNOB_PATH = "settings.characterAtlasAnisotropy" as const;
/** Kept local so the candidate helper remains independent of the renderer/host module graph. */
export const FORMAL_BENCHMARK_FRAME_COUNT = 5_400 as const;
export const FORMAL_BENCHMARK_FRAME_STEP_MS = 1_000 / 60;

const FORMAL_CANVAS = RENDER_BENCHMARK_MANIFEST.profile.canvas;
const FIXED_WEATHER = Object.freeze({ state: 0, intensity: 0, abrupt: false });

const CAMERA_NUMERIC_KEYS = [
  "yaw", "pitch", "distance", "view", "viewPitch", "zoom", "pivotHeight", "eyeHeight",
] as const;

export interface FormalBenchmarkLiveState {
  readonly world: WorldState | undefined;
  readonly mapId: number | undefined;
  readonly camera: CameraRig;
  readonly targetGuid?: bigint | string | null;
  readonly focusGuid?: bigint | string | null;
}

export interface FormalRenderBenchmarkCandidate {
  readonly formalGateEligible: false;
  readonly snapshot: Readonly<WorldReplaySnapshotV1>;
  readonly snapshotHash: string;
  readonly frameOrderHash: string;
  readonly scenario: Readonly<ApprovedBenchmarkScenario>;
  readonly issues: readonly string[];
}

export type FormalBenchmarkConsoleRunResult =
  | Readonly<DiagnosticRenderBenchmarkSuiteResult>
  | Readonly<FormalRenderBenchmarkSuiteResult>;

export type FormalBenchmarkConsoleStatus = Readonly<{
  readonly state: "idle" | "capturing" | "running" | "complete" | "error" | "aborted";
  readonly mode?: "candidate" | "approved";
  readonly stage?: string;
  readonly error?: string;
}>;

export interface FormalRenderBenchmarkRunnerFactory {
  readonly create: (definition: Readonly<FormalRenderBenchmarkDefinition>) => Promise<FormalBenchmarkRunnerLike>;
  readonly createDiagnosticCandidate: (
    definition: Readonly<FormalRenderBenchmarkDefinition>,
  ) => Promise<FormalBenchmarkRunnerLike>;
}

export interface FormalBenchmarkRunnerLike {
  readonly runDiagnostic: (
    host: FormalRenderBenchmarkHost,
    signal?: AbortSignal,
  ) => Promise<Readonly<DiagnosticRenderBenchmarkSuiteResult>>;
  readonly run: (
    host: FormalRenderBenchmarkHost,
    signal?: AbortSignal,
  ) => Promise<Readonly<FormalRenderBenchmarkSuiteResult>>;
}

export interface FormalRenderBenchmarkConsoleDependencies {
  /** Returns the current world without retaining a mutable game-context alias. */
  readonly captureLiveState: () => FormalBenchmarkLiveState;
  /** Reads actual canvas/WebGL state; host barriers call this after applying a variant. */
  readonly captureEnvironment: (
    configuration?: Readonly<LiveFormalRenderGraphicsConfiguration>,
  ) => unknown;
  /** Settings are copied into each A/B configuration; no settings object is retained. */
  readonly captureSettings: () => BenchmarkJsonObject;
  readonly createLiveHost: (
    captureEnvironment: (
      configuration: Readonly<LiveFormalRenderGraphicsConfiguration>,
    ) => unknown,
  ) => FormalRenderBenchmarkHost;
  readonly runner: FormalRenderBenchmarkRunnerFactory;
  readonly logger?: Pick<Console, "log" | "warn">;
  readonly now?: () => number;
}

export interface FormalRenderBenchmarkConsoleApi {
  readonly captureCandidate: (scenarioId: string) => Promise<Readonly<FormalRenderBenchmarkCandidate>>;
  readonly runCandidate: (
    candidate?: Readonly<FormalRenderBenchmarkCandidate>,
  ) => Promise<Readonly<DiagnosticRenderBenchmarkSuiteResult>>;
  readonly runApproved: (
    candidate?: Readonly<FormalRenderBenchmarkCandidate>,
  ) => Promise<Readonly<FormalRenderBenchmarkSuiteResult>>;
  readonly abort: (reason?: unknown) => void;
  readonly status: () => FormalBenchmarkConsoleStatus;
  readonly lastCandidate: () => Readonly<FormalRenderBenchmarkCandidate> | undefined;
  readonly lastResult: () => Readonly<FormalBenchmarkConsoleRunResult> | undefined;
}

/**
 * Makes the fixed candidate path. It is intentionally a static clone of the current camera: this
 * is a candidate capture, not a reviewed fixture, and every frame is an independent object.
 */
export function buildFixedBenchmarkCameraFrames(
  camera: Readonly<CameraRig>,
  frameCount: number = FORMAL_BENCHMARK_FRAME_COUNT,
): readonly WorldReplayCameraFrameV1[] {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new RangeError("formal candidate frameCount must be a positive safe integer");
  }
  const values = camera as Readonly<Record<string, unknown>>;
  for (const key of CAMERA_NUMERIC_KEYS) {
    if (typeof values[key] !== "number" || !Number.isFinite(values[key])) {
      throw new TypeError(`live camera ${key} must be finite`);
    }
  }
  const limit = (key: "wallView" | "terrainView"): number | null => {
    const value = values[key];
    if (value === Number.POSITIVE_INFINITY) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`live camera ${key} must be finite or +Infinity`);
    }
    return value;
  };
  const base = {
    yaw: values.yaw as number,
    pitch: values.pitch as number,
    distance: values.distance as number,
    view: values.view as number,
    viewPitch: values.viewPitch as number,
    zoom: values.zoom as number,
    wallView: limit("wallView"),
    terrainView: limit("terrainView"),
    pivotHeight: values.pivotHeight as number,
    eyeHeight: values.eyeHeight as number,
  };
  return Object.freeze(Array.from({ length: frameCount }, (_, frameIndex) =>
    Object.freeze({ frameIndex, ...base })));
}

/** Returns only the approved coordinate scenarios; pending non-coordinate entries are not usable. */
export function approvedFormalBenchmarkScenario(scenarioId: string): Readonly<ApprovedBenchmarkScenario> {
  const scenario = RENDER_BENCHMARK_MANIFEST.scenarios.find((entry) => entry.id === scenarioId);
  if (!scenario || scenario.status !== "approved") {
    throw new Error(`formal benchmark scenario is not approved: ${scenarioId}`);
  }
  return scenario;
}

/** Pure validation used both by the console and by candidate-focused tests. */
export function collectFormalBenchmarkCandidateIssues(
  scenario: Readonly<ApprovedBenchmarkScenario>,
  live: Readonly<FormalBenchmarkLiveState>,
  environment?: unknown,
): readonly string[] {
  const issues: string[] = [];
  if (scenario.fixtureStatus === "pending") issues.push("fixture pending approval; candidate is not gate eligible");
  if (live.world === undefined) {
    issues.push("live world is unavailable");
  } else {
    if (live.mapId === undefined || !Number.isFinite(live.mapId)) {
      issues.push("live world map id is unavailable");
    } else if (live.mapId !== scenario.mapId) {
      issues.push(`map mismatch: expected ${scenario.mapId}, got ${live.mapId}`);
    }
    const self = live.world.selfGuid === undefined ? undefined : live.world.objects.get(live.world.selfGuid);
    if (!self?.position) {
      issues.push("live self position is unavailable");
    } else {
      for (const axis of ["x", "y", "z"] as const) {
        const value = self.position[axis];
        if (!Number.isFinite(value)) issues.push(`live self position ${axis} is not finite`);
        else if (Math.abs(value - scenario.position[axis]) > 0.01) {
          issues.push(`self position ${axis} is outside the 0.01-yard fixture tolerance`);
        }
      }
    }
    const knownGuids = live.world.objects;
    for (const [label, guid] of [["target", live.targetGuid], ["focus", live.focusGuid]] as const) {
      if (guid === undefined || guid === null) continue;
      try {
        if (!knownGuids.has(typeof guid === "bigint" ? guid : BigInt(guid))) {
          issues.push(`live ${label} reference is not present in the captured world`);
        }
      } catch {
        issues.push(`live ${label} reference is invalid`);
      }
    }
  }
  try {
    buildFixedBenchmarkCameraFrames(live.camera, 1);
  } catch (error) {
    issues.push(errorMessage(error));
  }
  if (environment !== undefined) issues.push(...formalEnvironmentIssues(environment));
  return Object.freeze(issues);
}

/** Builds a candidate snapshot from a live WorldState without mutating that state or its camera. */
export function buildFormalBenchmarkCandidateSnapshot(
  scenario: Readonly<ApprovedBenchmarkScenario>,
  live: Readonly<FormalBenchmarkLiveState>,
  captureNowMs: number,
): WorldReplaySnapshotV1 {
  if (!live.world) throw new Error("cannot capture a formal candidate without a live world");
  if (!Number.isFinite(captureNowMs)) throw new TypeError("formal candidate capture time must be finite");
  const frames = buildFixedBenchmarkCameraFrames(live.camera).map((frame) => ({
    ...frame,
    wallView: frame.wallView === null ? Number.POSITIVE_INFINITY : frame.wallView,
    terrainView: frame.terrainView === null ? Number.POSITIVE_INFINITY : frame.terrainView,
  }));
  const selfGuid = live.world.selfGuid;
  if (selfGuid === undefined) throw new Error("cannot capture a formal candidate without a live self");
  const knownGuids = live.world.objects;
  const replayReference = (guid: bigint | string | null | undefined): bigint | string | null => {
    if (guid === undefined || guid === null) return null;
    try {
      const parsed = typeof guid === "bigint" ? guid : BigInt(guid);
      return knownGuids.has(parsed) ? guid : null;
    } catch {
      return null;
    }
  };
  return captureWorldReplaySnapshot({
    world: live.world,
    captureNowMs,
    metadata: {
      scenarioId: scenario.id,
      mapId: Number.isFinite(live.mapId) ? live.mapId! : scenario.mapId,
      selfGuid,
      targetGuid: replayReference(live.targetGuid),
      focusGuid: replayReference(live.focusGuid),
      halfMinute: scenario.halfMinute,
      weather: FIXED_WEATHER,
      // Seeds are documented and stable per scenario; they do not depend on wall-clock capture time.
      rngSeed: scenario.id === "goldshire-exterior" ? 0x474f4c44 : 0x53544f4d,
      frameStepMs: FORMAL_BENCHMARK_FRAME_STEP_MS,
      expectations: {
        scene: scenario.kind,
        indoors: false,
        underwater: false,
        precipitation: false,
        rainIntensity: 0,
      },
    },
    frames,
  });
}

function formalEnvironmentIssues(input: unknown): readonly string[] {
  let environment: BenchmarkEnvironmentMetadata;
  try {
    environment = cloneBenchmarkEnvironment(input);
  } catch (error) {
    return Object.freeze([`live benchmark environment is invalid: ${errorMessage(error)}`]);
  }
  const issues: string[] = [];
  if (environment.canvas.cssWidth !== FORMAL_CANVAS.cssWidth
    || environment.canvas.cssHeight !== FORMAL_CANVAS.cssHeight) {
    issues.push(`canvas CSS must be ${FORMAL_CANVAS.cssWidth}x${FORMAL_CANVAS.cssHeight}`);
  }
  if (environment.canvas.systemDpr !== FORMAL_CANVAS.systemDpr) {
    issues.push("system DPR must be 1 for the formal benchmark");
  }
  if (typeof environment.canvas.effectivePixelRatio !== "number") {
    issues.push("live renderer pixel ratio is unavailable");
  }
  if (environment.webgl.version === "unsupported"
    || environment.webgl.shadingLanguageVersion === "unsupported") {
    issues.push("live WebGL context is unavailable or lost");
  }
  return Object.freeze(issues);
}

function prospectiveFormalEnvironment(input: unknown, configuration: Readonly<FormalBenchmarkConfiguration>): BenchmarkEnvironmentMetadata {
  const actual = cloneBenchmarkEnvironment(input);
  const issues = formalEnvironmentIssues(actual);
  if (issues.length > 0) throw new Error(issues.join("; "));
  // Definition identity is prospective: host barriers later prove actual backing/pixel values after
  // applying the variant. CSS size and system DPR are checked from the live canvas before leasing.
  return cloneBenchmarkEnvironment({
    ...actual,
    lighting: 1,
    canvas: {
      ...actual.canvas,
      backingWidth: FORMAL_CANVAS.backingWidth,
      backingHeight: FORMAL_CANVAS.backingHeight,
      effectivePixelRatio: FORMAL_CANVAS.effectivePixelRatio,
      renderScalePercent: FORMAL_CANVAS.renderScalePercent,
    },
    settings: configuration.settings,
  });
}

interface FormalBenchmarkConfiguration {
  readonly lighting: 1;
  readonly settings: BenchmarkJsonObject;
}

function buildVariantConfigurations(settings: BenchmarkJsonObject): Readonly<{ A: FormalBenchmarkConfiguration; B: FormalBenchmarkConfiguration }> {
  const base: Record<string, BenchmarkJsonValue> = { ...cloneJson(settings) };
  base.lightingQuality = 1;
  base.renderScale = FORMAL_CANVAS.renderScalePercent;
  // This formal suite compares character-atlas anisotropy, so every unrelated R5 shader leaf is
  // explicitly OFF in both variants. Missing old account settings therefore resolve to the same
  // exact no-shader baseline instead of inheriting the interactive defaults.
  base.experimentalAerialHeightFog = false;
  base.experimentalTerrainMicroNormals = false;
  base.experimentalWaterFresnel = false;
  base.experimentalWaterMicroWaves = false;
  base.experimentalWaterSunSparkle = false;
  base.experimentalWaterFoam = false;
  base.experimentalVegetationWind = false;
  base.experimentalFantasyGlow = false;
  // P3's underwater overlay is a default-ON account leaf; a formal variant that left it to the
  // account would compare a tinted run against an untinted one whenever the fixture dips a camera.
  base.underwaterOverlay = false;
  // Either independent post-process leaf can select the shared composited path. Pin both OFF so
  // the formal variants compare the same direct pipeline while varying only the approved knob.
  base.fullscreenGlow = false;
  base.godRays = false;
  const a = cloneJson(base as BenchmarkJsonObject) as Record<string, BenchmarkJsonValue>;
  const b = cloneJson(base as BenchmarkJsonObject) as Record<string, BenchmarkJsonValue>;
  a.characterAtlasAnisotropy = false;
  b.characterAtlasAnisotropy = true;
  return Object.freeze({
    A: Object.freeze({ lighting: 1, settings: Object.freeze(a) as BenchmarkJsonObject }),
    B: Object.freeze({ lighting: 1, settings: Object.freeze(b) as BenchmarkJsonObject }),
  });
}

function cloneJson(value: BenchmarkJsonObject): BenchmarkJsonObject {
  const cloneValue = (current: BenchmarkJsonValue): BenchmarkJsonValue => {
    if (current === null || typeof current === "string" || typeof current === "boolean" || typeof current === "number") {
      if (typeof current === "number" && !Number.isFinite(current)) throw new TypeError("settings must contain finite numbers");
      return current;
    }
    if (Array.isArray(current)) return current.map(cloneValue);
    return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, cloneValue(child as BenchmarkJsonValue)]));
  };
  return cloneValue(value) as BenchmarkJsonObject;
}

async function ownCandidate(
  candidate: Readonly<FormalRenderBenchmarkCandidate>,
): Promise<Readonly<FormalRenderBenchmarkCandidate>> {
  const snapshot = cloneWorldReplaySnapshot(candidate.snapshot);
  const scenario = approvedFormalBenchmarkScenario(snapshot.scenarioId);
  const [snapshotHash, frameOrderHash] = await Promise.all([
    hashWorldReplaySnapshot(snapshot),
    hashWorldReplayFrameOrder(snapshot),
  ]);
  if (snapshotHash !== String(candidate.snapshotHash)) {
    throw new Error("candidate snapshotHash does not match its owned snapshot");
  }
  if (frameOrderHash !== String(candidate.frameOrderHash)) {
    throw new Error("candidate frameOrderHash does not match its owned snapshot");
  }
  const issues = Array.isArray(candidate.issues)
    ? candidate.issues.map((issue) => String(issue))
    : [];
  return deepFreeze({
    formalGateEligible: false as const,
    snapshot,
    snapshotHash,
    frameOrderHash,
    scenario,
    issues,
  });
}

export function createFormalRenderBenchmarkConsole(
  dependencies: Readonly<FormalRenderBenchmarkConsoleDependencies>,
): FormalRenderBenchmarkConsoleApi {
  let candidate: Readonly<FormalRenderBenchmarkCandidate> | undefined;
  let result: Readonly<FormalBenchmarkConsoleRunResult> | undefined;
  let controller: AbortController | undefined;
  let statusValue: FormalBenchmarkConsoleStatus = Object.freeze({ state: "idle" });
  let captureActive = false;
  const logger = dependencies.logger ?? console;
  const now = dependencies.now ?? (() => performance.now());

  const setStatus = (next: FormalBenchmarkConsoleStatus): void => { statusValue = Object.freeze({ ...next }); };
  const log = (message: string): void => { logger.log(`[формальный benchmark] ${message}`); };
  const requireNotRunning = (): void => {
    if (controller !== undefined || captureActive) throw new Error("formal benchmark console is busy");
  };

  const captureCandidate = async (scenarioId: string): Promise<Readonly<FormalRenderBenchmarkCandidate>> => {
    requireNotRunning();
    const scenario = approvedFormalBenchmarkScenario(scenarioId);
    captureActive = true;
    setStatus({ state: "capturing", stage: "live state" });
    try {
      let environment: unknown;
      const environmentIssues: string[] = [];
      try {
        environment = dependencies.captureEnvironment();
      } catch (error) {
        environment = undefined;
        environmentIssues.push(`live benchmark environment is unavailable: ${errorMessage(error)}`);
        log(`кандидат: среда не захвачена (${errorMessage(error)})`);
      }
      // No await is permitted between this read and snapshot ownership: map, camera and objects
      // must describe one JavaScript turn rather than a mutable world observed at two moments.
      const live = dependencies.captureLiveState();
      const snapshot = buildFormalBenchmarkCandidateSnapshot(scenario, live, now());
      const issues = Object.freeze([
        ...collectFormalBenchmarkCandidateIssues(scenario, live, environment),
        ...environmentIssues,
      ]);
      const [snapshotHash, frameOrderHash] = await Promise.all([
        hashWorldReplaySnapshot(snapshot),
        hashWorldReplayFrameOrder(snapshot),
      ]);
      const captured = deepFreeze({
        formalGateEligible: false as const,
        snapshot,
        snapshotHash,
        frameOrderHash,
        scenario,
        issues,
      });
      candidate = captured;
      result = undefined;
      setStatus({ state: "idle" });
      log(`кандидат ${scenario.id} захвачен: 5400 кадров; fixture pending, gate=false`);
      return captured;
    } catch (error) {
      setStatus({ state: "error", error: errorMessage(error) });
      throw error;
    } finally {
      captureActive = false;
    }
  };

  const run = async (
    mode: "candidate" | "approved",
    supplied: Readonly<FormalRenderBenchmarkCandidate> | undefined,
  ): Promise<Readonly<FormalBenchmarkConsoleRunResult>> => {
    requireNotRunning();
    if (supplied === undefined && candidate === undefined) {
      const error = new Error("captureCandidate must run before a formal benchmark");
      setStatus({ state: "error", mode, error: error.message });
      throw error;
    }
    controller = new AbortController();
    result = undefined;
    setStatus({ state: "running", mode, stage: "preflight" });
    const signal = controller.signal;
    try {
      const selected = supplied === undefined ? candidate! : await ownCandidate(supplied);
      throwIfAborted(signal);
      const blockingIssues = selected.issues.filter((issue) => !issue.startsWith("fixture pending approval"));
      if (blockingIssues.length > 0) {
        throw new Error(`candidate is not runnable: ${blockingIssues.join("; ")}`);
      }
      candidate = selected;
      const configs = buildVariantConfigurations(dependencies.captureSettings());
      const capturedEnvironment = dependencies.captureEnvironment(configs.A);
      throwIfAborted(signal);
      const environment = prospectiveFormalEnvironment(capturedEnvironment, configs.A);
      const definition: Readonly<FormalRenderBenchmarkDefinition> = Object.freeze({
        snapshot: selected.snapshot,
        environment,
        configurations: configs,
        comparisonId: FORMAL_BENCHMARK_COMPARISON_ID,
        allowedKnobPath: FORMAL_BENCHMARK_ALLOWED_KNOB_PATH,
      });
      if (mode === "candidate") {
        setStatus({ state: "running", mode, stage: "diagnostic execution" });
        log(`кандидат ${selected.scenario.id}: diagnostic run start (A/B, 10×90s)`);
      } else {
        setStatus({ state: "running", mode, stage: "approved execution" });
        log(`approved ${selected.scenario.id}: pinned run start`);
      }
      const runner = mode === "candidate"
        ? await dependencies.runner.createDiagnosticCandidate(definition)
        : await dependencies.runner.create(definition);
      throwIfAborted(signal);
      const host = dependencies.createLiveHost((configuration) => dependencies.captureEnvironment(configuration));
      const completed = mode === "candidate"
        ? await runner.runDiagnostic(host, signal)
        : await runner.run(host, signal);
      const owned = deepFreeze(completed) as Readonly<FormalBenchmarkConsoleRunResult>;
      result = owned;
      setStatus({ state: "complete", mode, stage: "finished" });
      log(`${mode === "candidate" ? "diagnostic" : "approved"} run end: formalGateEligible=${owned.formalGateEligible}`);
      return owned;
    } catch (error) {
      if (signal.aborted) {
        setStatus({ state: "aborted", mode, error: errorMessage(error) });
        log(`run aborted: ${errorMessage(error)}`);
      } else {
        setStatus({ state: "error", mode, error: errorMessage(error) });
        logger.warn(`[формальный benchmark] run error: ${errorMessage(error)}`);
      }
      throw error;
    } finally {
      controller = undefined;
    }
  };

  const api: FormalRenderBenchmarkConsoleApi = {
    captureCandidate,
    runCandidate: (supplied) => run("candidate", supplied) as Promise<Readonly<DiagnosticRenderBenchmarkSuiteResult>>,
    runApproved: (supplied) => run("approved", supplied) as Promise<Readonly<FormalRenderBenchmarkSuiteResult>>,
    abort: (reason) => {
      if (controller === undefined) return;
      controller.abort(reason ?? new Error("formal benchmark aborted by user"));
    },
    status: () => statusValue,
    lastCandidate: () => candidate,
    lastResult: () => result,
  };
  return Object.freeze(api);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "formal benchmark aborted"));
}
