import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_LONG_FRAME_THRESHOLD_MS,
  BENCHMARK_RUN_DURATION_MS,
  BENCHMARK_RUN_SAMPLE_CAP,
  BenchmarkRunAccumulator,
} from "../dist/code/browser/RenderBenchmarkRun.js";

const run = (sampleCap = 64) => new BenchmarkRunAccumulator({
  scenario: "goldshire-exterior",
  variant: "A",
  runIndex: 0,
  startedAt: 10_000,
  sampleCap,
});

test("a run summary uses nearest rank and strict long-frame threshold without FPS", () => {
  const accumulator = run();
  for (const milliseconds of [10, 20, 30, 40, 50, 51, 100]) accumulator.addFullFrameCpu(milliseconds);
  accumulator.addRendererFrameCpu(7);
  accumulator.addGpuSample({ status: "available", milliseconds: 3 });
  const summary = accumulator.finish(10_000 + BENCHMARK_RUN_DURATION_MS);

  assert.equal(summary.durationMs, BENCHMARK_RUN_DURATION_MS);
  assert.equal(summary.expectedDurationMs, BENCHMARK_RUN_DURATION_MS);
  assert.equal(summary.durationValid, true);
  assert.deepEqual(summary.fullFrameCpu, {
    count: 7,
    average: 301 / 7,
    worst: 100,
    longFrames: 2,
    p50: 40,
    p95: 100,
    p99: 100,
    dropped: 0,
  });
  assert.equal(summary.rendererFrameCpu.count, 1);
  assert.equal(summary.gpu.status, "available");
  assert.equal(summary.gpu.count, 1);
  assert.equal("reason" in summary.gpu, false);
  assert.deepEqual(summary.gpu.coverage, { attempted: 1, covered: 1, dropped: 0 });
  assert.equal("fps" in summary.fullFrameCpu, false);
  assert.equal(BENCHMARK_LONG_FRAME_THRESHOLD_MS, 50);
});

test("the accumulator retains the full run distribution instead of a rolling-window hitch", () => {
  const accumulator = run(256);
  accumulator.addFullFrameCpu(200);
  for (let index = 0; index < 130; index++) accumulator.addFullFrameCpu(16);
  const summary = accumulator.finish(100_000);

  assert.equal(summary.fullFrameCpu.count, 131);
  assert.equal(summary.fullFrameCpu.worst, 200);
  assert.equal(summary.fullFrameCpu.p99, 16);
  // A 120-sample rolling window would have forgotten the first hitch.
  assert.ok(summary.fullFrameCpu.count > 120);
});

test("duration validity rejects both short and overlong runs", () => {
  const short = run().finish(10_001);
  assert.equal(short.durationValid, false);
  assert.equal(short.durationOvershootMs, 0);

  const long = run().finish(10_000 + BENCHMARK_RUN_DURATION_MS + 1_000);
  assert.equal(long.durationValid, false);
  assert.equal(long.durationOvershootMs, 1_000);
});

test("sealing freezes the measured endpoint while delayed GPU samples still drain", () => {
  const accumulator = run();
  accumulator.addFullFrameCpu(16);
  accumulator.sealMeasurement(10_000 + BENCHMARK_RUN_DURATION_MS);
  accumulator.addGpuSample({ status: "available", milliseconds: 3 });

  const summary = accumulator.finishAfterGpuDrain();
  assert.equal(summary.endedAt, 10_000 + BENCHMARK_RUN_DURATION_MS);
  assert.equal(summary.durationMs, BENCHMARK_RUN_DURATION_MS);
  assert.equal(summary.gpu.count, 1);
  assert.deepEqual(summary.gpu.coverage, { attempted: 1, covered: 1, dropped: 0 });
});

test("sealed measurements reject CPU and resource samples but accept GPU drain callbacks", () => {
  const accumulator = run();
  accumulator.sealMeasurement(10_001);

  for (const operation of [
    () => accumulator.addFullFrameCpu(1),
    () => accumulator.addFrameInterval(1),
    () => accumulator.addRendererFrameCpu(1),
    () => accumulator.recordResourceStart({ counters: { textures: 1 } }),
    () => accumulator.recordResourceCheckpoint({ counters: { textures: 1 } }),
    () => accumulator.recordResourceEnd({ counters: { textures: 1 } }),
  ]) {
    assert.throws(operation, /measurement is already sealed/);
  }
  assert.doesNotThrow(() => accumulator.addGpuSample({ status: "unavailable", reason: "context-lost" }));
  assert.doesNotThrow(() => accumulator.addGpuDropped(1));
  assert.equal(accumulator.finishAfterGpuDrain().endedAt, 10_001);
});

test("finishAfterGpuDrain requires a seal and abort permanently suppresses summary output", () => {
  const unsealed = run();
  assert.throws(() => unsealed.finishAfterGpuDrain(), /must be sealed/);

  const aborted = run();
  aborted.abort();
  for (const operation of [
    () => aborted.addFullFrameCpu(1),
    () => aborted.addGpuSample({ status: "available", milliseconds: 1 }),
    () => aborted.addGpuDropped(1),
    () => aborted.recordResourceCheckpoint({ counters: { textures: 1 } }),
    () => aborted.sealMeasurement(10_001),
    () => aborted.finishAfterGpuDrain(),
    () => aborted.finish(10_001),
  ]) {
    assert.throws(operation, /already aborted/);
  }
});

test("RAF cadence is separate from renderer work duration", () => {
  const accumulator = run();
  accumulator.addFrameInterval(16);
  accumulator.addFrameInterval(16);
  accumulator.addRendererFrameCpu(5);
  accumulator.addRendererFrameCpu(5);
  const summary = accumulator.finish(10_000 + BENCHMARK_RUN_DURATION_MS);

  assert.equal(summary.frameInterval.average, 16);
  assert.equal(summary.frameInterval.p95, 16);
  assert.equal(summary.rendererFrameCpu.average, 5);
  assert.notEqual(summary.frameInterval.average, summary.rendererFrameCpu.average);
  assert.equal("fps" in summary.frameInterval, false);
});

test("invalid values and values beyond the hard cap are dropped", () => {
  const accumulator = run(2);
  accumulator.addFullFrameCpu(1);
  accumulator.addFullFrameCpu(2);
  accumulator.addFullFrameCpu(3);
  accumulator.addFullFrameCpu(-1);
  accumulator.addFullFrameCpu(Number.NaN);
  accumulator.addRendererFrameCpu(Number.POSITIVE_INFINITY);
  const summary = accumulator.finish(10_001);

  assert.equal(summary.fullFrameCpu.count, 2);
  assert.equal(summary.fullFrameCpu.dropped, 3);
  assert.equal(summary.rendererFrameCpu.count, 0);
  assert.equal(summary.rendererFrameCpu.dropped, 1);
  assert.equal(BENCHMARK_RUN_SAMPLE_CAP, 65_536);
});

test("GPU unsupported is explicit CPU-only while disjoint invalidates the gate", () => {
  const cpuOnly = run();
  cpuOnly.addGpuSample({ status: "unavailable", reason: "unsupported" });
  cpuOnly.addFullFrameCpu(16);
  const cpuOnlySummary = cpuOnly.finish(10_016);
  assert.equal(cpuOnlySummary.gpu.status, "cpu-only");
  assert.equal(cpuOnlySummary.gpu.reason, "unsupported");
  assert.equal(cpuOnlySummary.gpu.count, 0);
  assert.deepEqual(cpuOnlySummary.gpu.coverage, { attempted: 0, covered: 0, dropped: 0 });

  const invalid = run();
  invalid.addGpuSample({ status: "available", milliseconds: 2 });
  invalid.addGpuSample({ status: "unavailable", reason: "disjoint" });
  invalid.addGpuSample({ status: "available", milliseconds: 3 });
  const invalidSummary = invalid.finish(10_016);
  assert.equal(invalidSummary.gpu.status, "invalid");
  assert.equal(invalidSummary.gpu.reason, "disjoint");
  assert.equal(invalidSummary.gpu.count, 2);
  assert.deepEqual(invalidSummary.gpu.coverage, { attempted: 2, covered: 2, dropped: 0 });

  const mixed = run();
  mixed.addGpuSample({ status: "available", milliseconds: 2 });
  mixed.addGpuSample({ status: "unavailable", reason: "unsupported" });
  const mixedSummary = mixed.finish(10_001);
  assert.equal(mixedSummary.gpu.status, "invalid");
  assert.equal(mixedSummary.gpu.reason, "mixed-availability");
});

test("GPU invalid samples and queue drops invalidate coverage", () => {
  const invalidSample = run();
  invalidSample.addGpuSample({ status: "available", milliseconds: Number.NaN });
  const invalidSampleSummary = invalidSample.finish(10_001);
  assert.equal(invalidSampleSummary.gpu.status, "invalid");
  assert.equal(invalidSampleSummary.gpu.reason, "query-error");
  assert.deepEqual(invalidSampleSummary.gpu.coverage, { attempted: 1, covered: 0, dropped: 1 });

  const queueDrop = run();
  queueDrop.addGpuSample({ status: "available", milliseconds: 2 });
  queueDrop.addGpuDropped(2);
  const queueDropSummary = queueDrop.finish(10_001);
  assert.equal(queueDropSummary.gpu.status, "invalid");
  assert.equal(queueDropSummary.gpu.reason, "queue-drop");
  assert.deepEqual(queueDropSummary.gpu.coverage, { attempted: 3, covered: 1, dropped: 2 });
  assert.equal(queueDropSummary.gpu.dropped, 2);
});

test("resource checkpoints preserve exact values and high-water peaks", () => {
  const accumulator = run();
  accumulator.recordResourceStart({ counters: { textures: 2 }, bytes: { gpu: 100 } });
  accumulator.recordResourceCheckpoint({ counters: { textures: 5 }, bytes: { gpu: 80, cpu: 10 } });
  accumulator.recordResourceEnd({ counters: { textures: 3 }, bytes: { gpu: 90 } });
  const summary = accumulator.finish(10_100);

  assert.deepEqual(summary.resources, {
    start: { counters: { textures: 2 }, bytes: { gpu: 100 } },
    end: { counters: { textures: 3 }, bytes: { gpu: 90 } },
    peaks: { counters: { textures: 5 }, bytes: { gpu: 100, cpu: 10 } },
  });
});

test("finished summaries are deeply immutable and JSON-safe, with no raw samples", () => {
  const accumulator = run();
  accumulator.addFullFrameCpu(16);
  const summary = accumulator.finish(10_016);

  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.fullFrameCpu), true);
  assert.equal(Object.isFrozen(summary.resources.peaks.counters), true);
  assert.equal(JSON.parse(JSON.stringify(summary)).fullFrameCpu.count, 1);
  assert.equal(summary.durationValid, false);
  assert.equal("samples" in summary, false);
  assert.throws(() => { summary.fullFrameCpu.p95 = 99; }, TypeError);
  assert.throws(() => accumulator.addFullFrameCpu(1), /already finished/);
});
