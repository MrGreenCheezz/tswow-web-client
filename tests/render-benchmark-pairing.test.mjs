import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PAIRED_BENCHMARK_DURATION_TOLERANCE_MS,
  PAIRED_BENCHMARK_EXPECTED_DURATION_MS,
  PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT,
  PAIRED_BENCHMARK_ORDER,
  PAIRED_BENCHMARK_WARM_POLICY,
  buildPairedBenchmarkReport,
  pairedBootstrapMean,
  validatePairedBenchmarkRunRecord,
} from "../dist/code/browser/RenderBenchmarkPairing.js";

const hash = (label) => createHash("sha256").update(label).digest("hex");
const SNAPSHOT_HASH = hash("snapshot-v1");
const FRAME_ORDER_HASH = hash("frame-order-v1");
const SHARED_ENVIRONMENT_HASH = hash("shared-environment-v1");
const CONFIG_A_HASH = hash("variant-a-config-v1");
const CONFIG_B_HASH = hash("variant-b-config-v1");

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function records(overrides = {}) {
  const variants = ["A", "B", "B", "A", "A", "B", "B", "A", "A", "B"];
  return freeze(variants.map((variant, runIndex) => ({
    runIndex,
    pairIndex: Math.floor(runIndex / 2),
    variant,
    comparisonId: "renderer-r1-paired-v1",
    snapshotHash: SNAPSHOT_HASH,
    frameOrderHash: FRAME_ORDER_HASH,
    environmentHash: SHARED_ENVIRONMENT_HASH,
    variantConfigHash: variant === "A" ? CONFIG_A_HASH : CONFIG_B_HASH,
    warmPolicy: "prewarmed-stable-cache",
    cold: false,
    durationMs: 90_000,
    expectedDurationMs: 90_000,
    durationValid: true,
    frameCount: 5_400,
    expectedFrameCount: 5_400,
    frameSequenceComplete: true,
    diagnosticValid: true,
    readinessValid: true,
    resourceLoadValid: true,
    cpu: variant === "A" ? { p95: 100, p99: 100 } : { p95: 102, p99: 104 },
    gpu: variant === "A"
      ? {
        status: "available", p95: 100, p99: 100,
        coverage: { attempted: 5_400, covered: 5_400, dropped: 0 },
      }
      : {
        status: "available", p95: 102, p99: 104,
        coverage: { attempted: 5_400, covered: 5_400, dropped: 0 },
      },
    ...(typeof overrides === "function" ? overrides({ variant, runIndex }) : overrides),
  })));
}

test("the formal schedule and run constants are exact", () => {
  assert.deepEqual(PAIRED_BENCHMARK_ORDER.map(({ pairIndex, variant }) => [pairIndex, variant]), [
    [0, "A"], [0, "B"],
    [1, "B"], [1, "A"],
    [2, "A"], [2, "B"],
    [3, "B"], [3, "A"],
    [4, "A"], [4, "B"],
  ]);
  assert.equal(PAIRED_BENCHMARK_EXPECTED_DURATION_MS, 90_000);
  assert.equal(PAIRED_BENCHMARK_DURATION_TOLERANCE_MS, 250);
  assert.equal(PAIRED_BENCHMARK_EXPECTED_FRAME_COUNT, 5_400);
  assert.equal(PAIRED_BENCHMARK_WARM_POLICY, "prewarmed-stable-cache");
  assert.equal(Object.isFrozen(PAIRED_BENCHMARK_ORDER), true);
});

test("bootstrap enumerates all 5^5 ordered resamples and uses nearest-rank percentiles", () => {
  const result = pairedBootstrapMean([0, 0, 0, 0, 1]);
  assert.deepEqual(result, {
    estimate: 0.2,
    lower: 0,
    upper: 0.6,
    sampleCount: 3_125,
  });
});

test("bootstrap means avoid intermediate overflow for finite extreme deltas", () => {
  const result = pairedBootstrapMean([1e308, 1e308, 1e308, 1e308, 1e308]);
  assert.equal(Number.isFinite(result.estimate), true);
  assert.equal(Number.isFinite(result.lower), true);
  assert.equal(Number.isFinite(result.upper), true);
  assert.equal(result.estimate, 1e308);
  assert.equal(result.lower, 1e308);
  assert.equal(result.upper, 1e308);
});

test("a valid report pairs A as baseline with B and reports both configurations", () => {
  const input = records();
  assert.equal(validatePairedBenchmarkRunRecord(input[0]), undefined);
  const report = buildPairedBenchmarkReport(input);

  assert.equal(report.formalGateEligible, false);
  assert.equal(report.runCount, 10);
  assert.equal(report.pairCount, 5);
  assert.equal(report.expectedDurationMs, 90_000);
  assert.equal(report.durationToleranceMs, 250);
  assert.equal(report.expectedFrameCount, 5_400);
  assert.equal(report.environmentHash, SHARED_ENVIRONMENT_HASH);
  assert.deepEqual(report.variantConfigHashes, { A: CONFIG_A_HASH, B: CONFIG_B_HASH });
  assert.deepEqual(report.cpu.p95.deltas, [0.02, 0.02, 0.02, 0.02, 0.02]);
  assert.deepEqual(report.cpu.p99.deltas, [0.04, 0.04, 0.04, 0.04, 0.04]);
  assert.equal(report.cpu.gate, "pass");
  assert.equal(report.gpu.status, "available");
  assert.equal(report.gpu.p95.gate, "pass");
  assert.equal(report.gpu.p99.gate, "pass");
  assert.deepEqual(report.bootstrap, {
    method: "exhaustive-ordered-paired-mean",
    pairCount: 5,
    sampleCount: 3_125,
    confidence: 0.95,
    quantileRule: "nearest-rank",
  });
});

test("upper CI selects pass, warn, and fail at the roadmap thresholds", () => {
  const warning = buildPairedBenchmarkReport(records(({ variant }) => ({
    cpu: variant === "A" ? { p95: 100, p99: 100 } : { p95: 104, p99: 108 },
  })));
  assert.equal(warning.cpu.p95.gate, "warn");
  assert.equal(warning.cpu.p99.gate, "warn");
  assert.equal(warning.cpu.gate, "warn");

  const failure = buildPairedBenchmarkReport(records(({ variant }) => ({
    cpu: variant === "A" ? { p95: 100, p99: 100 } : { p95: 106, p99: 111 },
  })));
  assert.equal(failure.cpu.p95.gate, "fail");
  assert.equal(failure.cpu.p99.gate, "fail");
  assert.equal(failure.cpu.gate, "fail");
});

test("duration and frame validity are recomputed instead of trusting caller markers", () => {
  assert.throws(
    () => buildPairedBenchmarkReport(records({ durationMs: 89_999.999 })),
    /durationMs.*90_000.*90_250/,
  );
  assert.doesNotThrow(() => buildPairedBenchmarkReport(records({ durationMs: 90_000 })));
  assert.doesNotThrow(() => buildPairedBenchmarkReport(records({ durationMs: 90_250 })));
  assert.throws(
    () => buildPairedBenchmarkReport(records({ durationMs: 90_250.001 })),
    /durationMs.*90_000.*90_250/,
  );

  assert.throws(
    () => buildPairedBenchmarkReport(records({ durationMs: 1, durationValid: true })),
    /durationMs/,
  );
  assert.throws(
    () => buildPairedBenchmarkReport(records({ frameCount: 1, frameSequenceComplete: true })),
    /frameCount.*5_400/,
  );
  assert.doesNotThrow(() => buildPairedBenchmarkReport(records({
    durationValid: false,
    frameSequenceComplete: false,
  })));
});

test("formal expected duration and frame count cannot drift", () => {
  for (const [field, value] of [
    ["expectedDurationMs", 90_001],
    ["expectedFrameCount", 5_399],
  ]) {
    assert.throws(() => buildPairedBenchmarkReport(records({ [field]: value })), new RegExp(field));
  }
});

test("replay, comparison, and shared runtime capability identities are strict and stable", () => {
  for (const [field, value] of [
    ["comparisonId", ""],
    ["snapshotHash", "snapshot-v1"],
    ["frameOrderHash", "A".repeat(64)],
    ["environmentHash", "0".repeat(63)],
    ["variantConfigHash", "g".repeat(64)],
  ]) {
    assert.throws(() => buildPairedBenchmarkReport(records({ [field]: value })), new RegExp(field));
  }

  for (const [field, value] of [
    ["comparisonId", "another-comparison"],
    ["snapshotHash", hash("snapshot-drift")],
    ["frameOrderHash", hash("frame-order-drift")],
    ["environmentHash", hash("different-hardware")],
  ]) {
    const input = records(({ runIndex }) => runIndex === 6 ? { [field]: value } : {});
    assert.throws(() => buildPairedBenchmarkReport(input), new RegExp(field));
  }
});

test("A and B configurations are internally stable and distinct", () => {
  const driftA = records(({ runIndex }) => runIndex === 4
    ? { variantConfigHash: hash("variant-a-config-drift") }
    : {});
  assert.throws(() => buildPairedBenchmarkReport(driftA), /variant A.*variantConfigHash|variantConfigHash.*variant A/);

  const driftB = records(({ runIndex }) => runIndex === 5
    ? { variantConfigHash: hash("variant-b-config-drift") }
    : {});
  assert.throws(() => buildPairedBenchmarkReport(driftB), /variant B.*variantConfigHash|variantConfigHash.*variant B/);

  const sameConfiguration = records({ variantConfigHash: CONFIG_A_HASH });
  assert.throws(() => buildPairedBenchmarkReport(sameConfiguration), /A and B.*different/);
});

test("wrong order, cold runs, and invalid diagnostic readiness reject the report", () => {
  for (const [field, value] of [
    ["cold", true],
    ["diagnosticValid", false],
    ["readinessValid", false],
    ["resourceLoadValid", false],
    ["warmPolicy", "cold-cache"],
  ]) {
    assert.throws(() => buildPairedBenchmarkReport(records({ [field]: value })), new RegExp(field));
  }
  assert.throws(
    () => buildPairedBenchmarkReport(records(({ runIndex }) => runIndex === 0 ? { variant: "B" } : {})),
    /run 0.*variant A/,
  );
  assert.throws(
    () => buildPairedBenchmarkReport(records(({ runIndex }) => runIndex === 4 ? { pairIndex: 3 } : {})),
    /run 4.*pair 2/,
  );
});

test("run and CPU objects use strict exact-key plain shapes and ordered quantiles", () => {
  assert.throws(() => buildPairedBenchmarkReport(records({ unexpected: true })), /unexpected/);
  assert.throws(() => buildPairedBenchmarkReport(records({ cpu: { p95: 10 } })), /cpu.*p99/);
  assert.throws(() => buildPairedBenchmarkReport(records({ cpu: { p95: 10, p99: 20, mean: 15 } })), /cpu.*mean/);
  assert.throws(() => buildPairedBenchmarkReport(records({ cpu: { p95: 20, p99: 10 } })), /cpu.*p95.*p99/);
  assert.throws(() => buildPairedBenchmarkReport(records({ cpu: { p95: Number.NaN, p99: 10 } })), /cpu\.p95.*finite/);
  assert.throws(() => validatePairedBenchmarkRunRecord([]), /plain object/);
});

test("zero or nonfinite A baselines reject the whole report", () => {
  const zero = records(({ runIndex }) => runIndex === 0
    ? { cpu: { p95: 0, p99: 100 } }
    : {});
  assert.throws(() => buildPairedBenchmarkReport(zero), /cpu\.p95.*positive/);

  const nonfinite = records(({ runIndex }) => runIndex === 1
    ? { cpu: { p95: Number.POSITIVE_INFINITY, p99: Number.POSITIVE_INFINITY } }
    : {});
  assert.throws(() => buildPairedBenchmarkReport(nonfinite), /cpu\.p95.*finite/);
});

test("GPU is reported only when all runs have complete zero-drop coverage", () => {
  const cases = [
    {
      gpu: {
        status: "unavailable", reason: "unsupported",
        coverage: { attempted: 0, covered: 0, dropped: 0 },
      },
    },
    {
      gpu: {
        status: "available", p95: 10, p99: 20,
        coverage: { attempted: 0, covered: 0, dropped: 0 },
      },
    },
    {
      gpu: {
        status: "available", p95: 10, p99: 20,
        coverage: { attempted: 5_400, covered: 5_399, dropped: 0 },
      },
    },
    {
      gpu: {
        status: "available", p95: 10, p99: 20,
        coverage: { attempted: 5_400, covered: 5_399, dropped: 1 },
      },
    },
  ];
  for (const replacement of cases) {
    const report = buildPairedBenchmarkReport(records(({ runIndex }) => runIndex === 7 ? replacement : {}));
    assert.deepEqual(report.gpu, {
      status: "unavailable",
      reason: "not-all-runs-valid-and-complete",
      affectedRunIndices: [7],
    });
    assert.equal("p95" in report.gpu, false);
    assert.equal("p99" in report.gpu, false);
    assert.equal("gate" in report.gpu, false);
  }
});

test("GPU union, metrics, reasons, and coverage use strict exact shapes", () => {
  const invalidGpu = [
    { status: "mystery", coverage: { attempted: 0, covered: 0, dropped: 0 } },
    {
      status: "available", p95: 10, p99: 20, reason: "unsupported",
      coverage: { attempted: 5_400, covered: 5_400, dropped: 0 },
    },
    { status: "available", p95: 10, p99: 20 },
    {
      status: "available", p95: 20, p99: 10,
      coverage: { attempted: 5_400, covered: 5_400, dropped: 0 },
    },
    {
      status: "available", p95: 10, p99: 20,
      coverage: { attempted: 5_400.5, covered: 5_400, dropped: 0 },
    },
    {
      status: "cpu-only", reason: "unsupported", p95: 10,
      coverage: { attempted: 0, covered: 0, dropped: 0 },
    },
    {
      status: "invalid", reason: "not-a-real-reason",
      coverage: { attempted: 0, covered: 0, dropped: 0 },
    },
  ];
  for (const gpu of invalidGpu) {
    assert.throws(
      () => buildPairedBenchmarkReport(records(({ runIndex }) => runIndex === 5 ? { gpu } : {})),
      /gpu/,
    );
  }
});

test("the report is deeply immutable, JSON-safe, and contains no raw frame samples", () => {
  const report = buildPairedBenchmarkReport(records());
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.variantConfigHashes), true);
  assert.equal(Object.isFrozen(report.cpu.p95.deltas), true);
  assert.equal(Object.isFrozen(report.gpu), true);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.equal(JSON.stringify(report).includes("samples"), false);
  assert.throws(() => { report.cpu.p95.deltas[0] = 99; }, TypeError);
});
