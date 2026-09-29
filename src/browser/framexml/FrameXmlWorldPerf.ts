/**
 * Live frame-time counters for the stock HUD, read in the owner's client as
 * `window.frameXmlWorldPerf()` (and `window.frameXmlWorldPerf("reset")` to start a new window).
 *
 * The offline routes measure the HUD over a canned seam: no packets, no `LiveWorldSeam` polling
 * and none of the game frame's own DOM writes before the FrameXML step. What decides the next
 * optimisation is how the live session splits its frame, so the world mount keeps these numbers
 * itself: a handful of `performance.now()` reads per frame and per renderer pass, nothing else.
 *
 * - `step*`: the FrameXML `requestAnimationFrame` step — `seam.tick` (the live seam's polling and
 *   reconciles), the OnUpdate walk (`bridge.tick`, Lua handlers only), and the renderer pass that
 *   ends the step's mutation batch (`syncInStep`).
 * - `syncsOutsideStep`: renderer passes that ran outside that step — every one is a packet callback,
 *   a pointer event or a timer that changed the UI between two frames.
 * - `syncs`: every renderer pass by what it had to do (`structural` re-applies every drawn frame).
 * - `touches`: whole-HUD invalidations (settings, and any host that still calls `bridge.touch()`);
 *   `pictures`: a texture or font arriving, applied to the frames that hold it.
 *
 * Per-frame values are exponentially weighted over about 32 frames (`ewma`) with the worst frame
 * since the last reset (`max`); counters are totals since the reset with a per-second rate.
 */
import type { FrameXmlRenderPerfSink, FrameXmlSyncKind } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { captureProbe, captureProbeActive } from "../../world/CaptureProbe.js";

/**
 * A step or an outside-step renderer pass at least this long is reported to a running freeze
 * recording (`game/PerformanceCapture.ts`); shorter ones only feed the counters below.
 */
const CAPTURE_PROBE_MIN_MS = 4;

interface Series { ewma: number; max: number; seen: boolean }
interface Counter { count: number; ms: number; max: number }

const WEIGHT = 1 / 32;

function series(): Series {
  return { ewma: 0, max: 0, seen: false };
}

function counter(): Counter {
  return { count: 0, ms: 0, max: 0 };
}

function sample(target: Series, value: number): void {
  target.ewma = target.seen ? target.ewma + WEIGHT * (value - target.ewma) : value;
  target.seen = true;
  if (value > target.max) target.max = value;
}

function add(target: Counter, ms: number): void {
  target.count += 1;
  target.ms += ms;
  if (ms > target.max) target.max = ms;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export class FrameXmlWorldPerf implements FrameXmlRenderPerfSink {
  readonly #now: () => number;
  #resetAt: number;
  #frames = 0;
  #inStep = false;
  #stepStart: number | undefined;
  #lastStepStart: number | undefined;
  // The frame being accumulated: from one step start to the next.
  #frameSeam = 0;
  #frameOnUpdate = 0;
  #frameHandlers = 0;
  #frameSyncInStep = 0;
  #frameSyncOutside = 0;
  #frameStep = 0;
  #frameOpen = false;
  #series = {
    frame: series(), step: series(), seamTick: series(), onUpdate: series(), onUpdateHandlers: series(),
    syncInStep: series(), syncOutsideStep: series(),
  };
  #syncs: Record<FrameXmlSyncKind, Counter> = {
    structural: counter(), layout: counter(), paint: counter(), noop: counter(),
  };
  #outside = counter();
  #touches = 0;
  #pictures = counter();
  #longFrames = 0;
  #worst: Record<string, number> | undefined;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#resetAt = now();
  }

  /** The step starts: close the frame that ended here and open the next one. */
  stepBegin(): void {
    const now = this.#now();
    this.closeFrame(now);
    this.#inStep = true;
    this.#stepStart = now;
    this.#frameOpen = true;
  }

  /** `seam.tick` and the OnUpdate walk inside the step, with the handler count `bridge.tick` returned. */
  stepPieces(seamMs: number, onUpdateMs: number, handlers: number): void {
    this.#frameSeam += seamMs;
    this.#frameOnUpdate += onUpdateMs;
    this.#frameHandlers += handlers;
  }

  stepEnd(): void {
    if (this.#stepStart !== undefined) {
      const stepMs = this.#now() - this.#stepStart;
      this.#frameStep += stepMs;
      // The step runs in its own requestAnimationFrame callback, outside the game frame's clock.
      if (stepMs >= CAPTURE_PROBE_MIN_MS && captureProbeActive()) {
        captureProbe("frameXmlSteps", this.#stepStart, {
          stepMs, seamTickMs: this.#frameSeam, onUpdateMs: this.#frameOnUpdate,
          handlers: this.#frameHandlers, syncInStepMs: this.#frameSyncInStep,
        });
      }
    }
    this.#stepStart = undefined;
    this.#inStep = false;
  }

  sync(kind: FrameXmlSyncKind, ms: number): void {
    add(this.#syncs[kind], ms);
    if (this.#inStep) {
      this.#frameSyncInStep += ms;
      return;
    }
    if (kind === "noop") return;
    add(this.#outside, ms);
    this.#frameSyncOutside += ms;
    // A packet callback, pointer event or timer that re-rendered the HUD between two frames.
    if (ms >= CAPTURE_PROBE_MIN_MS && captureProbeActive()) {
      captureProbe("frameXmlSyncs", this.#now() - ms, { kind, ms });
    }
  }

  /** A whole-HUD invalidation (`bridge.touch()`). */
  touch(): void {
    this.#touches += 1;
  }

  picture(ms: number): void {
    add(this.#pictures, ms);
  }

  reset(): void {
    this.#resetAt = this.#now();
    this.#frames = 0;
    this.#lastStepStart = this.#inStep ? this.#stepStart : undefined;
    this.#series = {
      frame: series(), step: series(), seamTick: series(), onUpdate: series(), onUpdateHandlers: series(),
      syncInStep: series(), syncOutsideStep: series(),
    };
    this.#syncs = { structural: counter(), layout: counter(), paint: counter(), noop: counter() };
    this.#outside = counter();
    this.#touches = 0;
    this.#pictures = counter();
    this.#longFrames = 0;
    this.#worst = undefined;
  }

  snapshot(): Record<string, unknown> {
    const seconds = Math.max(1e-3, (this.#now() - this.#resetAt) / 1000);
    const view = (value: Series): { ewma: number; max: number } => ({ ewma: round(value.ewma), max: round(value.max) });
    const counted = (value: Counter): { count: number; perSecond: number; ms: number; msPerSecond: number; maxMs: number } => ({
      count: value.count, perSecond: round(value.count / seconds), ms: round(value.ms),
      msPerSecond: round(value.ms / seconds), maxMs: round(value.max),
    });
    const s = this.#series;
    return {
      seconds: round(seconds),
      frames: this.#frames,
      fps: round(this.#frames / seconds),
      frameMs: view(s.frame),
      longFrames: this.#longFrames,
      stepMs: view(s.step),
      seamTickMs: view(s.seamTick),
      onUpdateMs: view(s.onUpdate),
      onUpdateHandlers: view(s.onUpdateHandlers),
      syncInStepMs: view(s.syncInStep),
      syncOutsideStepMsPerFrame: view(s.syncOutsideStep),
      syncsOutsideStep: counted(this.#outside),
      syncs: Object.fromEntries(Object.entries(this.#syncs).map(([kind, value]) => [kind, counted(value)])),
      touches: { count: this.#touches, perSecond: round(this.#touches / seconds) },
      pictures: counted(this.#pictures),
      worstFrame: this.#worst,
    };
  }

  private closeFrame(now: number): void {
    if (!this.#frameOpen) {
      this.#lastStepStart = now;
      return;
    }
    const interval = this.#lastStepStart === undefined ? undefined : now - this.#lastStepStart;
    this.#lastStepStart = now;
    this.#frames += 1;
    const s = this.#series;
    if (interval !== undefined) {
      sample(s.frame, interval);
      if (interval > 1000 / 30) this.#longFrames += 1;
    }
    sample(s.step, this.#frameStep);
    sample(s.seamTick, this.#frameSeam);
    sample(s.onUpdate, this.#frameOnUpdate);
    sample(s.onUpdateHandlers, this.#frameHandlers);
    sample(s.syncInStep, this.#frameSyncInStep);
    sample(s.syncOutsideStep, this.#frameSyncOutside);
    const cost = this.#frameStep + this.#frameSyncOutside;
    if (!this.#worst || cost > (this.#worst["costMs"] ?? 0)) {
      this.#worst = {
        costMs: round(cost), frameMs: round(interval ?? 0), stepMs: round(this.#frameStep),
        seamTickMs: round(this.#frameSeam), onUpdateMs: round(this.#frameOnUpdate),
        syncInStepMs: round(this.#frameSyncInStep), syncOutsideStepMs: round(this.#frameSyncOutside),
        atSeconds: round((now - this.#resetAt) / 1000),
      };
    }
    this.#frameSeam = 0;
    this.#frameOnUpdate = 0;
    this.#frameHandlers = 0;
    this.#frameSyncInStep = 0;
    this.#frameSyncOutside = 0;
    this.#frameStep = 0;
  }
}

/**
 * Publish `window.frameXmlWorldPerf` for one mount; the returned cleanup removes it again unless a
 * later mount has already replaced it.
 */
export function publishFrameXmlWorldPerf(perf: FrameXmlWorldPerf): () => void {
  const read = (command?: unknown): unknown => {
    if (command === "reset") {
      perf.reset();
      return "reset";
    }
    return perf.snapshot();
  };
  Object.defineProperty(window, "frameXmlWorldPerf", { configurable: true, value: read });
  return () => {
    if (Object.getOwnPropertyDescriptor(window, "frameXmlWorldPerf")?.value === read) {
      Reflect.deleteProperty(window, "frameXmlWorldPerf");
    }
  };
}
