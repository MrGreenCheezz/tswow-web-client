import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildPairedBenchmarkRunRecord,
} from "../dist/code/browser/RenderBenchmarkFormalRun.js";

const hash = (label) => createHash("sha256").update(label).digest("hex");

function series(overrides = {}) {
  return {
    count: 5_400,
    average: 10,
    worst: 20,
    longFrames: 0,
    p50: overrides.p50 ?? overrides.p95 ?? 10,
    p95: overrides.p95 ?? 10,
    p99: overrides.p99 ?? 12,
    dropped: 0,
    ...overrides,
  };
}

function queues(overrides = {}) {
  return {
    "terrain.active": 0,
    "terrain.failed": 0,
    "terrainSplat.active": 0,
    "terrainSplat.failed": 0,
    "environment.activeTiles": 0,
    "environment.failedTiles": 0,
    "environment.queuedModels": 0,
    "environment.activeModels": 0,
    "environment.deferredModels": 0,
    "environment.failedModels": 0,
    "environment.queuedGroups": 0,
    "environment.activeGroups": 0,
    "environment.deferredGroups": 0,
    "environment.failedGroups": 0,
    "environment.queuedAnimations": 0,
  "environment.deferredAnimations": 0,
  "environment.activeAnimations": 0,
  "environment.failedAnimations": 0,
  "assetWarmup.queued": 0,
    "assetWarmup.active": 0,
    ...overrides,
  };
}

function evidence(overrides = {}) {
  const schedule = {
    scenario: "interior",
    variant: "A",
    runIndex: 0,
    pairIndex: 0,
    comparisonId: "formal-r1",
    snapshotHash: hash("snapshot"),
    frameOrderHash: hash("frames"),
    environmentHash: hash("environment"),
    variantConfigHash: hash("config-a"),
    warmPolicy: "prewarmed-stable-cache",
    cold: false,
  };
  const run = {
    scenario: "interior",
    variant: "A",
    runIndex: 0,
    startedAt: 1_000,
    endedAt: 91_000,
    durationMs: 90_000,
    expectedDurationMs: 90_000,
    durationOvershootMs: 0,
    durationValid: true,
    frameInterval: series({ count: 5_399, p95: 16, p99: 17 }),
    fullFrameCpu: series({ p95: 11, p99: 14 }),
    rendererFrameCpu: series({ p95: 7, p99: 9 }),
    gpu: {
      status: "available",
      ...series({ p95: 3, p99: 4 }),
      coverage: { attempted: 5_400, covered: 5_400, dropped: 0 },
    },
    resources: { peaks: { counters: queues(), bytes: {} } },
  };
  const replay = {
    startedAtWallMs: 1_000,
    finishedAtWallMs: 91_000,
    wallDurationMs: 90_000,
    frameStepMs: 1_000 / 60,
    logicalDurationMs: 90_000,
    expectedDurationMs: 90_000,
    toleranceMs: 250,
    expectedFrames: 5_400,
    emittedFrames: 5_400,
    complete: true,
    durationValid: true,
    valid: true,
    invalidReasons: [],
  };
  const diagnostic = {
    valid: true,
    frameSequenceComplete: true,
    frameFailures: 0,
    invalidReasons: [],
  };
  const readiness = {
    capturedAt: 1_000,
    ready: true,
    stableForMs: 2_000,
    stableSamples: 3,
    resourceSignature: "stable-signature",
    blockingReasons: [],
  };
  const base = { schedule, run, replay, diagnostic, readiness };
  const merged = typeof overrides === "function" ? overrides(base) : overrides;
  return {
    ...base,
    ...merged,
    schedule: { ...schedule, ...(merged.schedule ?? {}) },
    run: { ...run, ...(merged.run ?? {}) },
    replay: { ...replay, ...(merged.replay ?? {}) },
    diagnostic: { ...diagnostic, ...(merged.diagnostic ?? {}) },
    readiness: { ...readiness, ...(merged.readiness ?? {}) },
  };
}

test("converts a valid available-GPU run using full-frame CPU quantiles", () => {
  const record = buildPairedBenchmarkRunRecord(evidence());
  assert.deepEqual(record.cpu, { p95: 11, p99: 14 });
  assert.deepEqual(record.gpu, {
    status: "available",
    p95: 3,
    p99: 4,
    coverage: { attempted: 5_400, covered: 5_400, dropped: 0 },
  });
  assert.equal(record.durationMs, 90_000);
  assert.equal(record.frameCount, 5_400);
  assert.equal(record.diagnosticValid, true);
});

test("converts CPU-only GPU evidence without inventing zero GPU timings", () => {
  const record = buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
    run: {
        ...run,
        gpu: {
          status: "cpu-only",
          ...series({ count: 0, average: 0, worst: 0, p50: 0, p95: 0, p99: 0 }),
        reason: "unsupported",
        coverage: { attempted: 0, covered: 0, dropped: 0 },
      },
    },
  })));
  assert.deepEqual(record.gpu, {
    status: "cpu-only",
    reason: "unsupported",
    coverage: { attempted: 0, covered: 0, dropped: 0 },
  });
  assert.equal("p95" in record.gpu, false);
  assert.equal("p99" in record.gpu, false);
});

test("rejects mismatched run and replay timelines", () => {
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence({ replay: { finishedAtWallMs: 91_001 } })),
    /replay wall duration|timelines.*identical endpoints/,
  );
});

test("rejects forged duration and replay flags", () => {
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ run: { durationValid: false } })), /duration validity/);
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ replay: { valid: false } })), /replay\.valid/);
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ replay: { invalidReasons: ["duration-out-of-range"] } })), /invalidReasons/);
});

test("requires the formal replay step and logical duration independently of wall duration", () => {
  assert.doesNotThrow(() => buildPairedBenchmarkRunRecord(evidence({
    replay: { frameStepMs: 16.66666666666667, logicalDurationMs: 90_000.00000000001 },
  })));
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence({ replay: { frameStepMs: 1, logicalDurationMs: 5_400 } })),
    /frameStepMs|60 Hz/,
  );
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence({ replay: { logicalDurationMs: 89_999 } })),
    /logicalDurationMs/,
  );
});

test("requires GPU series and coverage counts to be coherent", () => {
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
      run: {
        ...run,
        gpu: { ...run.gpu, coverage: { ...run.gpu.coverage, covered: 5_399 } },
      },
    }))),
    /coverage\.covered.*count/,
  );
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
      run: {
        ...run,
        gpu: { ...run.gpu, dropped: 1 },
      },
    }))),
    /coverage\.dropped.*dropped/,
  );
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
      run: {
        ...run,
        gpu: { ...run.gpu, coverage: { ...run.gpu.coverage, attempted: 5_401 } },
      },
    }))),
    /coverage\.attempted.*covered.*dropped/,
  );
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
      run: {
        ...run,
        gpu: {
          ...run.gpu,
          count: 5_399,
          coverage: { attempted: 5_399, covered: 5_399, dropped: 0 },
        },
      },
    }))),
    /available GPU.*5_400/,
  );
});

test("requires exact accepted CPU counts and zero drops", () => {
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ run: { fullFrameCpu: series({ count: 5_399 }) } })), /CPU diagnostic/);
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ run: { rendererFrameCpu: series({ dropped: 1 }) } })), /CPU diagnostic/);
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ run: { frameInterval: series({ count: 5_398 }) } })), /CPU diagnostic/);
});

test("requires coherent non-empty and zero-count diagnostic series", () => {
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
      run: { ...run, frameInterval: series({ longFrames: 5_401 }) },
    }))),
    /longFrames.*count/,
  );
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
      run: { ...run, frameInterval: series({ p50: 11 }) },
    }))),
    /p50.*p95/,
  );
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
      run: { ...run, frameInterval: series({ p99: 21 }) },
    }))),
    /p99.*worst/,
  );
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
      run: { ...run, frameInterval: series({ average: 21 }) },
    }))),
    /average.*worst/,
  );
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
      run: { ...run, frameInterval: series({ count: 0 }) },
    }))),
    /zero-count.*zero/,
  );
});

test("requires honest, fresh readiness proof", () => {
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ readiness: { capturedAt: 1_001 } })), /captured no later/);
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ readiness: { ready: true, blockingReasons: ["asset-warmup-active"] } })), /readiness\.ready/);
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ readiness: { stableForMs: 1_999 } })), /readiness\.ready|stable idle window/);
});

test("requires every asynchronous resource queue peak and requires zero", () => {
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence(({ run }) => ({
    run: { ...run, resources: { peaks: { counters: Object.fromEntries(Object.entries(queues()).filter(([key]) => key !== "terrain.active")), bytes: {} } } },
  }))), /terrain\.active/);
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ run: { resources: { peaks: { counters: queues({ "assetWarmup.active": 1 }), bytes: {} } } } })), /assetWarmup\.active/);
  assert.throws(
    () => buildPairedBenchmarkRunRecord(evidence({
      run: { resources: { peaks: { counters: queues({ "environment.failedAnimations": 1 }), bytes: {} } } },
    })),
    /environment\.failedAnimations/,
  );
});

test("rejects each nonzero queue peak while accepted evidence remains resource-valid", () => {
  assert.equal(buildPairedBenchmarkRunRecord(evidence()).resourceLoadValid, true);
  for (const key of Object.keys(queues())) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.throws(
      () => buildPairedBenchmarkRunRecord(evidence({
        run: { resources: { peaks: { counters: queues({ [key]: 1 }), bytes: {} } } },
      })),
      new RegExp(escaped),
      `${key}: nonzero peak must reject formal evidence`,
    );
  }
});

test("requires schedule identity to match the raw run", () => {
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ run: { scenario: "rain" } })), /scenario, variant, and runIndex/);
  assert.throws(() => buildPairedBenchmarkRunRecord(evidence({ schedule: { variant: "B" } })), /scenario, variant, and runIndex/);
});

test("returns a deeply frozen JSON-safe record with no raw samples", () => {
  const record = buildPairedBenchmarkRunRecord(evidence());
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.cpu), true);
  assert.equal(Object.isFrozen(record.gpu), true);
  assert.equal(Object.isFrozen(record.gpu.coverage), true);
  assert.equal("samples" in record, false);
  assert.equal("samples" in record.cpu, false);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.throws(() => { record.cpu.p95 = 99; }, TypeError);
});
