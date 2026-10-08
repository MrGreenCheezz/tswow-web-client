/**
 * P1-04: the freeze recording's per-frame extras (`game/PerformanceCapture.ts`), kept apart as
 * plain classes so a test can drive them without a renderer.
 *
 * - {@link PhaseAccumulator}: sum, maximum and count of every `drawPhaseMs` key over every recorded
 *   frame, not only the slow ones `cpuSections` keeps.
 * - {@link StackingProbe}: the "budget stacking" sensor of ARC-5 — how many budgeted phases fired in
 *   one frame, and how many frames had two or more that together passed 4 ms.
 * - {@link FrameExtraColumns}: packet and FrameXML-step milliseconds per recorded frame row,
 *   parallel to `frames`; the frame rows themselves (`FrameCapture`) stay five columns.
 *
 * Every per-frame method is fixed-size arithmetic over preallocated typed arrays: no allocation, no
 * key walk over the renderer's object.
 */

/**
 * The draw phases accumulated, in report order. A fixed list rather than `Object.keys`: the walk
 * would allocate per frame, and a key the renderer does not (yet) publish simply stays at count 0.
 * `units.*`, `submit.*` and `visuals.*` are capture-only subphases inside their parents.
 */
export const CAPTURE_PHASE_KEYS: readonly string[] = Object.freeze([
  "setup", "terrain", "env", "ground", "objects", "units", "visuals", "warm", "evict", "submit",
  "units.appearance", "units.pose", "units.presentation",
  "visuals.rigs", "visuals.effects", "visuals.particles",
  "submit.sky", "submit.world", "submit.postprocess",
]);

export interface PhaseTotals {
  /** Milliseconds summed over the frames that had the phase. */
  readonly sumMs: number;
  /** Sum divided by every recorded frame, the phase's share of an average frame. */
  readonly meanMs: number;
  readonly maxMs: number;
  /** Frames on which the renderer reported the phase (a zero included). */
  readonly frames: number;
  /** Of those, frames on which it took any time at all. */
  readonly nonZeroFrames: number;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export class PhaseAccumulator {
  readonly keys: readonly string[];
  readonly #sums: Float64Array;
  readonly #maxes: Float64Array;
  readonly #counts: Uint32Array;
  readonly #nonZero: Uint32Array;
  #frames = 0;

  constructor(keys: readonly string[] = CAPTURE_PHASE_KEYS) {
    this.keys = keys;
    this.#sums = new Float64Array(keys.length);
    this.#maxes = new Float64Array(keys.length);
    this.#counts = new Uint32Array(keys.length);
    this.#nonZero = new Uint32Array(keys.length);
  }

  get frames(): number { return this.#frames; }

  /** One recorded frame; `phases` undefined (no renderer) still counts the frame. */
  add(phases: Readonly<Record<string, number>> | undefined): void {
    this.#frames++;
    if (phases === undefined) return;
    const keys = this.keys;
    for (let index = 0; index < keys.length; index++) {
      const ms = phases[keys[index]!];
      if (typeof ms !== "number" || !Number.isFinite(ms)) continue;
      const value = ms > 0 ? ms : 0;
      this.#sums[index] = this.#sums[index]! + value;
      if (value > this.#maxes[index]!) this.#maxes[index] = value;
      this.#counts[index]!++;
      if (value > 0) this.#nonZero[index]!++;
    }
  }

  reset(): void {
    this.#sums.fill(0);
    this.#maxes.fill(0);
    this.#counts.fill(0);
    this.#nonZero.fill(0);
    this.#frames = 0;
  }

  /** Export (outside the frame loop): the phases the renderer reported at least once. */
  report(): { frames: number; phases: Record<string, PhaseTotals> } {
    const phases: Record<string, PhaseTotals> = {};
    const frames = this.#frames;
    for (let index = 0; index < this.keys.length; index++) {
      const count = this.#counts[index]!;
      if (count === 0) continue;
      const sum = this.#sums[index]!;
      phases[this.keys[index]!] = {
        sumMs: round3(sum), meanMs: round3(frames > 0 ? sum / frames : 0), maxMs: round3(this.#maxes[index]!),
        frames: count, nonZeroFrames: this.#nonZero[index]!,
      };
    }
    return { frames, phases };
  }
}

/**
 * Per-frame budgets of ARC-5 in milliseconds (an inference from its budget table, not a
 * measurement). `env` includes the WMO groups, so it is an upper estimate; collisions and packets
 * enter only through `net` (the frame's packet handler time).
 */
export const STACKING_BUDGETS_MS: Readonly<Record<string, number>> = Object.freeze({
  terrain: 1.5, env: 2, objects: 2, "units.appearance": 2, "units.pose": 1, warm: 3, net: 4,
});
/** A phase "fires" at this share of its budget. */
export const STACKING_FIRE_SHARE = 0.5;
/** A frame "stacks" when at least two phases fired and their sum passed this. */
export const STACKING_SUM_MS = 4;

export class StackingProbe {
  readonly #names: readonly string[];
  readonly #thresholds: Float64Array;
  /** Frames by how many phases fired, 0 … phases. */
  readonly #histogram: Uint32Array;
  readonly #firedByPhase: Uint32Array;
  readonly #stackedByPhase: Uint32Array;
  #frames = 0;
  #stacked = 0;
  #stackedSumMs = 0;
  #stackedMaxMs = 0;

  constructor(budgets: Readonly<Record<string, number>> = STACKING_BUDGETS_MS, fireShare = STACKING_FIRE_SHARE,
    readonly sumMs = STACKING_SUM_MS) {
    this.#names = Object.keys(budgets);
    this.#thresholds = Float64Array.from(this.#names, (name) => budgets[name]! * fireShare);
    this.#histogram = new Uint32Array(this.#names.length + 1);
    this.#firedByPhase = new Uint32Array(this.#names.length);
    this.#stackedByPhase = new Uint32Array(this.#names.length);
  }

  /** One recorded frame: its draw phases and its packet time. */
  add(phases: Readonly<Record<string, number>> | undefined, netMs: number): void {
    this.#frames++;
    const names = this.#names;
    let fired = 0;
    let sum = 0;
    // A bit mask of the fired phases, so a stacked frame can be attributed without a second read.
    let mask = 0;
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!;
      const raw = name === "net" ? netMs : phases?.[name];
      if (typeof raw !== "number" || !(raw >= this.#thresholds[index]!)) continue;
      fired++;
      sum += raw;
      mask |= 1 << index;
      this.#firedByPhase[index]!++;
    }
    this.#histogram[fired]!++;
    if (fired >= 2 && sum > this.sumMs) {
      this.#stacked++;
      this.#stackedSumMs += sum;
      if (sum > this.#stackedMaxMs) this.#stackedMaxMs = sum;
      for (let index = 0; index < names.length; index++) {
        if ((mask & (1 << index)) !== 0) this.#stackedByPhase[index]!++;
      }
    }
  }

  reset(): void {
    this.#histogram.fill(0);
    this.#firedByPhase.fill(0);
    this.#stackedByPhase.fill(0);
    this.#frames = 0;
    this.#stacked = 0;
    this.#stackedSumMs = 0;
    this.#stackedMaxMs = 0;
  }

  report(): Record<string, unknown> {
    const byPhase = (counts: Uint32Array): Record<string, number> =>
      Object.fromEntries(this.#names.map((name, index) => [name, counts[index]!]));
    return {
      frames: this.#frames,
      stackedFrames: this.#stacked,
      stackedShare: this.#frames > 0 ? round3(this.#stacked / this.#frames) : 0,
      stackedMeanMs: this.#stacked > 0 ? round3(this.#stackedSumMs / this.#stacked) : 0,
      stackedMaxMs: round3(this.#stackedMaxMs),
      /** `firedHistogram[n]`: frames on which exactly n budgeted phases fired. */
      firedHistogram: Array.from(this.#histogram),
      firedByPhase: byPhase(this.#firedByPhase),
      stackedByPhase: byPhase(this.#stackedByPhase),
      budgetsMs: Object.fromEntries(this.#names.map((name, index) => [name, round3(this.#thresholds[index]! / STACKING_FIRE_SHARE)])),
      fireShare: STACKING_FIRE_SHARE,
      sumMs: this.sumMs,
    };
  }
}

/**
 * Packet and FrameXML-step time per frame row. Time adds up between two callbacks and lands on the
 * next recorded row, whose interval it falls into; a callback that `FrameCapture.frame` rejected
 * leaves it pending for the next row (that row's interval spans the rejected one), while a callback
 * outside the world (cadence broken, interval null) drops it.
 */
export class FrameExtraColumns {
  readonly netMs: Float32Array;
  readonly frameXmlMs: Float32Array;
  #pendingNet = 0;
  #pendingFrameXml = 0;
  #rows = 0;

  constructor(readonly limit: number) {
    this.netMs = new Float32Array(limit);
    this.frameXmlMs = new Float32Array(limit);
  }

  get rows(): number { return this.#rows; }

  addNet(ms: number): void { if (ms > 0 && Number.isFinite(ms)) this.#pendingNet += ms; }
  addFrameXml(ms: number): void { if (ms > 0 && Number.isFinite(ms)) this.#pendingFrameXml += ms; }

  /** Packet time collected since the last committed row, for the stacking sensor. */
  get pendingNetMs(): number { return this.#pendingNet; }

  /**
   * After `FrameCapture.frame`: `count` is the capture's row count. A new row takes the pending
   * time at `count − 1`; an unchanged count keeps it pending.
   */
  commit(count: number): boolean {
    if (count <= this.#rows || count > this.limit) return false;
    const index = count - 1;
    this.netMs[index] = this.#pendingNet;
    this.frameXmlMs[index] = this.#pendingFrameXml;
    this.#rows = count;
    this.#pendingNet = 0;
    this.#pendingFrameXml = 0;
    return true;
  }

  /** A callback outside the world: its time belongs to no row. */
  discard(): void {
    this.#pendingNet = 0;
    this.#pendingFrameXml = 0;
  }

  reset(): void {
    this.netMs.fill(0, 0, this.#rows);
    this.frameXmlMs.fill(0, 0, this.#rows);
    this.#rows = 0;
    this.discard();
  }

  report(): { columns: readonly string[]; netMs: number[]; frameXmlMs: number[] } {
    const column = (values: Float32Array): number[] => Array.from(values.subarray(0, this.#rows), round3);
    return { columns: ["netMs", "frameXmlMs"], netMs: column(this.netMs), frameXmlMs: column(this.frameXmlMs) };
  }
}
