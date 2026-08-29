import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  benchmarkBrowserFromUserAgent,
  captureBenchmarkEnvironment,
  captureBenchmarkWebGl,
} from "../dist/code/browser/BenchmarkManifest.js";
import { RenderBenchmarkRuntime } from "../dist/code/browser/RenderBenchmarkRuntime.js";

const telemetry = {
  renderer: undefined,
  resources: {},
};

test("live environment helpers retain browser/WebGL capabilities without fingerprint-only GPU data", () => {
  assert.deepEqual(
    benchmarkBrowserFromUserAgent(
      "Mozilla/5.0 Chrome/123.4.5.6 Safari/537.36 Edg/123.4.5.6",
    ),
    {
      name: "Edge",
      version: "123.4.5.6",
    },
  );
  assert.equal("userAgent" in benchmarkBrowserFromUserAgent("Firefox/124"), false);

  const calls = [];
  const webgl = captureBenchmarkWebGl({
    VERSION: 0x1f02,
    SHADING_LANGUAGE_VERSION: 0x8b8c,
    getParameter(parameter) {
      calls.push(parameter);
      return parameter === 0x1f02 ? "WebGL 2.0" : "WebGL GLSL ES 3.00";
    },
    getSupportedExtensions() {
      return ["EXT_disjoint_timer_query_webgl2"];
    },
  });
  assert.deepEqual(webgl, {
    version: "WebGL 2.0",
    shadingLanguageVersion: "WebGL GLSL ES 3.00",
    extensions: ["EXT_disjoint_timer_query_webgl2"],
  });
  assert.deepEqual(calls, [0x1f02, 0x8b8c]);
  assert.deepEqual(captureBenchmarkWebGl(undefined), {
    version: "unsupported",
    shadingLanguageVersion: "unsupported",
    extensions: [],
  });
});

test("a live finish forwards immutable environment metadata while remaining non-formal", () => {
  const runtime = new RenderBenchmarkRuntime();
  const environment = captureBenchmarkEnvironment({
    canvas: {
      cssWidth: 1600, cssHeight: 900, backingWidth: 1500, backingHeight: 844,
      systemDpr: 1.25, effectivePixelRatio: 0.9375, renderScalePercent: 75,
    },
    lighting: 2,
    browser: { name: "Firefox", version: "124" },
    webgl: { version: "WebGL 2.0", shadingLanguageVersion: "GLSL", extensions: [] },
    settings: { lightingQuality: 2, renderScale: 75 },
  });
  runtime.start({ scenario: "stormwind", variant: "live", runIndex: 0, startedAt: 1_000 },
    undefined, undefined, environment);
  const summary = runtime.finish(2_000, telemetry, environment);

  assert.equal(summary.formalGateEligible, false);
  assert.deepEqual(summary.environment, { start: environment, finish: environment });
  assert.equal(summary.environment.start.lighting, 2);
  assert.equal(Object.isFrozen(summary.environment), true);
  assert.equal(Object.isFrozen(summary.environment.start.canvas), true);
  assert.deepEqual(JSON.parse(JSON.stringify(summary.environment)), summary.environment);
});

test("live metadata records the renderer ratio rather than recomputing it from browser inputs", () => {
  const metadata = captureBenchmarkEnvironment({
    canvas: {
      cssWidth: 0, cssHeight: 0, backingWidth: 0, backingHeight: 0,
      systemDpr: 3, effectivePixelRatio: 1.375, renderScalePercent: 25,
    },
    browser: { name: "Firefox", version: "124" },
    webgl: { version: "WebGL 2.0", shadingLanguageVersion: "GLSL", extensions: [] },
    settings: { renderScale: 25 },
  });
  assert.equal(metadata.canvas.effectivePixelRatio, 1.375);
  assert.deepEqual(metadata.browser, { name: "Firefox", version: "124" });
  assert.equal("userAgent" in metadata.browser, false);
});

test("the browser console runner captures live environment before finishing", async () => {
  const source = await readFile(new URL("../src/browser/main.ts", import.meta.url), "utf8");
  assert.match(source, /captureBenchmarkEnvironment/);
  assert.match(source, /world3dCanvas\.getContext\("webgl2"\)/);
  assert.match(source, /game\.renderer\?\.pixelRatio \?\? \("unsupported" as const\)/);
  assert.doesNotMatch(source, /benchmarkEffectivePixelRatio/);
  assert.match(source, /settings\(\)/);
  assert.match(source, /renderBenchmarkRuntime\.finish\(endedAt, telemetry, environment\)/);
});
