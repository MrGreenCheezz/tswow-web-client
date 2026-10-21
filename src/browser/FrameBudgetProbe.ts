/**
 * P2-09a (ARC-5): a sensor for the frame's independent work limits — how many of them spend time in
 * the same frame period, and how much. It only records; nothing reads it back to steer the frame.
 *
 * There is no common deadline: fourteen limiters each keep their own slice (units 2 ms, environment
 * 2 ms, rooms 2 ms, game objects 2 ms, animations 1 ms, terrain 1.5 ms, warm-up 3 ms, collisions 4 ms,
 * packets 4 ms between callbacks …), so in a bad frame they add up. The line-P plan's question for a
 * shared frame budget (P2-09b) is how often they do: a period *stacks* when at least two limiters
 * fired (spent ≥ 0.1 ms) and together spent more than 4 ms. **Rejection criterion, written before
 * the measurement:** a stacked share below 2 % means no scheduler (P2-09b stays b0).
 *
 * A period runs from the start of one animation-frame callback to the start of the next, so packet
 * handling and the FrameXML step between two callbacks belong to the earlier frame. The FrameXML step
 * is not a limiter: it is counted on its own and joins only the second, "with the step" statistic.
 *
 * Disabled (the default), `begin()` answers 0 and `end`/`addOutside` return on their first test: no
 * clock read, no write. Enabled, every accumulator is preallocated; a period costs no allocation.
 */

/** The limiters, numbered for the accumulators (line-P-P2 P2-09, table rows 1–13; 11 is not per frame). */
export const FRAME_BUDGET = Object.freeze({
  units: 0,
  animations: 1,
  environment: 2,
  wmoGroups: 3,
  gameObjects: 4,
  terrain: 5,
  effects: 6,
  warmup: 7,
  collisions: 8,
  groundCover: 9,
  atlas: 10,
  /** Packet handling, measured around each delivery (between callbacks too). */
  net: 11,
  /** The stock HUD's step: not a limiter, the second statistic's extra participant. */
  framexml: 12,
});

export type FrameBudgetId = typeof FRAME_BUDGET[keyof typeof FRAME_BUDGET];

export const FRAME_BUDGET_NAMES: readonly string[] = Object.freeze(Object.keys(FRAME_BUDGET));

/** A limiter "fired" in a period when it spent at least this much. */
export const FRAME_BUDGET_FIRE_MS = 0.1;
/** A period stacks when two or more fired and together spent more than this. */
export const FRAME_BUDGET_STACK_MS = 4;
/** The rejection threshold of P2-09a: below this share of stacked periods, no scheduler. */
export const FRAME_BUDGET_GO_SHARE = 0.02;

const SLOTS = FRAME_BUDGET_NAMES.length;
/** 22.10 ARC-2 S4b: the accumulator count, for a record that carries one period (RenderResults.ts `budgetMs`). */
export const FRAME_BUDGET_SLOTS = SLOTS;
const LIMITERS = FRAME_BUDGET.framexml;
/** The histogram's last bucket holds this many fired limiters or more. */
const HISTOGRAM_TOP = 8;

export interface FrameBudgetRow {
  readonly id: string;
  /** Periods in which it fired. */
  readonly frames: number;
  readonly totalMs: number;
  readonly meanWhenFiredMs: number;
  readonly maxMs: number;
}

export interface FrameBudgetReport {
  readonly frames: number;
  /** Periods by how many limiters fired, 0 … 8 (8: eight or more). */
  readonly firedHistogram: readonly number[];
  /** Periods with two or more fired limiters spending more than 4 ms together. */
  readonly twoPlusOver4Ms: number;
  readonly share: number;
  /** The same with the FrameXML step counted as one more participant. */
  readonly withStep: { readonly twoPlusOver4Ms: number; readonly share: number };
  /** `share` against the criterion: GO builds P2-09b, NO-GO keeps b0. */
  readonly verdict: "GO" | "NO-GO" | "no frames";
  readonly perBudget: readonly FrameBudgetRow[];
  readonly fireMs: number;
  readonly stackMs: number;
}

export class FrameBudgetProbe {
  #enabled = false;
  /** The open period: milliseconds per slot. */
  readonly #period = new Float64Array(SLOTS);
  /** Whether a period is open, and whether it is to be counted when it closes. */
  #open = false;
  #counted = false;
  #frames = 0;
  readonly #histogram = new Uint32Array(HISTOGRAM_TOP + 1);
  #stacked = 0;
  #stackedWithStep = 0;
  readonly #firedFrames = new Uint32Array(SLOTS);
  readonly #totalMs = new Float64Array(SLOTS);
  /** Time in the periods where it fired, for the mean of those alone. */
  readonly #firedMs = new Float64Array(SLOTS);
  readonly #maxMs = new Float64Array(SLOTS);
  /** The last closed period, for the bench's per-frame columns. */
  #lastBudgetMs = 0;
  #lastFired = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  get enabled(): boolean { return this.#enabled; }

  /** Starts (and resets) or stops recording. */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    this.reset();
  }

  reset(): void {
    this.#period.fill(0);
    this.#open = false;
    this.#counted = false;
    this.#frames = 0;
    this.#histogram.fill(0);
    this.#stacked = 0;
    this.#stackedWithStep = 0;
    this.#firedFrames.fill(0);
    this.#totalMs.fill(0);
    this.#firedMs.fill(0);
    this.#maxMs.fill(0);
    this.#lastBudgetMs = 0;
    this.#lastFired = 0;
  }

  /** A start time for `end`, or 0 while disabled (then `end` does nothing). */
  begin(): number {
    return this.#enabled ? this.clock() : 0;
  }

  /** Adds the time since `begin` to a limiter of the open period. */
  end(id: FrameBudgetId, startedAt: number): void {
    if (startedAt === 0 || !this.#enabled) return;
    const spent = this.clock() - startedAt;
    if (spent > 0) this.#period[id] = this.#period[id]! + spent;
  }

  /** Work measured elsewhere (a packet, the FrameXML step), into the open period. */
  addOutside(id: FrameBudgetId, milliseconds: number): void {
    if (!this.#enabled || !(milliseconds > 0)) return;
    this.#period[id] = this.#period[id]! + milliseconds;
  }

  /**
   * An animation-frame callback starts: the period before it closes, and a new one opens. `counted`
   * says whether the new period is part of the measurement (a hidden, loading or benchmark frame is not).
   */
  frameStart(counted = true): void {
    if (!this.#enabled) return;
    // Work before the first callback belongs to no period.
    if (this.#open) this.#close();
    else this.#period.fill(0);
    this.#open = true;
    this.#counted = counted;
  }

  /**
   * 22.10 ARC-2 S4b: a renderer realm's own sensor hands what its limiters spent since the last take to the page's
   * (RendererReports.ts): added into `out` per slot, then zeroed here. Returns whether anything was spent.
   */
  takeOpenPeriod(out: Float64Array): boolean {
    if (!this.#enabled) return false;
    const period = this.#period;
    let spent = false;
    for (let id = 0; id < SLOTS; id++) {
      const ms = period[id]!;
      if (ms === 0) continue;
      out[id] = out[id]! + ms;
      period[id] = 0;
      spent = true;
    }
    return spent;
  }

  /** The last closed period's limiter time (the step excluded) and how many limiters fired in it. */
  get lastBudgetMs(): number { return this.#lastBudgetMs; }
  get lastFired(): number { return this.#lastFired; }

  #close(): void {
    const period = this.#period;
    let fired = 0;
    let sum = 0;
    let all = 0;
    for (let id = 0; id < LIMITERS; id++) {
      const ms = period[id]!;
      all += ms;
      if (ms < FRAME_BUDGET_FIRE_MS) continue;
      fired++;
      sum += ms;
    }
    this.#lastBudgetMs = all;
    this.#lastFired = fired;
    if (this.#counted) {
      this.#frames++;
      this.#histogram[Math.min(fired, HISTOGRAM_TOP)]!++;
      if (fired >= 2 && sum > FRAME_BUDGET_STACK_MS) this.#stacked++;
      const step = period[LIMITERS]!;
      const stepFired = step >= FRAME_BUDGET_FIRE_MS;
      if (fired + (stepFired ? 1 : 0) >= 2 && sum + (stepFired ? step : 0) > FRAME_BUDGET_STACK_MS) this.#stackedWithStep++;
      for (let id = 0; id < SLOTS; id++) {
        const ms = period[id]!;
        this.#totalMs[id] = this.#totalMs[id]! + ms;
        if (ms > this.#maxMs[id]!) this.#maxMs[id] = ms;
        if (ms >= FRAME_BUDGET_FIRE_MS) {
          this.#firedFrames[id]!++;
          this.#firedMs[id] = this.#firedMs[id]! + ms;
        }
      }
    }
    period.fill(0);
  }

  report(): FrameBudgetReport {
    const frames = this.#frames;
    const share = frames > 0 ? this.#stacked / frames : 0;
    const perBudget: FrameBudgetRow[] = [];
    for (let id = 0; id < SLOTS; id++) {
      const fired = this.#firedFrames[id]!;
      const total = this.#totalMs[id]!;
      if (fired === 0 && total === 0) continue;
      perBudget.push({
        id: FRAME_BUDGET_NAMES[id]!, frames: fired, totalMs: round3(total),
        meanWhenFiredMs: round3(fired > 0 ? this.#firedMs[id]! / fired : 0), maxMs: round3(this.#maxMs[id]!),
      });
    }
    return {
      frames,
      firedHistogram: [...this.#histogram],
      twoPlusOver4Ms: this.#stacked,
      share: round4(share),
      withStep: { twoPlusOver4Ms: this.#stackedWithStep, share: round4(frames > 0 ? this.#stackedWithStep / frames : 0) },
      verdict: frames === 0 ? "no frames" : share >= FRAME_BUDGET_GO_SHARE ? "GO" : "NO-GO",
      perBudget,
      fireMs: FRAME_BUDGET_FIRE_MS,
      stackMs: FRAME_BUDGET_STACK_MS,
    };
  }
}

function round3(value: number): number { return Math.round(value * 1000) / 1000; }
function round4(value: number): number { return Math.round(value * 10000) / 10000; }

/** The one sensor the frame loop, the renderer's limiters and the capture share. */
export const frameBudgetProbe = new FrameBudgetProbe();
