/**
 * A pure, run-level accumulator for the R1 warm benchmark.
 *
 * The live loop remains the owner of clocks, GPU queries, and replay state.
 * This class only accepts completed values, keeps a bounded append-only sample
 * set, and emits a summary without exposing raw samples.
 */

export const BENCHMARK_RUN_DURATION_MS = 90_000;
export const BENCHMARK_RUN_DURATION_TOLERANCE_MS = 250;
/** 90 seconds at 728 Hz; a full normal high-refresh run fits without rolling. */
export const BENCHMARK_RUN_SAMPLE_CAP = 65_536;
export const BENCHMARK_LONG_FRAME_THRESHOLD_MS = 50;

export type BenchmarkGpuUnavailableReason =
  | "unsupported"
  | "context-lost"
  | "disjoint"
  | "query-error"
  | "not-provided"
  | "queue-drop"
  | "query-discard"
  | "pending-at-finish"
  | "mixed-availability"
  | "sample-cap";

export type BenchmarkGpuSample =
  | { readonly status: "available"; readonly milliseconds: number }
  | { readonly status: "unavailable"; readonly reason: BenchmarkGpuUnavailableReason };

export type BenchmarkGpuDropReason = "queue-drop" | "query-discard" | "pending-at-finish";

export interface BenchmarkRunOptions {
  readonly scenario: string;
  readonly variant: string;
  readonly runIndex: number;
  readonly startedAt: number;
  /** Lower values make cap behaviour testable while never exceeding the production bound. */
  readonly sampleCap?: number;
}

export interface BenchmarkResourceCheckpointInput {
  readonly counters?: Readonly<Record<string, number>>;
  readonly bytes?: Readonly<Record<string, number>>;
}

export interface BenchmarkResourceCheckpoint {
  readonly counters?: Readonly<Record<string, number>>;
  readonly bytes?: Readonly<Record<string, number>>;
}

export interface BenchmarkSeriesSummary {
  readonly count: number;
  readonly average: number;
  readonly worst: number;
  readonly longFrames: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  /** Invalid samples and samples beyond the bounded cap share this count. */
  readonly dropped: number;
}

export type BenchmarkGpuStatus = "available" | "cpu-only" | "invalid" | "unavailable";

export type BenchmarkGpuSummary =
  | (BenchmarkSeriesSummary & {
    readonly status: "available";
    readonly coverage: {
      readonly attempted: number;
      readonly covered: number;
      readonly dropped: number;
    };
  })
  | (BenchmarkSeriesSummary & {
    readonly status: "cpu-only" | "invalid" | "unavailable";
    readonly reason: BenchmarkGpuUnavailableReason;
    readonly coverage: {
      readonly attempted: number;
      readonly covered: number;
      readonly dropped: number;
    };
  });

export interface BenchmarkResourcesSummary {
  readonly start?: BenchmarkResourceCheckpoint;
  readonly end?: BenchmarkResourceCheckpoint;
  readonly peaks: BenchmarkResourceCheckpoint;
}

export interface BenchmarkRunSummary {
  readonly scenario: string;
  readonly variant: string;
  readonly runIndex: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly expectedDurationMs: typeof BENCHMARK_RUN_DURATION_MS;
  readonly durationOvershootMs: number;
  /** A runner must reject a short warm run instead of comparing it as complete. */
  readonly durationValid: boolean;
  readonly frameInterval: BenchmarkSeriesSummary;
  readonly fullFrameCpu: BenchmarkSeriesSummary;
  readonly rendererFrameCpu: BenchmarkSeriesSummary;
  readonly gpu: BenchmarkGpuSummary;
  readonly resources: BenchmarkResourcesSummary;
}

type MutableResourceCheckpoint = {
  counters: Record<string, number>;
  bytes: Record<string, number>;
};

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function requireString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be non-empty`);
  return value;
}

function requireFinite(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  return value;
}

function requireNonNegative(name: string, value: unknown): number {
  const number = requireFinite(name, value);
  if (number < 0) throw new RangeError(`${name} must be non-negative`);
  return number;
}

function copyMetricMap(
  name: string,
  input: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${name} must be an object`);
  }
  const copy: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: requireNonNegative(`${name}.${key}`, value),
      writable: true,
    });
  }
  return Object.freeze(copy);
}

function copyResources(input: BenchmarkResourceCheckpointInput): BenchmarkResourceCheckpoint {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("resources must be an object");
  }
  const counters = copyMetricMap("resources.counters", input.counters);
  const bytes = copyMetricMap("resources.bytes", input.bytes);
  const result: { counters?: Readonly<Record<string, number>>; bytes?: Readonly<Record<string, number>> } = {};
  if (counters !== undefined) result.counters = counters;
  if (bytes !== undefined) result.bytes = bytes;
  return Object.freeze(result);
}

function mergePeaks(peaks: MutableResourceCheckpoint, checkpoint: BenchmarkResourceCheckpoint): void {
  for (const group of ["counters", "bytes"] as const) {
    const values = checkpoint[group];
    if (values === undefined) continue;
    for (const [key, value] of Object.entries(values)) {
      peaks[group][key] = Math.max(peaks[group][key] ?? 0, value);
    }
  }
}

function snapshotPeaks(peaks: MutableResourceCheckpoint): BenchmarkResourceCheckpoint {
  const counters = Object.freeze({ ...peaks.counters });
  const bytes = Object.freeze({ ...peaks.bytes });
  return Object.freeze({ counters, bytes });
}

class BoundedSeries {
  readonly #samples: Float64Array;
  #count = 0;
  #dropped = 0;
  #average = 0;

  constructor(readonly cap: number) {
    this.#samples = new Float64Array(cap);
  }

  add(milliseconds: number): boolean {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || this.#count >= this.cap) {
      this.#dropped++;
      return false;
    }
    this.#count++;
    this.#samples[this.#count - 1] = milliseconds;
    // This form avoids overflowing a sum when valid samples are finite.
    this.#average = this.#count === 1
      ? milliseconds
      : this.#average * ((this.#count - 1) / this.#count) + milliseconds / this.#count;
    return true;
  }

  get count(): number {
    return this.#count;
  }

  get dropped(): number {
    return this.#dropped;
  }

  summary(): BenchmarkSeriesSummary {
    const sorted = Array.from(this.#samples.subarray(0, this.#count));
    sorted.sort((left, right) => left - right);
    let worst = 0;
    let longFrames = 0;
    for (const sample of sorted) {
      worst = Math.max(worst, sample);
      if (sample > BENCHMARK_LONG_FRAME_THRESHOLD_MS) longFrames++;
    }
    return Object.freeze({
      count: this.#count,
      average: this.#count === 0 ? 0 : this.#average,
      worst,
      longFrames,
      p50: nearestRank(sorted, 0.5),
      p95: nearestRank(sorted, 0.95),
      p99: nearestRank(sorted, 0.99),
      dropped: this.#dropped,
    });
  }
}

function nearestRank(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

/**
 * Collects one 90-second (warm) run. It deliberately never derives FPS: work
 * duration is not frame cadence, and the replay owns frame ordering.
 */
export class BenchmarkRunAccumulator {
  readonly #scenario: string;
  readonly #variant: string;
  readonly #runIndex: number;
  readonly #startedAt: number;
  readonly #frameInterval: BoundedSeries;
  readonly #fullFrameCpu: BoundedSeries;
  readonly #rendererFrameCpu: BoundedSeries;
  readonly #gpu: BoundedSeries;
  #gpuAttempted = 0;
  #gpuQueueDropped = 0;
  readonly #resourcesPeaks: MutableResourceCheckpoint = { counters: {}, bytes: {} };
  #resourceStart: BenchmarkResourceCheckpoint | undefined;
  #resourceEnd: BenchmarkResourceCheckpoint | undefined;
  #gpuStatus: BenchmarkGpuStatus = "unavailable";
  #gpuReason: BenchmarkGpuUnavailableReason = "not-provided";
  #sealedAt: number | undefined;
  #finished = false;
  #aborted = false;

  constructor(options: BenchmarkRunOptions) {
    this.#scenario = requireString("scenario", options.scenario);
    this.#variant = requireString("variant", options.variant);
    this.#startedAt = requireFinite("startedAt", options.startedAt);
    if (!Number.isSafeInteger(options.runIndex) || options.runIndex < 0) {
      throw new RangeError("runIndex must be a non-negative safe integer");
    }
    this.#runIndex = options.runIndex;
    const cap = options.sampleCap ?? BENCHMARK_RUN_SAMPLE_CAP;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > BENCHMARK_RUN_SAMPLE_CAP) {
      throw new RangeError(`sampleCap must be an integer from 1 to ${BENCHMARK_RUN_SAMPLE_CAP}`);
    }
    this.#fullFrameCpu = new BoundedSeries(cap);
    this.#frameInterval = new BoundedSeries(cap);
    this.#rendererFrameCpu = new BoundedSeries(cap);
    this.#gpu = new BoundedSeries(cap);
  }

  addFullFrameCpu(milliseconds: number): void {
    this.#assertMeasurementOpen();
    this.#fullFrameCpu.add(milliseconds);
  }

  /** Records the RAF-to-RAF cadence separately from synchronous work duration. */
  addFrameInterval(milliseconds: number): void {
    this.#assertMeasurementOpen();
    this.#frameInterval.add(milliseconds);
  }

  addRendererFrameCpu(milliseconds: number): void {
    this.#assertMeasurementOpen();
    this.#rendererFrameCpu.add(milliseconds);
  }

  addGpuSample(sample: BenchmarkGpuSample): void {
    this.#assertGpuOpen();
    if (sample.status === "available") {
      this.#gpuAttempted++;
      if (!Number.isFinite(sample.milliseconds) || sample.milliseconds < 0) {
        this.#gpu.add(sample.milliseconds);
        this.#invalidateGpu("query-error");
        return;
      }
      const accepted = this.#gpu.add(sample.milliseconds);
      if (!accepted) {
        this.#invalidateGpu("sample-cap");
        return;
      }
      if (this.#gpuStatus === "cpu-only") {
        this.#invalidateGpu("mixed-availability");
      } else if (this.#gpuStatus === "unavailable") {
        this.#gpuStatus = "available";
        this.#gpuReason = "not-provided";
      }
      return;
    }
    if (sample.reason === "unsupported") {
      if (this.#gpuStatus === "available" || this.#gpu.count > 0) {
        this.#invalidateGpu("mixed-availability");
      } else if (this.#gpuStatus !== "invalid") {
        this.#gpuStatus = "cpu-only";
        this.#gpuReason = sample.reason;
      }
      return;
    }
    this.#invalidateGpu(sample.reason);
  }

  /** Records GPU queries skipped by the async timer queue; this invalidates coverage. */
  addGpuDropped(count: number, reason: BenchmarkGpuDropReason = "queue-drop"): void {
    this.#assertGpuOpen();
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("GPU dropped count must be a non-negative safe integer");
    }
    if (count > Number.MAX_SAFE_INTEGER - this.#gpuAttempted) {
      throw new RangeError("GPU attempted count exceeds safe integer range");
    }
    this.#gpuAttempted += count;
    this.#gpuQueueDropped += count;
    if (count > 0) this.#invalidateGpu(reason);
  }

  recordResourceStart(checkpoint: BenchmarkResourceCheckpointInput): void {
    this.#assertMeasurementOpen();
    if (this.#resourceStart !== undefined) throw new Error("resource start already recorded");
    this.#resourceStart = copyResources(checkpoint);
    mergePeaks(this.#resourcesPeaks, this.#resourceStart);
  }

  recordResourceCheckpoint(checkpoint: BenchmarkResourceCheckpointInput): void {
    this.#assertMeasurementOpen();
    mergePeaks(this.#resourcesPeaks, copyResources(checkpoint));
  }

  recordResourceEnd(checkpoint: BenchmarkResourceCheckpointInput): void {
    this.#assertMeasurementOpen();
    if (this.#resourceEnd !== undefined) throw new Error("resource end already recorded");
    this.#resourceEnd = copyResources(checkpoint);
    mergePeaks(this.#resourcesPeaks, this.#resourceEnd);
  }

  sealMeasurement(endedAt: number, endResources?: BenchmarkResourceCheckpointInput): void {
    this.#assertMeasurementOpen();
    const end = requireFinite("endedAt", endedAt);
    if (end < this.#startedAt) throw new RangeError("endedAt must not precede startedAt");
    const durationMs = end - this.#startedAt;
    if (!Number.isFinite(durationMs)) throw new RangeError("duration must be finite");
    if (endResources !== undefined) this.recordResourceEnd(endResources);
    this.#sealedAt = end;
  }

  finishAfterGpuDrain(): Readonly<BenchmarkRunSummary> {
    this.#assertNotAborted();
    if (this.#finished) throw new Error("benchmark run is already finished");
    if (this.#sealedAt === undefined) throw new Error("benchmark measurement must be sealed before GPU drain finish");
    this.#finished = true;
    const end = this.#sealedAt;
    const durationMs = end - this.#startedAt;
    const gpuStatus = this.#gpuStatus;
    const gpuBase = this.#gpu.summary();
    const gpuDropped = gpuBase.dropped + this.#gpuQueueDropped;
    const coverage = {
      attempted: this.#gpuAttempted,
      covered: gpuBase.count,
      dropped: gpuDropped,
    };
    const gpu = gpuStatus === "available"
      ? { ...gpuBase, dropped: gpuDropped, status: "available" as const, coverage }
      : { ...gpuBase, dropped: gpuDropped, status: gpuStatus, reason: this.#gpuReason, coverage };
    const summary: BenchmarkRunSummary = {
      scenario: this.#scenario,
      variant: this.#variant,
      runIndex: this.#runIndex,
      startedAt: this.#startedAt,
      endedAt: end,
      durationMs,
      expectedDurationMs: BENCHMARK_RUN_DURATION_MS,
      durationOvershootMs: Math.max(0, durationMs - BENCHMARK_RUN_DURATION_MS),
      durationValid: durationMs >= BENCHMARK_RUN_DURATION_MS
        && durationMs <= BENCHMARK_RUN_DURATION_MS + BENCHMARK_RUN_DURATION_TOLERANCE_MS,
      frameInterval: this.#frameInterval.summary(),
      fullFrameCpu: this.#fullFrameCpu.summary(),
      rendererFrameCpu: this.#rendererFrameCpu.summary(),
      gpu,
      resources: {
        ...(this.#resourceStart === undefined ? {} : { start: this.#resourceStart }),
        ...(this.#resourceEnd === undefined ? {} : { end: this.#resourceEnd }),
        peaks: snapshotPeaks(this.#resourcesPeaks),
      },
    };
    return freezeDeep(summary);
  }

  finish(endedAt: number, endResources?: BenchmarkResourceCheckpointInput): Readonly<BenchmarkRunSummary> {
    this.sealMeasurement(endedAt, endResources);
    return this.finishAfterGpuDrain();
  }

  abort(): void {
    if (this.#finished) throw new Error("benchmark run is already finished");
    if (this.#aborted) throw new Error("benchmark run is already aborted");
    this.#aborted = true;
  }

  #assertNotAborted(): void {
    if (this.#aborted) throw new Error("benchmark run is already aborted");
  }

  #assertMeasurementOpen(): void {
    this.#assertNotAborted();
    if (this.#finished) throw new Error("benchmark run is already finished");
    if (this.#sealedAt !== undefined) throw new Error("benchmark measurement is already sealed");
  }

  #assertGpuOpen(): void {
    this.#assertNotAborted();
    if (this.#finished) throw new Error("benchmark run is already finished");
  }

  #invalidateGpu(reason: BenchmarkGpuUnavailableReason): void {
    if (this.#gpuStatus === "invalid") return;
    this.#gpuStatus = "invalid";
    this.#gpuReason = reason;
  }
}
