import assert from "node:assert/strict";
import test from "node:test";

import {
  RENDER_BENCHMARK_MANIFEST,
  RENDER_BENCHMARK_MANIFEST_VERSION,
  benchmarkEffectivePixelRatio,
  captureBenchmarkEnvironment,
} from "../dist/code/browser/BenchmarkManifest.js";

test("the R1 benchmark manifest freezes approved and pending fixtures", () => {
  assert.equal(RENDER_BENCHMARK_MANIFEST_VERSION, 1);
  assert.deepEqual(RENDER_BENCHMARK_MANIFEST.profile.canvas, {
    cssWidth: 1920,
    cssHeight: 1080,
    backingWidth: 1920,
    backingHeight: 1080,
    systemDpr: 1,
    effectivePixelRatio: 1,
    renderScalePercent: 100,
  });
  assert.equal(RENDER_BENCHMARK_MANIFEST.profile.lighting, 1);
  assert.equal(RENDER_BENCHMARK_MANIFEST.profile.warmRunSeconds, 90);
  assert.equal(RENDER_BENCHMARK_MANIFEST.profile.pairedAlternatingRuns, 5);
  assert.equal(RENDER_BENCHMARK_MANIFEST.profile.coldRunComparison, "separate-only");
  assert.deepEqual(RENDER_BENCHMARK_MANIFEST.profile.replayRequirements, {
    halfMinute: "fixed",
    time: "fixed",
    weather: "fixed",
    rngSeed: "fixed",
    cameraPath: "fixed",
    frameOrder: "fixed",
  });

  const scenarios = Object.fromEntries(
    RENDER_BENCHMARK_MANIFEST.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  assert.deepEqual(scenarios["goldshire-exterior"].position, {
    x: -9461.82,
    y: 63.31,
    z: 56.23,
  });
  assert.equal(scenarios["goldshire-exterior"].mapId, 0);
  assert.equal(scenarios["goldshire-exterior"].halfMinute, 1440);
  assert.deepEqual(scenarios["goldshire-exterior"].weather, { mode: "fine" });
  assert.equal(scenarios["goldshire-exterior"].fixtureStatus, "pending");
  assert.equal("snapshotHash" in scenarios["goldshire-exterior"], false);
  assert.equal("frameOrderHash" in scenarios["goldshire-exterior"], false);
  assert.deepEqual(scenarios.stormwind.position, {
    x: -8913.25,
    y: 554.5,
    z: 93.75,
  });
  assert.equal(scenarios.stormwind.mapId, 0);
  assert.equal(scenarios.stormwind.halfMinute, 1440);
  assert.deepEqual(scenarios.stormwind.weather, { mode: "fine" });
  assert.equal(scenarios.stormwind.fixtureStatus, "pending");
  assert.equal("snapshotHash" in scenarios.stormwind, false);
  assert.equal("frameOrderHash" in scenarios.stormwind, false);
  for (const id of ["interior", "underwater", "rain"]) {
    assert.equal(scenarios[id].status, "pending");
    assert.equal(scenarios[id].pendingReason, "coordinates-not-provided");
    assert.equal("position" in scenarios[id], false);
    assert.equal("mapId" in scenarios[id], false);
  }
  assert.deepEqual(scenarios.rain.weather, { mode: "rain", intensity: 0.7 });

  assert.equal(Object.isFrozen(RENDER_BENCHMARK_MANIFEST), true);
  assert.equal(Object.isFrozen(RENDER_BENCHMARK_MANIFEST.profile), true);
  assert.equal(Object.isFrozen(RENDER_BENCHMARK_MANIFEST.scenarios), true);
  assert.equal(Object.isFrozen(scenarios["goldshire-exterior"].position), true);
  assert.throws(() => { RENDER_BENCHMARK_MANIFEST.profile.warmRunSeconds = 1; }, TypeError);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(RENDER_BENCHMARK_MANIFEST)));
});

test("environment capture is pure, deeply immutable, JSON-safe, and explicit about GPU limits", () => {
  const input = {
    canvas: {
      cssWidth: 1920, cssHeight: 1080, backingWidth: 1920, backingHeight: 1080,
      systemDpr: 1, effectivePixelRatio: 1, renderScalePercent: 100,
    },
    browser: { name: "Example", version: "1.2" },
    webgl: {
      version: "WebGL 2.0",
      shadingLanguageVersion: "WebGL GLSL ES 3.00",
      extensions: ["EXT_disjoint_timer_query_webgl2"],
      vendor: "must not be collected",
      renderer: "must not be collected",
    },
    settings: { lighting: 1, quality: { shadows: true }, labels: ["fixed"] },
  };
  const before = JSON.stringify(input);
  const metadata = captureBenchmarkEnvironment(input);

  assert.equal(metadata.schemaVersion, 1);
  assert.deepEqual(metadata.canvas, input.canvas);
  assert.deepEqual(metadata.browser, input.browser);
  assert.equal("userAgent" in metadata.browser, false);
  assert.deepEqual(metadata.webgl.version, input.webgl.version);
  assert.deepEqual(metadata.webgl.extensions, input.webgl.extensions);
  assert.deepEqual(metadata.webgl.gpu, {
    vendor: { status: "unsupported", reason: "not-collected" },
    renderer: { status: "unsupported", reason: "not-collected" },
  });
  assert.equal("vendor" in metadata.webgl, false);
  assert.equal("renderer" in metadata.webgl, false);
  assert.deepEqual(metadata.settings, input.settings);
  assert.equal(JSON.stringify(input), before);
  input.settings.quality.shadows = false;
  input.settings.labels.push("caller mutation");
  assert.equal(metadata.settings.quality.shadows, true);
  assert.deepEqual(metadata.settings.labels, ["fixed"]);

  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.webgl.gpu.vendor), true);
  assert.equal(Object.isFrozen(metadata.settings), true);
  assert.equal(Object.isFrozen(metadata.settings.quality), true);
  assert.equal(Object.isFrozen(metadata.settings.labels), true);
  assert.throws(() => { metadata.settings.quality.shadows = false; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), metadata);
});

test("environment capture rejects non-JSON-safe settings", () => {
  const base = {
    canvas: {
      cssWidth: 1920, cssHeight: 1080, backingWidth: 1920, backingHeight: 1080,
      systemDpr: 1, effectivePixelRatio: 1, renderScalePercent: 100,
    },
    browser: { name: "Example", version: "1.2" },
    webgl: { version: "WebGL 2.0", shadingLanguageVersion: "GLSL", extensions: [] },
    settings: {},
  };
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => captureBenchmarkEnvironment({ ...base, settings: cyclic }), /cyclic/);
  assert.throws(() => captureBenchmarkEnvironment({
    ...base,
    settings: { notANumber: Number.NaN },
  }), /finite number/);
});

test("effective pixel ratio applies the renderer's DPR cap before render scale", () => {
  assert.equal(benchmarkEffectivePixelRatio(3, 75), 1.5);
  assert.equal(benchmarkEffectivePixelRatio(2, 50), 1);
});

test("environment capture preserves zero canvas dimensions and validates positive scale inputs", () => {
  const base = {
    canvas: {
      cssWidth: 0, cssHeight: 0, backingWidth: 0, backingHeight: 0,
      systemDpr: 1, effectivePixelRatio: "unsupported", renderScalePercent: 50,
    },
    browser: { name: "Example", version: "1.2" },
    webgl: { version: "unsupported", shadingLanguageVersion: "unsupported", extensions: [] },
    settings: {},
  };
  const metadata = captureBenchmarkEnvironment(base);
  assert.deepEqual(metadata.canvas, base.canvas);
  for (const [field, value] of [
    ["cssWidth", -1], ["cssHeight", -1], ["backingWidth", -1], ["backingHeight", -1],
  ]) {
    assert.throws(() => captureBenchmarkEnvironment({
      ...base, canvas: { ...base.canvas, [field]: value },
    }), /non-negative/);
  }
  assert.throws(() => captureBenchmarkEnvironment({
    ...base, canvas: { ...base.canvas, systemDpr: 0 },
  }), /positive/);
  assert.throws(() => captureBenchmarkEnvironment({
    ...base, canvas: { ...base.canvas, renderScalePercent: 0 },
  }), /positive/);
});
