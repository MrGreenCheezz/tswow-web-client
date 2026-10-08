import { CAPTURE_DURATION_MS, CAPTURE_FRAME_LIMIT, FrameCapture, captureScriptFile } from "../FrameCapture.js";
import { FrameExtraColumns, PhaseAccumulator, StackingProbe } from "./CaptureExtras.js";
import { formalRenderBenchmarkExclusiveActive } from "../RenderBenchmarkExclusiveLease.js";
import { renderBenchmarkRuntime } from "../RenderBenchmarkRuntime.js";
import { game } from "./Context.js";
import { world3dCanvas, worldPanel } from "../ui/Dom.js";
import { settings } from "../ui/Settings.js";
import { loadingScreenVisible } from "../ui/LoadingScreen.js";
import { autoQualityStatus } from "../AutoQuality.js";
import { setCaptureProbe } from "../../world/CaptureProbe.js";
import { poseWorkerReport } from "../ui/PoseWorkerStatus.js"; // L10 (10.18)

interface LongFrameEntry extends PerformanceEntry {
  readonly blockingDuration?: number;
  readonly renderStart?: number;
  readonly styleAndLayoutStart?: number;
  readonly scripts?: readonly {
    readonly duration: number;
    readonly startTime?: number;
    readonly executionStart?: number;
    readonly pauseDuration?: number;
    readonly invoker?: string;
    readonly invokerType?: string;
    readonly sourceURL: string;
    readonly sourceFunctionName: string;
    readonly sourceCharPosition?: number;
    readonly forcedStyleAndLayoutDuration: number;
  }[];
}

/**
 * The JS Self-Profiling API. Chromium only, and only on a page served with
 * `Document-Policy: js-profiling` (vite.config.mjs, electron/main.cjs, electron/static-server.cjs);
 * elsewhere the constructor is missing or refuses, and the capture records why.
 */
interface JsProfilerTrace {
  readonly resources: readonly string[];
  readonly frames: readonly {
    readonly name: string; readonly resourceId?: number; readonly line?: number; readonly column?: number;
  }[];
  readonly stacks: readonly { readonly parentId?: number; readonly frameId: number }[];
  readonly samples: readonly { readonly timestamp: number; readonly stackId?: number; readonly marker?: string }[];
}
interface JsProfiler extends EventTarget {
  readonly sampleInterval: number;
  stop(): Promise<JsProfilerTrace>;
}
type JsProfilerConstructor = new (options: { sampleInterval: number; maxBufferSize: number }) => JsProfiler;

/** Requested sampling period; the browser may choose a longer one and reports the period it chose. */
const JS_PROFILE_SAMPLE_INTERVAL_MS = 5;
/** More than 60 s at the requested period; a full buffer stops sampling, and the report says so. */
const JS_PROFILE_SAMPLE_LIMIT = 15_000;
/**
 * A packet whose delivery took at least this long is kept individually, beside the per-opcode
 * totals. The time is wall time around `WorldClient.#deliver`, awaits inside the handler included,
 * so it is an upper bound, not CPU; past the capture's event limit only the slowest are kept.
 */
const SLOW_PACKET_MS = 4;

interface PacketTotals { count: number; bytes: number; ms: number; maxMs: number }

let recording: FrameCapture | undefined;
let completed: FrameCapture | undefined;
let metadata: Record<string, unknown> = {};
let observers: PerformanceObserver[] = [];
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let lastCheckpoint = 0;
let frameStartedAt = 0;
let frameRecording: FrameCapture | undefined;
let frameWasActive = false;
let shaderCaptureRenderer: typeof game.renderer;
let changed: () => void = () => {};
const entrySupport: Record<string, string> = {};
let profiler: JsProfiler | undefined;
let profileSampleIntervalMs: number | undefined;
let profileBufferFull = false;
/** Set while the stopped profiler builds its trace; the report is not ready until it settles. */
let profilePending: Promise<void> | undefined;
let completedProfile: unknown;
let packetsByOpcode = new Map<number, PacketTotals>();
let packetsPerSecond: PacketTotals[] = [];
let frameXmlAtStop: unknown;
/**
 * P1-04: every recorded frame's draw phases, the budget-stacking sensor, and packet/FrameXML time
 * per frame row. Preallocated once (2 × Float32Array(CAPTURE_FRAME_LIMIT) = 160 KB) and reset by
 * each new recording.
 */
const phaseTotals = new PhaseAccumulator();
const stacking = new StackingProbe();
const frameExtra = new FrameExtraColumns(CAPTURE_FRAME_LIMIT);

export function onPerformanceCaptureChanged(listener: () => void): void { changed = listener; }
export function performanceCaptureActive(): boolean { return recording !== undefined; }
export function performanceCaptureReady(): boolean {
  return completed !== undefined && recording === undefined && profilePending === undefined;
}
/** The recording has stopped and the profiler is still building its trace (usually well under a second). */
export function performanceCaptureFinishing(): boolean { return profilePending !== undefined; }

function worldActive(): boolean {
  return game.world !== undefined && !worldPanel.hidden && !document.hidden && !loadingScreenVisible()
    && !formalRenderBenchmarkExclusiveActive() && !renderBenchmarkRuntime.active;
}

function observeEntries(entries: readonly PerformanceEntry[]): void {
  const capture = recording;
  if (!capture) return;
  for (const entry of entries) {
    if (entry.entryType === "long-animation-frame") {
      const frame = entry as LongFrameEntry;
      capture.event("longAnimationFrames", entry.startTime, {
        durationMs: entry.duration,
        blockingDurationMs: frame.blockingDuration,
        renderStartMs: frame.renderStart ? frame.renderStart - capture.startedAt : null,
        styleAndLayoutStartMs: frame.styleAndLayoutStart ? frame.styleAndLayoutStart - capture.startedAt : null,
        scripts: (frame.scripts ?? []).slice(0, 24).map((script) => ({
          file: captureScriptFile(script.sourceURL),
          function: script.sourceFunctionName,
          // With the build's source maps (dist/sourcemaps) this names the entry point exactly.
          charPosition: script.sourceCharPosition,
          invoker: captureInvoker(script.invoker),
          invokerType: script.invokerType,
          startMs: script.startTime === undefined ? undefined : script.startTime - capture.startedAt,
          durationMs: script.duration,
          pauseMs: script.pauseDuration,
          forcedStyleAndLayoutMs: script.forcedStyleAndLayoutDuration,
        })),
      });
    } else if (entry.entryType === "longtask") {
      capture.event("longTasks", entry.startTime, { durationMs: entry.duration });
    } else if (entry.entryType === "resource") {
      const resource = entry as PerformanceResourceTiming;
      // Resource URLs can contain account identifiers or tokens. Only timings and kind are needed.
      capture.event("resources", Math.max(entry.startTime, capture.startedAt), {
        startedBeforeCapture: entry.startTime < capture.startedAt,
        durationMs: entry.duration, completedAtMs: entry.startTime + entry.duration - capture.startedAt,
        initiatorType: resource.initiatorType, transferSize: resource.transferSize,
        decodedBodySize: resource.decodedBodySize,
      });
    }
  }
}

/** An invoker names a callback, or for a classic script its URL: keep the file name only. */
function captureInvoker(invoker: string | undefined): string | undefined {
  if (invoker === undefined) return undefined;
  return invoker.includes("://") ? captureScriptFile(invoker) : invoker.slice(0, 120);
}

function visibilityChanged(): void {
  recording?.breakCadence();
  recording?.event("visibility", performance.now(), { hidden: document.hidden });
}

/** Timings reported by code outside the frame loop (world packets, the FrameXML step). */
function probe(kind: string, at: number, details: Readonly<Record<string, unknown>>): void {
  const capture = recording;
  if (!capture) return;
  // Every FrameXML step (up to 144 a second): a frame column, never an event, or it would fill
  // the 240-entry log in two seconds.
  if (kind === "frameXmlStepTime") {
    frameExtra.addFrameXml(Number(details["ms"]));
    return;
  }
  if (kind !== "packets") {
    capture.event(kind, at, details);
    return;
  }
  const opcode = Number(details["opcode"]);
  const bytes = Number(details["bytes"]);
  const ms = Number(details["ms"]);
  if (!Number.isFinite(opcode) || !Number.isFinite(bytes) || !Number.isFinite(ms)) return;
  frameExtra.addNet(ms);
  const totals = packetsByOpcode.get(opcode) ?? { count: 0, bytes: 0, ms: 0, maxMs: 0 };
  addPacket(totals, bytes, ms);
  packetsByOpcode.set(opcode, totals);
  const second = Math.floor((at - capture.startedAt) / 1000);
  if (second >= 0 && second <= CAPTURE_DURATION_MS / 1000) {
    while (packetsPerSecond.length <= second) packetsPerSecond.push({ count: 0, bytes: 0, ms: 0, maxMs: 0 });
    addPacket(packetsPerSecond[second]!, bytes, ms);
  }
  if (ms >= SLOW_PACKET_MS) capture.event("slowPackets", at, { opcode, bytes, ms });
}

function addPacket(totals: PacketTotals, bytes: number, ms: number): void {
  totals.count++;
  totals.bytes += bytes;
  totals.ms += ms;
  if (ms > totals.maxMs) totals.maxMs = ms;
}

function round2(value: number): number { return Math.round(value * 100) / 100; }

/** The stock HUD's own counters (`window.frameXmlWorldPerf`), present only while it is mounted. */
function frameXmlPerf(command?: "reset"): unknown {
  const read = (globalThis as { frameXmlWorldPerf?: (command?: unknown) => unknown }).frameXmlWorldPerf;
  if (typeof read !== "function") return undefined;
  try { return read(command); } catch { return undefined; }
}

function jsHeap(): { usedMB: number; totalMB: number } | undefined {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  if (!memory) return undefined;
  return { usedMB: round2(memory.usedJSHeapSize / 1048576), totalMB: round2(memory.totalJSHeapSize / 1048576) };
}

function startJsProfiler(): void {
  profileBufferFull = false;
  profileSampleIntervalMs = undefined;
  const Profiler = (globalThis as { Profiler?: JsProfilerConstructor }).Profiler;
  if (typeof Profiler !== "function") {
    entrySupport["jsProfiler"] = "unsupported";
    return;
  }
  try {
    const started = new Profiler({ sampleInterval: JS_PROFILE_SAMPLE_INTERVAL_MS, maxBufferSize: JS_PROFILE_SAMPLE_LIMIT });
    started.addEventListener("samplebufferfull", () => { profileBufferFull = true; });
    profiler = started;
    profileSampleIntervalMs = started.sampleInterval;
    entrySupport["jsProfiler"] = "enabled";
  } catch (error) {
    // Without `Document-Policy: js-profiling` on the page the constructor throws NotAllowedError.
    entrySupport["jsProfiler"] = `unavailable: ${error instanceof Error ? error.name : "error"}`;
  }
}

/**
 * The stopped profiler's trace, made small: script URLs reduced to file names like LoAF scripts,
 * sample times relative to the capture start, frames and stacks as tuples.
 */
function compactProfile(trace: JsProfilerTrace, startedAt: number): unknown {
  const markers = trace.samples.some((sample) => sample.marker !== undefined);
  return {
    sampleIntervalMs: profileSampleIntervalMs,
    bufferFull: profileBufferFull,
    resources: trace.resources.map(captureScriptFile),
    frameColumns: ["name", "resourceId", "line", "column"],
    frames: trace.frames.map((frame) => [frame.name, frame.resourceId ?? -1, frame.line ?? -1, frame.column ?? -1]),
    stackColumns: ["frameId", "parentId"],
    stacks: trace.stacks.map((stack) => [stack.frameId, stack.parentId ?? -1]),
    samples: {
      atMs: trace.samples.map((sample) => round2(sample.timestamp - startedAt)),
      stackId: trace.samples.map((sample) => sample.stackId ?? -1),
      ...(markers ? { marker: trace.samples.map((sample) => sample.marker ?? null) } : {}),
    },
  };
}

function stopJsProfiler(startedAt: number): void {
  const active = profiler;
  profiler = undefined;
  if (!active) return;
  const pending = active.stop().then(
    (trace) => { completedProfile = compactProfile(trace, startedAt); },
    (error: unknown) => { completedProfile = { error: error instanceof Error ? error.name : "error" }; },
  ).finally(() => {
    if (profilePending === pending) profilePending = undefined;
    changed();
  });
  profilePending = pending;
}

/** Explicit local capture; no uploads, renderer setting changes or extra animation loop. */
export function startPerformanceCapture(): boolean {
  // A new profiler must not start while the last one is still handing over its trace.
  if (recording || profilePending || !worldActive()) return false;
  const gl = game.renderer ? world3dCanvas.getContext("webgl2") : null;
  let adapter = "unavailable";
  let webgl = "Canvas fallback";
  try {
    if (gl) {
      webgl = String(gl.getParameter(gl.VERSION));
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      adapter = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    }
  } catch { /* A restricted/lost context still permits CPU recording. */ }
  metadata = {
    recordedAt: new Date().toISOString(), browser: navigator.userAgent, webgl, adapter,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    // These are preferences; the checkpoint contains the effective adaptive scale.
    settings: { ...settings() },
  };
  game.renderer?.resetGpuTimingEpoch();
  recording = new FrameCapture(performance.now());
  shaderCaptureRenderer = game.renderer;
  shaderCaptureRenderer?.setShaderProgramCapture(true);
  completed = undefined;
  completedProfile = undefined;
  frameXmlAtStop = undefined;
  packetsByOpcode = new Map();
  packetsPerSecond = [];
  lastCheckpoint = Number.NEGATIVE_INFINITY;
  resetCheckpointSections();
  phaseTotals.reset();
  stacking.reset();
  frameExtra.reset();
  // Checkpoints carry the worker's counters since this point (P1-04).
  game.renderer?.poseWorkerStats(true);
  // The stock HUD keeps its own window of counters; start it with the recording.
  metadata["frameXmlMounted"] = frameXmlPerf("reset") !== undefined;
  // L10 (10.18): whether crowd poses ran in the worker or on the main thread, and why.
  metadata["poseWorker"] = poseWorkerReport();
  setCaptureProbe(probe);
  startJsProfiler();
  for (const type of ["longtask", "long-animation-frame", "resource"]) {
    entrySupport[type] = "unsupported";
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes(type)) continue;
    let observer: PerformanceObserver | undefined;
    try {
      observer = new PerformanceObserver((list) => observeEntries(list.getEntries()));
      observer.observe({ type, buffered: false });
      observers.push(observer);
      entrySupport[type] = "enabled";
    } catch {
      observer?.disconnect();
      entrySupport[type] = "unavailable";
    }
  }
  document.addEventListener("visibilitychange", visibilityChanged);
  stopTimer = setTimeout(stopPerformanceCapture, CAPTURE_DURATION_MS);
  changed();
  return true;
}

export function stopPerformanceCapture(): void {
  if (!recording) return;
  setCaptureProbe(undefined);
  stopJsProfiler(recording.startedAt);
  frameXmlAtStop = frameXmlPerf();
  captureShaderPrograms(recording);
  shaderCaptureRenderer?.setShaderProgramCapture(false);
  shaderCaptureRenderer = undefined;
  for (const observer of observers) {
    observeEntries(observer.takeRecords());
    observer.disconnect();
  }
  observers = [];
  document.removeEventListener("visibilitychange", visibilityChanged);
  clearTimeout(stopTimer);
  stopTimer = undefined;
  recording.finish(performance.now());
  completed = recording;
  recording = undefined;
  frameRecording = undefined;
  changed();
}

export function performanceCaptureReport(): unknown {
  if (!completed || recording || profilePending) return undefined;
  const packetRow = ([opcode, totals]: [number, PacketTotals]) => ({
    opcode: `0x${opcode.toString(16)}`, count: totals.count, bytes: totals.bytes,
    ms: round2(totals.ms), maxMs: round2(totals.maxMs),
  });
  return {
    version: 2, telemetryRevision: 2, ...metadata, entrySupport: { ...entrySupport }, ...completed.report(),
    drawPhases: phaseTotals.report(),
    stacking: stacking.report(),
    frameExtra: frameExtra.report(),
    packets: {
      byOpcode: [...packetsByOpcode].sort((left, right) => right[1].ms - left[1].ms).map(packetRow),
      perSecond: packetsPerSecond.map((totals, second) => ({
        second, count: totals.count, bytes: totals.bytes, ms: round2(totals.ms), maxMs: round2(totals.maxMs),
      })),
    },
    frameXml: frameXmlAtStop,
    jsProfile: completedProfile,
    notes: [
      "jsProfile is the JS Self-Profiling trace: samples[i] at atMs has stack stackId; a stack is [frameId, parentId]; frames are [name, resourceId, line, column] in the shipped bundle. Resolve with the build's source maps (dist/sourcemaps) via bench/analyze-live-profile.mjs.",
      "packets.*.ms is handler time per server packet including awaits inside the handler; slowPackets lists single packets over 4 ms.",
      "frameXmlSteps/frameXmlSyncs: the stock HUD runs in its own animation-frame callback, outside cpuMs; steps and between-frame HUD passes over 4 ms are listed.",
      "All times are milliseconds relative to capture start; intervalMs is RAF cadence, not GPU cost.",
      "A long interval ends at this row and may be caused by CPU work in the PREVIOUS row or between callbacks.",
      "CPU is synchronous elapsed callback time, including driver waits; nested render.* sections overlap render.",
      "render.units.* and render.submit.* are capture-only subphases included in their parent totals; do not sum them twice.",
      "render.visuals.* are inside render.visuals; visuals.particles is inside visuals.effects.",
      "drawPhases (telemetryRevision 2) sums every drawPhaseMs key over every recorded frame; meanMs divides by drawPhases.frames, the recorded frame rows.",
      "frameExtra.netMs[i] and frameExtra.frameXmlMs[i] belong to frames[i]: packet handler time and FrameXML step time since the previous row, i.e. what fills that row's interval outside cpuMs.",
      "stacking counts frames where at least two budgeted phases (budgetsMs, net = packet time) reached fireShare of their budget and together passed sumMs; env includes WMO groups, so it is an upper estimate, not a budget measurement.",
      "checkpoints[].poseWorker are the pose worker's counters since capture start; in checkpoints[].shadow, cascades[].renders and frames are totals since the cascades were configured (difference two checkpoints), rendered/drawCalls/cpuMs describe each cascade's last render.",
      "GPU checkpoints contain delayed rolling query results, not the current frame; pending/unavailable is not zero.",
      "GPU query envelope covers world update/submission and portraits; it can include waits for CPU submission, not just busy GPU time.",
      "Resource completion and new GL objects are correlations, not proof of the cause. No resource URLs are exported.",
      "shaderPrograms attributes newly created programs to render passes; keyFields are Three r185 switches with custom text fingerprinted. Hashes are diagnostic identities, not security hashes.",
      "Hidden/loading/login/benchmark frames are excluded from cadence; browser events can overlap visibility boundaries.",
      "This capture has bounded diagnostic overhead. GC stacks and OS scheduling require a browser Performance trace.",
    ],
  };
}

/** Called at callback entry, before the existing full-frame clock. Disabled path is one check. */
export function beginPerformanceCaptureFrame(): void {
  frameRecording = recording;
  if (!frameRecording) return;
  frameStartedAt = performance.now();
  frameWasActive = worldActive();
  clearFrameSections();
  if (!frameWasActive) frameRecording.breakCadence();
}

export function captureFrameSections(at: number, cpuMs: number, sections: Readonly<Record<string, number>>, detail?: string): void {
  if (frameRecording && frameWasActive) {
    frameRecording.event("cpuSections", at, { cpuMs, sections: { ...sections }, detail });
  }
}

/**
 * P1-20a: section sums of every recorded frame since the last checkpoint. `cpuSections` keeps only
 * the slow frames, so ordinary frames had no sectioned number at all; each checkpoint now carries
 * their average (`sections`, ms per frame). Disabled path is one check.
 */
const checkpointSectionSums: Record<string, number> = {};
let checkpointSectionFrames = 0;
/**
 * This frame's sections, kept apart until `endPerformanceCaptureFrame` knows whether the frame is
 * counted: a frame that turns the loading screen on is not, and its time must not land in a window
 * whose frame count leaves it out (a 40 ms loading frame would otherwise inflate ten 0.1 ms ones 41×).
 */
const frameSectionScratch: Record<string, number> = {};

export function addCheckpointSection(name: string, milliseconds: number): void {
  if (!frameRecording || frameRecording !== recording || !frameWasActive) return;
  if (!Number.isFinite(milliseconds)) return;
  // A zero still marks the section as seen, so its checkpoints report 0 rather than nothing.
  frameSectionScratch[name] = (frameSectionScratch[name] ?? 0) + Math.max(0, milliseconds);
}

/** Moves a counted frame's sections into the checkpoint window. */
function commitFrameSections(): void {
  for (const name of Object.keys(frameSectionScratch)) {
    checkpointSectionSums[name] = (checkpointSectionSums[name] ?? 0) + frameSectionScratch[name]!;
    frameSectionScratch[name] = 0;
  }
}

function clearFrameSections(): void {
  for (const name of Object.keys(frameSectionScratch)) frameSectionScratch[name] = 0;
}

/**
 * Averages since the last call, and restarts the window. Every section seen in this recording is
 * present, 0 included: an absent key would drop that checkpoint from the distribution and bias a
 * rarely non-zero part upwards. Undefined when the recording has seen no section at all.
 */
function takeCheckpointSections(): Record<string, number> | undefined {
  const frames = checkpointSectionFrames;
  let sections: Record<string, number> | undefined;
  for (const name of Object.keys(checkpointSectionSums)) {
    const sum = checkpointSectionSums[name]!;
    checkpointSectionSums[name] = 0;
    if (frames > 0) (sections ??= {})[name] = sum / frames;
  }
  checkpointSectionFrames = 0;
  return sections;
}

/** A new recording forgets the sections the last one saw. */
function resetCheckpointSections(): void {
  for (const name of Object.keys(checkpointSectionSums)) delete checkpointSectionSums[name];
  for (const name of Object.keys(frameSectionScratch)) delete frameSectionScratch[name];
  checkpointSectionFrames = 0;
}

/** Checkpoint reads are outside CPU measurement and never walk the full resource accounting tree. */
export function endPerformanceCaptureFrame(rafAt: number, cpuMs: number, failed: boolean): void {
  const capture = frameRecording;
  if (!capture || capture !== recording) return;
  captureShaderPrograms(capture);
  if (frameWasActive && worldActive()) {
    capture.frame(rafAt, frameStartedAt, cpuMs, failed);
    // P1-04: only a frame that became a row feeds the per-frame extras, so they align with `frames`.
    const netMs = frameExtra.pendingNetMs;
    if (frameExtra.commit(capture.count)) {
      const phases = game.renderer?.drawPhaseMs;
      phaseTotals.add(phases);
      stacking.add(phases, netMs);
    }
    commitFrameSections();
    checkpointSectionFrames++;
    if (frameStartedAt - lastCheckpoint >= 500) {
      lastCheckpoint = frameStartedAt;
      const checkpointStart = performance.now();
      try {
        const telemetry = game.renderer?.telemetry;
        const warmup = game.renderer?.programWarmup;
        capture.event("checkpoints", performance.now(), {
          renderer: telemetry, warmup: warmup === undefined ? undefined : {
            programs: warmup.programs, uniformLocations: warmup.uniformLocations, queued: warmup.queued,
            retainedPrograms: warmup.retainedPrograms,
            batches: warmup.batches, failures: warmup.failures, parallelCompile: warmup.parallelCompile,
          },
          terrain: game.terrain?.stats, quality: autoQualityStatus(),
          // A sawtooth here is garbage collection; a drop next to a long interval points at a major GC.
          heap: jsHeap(), worldObjects: game.world?.state.objects.size,
          sections: takeCheckpointSections(),
          poseWorker: game.renderer?.poseWorkerStats(),
          shadow: shadowCheckpoint(game.renderer?.shadowCascadeStats),
          diagnosticMs: performance.now() - checkpointStart,
        });
      } catch {
        capture.event("diagnosticErrors", performance.now(), { stage: "checkpoint" });
      }
    }
  } else {
    capture.breakCadence();
    frameExtra.discard();
  }
  if (capture.full || performance.now() - capture.startedAt >= CAPTURE_DURATION_MS) stopPerformanceCapture();
}

/**
 * The cascades' cumulative counters (P1-04), without the static map sizes and extents, which the
 * renderer telemetry and settings already describe.
 */
function shadowCheckpoint(stats: undefined | {
  readonly cascades: readonly { readonly rendered: boolean; readonly drawCalls: number; readonly cpuMs: number; readonly renders: number }[];
  readonly frames: number; readonly shadowOnlyOwners: number;
}): unknown {
  if (stats === undefined) return undefined;
  return {
    cascades: stats.cascades.map((cascade) => ({
      rendered: cascade.rendered, drawCalls: cascade.drawCalls, cpuMs: round2(cascade.cpuMs), renders: cascade.renders,
    })),
    frames: stats.frames, shadowOnlyOwners: stats.shadowOnlyOwners, // P2-01a: was shadowOnlyCasters (old toggle count)
  };
}

function captureShaderPrograms(capture: FrameCapture): void {
  const events = shaderCaptureRenderer?.drainShaderProgramCapture();
  if (!events) return;
  for (const { at, ...details } of events) capture.event("shaderPrograms", at, details);
}
