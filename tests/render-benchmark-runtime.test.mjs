import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RENDER_BENCHMARK_CHECKPOINT_INTERVAL_MS,
  RenderBenchmarkRuntime,
  acquireRenderBenchmarkFormalGpuObserver,
  benchmarkResourceCheckpoint,
  renderBenchmarkGpuObserver,
  renderBenchmarkRuntime,
} from "../dist/code/browser/RenderBenchmarkRuntime.js";
import { GpuTimer } from "../dist/code/browser/GpuTimer.js";
import { captureBenchmarkEnvironment } from "../dist/code/browser/BenchmarkManifest.js";

const frame = Object.freeze({
  count: 1, average: 5, worst: 5, longFrames: 0, p50: 5, p95: 5, p99: 5,
});

function telemetry(scale = 1) {
  return {
    capturedAt: 1_000 * scale,
    fullFrame: frame,
    renderer: {
      cpu: frame,
      gpu: { status: "pending", pending: 0, dropped: 0 },
      observedFps: 60,
      drawCalls: 10 * scale,
      triangles: 1_000 * scale,
      unitsDrawn: 2, unitsDropped: 0,
      gameObjectsDrawn: 3, gameObjectsDropped: 1,
      effectsDrawn: 4, effectsDropped: 1,
      groundCoverDrawn: 50, groundCoverSelected: 60,
      groundCoverSelectionDroppedCells: 2, groundCoverResidentMeshes: 3,
      wmoPortalModels: 1, wmoPortalCandidates: 8, wmoPortalCulled: 5,
      textureCount: 20 * scale, geometryCount: 12 * scale,
    },
    resources: {
      terrain: { resident: 4 * scale, failed: 1, active: 2, typedPayloadBytes: 1_024 * scale },
      environment: {
        residentTiles: 5, knownMissingTiles: 6, failedTiles: 7, activeTiles: 8,
        residentObjects: 9, residentModels: 10, knownMissingModels: 11,
        deferredModels: 12, failedModels: 13, queuedModels: 14, activeModels: 15,
        queuedGroups: 16, activeGroups: 17, deferredGroups: 18, failedGroups: 19, residentAnimations: 20,
        failedAnimations: 21, deferredAnimations: 0, queuedAnimations: 0, activeAnimations: 22,
      },
      terrainSplat: {
        resident: 2, failed: 1, active: 3,
        decodedLayerBytes: 2_048 * scale, layerRequestEntries: 4,
      },
      assetWarmup: { accepted: 100, queued: 5, active: 2, closed: false },
      accounting: Object.freeze({
        cpu: Object.freeze({
          uniqueRetainedBytes: 4_096 * scale,
          uniqueResources: 4,
          owners: 3,
          references: 6,
          sharedResources: 2,
        }),
        gpuBuffers: Object.freeze({
          estimatedGpuBufferBytes: 8_192 * scale,
          uniqueResources: 5,
          owners: 3,
          references: 7,
          sharedResources: 2,
        }),
        unsupported: Object.freeze({
          uniqueResources: 2,
          owners: 2,
          references: 3,
          sharedResources: 1,
        }),
        coverage: Object.freeze({
          complete: false,
          gaps: Object.freeze(["textures", "render-targets"]),
        }),
      }),
    },
  };
}

function environment(backingWidth = 1600) {
  return captureBenchmarkEnvironment({
    canvas: {
      cssWidth: 1600, cssHeight: 900, backingWidth, backingHeight: 900,
      systemDpr: 1.25, effectivePixelRatio: 1.25, renderScalePercent: 100,
    },
    lighting: 1,
    browser: { name: "Firefox", version: "124" },
    webgl: { version: "WebGL 2.0", shadingLanguageVersion: "GLSL", extensions: [] },
    settings: { lightingQuality: 1, renderScale: 100 },
  });
}

test("inactive runtime record methods are no-ops and status is explicitly non-formal", () => {
  const runtime = new RenderBenchmarkRuntime();
  assert.doesNotThrow(() => {
    runtime.recordFrameInterval(Number.NaN);
    runtime.recordFullFrameCpu(-1);
    runtime.recordRendererFrameCpu(Number.POSITIVE_INFINITY);
    runtime.recordGpuSample(Number.NaN);
    runtime.recordGpuDropped(-1);
    runtime.recordFrameFailure();
    runtime.recordResourceCheckpoint(1_000, telemetry());
  });
  assert.deepEqual(runtime.status(), {
    mode: "live-diagnostic",
    formalGateEligible: false,
    active: false,
  });
  assert.equal(runtime.checkpointDue(1_000), false);
});

test("runtime rejects overlap and records raw cadence, CPU work, GPU and one-second resources", () => {
  const runtime = new RenderBenchmarkRuntime();
  const startedAt = 10_000;
  const stableEnvironment = environment();
  const status = runtime.start({ scenario: "stormwind", variant: "A", runIndex: 2, startedAt }, telemetry(),
    undefined, stableEnvironment);
  assert.equal(status.active, true);
  assert.throws(() => runtime.start({ scenario: "other", variant: "B", runIndex: 3, startedAt }),
    /already active/);

  runtime.recordFrameInterval(16);
  runtime.recordFrameInterval(17);
  runtime.recordFullFrameCpu(9);
  runtime.recordRendererFrameCpu(5);
  runtime.recordGpuSample(2.5);
  assert.equal(runtime.checkpointDue(startedAt + RENDER_BENCHMARK_CHECKPOINT_INTERVAL_MS - 1), false);
  runtime.recordResourceCheckpoint(startedAt + 999, telemetry(3));
  assert.equal(runtime.checkpointDue(startedAt + RENDER_BENCHMARK_CHECKPOINT_INTERVAL_MS), true);
  runtime.recordResourceCheckpoint(startedAt + RENDER_BENCHMARK_CHECKPOINT_INTERVAL_MS, telemetry(2));
  assert.equal(runtime.checkpointDue(startedAt + RENDER_BENCHMARK_CHECKPOINT_INTERVAL_MS), false);

  const summary = runtime.finish(startedAt + 90_000, telemetry(1.5), stableEnvironment);
  assert.equal(summary.mode, "live-diagnostic");
  assert.equal(summary.formalGateEligible, false);
   assert.deepEqual(summary.diagnosticValidity, {
     valid: true, frameSequenceComplete: true, frameFailures: 0, invalidReasons: [],
   });
  assert.equal(summary.durationValid, true, "duration validity is descriptive, never a formal gate");
  assert.deepEqual(summary.frameInterval, {
    count: 2, average: 16.5, worst: 17, longFrames: 0,
    p50: 16, p95: 17, p99: 17, dropped: 0,
  });
  assert.equal(summary.fullFrameCpu.average, 9);
  assert.equal(summary.rendererFrameCpu.average, 5);
  assert.equal(summary.gpu.average, 2.5);
  assert.equal(summary.resources.start.counters["environment.knownMissingTiles"], 6);
  assert.equal(summary.resources.peaks.counters["renderer.textureCount"], 40);
  assert.equal(summary.resources.peaks.bytes["terrain.typedPayload"], 2_048);
  assert.equal(summary.resources.peaks.bytes["terrainSplat.decodedLayers"], 4_096);
  assert.equal(summary.resources.start.bytes["accounting.cpu.uniqueRetainedBytes"], 4_096);
  assert.equal(summary.resources.peaks.bytes["accounting.gpuBuffers.estimatedGpuBufferBytes"], 16_384);
  assert.equal(summary.resources.peaks.counters["accounting.cpu.uniqueResources"], 4);
  assert.equal(summary.resources.peaks.counters["accounting.cpu.owners"], 3);
  assert.equal(summary.resources.peaks.counters["accounting.cpu.references"], 6);
  assert.equal(summary.resources.peaks.counters["accounting.cpu.sharedResources"], 2);
  assert.equal(summary.resources.peaks.counters["accounting.gpuBuffers.uniqueResources"], 5);
  assert.equal(summary.resources.peaks.counters["accounting.gpuBuffers.owners"], 3);
  assert.equal(summary.resources.peaks.counters["accounting.gpuBuffers.references"], 7);
  assert.equal(summary.resources.peaks.counters["accounting.gpuBuffers.sharedResources"], 2);
  assert.equal(summary.resources.peaks.counters["accounting.unsupported.uniqueResources"], 2);
  assert.equal(summary.resources.peaks.counters["accounting.unsupported.owners"], 2);
  assert.equal(summary.resources.peaks.counters["accounting.unsupported.references"], 3);
  assert.equal(summary.resources.peaks.counters["accounting.unsupported.sharedResources"], 1);
  assert.equal(summary.resources.peaks.counters["accounting.coverageComplete"], 0);
  assert.equal(summary.resources.peaks.counters["accounting.coverageGapCount"], 2);
  assert.equal(runtime.active, false);
});

test("pending GPU invalidation is counted as dropped and cannot remain GPU-valid", () => {
  const runtime = new RenderBenchmarkRuntime();
  runtime.start({ scenario: "goldshire", variant: "A", runIndex: 0, startedAt: 1_000 }, telemetry());
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    extension: { TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 },
    active: undefined,
    getExtension() { return this.extension; },
    getParameter() { return false; },
    createQuery() { return {}; },
    beginQuery(_target, query) { this.active = query; },
    endQuery() { this.active = undefined; },
    getQueryParameter() { return false; },
    deleteQuery() {},
    isContextLost() { return false; },
  };
  const timer = new GpuTimer(gl, runtime.gpuObserver);
  assert.equal(timer.beginFrame(), true);
  timer.endFrame();
  timer.resetEpoch(); // the finish path discards this one unresolved query while runtime is active
  const summary = runtime.finish(2_000, telemetry(), environment());

  assert.equal(summary.gpu.status, "invalid");
  assert.equal(summary.gpu.reason, "pending-at-finish");
  assert.deepEqual(summary.gpu.coverage, { attempted: 1, covered: 0, dropped: 1 });
});

test("GPU timer drop reasons remain distinct at the runtime boundary", () => {
  for (const [timerReason, summaryReason] of [
    ["queue-full", "queue-drop"],
    ["discarded", "query-discard"],
    ["epoch-reset", "pending-at-finish"],
  ]) {
    const runtime = new RenderBenchmarkRuntime();
    runtime.start({ scenario: "drop", variant: timerReason, runIndex: 0, startedAt: 1_000 }, telemetry());
    runtime.gpuObserver.onDropped(1, timerReason);
    const summary = runtime.finish(2_000, telemetry());
    assert.equal(summary.gpu.reason, summaryReason);
    assert.deepEqual(summary.gpu.coverage, { attempted: 1, covered: 0, dropped: 1 });
  }
});

test("beginQuery failure retains query-error as the causal runtime reason", () => {
  const runtime = new RenderBenchmarkRuntime();
  runtime.start({ scenario: "query", variant: "begin-throw", runIndex: 0, startedAt: 1_000 }, telemetry());
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    extension: { TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 },
    getExtension() { return this.extension; },
    getParameter() { return false; },
    createQuery() { return {}; },
    beginQuery() { throw new Error("begin failed"); },
    endQuery() {},
    getQueryParameter() { return false; },
    deleteQuery() {},
    isContextLost() { return false; },
  };
  const timer = new GpuTimer(gl, runtime.gpuObserver);

  assert.equal(timer.beginFrame(), false);
  const summary = runtime.finish(2_000, telemetry());
  assert.equal(summary.gpu.reason, "query-error");
  assert.deepEqual(summary.gpu.coverage, { attempted: 1, covered: 0, dropped: 1 });
});

test("initial unsupported state is CPU-only and finished output is frozen JSON", () => {
  const runtime = new RenderBenchmarkRuntime();
  runtime.start(
    { scenario: "goldshire", variant: "baseline", runIndex: 0, startedAt: 1_000 },
    telemetry(),
    "unsupported",
    environment(),
  );
  runtime.recordFullFrameCpu(8);
  runtime.recordFrameFailure();
  assert.equal(runtime.status().frameFailures, 1);
  const summary = runtime.finish(2_000, telemetry(), environment());

  assert.equal(summary.gpu.status, "cpu-only");
  assert.equal(summary.gpu.reason, "unsupported");
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.diagnosticValidity), true);
  assert.deepEqual(summary.diagnosticValidity, {
    valid: false, frameSequenceComplete: false, frameFailures: 1, invalidReasons: ["frame-errors"],
  });
  assert.equal(Object.isFrozen(summary.resources.end.bytes), true);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
  assert.throws(() => { summary.formalGateEligible = true; }, TypeError);
});

test("frame sequence completeness is distinct from the diagnostic duration advisory", () => {
  const runtime = new RenderBenchmarkRuntime();
  const stableEnvironment = environment();
  runtime.start({ scenario: "short", variant: "live", runIndex: 0, startedAt: 1_000 }, telemetry(),
    undefined, stableEnvironment);
  const summary = runtime.finish(2_000, telemetry(), stableEnvironment);

  assert.equal(summary.durationValid, false);
  assert.deepEqual(summary.diagnosticValidity, {
    valid: true,
    frameSequenceComplete: true,
    frameFailures: 0,
    invalidReasons: [],
  });
});

test("runtime captures start environment and keeps unchanged runs diagnostically valid", () => {
  const runtime = new RenderBenchmarkRuntime();
  const start = environment();
  runtime.start({ scenario: "stormwind", variant: "live", runIndex: 0, startedAt: 1_000 },
    undefined, undefined, start);
  const summary = runtime.finish(2_000, telemetry(), start);

  assert.deepEqual(summary.environment, { start, finish: start });
  assert.deepEqual(summary.diagnosticValidity, {
    valid: true, frameSequenceComplete: true, frameFailures: 0, invalidReasons: [],
  });
});

test("environment changes invalidate diagnostics independently and compose with frame errors", () => {
  const runtime = new RenderBenchmarkRuntime();
  const start = environment();
  runtime.start({ scenario: "stormwind", variant: "live", runIndex: 0, startedAt: 1_000 },
    undefined, undefined, start);
  runtime.recordFrameFailure();
  const summary = runtime.finish(2_000, telemetry(), environment(1700));

  assert.deepEqual(summary.diagnosticValidity, {
    valid: false,
    frameSequenceComplete: false,
    frameFailures: 1,
    invalidReasons: ["frame-errors", "environment-changed"],
  });
  assert.deepEqual(summary.environment, { start, finish: environment(1700) });
});

test("runtime owns a validated environment copy at finish", () => {
  const runtime = new RenderBenchmarkRuntime();
  runtime.start({ scenario: "copy", variant: "live", runIndex: 0, startedAt: 1_000 }, undefined, undefined,
    environment());
  const mutable = {
    canvas: {
      cssWidth: 1600, cssHeight: 900, backingWidth: 1600, backingHeight: 900,
      systemDpr: 1.25, effectivePixelRatio: 1.25, renderScalePercent: 100,
    },
    lighting: 1,
    browser: { name: "Firefox", version: "124" },
    webgl: { version: "WebGL 2.0", shadingLanguageVersion: "GLSL", extensions: [] },
    settings: { nested: { enabled: true } },
  };
  const summary = runtime.finish(2_000, telemetry(), mutable);
  mutable.canvas.cssWidth = 1;
  mutable.settings.nested.enabled = false;
  assert.equal(summary.environment.finish.canvas.cssWidth, 1600);
  assert.equal(summary.environment.finish.settings.nested.enabled, true);
  assert.equal(Object.isFrozen(summary.environment), true);

  const invalidRuntime = new RenderBenchmarkRuntime();
  invalidRuntime.start({ scenario: "invalid", variant: "live", runIndex: 0, startedAt: 1_000 });
  assert.throws(() => invalidRuntime.finish(2_000, telemetry(), { canvas: {} }), /canvas\.(cssWidth|effectivePixelRatio)/);
});

test("missing environment endpoint invalidates diagnostics with a distinct reason", () => {
  const finishOnly = new RenderBenchmarkRuntime();
  finishOnly.start({ scenario: "missing-start", variant: "live", runIndex: 0, startedAt: 1_000 });
  const finishOnlySummary = finishOnly.finish(2_000, telemetry(), environment());
  assert.deepEqual(finishOnlySummary.environment, { start: null, finish: environment() });
  assert.deepEqual(finishOnlySummary.diagnosticValidity.invalidReasons, ["environment-missing"]);
  assert.equal(finishOnlySummary.diagnosticValidity.valid, false);

  const startOnly = new RenderBenchmarkRuntime();
  const start = environment();
  startOnly.start({ scenario: "missing-finish", variant: "live", runIndex: 0, startedAt: 1_000 },
    undefined, undefined, start);
  const startOnlySummary = startOnly.finish(2_000, telemetry());
  assert.deepEqual(startOnlySummary.environment, { start, finish: null });
  assert.deepEqual(startOnlySummary.diagnosticValidity.invalidReasons, ["environment-missing"]);
  assert.equal(startOnlySummary.diagnosticValidity.valid, false);
});

test("module-level GPU observer routes an exclusive formal lease and restores live runtime", () => {
  const formalEvents = [];
  const formalObserver = {
    onSample: (milliseconds) => formalEvents.push(["sample", milliseconds]),
    onUnavailable: (reason) => formalEvents.push(["unavailable", reason]),
    onDropped: (count, reason) => formalEvents.push(["dropped", count, reason]),
  };
  const lease = acquireRenderBenchmarkFormalGpuObserver(formalObserver);
  try {
    assert.equal(Object.isFrozen(lease), true);
    assert.equal(typeof lease.id, "number");
    assert.throws(() => acquireRenderBenchmarkFormalGpuObserver(formalObserver), /already claimed/);
    assert.throws(
      () => renderBenchmarkRuntime.start({ scenario: "blocked", variant: "live", runIndex: 0, startedAt: 1_000 }),
      /formal GPU observer.*claimed/,
    );

    renderBenchmarkGpuObserver.onSample(3);
    renderBenchmarkGpuObserver.onUnavailable("disjoint");
    renderBenchmarkGpuObserver.onDropped(2, "queue-full");
    assert.deepEqual(formalEvents, [
      ["sample", 3], ["unavailable", "disjoint"], ["dropped", 2, "queue-full"],
    ]);
  } finally {
    lease.release();
    lease.release();
  }

  const secondEvents = [];
  const secondLease = acquireRenderBenchmarkFormalGpuObserver({
    onSample: (milliseconds) => secondEvents.push(milliseconds),
  });
  renderBenchmarkGpuObserver.onSample(5);
  secondLease.release();
  assert.deepEqual(secondEvents, [5]);

  renderBenchmarkRuntime.start({ scenario: "restored", variant: "live", runIndex: 0, startedAt: 1_000 });
  renderBenchmarkGpuObserver.onSample(7);
  const liveSummary = renderBenchmarkRuntime.finish(2_000);
  assert.equal(liveSummary.gpu.count, 1);
  assert.equal(liveSummary.gpu.average, 7);

  const throwingLease = acquireRenderBenchmarkFormalGpuObserver({
    onSample: () => { throw new Error("diagnostic observer failure"); },
  });
  assert.doesNotThrow(() => renderBenchmarkGpuObserver.onSample(9));
  throwingLease.release();
});

test("resource flattening preserves terrain/splat bytes and exposes labelled accounting without guessed VRAM", () => {
  const checkpoint = benchmarkResourceCheckpoint(telemetry());
  assert.deepEqual(Object.keys(checkpoint.bytes).sort(), [
    "accounting.cpu.uniqueRetainedBytes",
    "accounting.gpuBuffers.estimatedGpuBufferBytes",
    "terrain.typedPayload",
    "terrainSplat.decodedLayers",
  ]);
  assert.equal(checkpoint.counters["environment.knownMissingTiles"], 6);
  assert.equal(Object.keys(checkpoint.bytes).some((key) => /vram|resident/i.test(key)), false);
  assert.deepEqual(Object.keys(checkpoint.bytes).filter((key) => /gpu/i.test(key)), [
    "accounting.gpuBuffers.estimatedGpuBufferBytes",
  ]);
});

test("main exposes start/finish/status hooks and closes pending GPU epoch before runtime finish", async () => {
  const source = await readFile(new URL("../src/browser/main.ts", import.meta.url), "utf8");
  assert.equal(source.includes("webclientRenderBenchmark"), true);
  assert.equal(source.includes('game.renderer ? game.renderer.resetGpuTimingEpoch() : "unsupported"'), true,
    "missing WebGL renderer is explicit CPU-only degradation");
  const startBegin = source.indexOf("start(scenario: string, variant: string, runIndex: number)");
  const activeGuard = source.indexOf("if (renderBenchmarkRuntime.active)", startBegin);
  const cadenceReset = source.indexOf("resetFrameCadence()", activeGuard);
  const startReset = source.indexOf("resetGpuTimingEpoch()", cadenceReset);
  const startCapture = source.indexOf("captureRenderTelemetry(startedAt)", startReset);
  const activate = source.indexOf("renderBenchmarkRuntime.start(", startCapture);
  assert.ok(startBegin >= 0 && activeGuard > startBegin && cadenceReset > activeGuard
    && startReset > cadenceReset
    && startCapture > startReset && activate > startCapture,
  "pre-run cadence/GPU reset and capture happen while the accumulator is inactive");
  const finishStart = source.indexOf("finish(): LiveRenderBenchmarkSummary {");
  const capture = source.indexOf("captureRenderTelemetry(endedAt)", finishStart);
  const reset = source.indexOf("resetGpuTimingEpoch()", capture);
  const finish = source.indexOf("renderBenchmarkRuntime.finish(endedAt, telemetry, environment)", reset);
  assert.ok(finishStart >= 0 && capture > finishStart && reset > capture && finish > reset);
});
