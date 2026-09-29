import { FrameClock } from "./RenderStats.js";

export const CAPTURE_DURATION_MS = 60_000;
export const CAPTURE_FRAME_LIMIT = 20_000;
const EVENT_LIMIT = 240;
const FRAME_COLUMNS = ["rafAtMs", "callbackStartMs", "cpuMs", "intervalMs", "failed"] as const;
/**
 * Event kinds that keep their largest entries once the log is full, by this field, instead of
 * the first ones: a long stuttery route must not crowd out the one severe freeze near its end.
 */
const RANKED_EVENTS: Readonly<Record<string, string>> = {
  cpuSections: "cpuMs",
  longAnimationFrames: "durationMs",
  longTasks: "durationMs",
  frameXmlSteps: "stepMs",
  frameXmlSyncs: "ms",
  slowPackets: "ms",
};

export interface CaptureEvent {
  readonly atMs: number;
  readonly [key: string]: unknown;
}

/** Bounded, opt-in recording. Ordinary frames write numbers into a preallocated buffer. */
export class FrameCapture {
  readonly #frames: Float64Array;
  readonly #events: Record<string, CaptureEvent[]> = {};
  readonly #dropped: Record<string, number> = {};
  #count = 0;
  #previousRaf: number | undefined;
  #lastRaf: number | undefined;
  #endedAt: number | undefined;

  constructor(readonly startedAt: number, readonly frameLimit = CAPTURE_FRAME_LIMIT) {
    if (!Number.isInteger(frameLimit) || frameLimit < 1) throw new RangeError("Invalid frame limit");
    this.#frames = new Float64Array(frameLimit * FRAME_COLUMNS.length);
  }

  get count(): number { return this.#count; }
  get full(): boolean { return this.#count >= this.frameLimit; }

  /** Hidden tabs, loading/login screens and benchmark leases must not become movement hitches. */
  breakCadence(): void { this.#previousRaf = undefined; }

  frame(rafAt: number, callbackStart: number, cpuMs: number, failed: boolean): void {
    if (this.#endedAt !== undefined || this.full || !Number.isFinite(rafAt)
      || !Number.isFinite(callbackStart) || !Number.isFinite(cpuMs) || cpuMs < 0
      || callbackStart < this.startedAt || (this.#lastRaf !== undefined && rafAt <= this.#lastRaf)) return;
    const offset = this.#count++ * FRAME_COLUMNS.length;
    this.#frames[offset] = rafAt - this.startedAt;
    this.#frames[offset + 1] = callbackStart - this.startedAt;
    this.#frames[offset + 2] = cpuMs;
    this.#frames[offset + 3] = this.#previousRaf === undefined ? Number.NaN : rafAt - this.#previousRaf;
    this.#frames[offset + 4] = Number(failed);
    this.#previousRaf = rafAt;
    this.#lastRaf = rafAt;
  }

  event(kind: string, at: number, details: Readonly<Record<string, unknown>>): void {
    if (!Number.isFinite(at) || at < this.startedAt || this.#endedAt !== undefined) return;
    const events = this.#events[kind] ??= [];
    if (events.length >= EVENT_LIMIT) {
      this.#dropped[kind] = (this.#dropped[kind] ?? 0) + 1;
      // A sustained 25-ms scene fills the section log in seconds. Keep the slowest entries
      // across the entire route, so a later 180-ms hitch still has attribution.
      const rank = RANKED_EVENTS[kind];
      const value = rank === undefined ? undefined : details[rank];
      if (rank !== undefined && typeof value === "number" && Number.isFinite(value)) {
        let smallest = 0;
        for (let index = 1; index < events.length; index++) {
          if (Number(events[index]![rank] ?? 0) < Number(events[smallest]![rank] ?? 0)) smallest = index;
        }
        if (value > Number(events[smallest]![rank] ?? 0)) {
          events[smallest] = { ...details, atMs: at - this.startedAt };
        }
      }
      return;
    }
    events.push({ ...details, atMs: at - this.startedAt });
  }

  finish(at: number): void { this.#endedAt ??= Math.max(this.startedAt, at); }

  /** Export only after recording: percentile sorts and JSON objects stay out of the frame loop. */
  report() {
    const cpu = new FrameClock(Math.max(1, this.#count));
    const intervals = new FrameClock(Math.max(1, this.#count));
    const frames: Array<Array<number | null>> = [];
    for (let index = 0; index < this.#count; index++) {
      const row = Array.from(this.#frames.subarray(index * FRAME_COLUMNS.length, (index + 1) * FRAME_COLUMNS.length));
      cpu.add(row[2]!);
      intervals.add(row[3]!);
      frames.push(row.map((value) => Number.isFinite(value) ? value : null));
    }
    const events = structuredClone(this.#events);
    for (const kind of Object.keys(RANKED_EVENTS)) events[kind]?.sort((left, right) => left.atMs - right.atMs);
    return {
      durationMs: (this.#endedAt ?? this.startedAt) - this.startedAt,
      frameColumns: FRAME_COLUMNS,
      frames,
      summary: { cpu: cpu.snapshot(), intervals: intervals.snapshot() },
      events,
      eventSelection: Object.fromEntries(Object.entries(RANKED_EVENTS).map(([kind, field]) =>
        [kind, `${kind === "cpuSections" ? "slowest callbacks" : `largest ${field}`}, in chronological order`])),
      droppedEvents: { ...this.#dropped },
      frameLimitReached: this.full,
    };
  }
}

/** Keep script attribution useful without exporting hosts, URL queries, credentials or paths. */
export function captureScriptFile(source: string): string {
  try {
    const url = new URL(source);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unavailable";
    return url.pathname.split("/").pop() || "unavailable";
  } catch { return "unavailable"; }
}
