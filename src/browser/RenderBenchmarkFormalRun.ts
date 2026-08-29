import {
  BENCHMARK_RUN_DURATION_MS,
  BENCHMARK_RUN_DURATION_TOLERANCE_MS,
  type BenchmarkGpuUnavailableReason,
  type BenchmarkRunSummary,
} from "./RenderBenchmarkRun.js";
import {
  PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT,
  PAIRED_BENCHMARK_WARM_POLICY,
  type BenchmarkVariant,
  type PairedBenchmarkGpuInput,
  type PairedBenchmarkRunRecord,
  validatePairedBenchmarkRunRecord,
} from "./RenderBenchmarkPairing.js";
import {
  RENDER_REPLAY_DURATION_TOLERANCE_MS,
  RENDER_REPLAY_EXPECTED_DURATION_MS,
  type RenderReplaySummary,
} from "./RenderReplayScheduler.js";
import {
  RENDER_BENCHMARK_MIN_STABLE_SAMPLES,
  RENDER_BENCHMARK_STABLE_RESIDENCY_MS,
  type BenchmarkReadinessObservation,
} from "./RenderBenchmarkReadiness.js";

/** Identity supplied by the formal AB/BA schedule for one run. */
export interface FormalBenchmarkScheduleIdentity {
  readonly scenario: string;
  readonly variant: BenchmarkVariant;
  readonly runIndex: number;
  readonly pairIndex: number;
  readonly comparisonId: string;
  readonly snapshotHash: string;
  readonly frameOrderHash: string;
  readonly environmentHash: string;
  readonly variantConfigHash: string;
  readonly warmPolicy: typeof PAIRED_BENCHMARK_WARM_POLICY;
  readonly cold: false;
}

/** Raw diagnostic flags produced alongside a live BenchmarkRunSummary. */
export interface FormalBenchmarkDiagnosticEvidence {
  readonly valid: boolean;
  readonly frameSequenceComplete: boolean;
  readonly frameFailures: number;
  readonly invalidReasons: readonly ("frame-errors" | "environment-missing" | "environment-changed")[];
}

/**
 * The only input accepted by the formal boundary. It deliberately takes
 * summaries, not raw samples: the run accumulator owns sample aggregation.
 */
export interface FormalBenchmarkRunEvidence {
  readonly schedule: FormalBenchmarkScheduleIdentity;
  readonly run: Readonly<BenchmarkRunSummary>;
  readonly replay: Readonly<RenderReplaySummary>;
  readonly diagnostic: Readonly<FormalBenchmarkDiagnosticEvidence>;
  readonly readiness: Readonly<BenchmarkReadinessObservation>;
}

const RUN_KEYS = [
  "scenario", "variant", "runIndex", "startedAt", "endedAt", "durationMs",
  "expectedDurationMs", "durationOvershootMs", "durationValid", "frameInterval",
  "fullFrameCpu", "rendererFrameCpu", "gpu", "resources",
] as const;
const SERIES_KEYS = ["count", "average", "worst", "longFrames", "p50", "p95", "p99", "dropped"] as const;
const GPU_COVERAGE_KEYS = ["attempted", "covered", "dropped"] as const;
const GPU_AVAILABLE_KEYS = [
  ...SERIES_KEYS, "status", "coverage",
] as const;
const GPU_UNAVAILABLE_KEYS = [
  ...SERIES_KEYS, "status", "reason", "coverage",
] as const;
const RESOURCE_KEYS = ["peaks", "start", "end"] as const;
const PEAK_KEYS = ["counters", "bytes"] as const;
const REPLAY_KEYS = [
  "startedAtWallMs", "finishedAtWallMs", "wallDurationMs", "frameStepMs", "logicalDurationMs",
  "expectedDurationMs", "toleranceMs",
  "expectedFrames", "emittedFrames", "complete", "durationValid", "valid", "invalidReasons",
] as const;
const DIAGNOSTIC_KEYS = ["valid", "frameSequenceComplete", "frameFailures", "invalidReasons"] as const;
const READINESS_KEYS = [
  "capturedAt", "ready", "stableForMs", "stableSamples", "resourceSignature", "blockingReasons",
] as const;
const SCHEDULE_KEYS = [
  "scenario", "variant", "runIndex", "pairIndex", "comparisonId", "snapshotHash", "frameOrderHash",
  "environmentHash", "variantConfigHash", "warmPolicy", "cold",
] as const;

const REQUIRED_QUEUE_COUNTERS = [
  "terrain.active",
  "terrain.failed",
  "terrainSplat.active",
  "terrainSplat.failed",
  "environment.activeTiles",
  "environment.failedTiles",
  "environment.queuedModels",
  "environment.activeModels",
  "environment.deferredModels",
  "environment.failedModels",
  "environment.queuedGroups",
  "environment.activeGroups",
  "environment.deferredGroups",
  "environment.failedGroups",
  "environment.queuedAnimations",
  "environment.deferredAnimations",
  "environment.activeAnimations",
  "environment.failedAnimations",
  "assetWarmup.queued",
  "assetWarmup.active",
] as const;

const REPLAY_INVALID_REASONS = new Set(["incomplete-frame-sequence", "duration-out-of-range"]);
const DIAGNOSTIC_INVALID_REASONS = new Set([
  "frame-errors", "environment-missing", "environment-changed",
]);
const GPU_UNAVAILABLE_STATUSES = new Set(["cpu-only", "invalid", "unavailable"]);
const GPU_UNAVAILABLE_REASONS = new Set<BenchmarkGpuUnavailableReason>([
  "unsupported", "context-lost", "disjoint", "query-error", "not-provided", "queue-drop",
  "query-discard", "pending-at-finish", "mixed-availability", "sample-cap",
]);
const FORMAL_REPLAY_FRAME_STEP_MS = 1_000 / 60;
const FORMAL_REPLAY_LOGICAL_DURATION_MS = RENDER_REPLAY_EXPECTED_DURATION_MS;

/**
 * Converts one completed formal run into the strict paired-report boundary.
 * Every validity bit in the returned record is derived here; caller markers
 * are accepted only when they agree with the raw summary numbers.
 */
export function buildPairedBenchmarkRunRecord(
  input: Readonly<FormalBenchmarkRunEvidence>,
): Readonly<PairedBenchmarkRunRecord> {
  requireExactPlainObject(input, "evidence", ["schedule", "run", "replay", "diagnostic", "readiness"]);
  const schedule = validateSchedule(input.schedule);
  const run = validateRunSummary(input.run);
  const replay = validateReplaySummary(input.replay);
  const diagnostic = validateDiagnostic(input.diagnostic);
  const readiness = validateReadiness(input.readiness);

  if (run.gpu.status === "available"
    && (run.gpu.count !== PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT
      || run.gpu.coverage.attempted !== PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT
      || run.gpu.coverage.covered !== PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT
      || run.gpu.coverage.dropped !== 0
      || run.gpu.dropped !== 0)) {
    throw new Error("formal available GPU evidence must be exactly 5_400/5_400/0");
  }

  if (run.scenario !== schedule.scenario || run.variant !== schedule.variant || run.runIndex !== schedule.runIndex) {
    throw new Error("run scenario, variant, and runIndex must match the supplied schedule identity");
  }

  const runDuration = run.endedAt - run.startedAt;
  const replayDuration = replay.finishedAtWallMs - replay.startedAtWallMs;
  if (run.startedAt !== replay.startedAtWallMs || run.endedAt !== replay.finishedAtWallMs) {
    throw new Error("BenchmarkRunSummary and RenderReplaySummary timelines must have identical endpoints");
  }
  if (run.durationMs !== runDuration || replay.wallDurationMs !== replayDuration || runDuration !== replayDuration) {
    throw new Error("BenchmarkRunSummary and RenderReplaySummary durations must be derived and identical");
  }
  const durationValid = runDuration >= BENCHMARK_RUN_DURATION_MS
    && runDuration <= BENCHMARK_RUN_DURATION_MS + BENCHMARK_RUN_DURATION_TOLERANCE_MS;
  if (run.durationValid !== durationValid || replay.durationValid !== durationValid) {
    throw new Error("duration validity flags do not match the raw timeline");
  }
  if (runDuration < BENCHMARK_RUN_DURATION_MS || runDuration > BENCHMARK_RUN_DURATION_MS + BENCHMARK_RUN_DURATION_TOLERANCE_MS) {
    throw new RangeError("formal run duration must be within inclusive 90_000..90_250 ms");
  }

  const frameComplete = replay.expectedFrames === PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT
    && replay.emittedFrames === PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT;
  if (replay.complete !== frameComplete) throw new Error("replay.complete does not match emitted and expected frames");
  const expectedReplayReasons = [
    ...(frameComplete ? [] : ["incomplete-frame-sequence"]),
    ...(durationValid ? [] : ["duration-out-of-range"]),
  ];
  if (!sameStringArray(replay.invalidReasons, expectedReplayReasons)) {
    throw new Error("replay invalidReasons are not coherent with raw completion and duration");
  }
  if (replay.valid !== (frameComplete && durationValid)) {
    throw new Error("replay.valid does not match raw completion and duration");
  }
  if (!frameComplete) throw new Error("formal replay must emit exactly 5_400 frames");

  const cpuValid = run.fullFrameCpu.count === PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT
    && run.fullFrameCpu.dropped === 0
    && run.rendererFrameCpu.count === PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT
    && run.rendererFrameCpu.dropped === 0
    && (run.frameInterval.count === PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT - 1
      || run.frameInterval.count === PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT)
    && run.frameInterval.dropped === 0;
  if (!cpuValid) throw new Error("CPU diagnostic series must have 5_400 accepted full/renderer samples and no drops");

  const diagnosticValid = diagnostic.frameFailures === 0 && diagnostic.valid
    && diagnostic.frameSequenceComplete && diagnostic.invalidReasons.length === 0 && cpuValid;
  if (!diagnosticValid) throw new Error("diagnostic evidence is not valid for a formal run");
  if (readiness.capturedAt > run.startedAt || !readiness.ready) {
    throw new Error("readiness must be ready and captured no later than run start");
  }
  if (readiness.stableForMs < RENDER_BENCHMARK_STABLE_RESIDENCY_MS
    || readiness.stableSamples < RENDER_BENCHMARK_MIN_STABLE_SAMPLES
    || readiness.blockingReasons.length !== 0) {
    throw new Error("readiness evidence does not prove the required stable idle window");
  }
  validateRequiredQueuePeaks(run);

  const record: PairedBenchmarkRunRecord = {
    runIndex: schedule.runIndex,
    pairIndex: schedule.pairIndex,
    variant: schedule.variant,
    comparisonId: schedule.comparisonId,
    snapshotHash: schedule.snapshotHash,
    frameOrderHash: schedule.frameOrderHash,
    environmentHash: schedule.environmentHash,
    variantConfigHash: schedule.variantConfigHash,
    warmPolicy: schedule.warmPolicy,
    cold: schedule.cold,
    durationMs: runDuration,
    expectedDurationMs: BENCHMARK_RUN_DURATION_MS,
    durationValid: true,
    frameCount: PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT,
    expectedFrameCount: PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT,
    frameSequenceComplete: true,
    diagnosticValid: true,
    readinessValid: true,
    resourceLoadValid: true,
    cpu: {
      p95: run.fullFrameCpu.p95,
      p99: run.fullFrameCpu.p99,
    },
    gpu: cloneGpu(run.gpu),
  };
  validatePairedBenchmarkRunRecord(record);
  return deepFreeze(record);
}

function validateSchedule(value: unknown): FormalBenchmarkScheduleIdentity {
  requireExactPlainObject(value, "schedule", SCHEDULE_KEYS);
  const schedule = value as FormalBenchmarkScheduleIdentity;
  requireNonEmptyString(schedule.scenario, "schedule.scenario");
  if (schedule.variant !== "A" && schedule.variant !== "B") throw new TypeError("schedule.variant must be A or B");
  requireNonNegativeSafeInteger(schedule.runIndex, "schedule.runIndex");
  requireNonNegativeSafeInteger(schedule.pairIndex, "schedule.pairIndex");
  requireNonEmptyString(schedule.comparisonId, "schedule.comparisonId");
  requireHashLike(schedule.snapshotHash, "schedule.snapshotHash");
  requireHashLike(schedule.frameOrderHash, "schedule.frameOrderHash");
  requireHashLike(schedule.environmentHash, "schedule.environmentHash");
  requireHashLike(schedule.variantConfigHash, "schedule.variantConfigHash");
  if (schedule.warmPolicy !== PAIRED_BENCHMARK_WARM_POLICY) throw new Error("schedule.warmPolicy must be prewarmed-stable-cache");
  if (schedule.cold !== false) throw new Error("schedule.cold must be false");
  return schedule;
}

function validateRunSummary(value: unknown): BenchmarkRunSummary {
  requireExactPlainObject(value, "run", RUN_KEYS);
  const run = value as BenchmarkRunSummary;
  requireNonEmptyString(run.scenario, "run.scenario");
  if (run.variant !== "A" && run.variant !== "B") throw new TypeError("run.variant must be A or B");
  requireNonNegativeSafeInteger(run.runIndex, "run.runIndex");
  requireFinite(run.startedAt, "run.startedAt");
  requireFinite(run.endedAt, "run.endedAt");
  if (run.endedAt < run.startedAt) throw new RangeError("run.endedAt must not precede run.startedAt");
  requireFinite(run.durationMs, "run.durationMs");
  requireFinite(run.expectedDurationMs, "run.expectedDurationMs");
  requireFinite(run.durationOvershootMs, "run.durationOvershootMs");
  requireBoolean(run.durationValid, "run.durationValid");
  if (run.expectedDurationMs !== BENCHMARK_RUN_DURATION_MS) throw new Error("run.expectedDurationMs must equal 90_000");
  const derivedDuration = run.endedAt - run.startedAt;
  if (run.durationMs !== derivedDuration || run.durationOvershootMs !== Math.max(0, derivedDuration - BENCHMARK_RUN_DURATION_MS)) {
    throw new Error("run duration fields are not coherent with startedAt/endedAt");
  }
  validateSeries(run.frameInterval, "run.frameInterval");
  validateSeries(run.fullFrameCpu, "run.fullFrameCpu");
  validateSeries(run.rendererFrameCpu, "run.rendererFrameCpu");
  validateGpuSummary(run.gpu);
  if (!isPlainObject(run.resources)) throw new TypeError("run.resources must be a plain object");
  requireAllowedKeys(run.resources as unknown as Record<string, unknown>, "run.resources", RESOURCE_KEYS);
  if (!("peaks" in run.resources)) throw new TypeError("run.resources.peaks is required");
  validatePeaks(run.resources.peaks);
  return run;
}

function validateSeries(value: unknown, label: string, exact = true): void {
  if (exact) requireExactPlainObject(value, label, SERIES_KEYS);
  else if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const series = value as Record<string, unknown>;
  for (const key of SERIES_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(series, key)) throw new TypeError(`${label}.${key} is required`);
  }
  requireNonNegativeSafeInteger(series.count, `${label}.count`);
  requireNonNegativeSafeInteger(series.dropped, `${label}.dropped`);
  for (const key of ["average", "worst", "p50", "p95", "p99"] as const) {
    requireFinite(series[key], `${label}.${key}`);
    if ((series[key] as number) < 0) throw new RangeError(`${label}.${key} must be non-negative`);
  }
  requireNonNegativeSafeInteger(series.longFrames, `${label}.longFrames`);
  if ((series.count as number) > 0 && (series.average as number) > (series.worst as number)) {
    throw new RangeError(`${label}.average must be less than or equal to worst`);
  }
  if ((series.longFrames as number) > (series.count as number)) throw new RangeError(`${label}.longFrames must be less than or equal to count`);
  if ((series.p50 as number) > (series.p95 as number)) throw new RangeError(`${label}.p50 must be less than or equal to p95`);
  if ((series.p95 as number) > (series.p99 as number)) throw new RangeError(`${label}.p95 must be less than or equal to p99`);
  if ((series.p99 as number) > (series.worst as number)) throw new RangeError(`${label}.p99 must be less than or equal to worst`);
  if (series.count === 0
    && [series.average, series.worst, series.p50, series.p95, series.p99].some((metric) => metric !== 0)) {
    throw new RangeError(`${label} zero-count metrics must all be zero`);
  }
}

function validateGpuSummary(value: unknown): void {
  if (!isPlainObject(value)) throw new TypeError("run.gpu must be a plain object");
  const status = value.status;
  if (status === "available") {
    requireExactPlainObject(value, "run.gpu", GPU_AVAILABLE_KEYS);
    validateSeries(value, "run.gpu", false);
    validateGpuCoverage(value, value.coverage);
    return;
  }
  if (typeof status !== "string" || !GPU_UNAVAILABLE_STATUSES.has(status)) throw new TypeError("run.gpu.status is invalid");
  requireExactPlainObject(value, "run.gpu", GPU_UNAVAILABLE_KEYS);
  validateSeries(value, "run.gpu", false);
  if (typeof value.reason !== "string" || !GPU_UNAVAILABLE_REASONS.has(value.reason as BenchmarkGpuUnavailableReason)) {
    throw new TypeError("run.gpu.reason is invalid");
  }
  validateGpuCoverage(value, value.coverage);
}

function validateGpuCoverage(seriesValue: Record<string, unknown>, value: unknown): void {
  requireExactPlainObject(value, "run.gpu.coverage", GPU_COVERAGE_KEYS);
  const coverage = value as Record<string, unknown>;
  for (const key of GPU_COVERAGE_KEYS) requireNonNegativeSafeInteger(coverage[key], `run.gpu.coverage.${key}`);
  if (coverage.covered !== seriesValue.count) throw new Error("run.gpu.coverage.covered must equal run.gpu.count");
  if (coverage.dropped !== seriesValue.dropped) throw new Error("run.gpu.coverage.dropped must equal run.gpu.dropped");
  const attempted = coverage.attempted as number;
  const covered = coverage.covered as number;
  const dropped = coverage.dropped as number;
  if (BigInt(attempted) !== BigInt(covered) + BigInt(dropped)) {
    throw new Error("run.gpu.coverage.attempted must equal covered plus dropped");
  }
}

function validatePeaks(value: unknown): void {
  requireExactPlainObject(value, "run.resources.peaks", PEAK_KEYS);
  const peaks = value as Record<string, unknown>;
  if (!isPlainObject(peaks.counters) || !isPlainObject(peaks.bytes)) throw new TypeError("resource peaks maps must be plain objects");
  for (const [mapName, map] of [["counters", peaks.counters], ["bytes", peaks.bytes]] as const) {
    for (const [key, raw] of Object.entries(map)) {
      requireFinite(raw, `run.resources.peaks.${mapName}.${key}`);
      if (raw < 0) throw new RangeError(`run.resources.peaks.${mapName}.${key} must be non-negative`);
    }
  }
}

function validateRequiredQueuePeaks(run: BenchmarkRunSummary): void {
  const counters = run.resources.peaks.counters as Readonly<Record<string, number>>;
  for (const key of REQUIRED_QUEUE_COUNTERS) {
    if (!Object.prototype.hasOwnProperty.call(counters, key)) throw new Error(`missing required resource queue counter ${key}`);
    const value = counters[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value !== 0 || Object.is(value, -0)) {
      throw new Error(`resource queue counter ${key} must be exactly zero`);
    }
  }
}

function validateReplaySummary(value: unknown): RenderReplaySummary {
  requireExactPlainObject(value, "replay", REPLAY_KEYS);
  const replay = value as RenderReplaySummary;
  for (const key of [
    "startedAtWallMs", "finishedAtWallMs", "wallDurationMs", "frameStepMs", "logicalDurationMs",
    "expectedDurationMs", "toleranceMs",
  ] as const) {
    requireFinite(replay[key], `replay.${key}`);
  }
  requireNonNegativeSafeInteger(replay.expectedFrames, "replay.expectedFrames");
  requireNonNegativeSafeInteger(replay.emittedFrames, "replay.emittedFrames");
  requireBoolean(replay.complete, "replay.complete");
  requireBoolean(replay.durationValid, "replay.durationValid");
  requireBoolean(replay.valid, "replay.valid");
  if (replay.expectedDurationMs !== RENDER_REPLAY_EXPECTED_DURATION_MS || replay.toleranceMs !== RENDER_REPLAY_DURATION_TOLERANCE_MS) {
    throw new Error("replay schedule constants must be 90_000 ms and 250 ms");
  }
  if (!numbersEqual(replay.frameStepMs, FORMAL_REPLAY_FRAME_STEP_MS)) {
    throw new Error("formal replay frameStepMs must equal 60 Hz (1000/60)");
  }
  const derivedLogicalDurationMs = replay.expectedFrames * replay.frameStepMs;
  if (!numbersEqual(replay.logicalDurationMs, derivedLogicalDurationMs)
    || !numbersEqual(replay.logicalDurationMs, FORMAL_REPLAY_LOGICAL_DURATION_MS)) {
    throw new Error("formal replay logicalDurationMs must be 90_000 ms for 5_400 frames at 60 Hz");
  }
  if (replay.finishedAtWallMs < replay.startedAtWallMs || replay.wallDurationMs !== replay.finishedAtWallMs - replay.startedAtWallMs) {
    throw new Error("replay wall duration is not coherent with its endpoints");
  }
  if (!Array.isArray(replay.invalidReasons) || replay.invalidReasons.some((reason) => !REPLAY_INVALID_REASONS.has(reason))) {
    throw new TypeError("replay.invalidReasons contains an unsupported reason");
  }
  return replay;
}

function validateDiagnostic(value: unknown): FormalBenchmarkDiagnosticEvidence {
  requireExactPlainObject(value, "diagnostic", DIAGNOSTIC_KEYS);
  const diagnostic = value as FormalBenchmarkDiagnosticEvidence;
  requireBoolean(diagnostic.valid, "diagnostic.valid");
  requireBoolean(diagnostic.frameSequenceComplete, "diagnostic.frameSequenceComplete");
  requireNonNegativeSafeInteger(diagnostic.frameFailures, "diagnostic.frameFailures");
  if (!Array.isArray(diagnostic.invalidReasons) || diagnostic.invalidReasons.some((reason) => !DIAGNOSTIC_INVALID_REASONS.has(reason))) {
    throw new TypeError("diagnostic.invalidReasons contains an unsupported reason");
  }
  const frameError = diagnostic.frameFailures > 0;
  if (diagnostic.frameSequenceComplete !== !frameError || diagnostic.invalidReasons.includes("frame-errors") !== frameError) {
    throw new Error("diagnostic frame flags/reasons are incoherent with frameFailures");
  }
  if (diagnostic.valid !== (diagnostic.invalidReasons.length === 0)) throw new Error("diagnostic.valid does not match invalidReasons");
  return diagnostic;
}

function validateReadiness(value: unknown): BenchmarkReadinessObservation {
  requireExactPlainObject(value, "readiness", READINESS_KEYS);
  const readiness = value as BenchmarkReadinessObservation;
  requireFinite(readiness.capturedAt, "readiness.capturedAt");
  requireBoolean(readiness.ready, "readiness.ready");
  requireFinite(readiness.stableForMs, "readiness.stableForMs");
  if (readiness.stableForMs < 0) throw new RangeError("readiness.stableForMs must be non-negative");
  requireNonNegativeSafeInteger(readiness.stableSamples, "readiness.stableSamples");
  if (typeof readiness.resourceSignature !== "string" || readiness.resourceSignature.length === 0) throw new TypeError("readiness.resourceSignature must be non-empty");
  if (!Array.isArray(readiness.blockingReasons) || readiness.blockingReasons.some((reason) => typeof reason !== "string")) throw new TypeError("readiness.blockingReasons must be an array of strings");
  const enough = readiness.stableForMs >= RENDER_BENCHMARK_STABLE_RESIDENCY_MS
    && readiness.stableSamples >= RENDER_BENCHMARK_MIN_STABLE_SAMPLES
    && readiness.blockingReasons.length === 0;
  if (readiness.ready !== enough) throw new Error("readiness.ready does not match raw readiness evidence");
  return readiness;
}

function cloneGpu(value: BenchmarkRunSummary["gpu"]): PairedBenchmarkGpuInput {
  if (value.status === "available") {
    return {
      status: "available",
      p95: value.p95,
      p99: value.p99,
      coverage: {
        attempted: value.coverage.attempted,
        covered: value.coverage.covered,
        dropped: value.coverage.dropped,
      },
    };
  }
  return {
    status: value.status,
    reason: value.reason,
    coverage: {
      attempted: value.coverage.attempted,
      covered: value.coverage.covered,
      dropped: value.coverage.dropped,
    },
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function numbersEqual(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function requireHashLike(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 hash`);
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be non-empty`);
}

function requireFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
}

function requireNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
}

function requireBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactPlainObject(value: unknown, label: string, expectedKeys: readonly string[]): asserts value is Record<string, any> {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const ownKeys = Reflect.ownKeys(value);
  const actualKeys = ownKeys.filter((key): key is string => typeof key === "string");
  const unexpectedSymbols = ownKeys.filter((key) => typeof key === "symbol");
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const unexpected = actualKeys.filter((key) => !expectedKeys.includes(key));
  if (unexpectedSymbols.length > 0) unexpected.push(...unexpectedSymbols.map(String));
  if (missing.length > 0 || unexpected.length > 0) throw new TypeError(`${label} must contain exactly the expected keys`);
}

function requireAllowedKeys(value: Record<string, unknown>, label: string, allowedKeys: readonly string[]): void {
  const unexpected = Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowedKeys.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${label} contains unsupported keys`);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
