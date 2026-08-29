import {
  BENCHMARK_RUN_DURATION_MS,
  BENCHMARK_RUN_DURATION_TOLERANCE_MS,
  type BenchmarkGpuUnavailableReason,
} from "./RenderBenchmarkRun.js";

export type BenchmarkVariant = "A" | "B";
export type BenchmarkGate = "pass" | "warn" | "fail";

export const PAIRED_BENCHMARK_EXPECTED_DURATION_MS = BENCHMARK_RUN_DURATION_MS;
export const PAIRED_BENCHMARK_DURATION_TOLERANCE_MS = BENCHMARK_RUN_DURATION_TOLERANCE_MS;
export const PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT = 5_400;
export const PAIRED_BENCHMARK_WARM_POLICY = "prewarmed-stable-cache" as const;

export interface PairedBenchmarkMetricInput {
  readonly p95: number;
  readonly p99: number;
}

export interface PairedBenchmarkGpuCoverage {
  readonly attempted: number;
  readonly covered: number;
  readonly dropped: number;
}

export type PairedBenchmarkGpuInput =
  | Readonly<{
    status: "available";
    p95: number;
    p99: number;
    coverage: Readonly<PairedBenchmarkGpuCoverage>;
  }>
  | Readonly<{
    status: "cpu-only" | "invalid" | "unavailable";
    reason: BenchmarkGpuUnavailableReason;
    coverage: Readonly<PairedBenchmarkGpuCoverage>;
  }>;

/** One already-aggregated warm run. Raw frame samples deliberately do not cross this boundary. */
export interface PairedBenchmarkRunRecord {
  readonly runIndex: number;
  readonly pairIndex: number;
  readonly variant: BenchmarkVariant;
  readonly comparisonId: string;
  readonly snapshotHash: string;
  readonly frameOrderHash: string;
  /** Shared browser/WebGL capability/runtime identity; it deliberately does not identify hardware. */
  readonly environmentHash: string;
  readonly variantConfigHash: string;
  readonly warmPolicy: typeof PAIRED_BENCHMARK_WARM_POLICY;
  readonly cold: boolean;
  readonly durationMs: number;
  readonly expectedDurationMs: number;
  /** Caller diagnostic only; report validity is independently recomputed from durationMs. */
  readonly durationValid: boolean;
  readonly frameCount: number;
  readonly expectedFrameCount: number;
  /** Caller diagnostic only; report validity is independently recomputed from the frame counts. */
  readonly frameSequenceComplete: boolean;
  readonly diagnosticValid: boolean;
  readonly readinessValid: boolean;
  readonly resourceLoadValid: boolean;
  readonly cpu: Readonly<PairedBenchmarkMetricInput>;
  readonly gpu: PairedBenchmarkGpuInput;
}

export interface PairedBootstrapResult {
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
  readonly sampleCount: number;
}

export interface PairedBenchmarkMetricReport extends PairedBootstrapResult {
  readonly deltas: readonly number[];
  readonly ci95: Readonly<{ lower: number; upper: number }>;
  readonly thresholds: Readonly<{ warn: number; fail: number }>;
  readonly gate: BenchmarkGate;
}

export interface AvailableGpuReport {
  readonly status: "available";
  readonly gate: BenchmarkGate;
  readonly p95: Readonly<PairedBenchmarkMetricReport>;
  readonly p99: Readonly<PairedBenchmarkMetricReport>;
}

export interface UnavailableGpuReport {
  readonly status: "unavailable";
  readonly reason: "not-all-runs-valid-and-complete";
  readonly affectedRunIndices: readonly number[];
}

export interface PairedBenchmarkReport {
  readonly schemaVersion: 1;
  /** Pure aggregation is diagnostic only; formal eligibility is minted by the live runner. */
  readonly formalGateEligible: false;
  readonly runCount: 10;
  readonly pairCount: 5;
  readonly comparisonId: string;
  readonly snapshotHash: string;
  readonly frameOrderHash: string;
  readonly environmentHash: string;
  readonly variantConfigHashes: Readonly<{ A: string; B: string }>;
  readonly warmPolicy: typeof PAIRED_BENCHMARK_WARM_POLICY;
  readonly expectedDurationMs: typeof BENCHMARK_RUN_DURATION_MS;
  readonly durationToleranceMs: typeof BENCHMARK_RUN_DURATION_TOLERANCE_MS;
  readonly expectedFrameCount: typeof PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT;
  readonly bootstrap: Readonly<{
    method: "exhaustive-ordered-paired-mean";
    pairCount: 5;
    sampleCount: 3_125;
    confidence: 0.95;
    quantileRule: "nearest-rank";
  }>;
  readonly cpu: Readonly<{
    gate: BenchmarkGate;
    p95: Readonly<PairedBenchmarkMetricReport>;
    p99: Readonly<PairedBenchmarkMetricReport>;
  }>;
  readonly gpu: Readonly<AvailableGpuReport | UnavailableGpuReport>;
}

export type TrustedPairedBenchmarkReport = Readonly<
  Omit<PairedBenchmarkReport, "formalGateEligible"> & { readonly formalGateEligible: true }
>;

const PAIR_COUNT = 5 as const;
const RUN_COUNT = 10 as const;
const BOOTSTRAP_SAMPLE_COUNT = 3_125 as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const P95_THRESHOLDS = Object.freeze({ warn: 0.03, fail: 0.05 });
const P99_THRESHOLDS = Object.freeze({ warn: 0.05, fail: 0.10 });

const RUN_KEYS = [
  "runIndex", "pairIndex", "variant", "comparisonId", "snapshotHash", "frameOrderHash",
  "environmentHash", "variantConfigHash", "warmPolicy", "cold", "durationMs",
  "expectedDurationMs", "durationValid", "frameCount", "expectedFrameCount",
  "frameSequenceComplete", "diagnosticValid", "readinessValid", "resourceLoadValid", "cpu", "gpu",
] as const;
const METRIC_KEYS = ["p95", "p99"] as const;
const GPU_AVAILABLE_KEYS = ["status", "p95", "p99", "coverage"] as const;
const GPU_UNAVAILABLE_KEYS = ["status", "reason", "coverage"] as const;
const GPU_COVERAGE_KEYS = ["attempted", "covered", "dropped"] as const;
const GPU_UNAVAILABLE_STATUSES = new Set(["cpu-only", "invalid", "unavailable"]);
const GPU_UNAVAILABLE_REASONS = new Set<string>([
  "unsupported", "context-lost", "disjoint", "query-error", "not-provided", "queue-drop",
  "query-discard", "pending-at-finish", "mixed-availability", "sample-cap",
]);

export const PAIRED_BENCHMARK_ORDER: ReadonlyArray<Readonly<{
  runIndex: number;
  pairIndex: number;
  variant: BenchmarkVariant;
}>> = Object.freeze([
  Object.freeze({ runIndex: 0, pairIndex: 0, variant: "A" as const }),
  Object.freeze({ runIndex: 1, pairIndex: 0, variant: "B" as const }),
  Object.freeze({ runIndex: 2, pairIndex: 1, variant: "B" as const }),
  Object.freeze({ runIndex: 3, pairIndex: 1, variant: "A" as const }),
  Object.freeze({ runIndex: 4, pairIndex: 2, variant: "A" as const }),
  Object.freeze({ runIndex: 5, pairIndex: 2, variant: "B" as const }),
  Object.freeze({ runIndex: 6, pairIndex: 3, variant: "B" as const }),
  Object.freeze({ runIndex: 7, pairIndex: 3, variant: "A" as const }),
  Object.freeze({ runIndex: 8, pairIndex: 4, variant: "A" as const }),
  Object.freeze({ runIndex: 9, pairIndex: 4, variant: "B" as const }),
]);

/** Exhaustive ordered bootstrap of five run-level paired deltas, with nearest-rank quantiles. */
export function pairedBootstrapMean(deltas: readonly number[]): Readonly<PairedBootstrapResult> {
  if (deltas.length !== PAIR_COUNT) throw new RangeError(`bootstrap requires exactly ${PAIR_COUNT} paired deltas`);
  for (const [index, delta] of deltas.entries()) assertFinite(delta, `delta ${index}`);

  const means = new Float64Array(BOOTSTRAP_SAMPLE_COUNT);
  let sample = 0;
  for (let a = 0; a < PAIR_COUNT; a++) {
    for (let b = 0; b < PAIR_COUNT; b++) {
      for (let c = 0; c < PAIR_COUNT; c++) {
        for (let d = 0; d < PAIR_COUNT; d++) {
          for (let e = 0; e < PAIR_COUNT; e++) {
            means[sample++] = finiteMean5(
              deltas[a]!, deltas[b]!, deltas[c]!, deltas[d]!, deltas[e]!,
              `bootstrap sample ${sample}`,
            );
          }
        }
      }
    }
  }
  const sorted = Array.from(means).sort((left, right) => left - right);
  return Object.freeze({
    estimate: finiteMean5(deltas[0]!, deltas[1]!, deltas[2]!, deltas[3]!, deltas[4]!, "bootstrap estimate"),
    lower: nearestRank(sorted, 0.025),
    upper: nearestRank(sorted, 0.975),
    sampleCount: BOOTSTRAP_SAMPLE_COUNT,
  });
}

/** Strict JSON-boundary validator for one independently usable run record. */
export function validatePairedBenchmarkRunRecord(value: unknown): asserts value is PairedBenchmarkRunRecord {
  validateRunRecord(value, "record");
}

/** Validates and compares exactly five adjacent logical pairs; one bad run rejects the report. */
export function buildPairedBenchmarkReport(
  records: readonly Readonly<PairedBenchmarkRunRecord>[],
): Readonly<PairedBenchmarkReport> {
  if (!Array.isArray(records) || records.length !== RUN_COUNT) {
    throw new RangeError(`paired benchmark requires exactly ${RUN_COUNT} runs`);
  }
  for (let index = 0; index < records.length; index++) validateRunRecord(records[index], `run ${index}`);

  const first = records[0]!;
  const variantConfigHashes: Partial<Record<BenchmarkVariant, string>> = {};
  for (let index = 0; index < records.length; index++) {
    const run = records[index]!;
    const expected = PAIRED_BENCHMARK_ORDER[index]!;
    const label = `run ${index}`;
    if (run.runIndex !== expected.runIndex) throw new Error(`${label} must have runIndex ${expected.runIndex}`);
    if (run.pairIndex !== expected.pairIndex) throw new Error(`${label} must belong to pair ${expected.pairIndex}`);
    if (run.variant !== expected.variant) throw new Error(`${label} must use variant ${expected.variant}`);

    for (const field of [
      "comparisonId", "snapshotHash", "frameOrderHash", "environmentHash",
    ] as const) {
      if (run[field] !== first[field]) throw new Error(`${label} ${field} does not match run 0`);
    }

    const variant = run.variant as BenchmarkVariant;
    const establishedConfig = variantConfigHashes[variant];
    if (establishedConfig === undefined) {
      variantConfigHashes[variant] = run.variantConfigHash;
    } else if (run.variantConfigHash !== establishedConfig) {
      throw new Error(`${label} variant ${run.variant} variantConfigHash drifted within the comparison`);
    }
  }

  const configA = variantConfigHashes.A!;
  const configB = variantConfigHashes.B!;
  if (configA === configB) throw new Error("variant A and B configurations must be different");

  const cpuP95 = metricReport(pairDeltas(records, (run) => run.cpu.p95, "cpu.p95"), P95_THRESHOLDS);
  const cpuP99 = metricReport(pairDeltas(records, (run) => run.cpu.p99, "cpu.p99"), P99_THRESHOLDS);
  const cpu = {
    gate: worstGate(cpuP95.gate, cpuP99.gate),
    p95: cpuP95,
    p99: cpuP99,
  } as const;

  const affectedRunIndices = records
    .filter((run) => !gpuRunIsComplete(run))
    .map((run) => run.runIndex);
  const gpu: AvailableGpuReport | UnavailableGpuReport = affectedRunIndices.length > 0
    ? {
      status: "unavailable",
      reason: "not-all-runs-valid-and-complete",
      affectedRunIndices,
    }
    : availableGpuReport(records);

  return deepFreeze({
    schemaVersion: 1,
    formalGateEligible: false as const,
    runCount: RUN_COUNT,
    pairCount: PAIR_COUNT,
    comparisonId: first.comparisonId,
    snapshotHash: first.snapshotHash,
    frameOrderHash: first.frameOrderHash,
    environmentHash: first.environmentHash,
    variantConfigHashes: { A: configA, B: configB },
    warmPolicy: PAIRED_BENCHMARK_WARM_POLICY,
    expectedDurationMs: BENCHMARK_RUN_DURATION_MS,
    durationToleranceMs: BENCHMARK_RUN_DURATION_TOLERANCE_MS,
    expectedFrameCount: PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT,
    bootstrap: {
      method: "exhaustive-ordered-paired-mean",
      pairCount: PAIR_COUNT,
      sampleCount: BOOTSTRAP_SAMPLE_COUNT,
      confidence: 0.95,
      quantileRule: "nearest-rank",
    },
    cpu,
    gpu,
  });
}

function finiteMean5(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  label: string,
): number {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d), Math.abs(e));
  if (scale === 0) return 0;
  const mean = ((a / scale) + (b / scale) + (c / scale) + (d / scale) + (e / scale))
    / PAIR_COUNT * scale;
  assertFinite(mean, label);
  return mean;
}

function validateRunRecord(value: unknown, label: string): asserts value is PairedBenchmarkRunRecord {
  requireExactPlainObject(value, label, RUN_KEYS);
  const run = value as unknown as PairedBenchmarkRunRecord;

  requireNonNegativeSafeInteger(run.runIndex, `${label}.runIndex`);
  requireNonNegativeSafeInteger(run.pairIndex, `${label}.pairIndex`);
  if (run.variant !== "A" && run.variant !== "B") throw new TypeError(`${label}.variant must be A or B`);
  requireNonEmptyString(run.comparisonId, `${label}.comparisonId`);
  validateSha256(run.snapshotHash, `${label}.snapshotHash`);
  validateSha256(run.frameOrderHash, `${label}.frameOrderHash`);
  validateSha256(run.environmentHash, `${label}.environmentHash`);
  validateSha256(run.variantConfigHash, `${label}.variantConfigHash`);
  if (run.warmPolicy !== PAIRED_BENCHMARK_WARM_POLICY) {
    throw new Error(`${label}.warmPolicy must be ${PAIRED_BENCHMARK_WARM_POLICY}`);
  }
  if (run.cold !== false) throw new Error(`${label}.cold must be false`);

  assertFinite(run.durationMs, `${label}.durationMs`);
  if (run.durationMs < BENCHMARK_RUN_DURATION_MS
    || run.durationMs > BENCHMARK_RUN_DURATION_MS + BENCHMARK_RUN_DURATION_TOLERANCE_MS) {
    throw new RangeError(`${label}.durationMs must be within inclusive 90_000..90_250 ms`);
  }
  if (run.expectedDurationMs !== BENCHMARK_RUN_DURATION_MS) {
    throw new RangeError(`${label}.expectedDurationMs must equal 90_000`);
  }
  requireBoolean(run.durationValid, `${label}.durationValid`);
  if (run.frameCount !== PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT) {
    throw new RangeError(`${label}.frameCount must equal 5_400`);
  }
  if (run.expectedFrameCount !== PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT) {
    throw new RangeError(`${label}.expectedFrameCount must equal 5_400`);
  }
  requireBoolean(run.frameSequenceComplete, `${label}.frameSequenceComplete`);
  requireTrue(run.diagnosticValid, `${label}.diagnosticValid`);
  requireTrue(run.readinessValid, `${label}.readinessValid`);
  requireTrue(run.resourceLoadValid, `${label}.resourceLoadValid`);

  validateMetric(run.cpu, `${label}.cpu`);
  validateGpu(run.gpu, `${label}.gpu`);
}

function validateMetric(value: unknown, label: string): asserts value is PairedBenchmarkMetricInput {
  requireExactPlainObject(value, label, METRIC_KEYS);
  const metric = value as unknown as PairedBenchmarkMetricInput;
  validateQuantiles(metric.p95, metric.p99, label);
}

function validateGpu(value: unknown, label: string): asserts value is PairedBenchmarkGpuInput {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const status = value["status"];
  if (status === "available") {
    requireExactPlainObject(value, label, GPU_AVAILABLE_KEYS);
    validateQuantiles(value["p95"], value["p99"], label);
    validateGpuCoverage(value["coverage"], `${label}.coverage`);
    return;
  }
  if (typeof status !== "string" || !GPU_UNAVAILABLE_STATUSES.has(status)) {
    throw new TypeError(`${label}.status is not a supported GPU status`);
  }
  requireExactPlainObject(value, label, GPU_UNAVAILABLE_KEYS);
  if (typeof value["reason"] !== "string" || !GPU_UNAVAILABLE_REASONS.has(value["reason"])) {
    throw new TypeError(`${label}.reason is not a BenchmarkGpuUnavailableReason`);
  }
  validateGpuCoverage(value["coverage"], `${label}.coverage`);
}

function validateGpuCoverage(value: unknown, label: string): asserts value is PairedBenchmarkGpuCoverage {
  requireExactPlainObject(value, label, GPU_COVERAGE_KEYS);
  for (const field of GPU_COVERAGE_KEYS) {
    requireNonNegativeSafeInteger(value[field], `${label}.${field}`);
  }
}

function validateQuantiles(p95: unknown, p99: unknown, label: string): void {
  assertFinite(p95, `${label}.p95`);
  assertFinite(p99, `${label}.p99`);
  if (p95 < 0) throw new RangeError(`${label}.p95 must be non-negative`);
  if (p99 < 0) throw new RangeError(`${label}.p99 must be non-negative`);
  if (p95 > p99) throw new RangeError(`${label}.p95 must be less than or equal to ${label}.p99`);
}

function pairDeltas(
  records: readonly Readonly<PairedBenchmarkRunRecord>[],
  value: (run: Readonly<PairedBenchmarkRunRecord>) => number,
  label: string,
): number[] {
  const deltas: number[] = [];
  for (let pairIndex = 0; pairIndex < PAIR_COUNT; pairIndex++) {
    const first = records[pairIndex * 2]!;
    const second = records[pairIndex * 2 + 1]!;
    const baseline = first.variant === "A" ? first : second;
    const candidate = first.variant === "B" ? first : second;
    const a = value(baseline);
    const b = value(candidate);
    if (!(a > 0)) throw new RangeError(`pair ${pairIndex} ${label} baseline must be positive`);
    const delta = (b - a) / a;
    assertFinite(delta, `pair ${pairIndex} ${label} delta`);
    deltas.push(delta);
  }
  return deltas;
}

function gpuRunIsComplete(run: Readonly<PairedBenchmarkRunRecord>): boolean {
  const gpu = run.gpu;
  return gpu.status === "available"
    && gpu.coverage.attempted === run.frameCount
    && gpu.coverage.covered === run.frameCount
    && gpu.coverage.dropped === 0;
}

function availableGpuReport(records: readonly Readonly<PairedBenchmarkRunRecord>[]): AvailableGpuReport {
  const metric = (run: Readonly<PairedBenchmarkRunRecord>, name: "p95" | "p99"): number => {
    if (run.gpu.status !== "available") throw new Error("GPU availability changed during report construction");
    return run.gpu[name];
  };
  const p95 = metricReport(pairDeltas(records, (run) => metric(run, "p95"), "gpu.p95"), P95_THRESHOLDS);
  const p99 = metricReport(pairDeltas(records, (run) => metric(run, "p99"), "gpu.p99"), P99_THRESHOLDS);
  return { status: "available", gate: worstGate(p95.gate, p99.gate), p95, p99 };
}

function metricReport(
  deltas: readonly number[],
  thresholds: Readonly<{ warn: number; fail: number }>,
): PairedBenchmarkMetricReport {
  const bootstrap = pairedBootstrapMean(deltas);
  const gate: BenchmarkGate = bootstrap.upper > thresholds.fail
    ? "fail"
    : bootstrap.upper > thresholds.warn ? "warn" : "pass";
  return {
    ...bootstrap,
    deltas: [...deltas],
    ci95: { lower: bootstrap.lower, upper: bootstrap.upper },
    thresholds: { ...thresholds },
    gate,
  };
}

function worstGate(left: BenchmarkGate, right: BenchmarkGate): BenchmarkGate {
  if (left === "fail" || right === "fail") return "fail";
  if (left === "warn" || right === "warn") return "warn";
  return "pass";
}

function nearestRank(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

function validateSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError(`${field} must be a lowercase 64-character SHA-256 hash`);
  }
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must be non-empty`);
}

function assertFinite(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${field} must be finite`);
}

function requireNonNegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function requireBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
}

function requireTrue(value: unknown, field: string): asserts value is true {
  if (value !== true) throw new Error(`${field} must be true`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactPlainObject(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const ownKeys = Reflect.ownKeys(value);
  const symbolKey = ownKeys.find((key) => typeof key === "symbol");
  const actualKeys = ownKeys.filter((key): key is string => typeof key === "string");
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const unexpected = actualKeys.filter((key) => !expectedKeys.includes(key));
  if (symbolKey !== undefined) unexpected.push(symbolKey.toString());
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0 ? [`unexpected ${unexpected.join(", ")}`] : []),
    ].join("; ");
    throw new TypeError(`${label} must contain exactly the expected keys: ${details}`);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
