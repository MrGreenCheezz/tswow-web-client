import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalBenchmarkEnvironmentJson,
  cloneBenchmarkEnvironment,
  hashBenchmarkEnvironment,
} from "../dist/code/browser/BenchmarkManifest.js";

function environment() {
  return {
    canvas: {
      cssWidth: 1920,
      cssHeight: 1080,
      backingWidth: 1920,
      backingHeight: 1080,
      systemDpr: 1,
      effectivePixelRatio: 1,
      renderScalePercent: 100,
    },
    lighting: 1,
    browser: { name: "Firefox", version: "140.0" },
    webgl: {
      version: "WebGL 2.0",
      shadingLanguageVersion: "WebGL GLSL ES 3.00",
      extensions: ["EXT_color_buffer_float", "OES_texture_float_linear"],
    },
    settings: {
      shadows: { enabled: true, size: 2048 },
      quality: "high",
      passes: ["opaque", "transparent"],
    },
  };
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
}

test("canonical environment JSON and hash are stable across object insertion order", async () => {
  const left = environment();
  const right = reverseKeys(left);
  assert.equal(canonicalBenchmarkEnvironmentJson(left), canonicalBenchmarkEnvironmentJson(right));
  const first = await hashBenchmarkEnvironment(left);
  assert.equal(first, await hashBenchmarkEnvironment(right));
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("every environment category contributes to the digest", async () => {
  const base = environment();
  const changes = [
    (value) => { value.canvas.backingWidth++; },
    (value) => { value.lighting = 0.75; },
    (value) => { value.browser.version = "141.0"; },
    (value) => { value.webgl.extensions.push("WEBGL_multisampled_render_to_texture"); },
    (value) => { value.settings.quality = "medium"; },
  ];
  const expected = await hashBenchmarkEnvironment(base);
  for (const change of changes) {
    const altered = structuredClone(base);
    change(altered);
    assert.notEqual(await hashBenchmarkEnvironment(altered), expected);
  }
});

test("hashing uses cloneBenchmarkEnvironment ownership and never fingerprints GPU vendor/renderer", async () => {
  const input = environment();
  const owned = cloneBenchmarkEnvironment(input);
  assert.ok(Object.isFrozen(owned));
  assert.ok(Object.isFrozen(owned.settings));
  assert.deepEqual(owned.webgl.gpu, {
    vendor: { status: "unsupported", reason: "not-collected" },
    renderer: { status: "unsupported", reason: "not-collected" },
  });
  input.settings.quality = "low";
  assert.equal(owned.settings.quality, "high");

  const withExplicitUnsupported = {
    ...environment(),
    schemaVersion: 1,
    webgl: {
      ...environment().webgl,
      gpu: {
        vendor: { status: "unsupported", reason: "not-collected" },
        renderer: { status: "unsupported", reason: "not-collected" },
      },
    },
  };
  assert.equal(await hashBenchmarkEnvironment(environment()), await hashBenchmarkEnvironment(withExplicitUnsupported));
});

test("hashing explicitly reports unavailable Web Crypto", async () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    await assert.rejects(hashBenchmarkEnvironment(environment()), /Web Crypto|SHA-256|crypto/i);
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: original });
  }
});
