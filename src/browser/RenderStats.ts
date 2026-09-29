import type { GpuTimerReading } from "./GpuTimer.js";
import type { WarmFetchQueueStats } from "./AssetWarmup.js";
import type { EnvironmentStats, TerrainStats } from "./Terrain.js";
import type { TerrainSplatStats } from "./TerrainSplat.js";
import {
  immutableResourceAccountingSnapshot,
  type ResourceAccountingSnapshot,
} from "./ResourceAccounting.js";
import type { BenchmarkClientReadinessInput } from "./RenderBenchmarkReadiness.js";

/**
 * How long frames are taking, and what they cost.
 *
 * Every budget in the renderer carries a comment saying slice R8 is where its number stops being
 * guessed at, and none of them could be: nothing in the client measured a frame. This is the
 * instrument — a ring of the last two seconds of frame times, and the draw calls and triangles the
 * WebGL renderer reports — and it is a module of its own because a ring buffer and a percentile are
 * exactly the kind of thing that is wrong by one and never noticed.
 *
 * The worst frame matters more than the mean. Sixty frames a second with one frame of eighty
 * milliseconds in every hundred reads as a stutter, and a mean of 17 ms hides it completely.
 */

/** Two seconds at sixty frames, which is long enough for one hitch to still be in the window. */
export const FRAME_WINDOW = 120;

/** A frame above this budget is long; exactly 50 ms is deliberately not counted. */
export const LONG_FRAME_THRESHOLD_MS = 50;

/** A read-only view of the frame-time window, including its tail latencies. */
export interface FrameSnapshot {
  readonly count: number;
  readonly average: number;
  readonly worst: number;
  readonly longFrames: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/** Immutable renderer-only telemetry, deliberately limited to exact counters and timings. */
export interface RendererTelemetrySnapshot {
  readonly cpu: Readonly<FrameSnapshot>;
  readonly gpu: Readonly<GpuTimerReading>;
  /** Actual requestAnimationFrame cadence, not the reciprocal of CPU or GPU work time. */
  readonly observedFps: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly unitsDrawn: number;
  readonly unitsDropped: number;
  readonly gameObjectsDrawn: number;
  readonly gameObjectsDropped: number;
  readonly effectsDrawn: number;
  readonly effectsDropped: number;
  readonly groundCoverDrawn: number;
  readonly groundCoverSelected: number;
  readonly groundCoverSelectionDroppedCells: number;
  readonly groundCoverResidentMeshes: number;
  readonly wmoPortalModels: number;
  readonly wmoPortalCandidates: number;
  readonly wmoPortalCulled: number;
  /** Exact WebGLRenderer.info.memory object counts; no guessed byte estimate is included. */
  readonly textureCount: number;
  readonly geometryCount: number;
}

/** Client-side resource counters and explicitly labelled estimates captured with one reading. */
export interface RenderResourcesSnapshot {
  readonly terrain?: Readonly<TerrainStats>;
  readonly environment?: Readonly<EnvironmentStats>;
  readonly terrainSplat?: Readonly<TerrainSplatStats>;
  readonly assetWarmup?: Readonly<WarmFetchQueueStats>;
  /** Exact retained CPU buffers plus a logical GPU buffer estimate, with named coverage gaps. */
  readonly accounting?: Readonly<ResourceAccountingSnapshot>;
}

/** Input shape permits optional chaining while the immutable output records absent clients explicitly. */
export interface RenderResourcesInput {
  readonly terrain?: Readonly<TerrainStats> | undefined;
  readonly environment?: Readonly<EnvironmentStats> | undefined;
  readonly terrainSplat?: Readonly<TerrainSplatStats> | undefined;
  readonly assetWarmup?: Readonly<WarmFetchQueueStats> | undefined;
  readonly accounting?: Readonly<ResourceAccountingSnapshot> | undefined;
}

/** Immutable full-frame plus renderer telemetry captured at one caller-supplied timestamp. */
export interface RenderTelemetrySnapshot {
  readonly capturedAt: number;
  readonly fullFrame: Readonly<FrameSnapshot>;
  readonly renderer: Readonly<RendererTelemetrySnapshot> | undefined;
  readonly resources: Readonly<RenderResourcesSnapshot>;
  /** Live asynchronous owners captured beside renderer/resource telemetry; absent is fail-closed. */
  readonly benchmarkClients: Readonly<BenchmarkClientReadinessInput> | undefined;
}

function immutableBenchmarkClients(
  clients: Readonly<BenchmarkClientReadinessInput>,
): Readonly<BenchmarkClientReadinessInput> {
  const copy = (stats: BenchmarkClientReadinessInput[keyof BenchmarkClientReadinessInput]) =>
    Object.freeze({
      pending: stats.pending,
      success: stats.success,
      error: stats.error,
      generation: stats.generation,
    });
  return Object.freeze({
    light: copy(clients.light),
    liquids: copy(clients.liquids),
    groundCover: copy(clients.groundCover),
    horizon: copy(clients.horizon),
    transportPaths: copy(clients.transportPaths),
    creatureModels: copy(clients.creatureModels),
    creatureMetadata: copy(clients.creatureMetadata),
    gameObjectMetadata: copy(clients.gameObjectMetadata),
    itemMetadata: copy(clients.itemMetadata),
    collision: copy(clients.collision),
  });
}

function immutableFrame(snapshot: Readonly<FrameSnapshot>): Readonly<FrameSnapshot> {
  return Object.freeze({ ...snapshot });
}

function immutableResources(resources: RenderResourcesInput): Readonly<RenderResourcesSnapshot> {
  const snapshot: {
    terrain?: Readonly<TerrainStats>;
    environment?: Readonly<EnvironmentStats>;
    terrainSplat?: Readonly<TerrainSplatStats>;
    assetWarmup?: Readonly<WarmFetchQueueStats>;
    accounting?: Readonly<ResourceAccountingSnapshot>;
  } = {};
  if (resources.terrain !== undefined) snapshot.terrain = Object.freeze({ ...resources.terrain });
  if (resources.environment !== undefined) snapshot.environment = Object.freeze({ ...resources.environment });
  if (resources.terrainSplat !== undefined) snapshot.terrainSplat = Object.freeze({ ...resources.terrainSplat });
  if (resources.assetWarmup !== undefined) snapshot.assetWarmup = Object.freeze({ ...resources.assetWarmup });
  if (resources.accounting !== undefined) {
    snapshot.accounting = immutableResourceAccountingSnapshot(resources.accounting);
  }
  return Object.freeze(snapshot);
}

/** Copies and freezes a renderer reading so public telemetry cannot mutate live state. */
export function makeRendererTelemetrySnapshot(
  snapshot: RendererTelemetrySnapshot,
): Readonly<RendererTelemetrySnapshot> {
  return Object.freeze({
    ...snapshot,
    cpu: immutableFrame(snapshot.cpu),
    gpu: Object.freeze({ ...snapshot.gpu }),
  });
}

/** Copies and freezes one complete telemetry capture, including its nested readings. */
export function makeRenderTelemetrySnapshot(
  capturedAt: number,
  fullFrame: Readonly<FrameSnapshot>,
  renderer: Readonly<RendererTelemetrySnapshot> | undefined,
  resources: RenderResourcesInput = {},
  benchmarkClients?: Readonly<BenchmarkClientReadinessInput>,
): Readonly<RenderTelemetrySnapshot> {
  return Object.freeze({
    capturedAt,
    fullFrame: immutableFrame(fullFrame),
    renderer: renderer === undefined ? undefined : makeRendererTelemetrySnapshot(renderer),
    resources: immutableResources(resources),
    benchmarkClients: benchmarkClients === undefined ? undefined : immutableBenchmarkClients(benchmarkClients),
  });
}

export class FrameClock {
  readonly #samples: Float64Array;
  #at = 0;
  #filled = 0;
  #total = 0;

  constructor(window = FRAME_WINDOW) {
    this.#samples = new Float64Array(Math.max(1, Math.floor(window)));
  }

  /** One frame, in milliseconds. Anything not finite is dropped rather than poisoning the mean. */
  add(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const size = this.#samples.length;
    this.#total += milliseconds - (this.#filled === size ? this.#samples[this.#at]! : 0);
    this.#samples[this.#at] = milliseconds;
    this.#at = (this.#at + 1) % size;
    if (this.#filled < size) this.#filled++;
  }

  get count(): number {
    return this.#filled;
  }

  /** The mean frame time over the window, or zero before the first frame. */
  get average(): number {
    return this.#filled === 0 ? 0 : this.#total / this.#filled;
  }

  /**
   * The longest frame in the window, which is the one the player feels.
   *
   * The maximum rather than a high percentile, and that is a deliberate choice: a run that stutters
   * five times a second has a ninety-fifth percentile of exactly its good frame, because 95% of its
   * frames *are* good. The window is two seconds, so this is "the worst frame in the last two
   * seconds" and not a lifetime record that never recovers.
   */
  get worst(): number {
    let worst = 0;
    for (let index = 0; index < this.#filled; index++) worst = Math.max(worst, this.#samples[index]!);
    return worst;
  }

  /**
   * Read an immutable copy of the current window.
   *
   * Percentiles use the nearest-rank convention: after ascending sort, p is the value at
   * one-based rank ceil(p * count). An empty window reports zero for every field. The copy and
   * sort happen here, never on the add() hot path, and the ring is read in chronological order so
   * a wrapped window is included exactly once.
   */
  snapshot(): Readonly<FrameSnapshot> {
    const sorted = new Float64Array(this.#filled);
    const size = this.#samples.length;
    const first = (this.#at - this.#filled + size) % size;
    let longFrames = 0;
    for (let index = 0; index < this.#filled; index++) {
      const sample = this.#samples[(first + index) % size]!;
      sorted[index] = sample;
      if (sample > LONG_FRAME_THRESHOLD_MS) longFrames++;
    }
    sorted.sort();

    const count = this.#filled;
    const average = this.average;
    return Object.freeze({
      count,
      average,
      worst: this.worst,
      longFrames,
      p50: this.#percentile(sorted, 0.5),
      p95: this.#percentile(sorted, 0.95),
      p99: this.#percentile(sorted, 0.99),
    });
  }

  reset(): void {
    this.#samples.fill(0);
    this.#at = 0;
    this.#filled = 0;
    this.#total = 0;
  }

  #percentile(sorted: Float64Array, fraction: number): number {
    if (sorted.length === 0) return 0;
    return sorted[Math.ceil(fraction * sorted.length) - 1]!;
  }
}

/** Actual frame cadence from consecutive requestAnimationFrame timestamps. */
export class FrameCadenceClock {
  readonly #intervals: FrameClock;
  #previousAt: number | undefined;

  constructor(window = FRAME_WINDOW) {
    this.#intervals = new FrameClock(window);
  }

  /** The first timestamp establishes a baseline and is never invented into a frame interval. */
  observe(timestamp: number): number | undefined {
    if (!Number.isFinite(timestamp)) return undefined;
    const previousAt = this.#previousAt;
    if (previousAt !== undefined && timestamp < previousAt) return undefined;
    this.#previousAt = timestamp;
    if (previousAt === undefined) return undefined;
    const interval = timestamp - previousAt;
    this.#intervals.add(interval);
    return interval;
  }

  get fps(): number {
    const interval = this.#intervals.average;
    return interval > 0 ? 1000 / interval : 0;
  }

  /** Interval statistics for low-frequency HUD updates, not synchronous render/GPU cost. */
  snapshot(): Readonly<FrameSnapshot> {
    return this.#intervals.snapshot();
  }

  reset(): void {
    this.#previousAt = undefined;
    this.#intervals.reset();
  }
}

/**
 * Measures synchronous work performed by one animation callback.
 *
 * The renderer's {@link FrameClock} is intentionally a separate instance: it measures the world
 * update/submission plus dirty portrait render/readback envelope, while this clock measures the
 * whole callback. `measure`
 * samples immediately before and after the callback, so time spent waiting for the next
 * requestAnimationFrame is never included, and `finally` records a callback even when it throws.
 */
export class FullFrameClock {
  readonly #frames: FrameClock;
  readonly #now: () => number;
  #startedAt: number | undefined;

  constructor(window = FRAME_WINDOW, now: () => number = () => performance.now()) {
    this.#frames = new FrameClock(window);
    this.#now = now;
  }

  /** Starts one synchronous callback measurement without allocating a per-frame closure. */
  begin(): void {
    if (this.#startedAt !== undefined) throw new Error("FullFrameClock.begin() called while active");
    this.#startedAt = this.#now();
  }

  /** Ends the active measurement and records it, even when the callback's work threw. */
  end(): number {
    const startedAt = this.#startedAt;
    this.#startedAt = undefined;
    if (startedAt === undefined) throw new Error("FullFrameClock.end() called before begin()");
    const elapsed = this.#now() - startedAt;
    this.#frames.add(elapsed);
    return elapsed;
  }

  measure<T>(work: () => T): T {
    this.begin();
    try {
      return work();
    } finally {
      this.end();
    }
  }

  snapshot(): Readonly<FrameSnapshot> {
    return this.#frames.snapshot();
  }

  reset(): void {
    this.#frames.reset();
  }
}

/**
 * One slow frame broken down by loop section, recorded by the render loop for hitch diagnosis.
 *
 * A hitch while walking is almost never "the renderer is slow": it is one section — a tile
 * landing that rebuilds terrain, a reselect over tens of thousands of placements, a collision
 * rebuild, or a burst of model builds — eating a whole frame. The ring this feeds is what
 * `webclientHitches()` prints, so the sections have to be cheap numbers, never objects.
 */
export interface FrameHitch {
  readonly at: number;
  readonly total: number;
  readonly sections: Readonly<Record<string, number>>;
  /** Non-timing note, e.g. what the submit allocated; appended to the summary when present. */
  readonly detail?: string;
}

/**
 * The hottest sections of a hitch, hottest first, for the status line and the console.
 *
 * Pure over the record so a diagnostics test can pin the wording without a frame: non-finite
 * entries (sections a frame never reached, like the world pass on a loading screen) are
 * skipped rather than printed as NaN.
 */
export function summarizeFrameHitch(hitch: Readonly<FrameHitch>, top = 2): string {
  const entries = Object.entries(hitch.sections)
    .filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .sort((left, right) => right[1] - left[1])
    .slice(0, Math.max(0, top));
  const sections = entries
    .map(([name, ms]) => `${name} ${ms.toFixed(ms < 10 ? 1 : 0)}мс`)
    .join(", ");
  return `фриз ${hitch.total.toFixed(0)}мс${sections ? `: ${sections}` : ""}`
    + (hitch.detail ? ` [${hitch.detail}]` : "");
}

/**
 * The hottest average sections of ordinary frames, hottest first.
 *
 * The hitch ring covers frames over 50 ms; this covers the baseline — where the usual
 * 13 ms go when nothing dramatic happens. Pure over caller-kept sums so the wording is
 * testable without a frame; entries with no samples are skipped.
 */
export function topSectionAverages(
  sums: Readonly<Record<string, number>>,
  count: number,
  top = 5,
): string {
  if (!(count > 0)) return "";
  return Object.entries(sums)
    .filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0)
    .map(([name, sum]): [string, number] => [name, sum / count])
    .filter((entry): entry is [string, number] => entry[1] > 0.05)
    .sort((left, right) => right[1] - left[1])
    .slice(0, Math.max(0, top))
    .map(([name, average]) => `${name} ${average.toFixed(1)}`)
    .join(", ");
}

/**
 * Whether the environment ranking has to run again.
 *
 * It costs 1.26 milliseconds a frame in Stormwind — 42,797 placements over the nine tiles around
 * the city, ranked from scratch every frame, standing still included — which is 7.6% of a sixteen
 * millisecond budget spent to arrive at the answer it already had. That measurement was at the
 * former 230-yard leash; the live leash is now 300 yards, while the selected placement budget is
 * unchanged. Four yards is still small enough that nothing is ever drawn late.
 *
 * The generation is the other half: a tile landing adds placements, and the cache has to notice.
 */
export const RESELECT_DISTANCE = 4;

export function shouldReselect(
  last: { x: number; y: number; generation: number } | undefined,
  player: { x: number; y: number },
  generation: number,
  distance = RESELECT_DISTANCE,
): boolean {
  if (!last || last.generation !== generation) return true;
  return Math.hypot(player.x - last.x, player.y - last.y) >= distance;
}
