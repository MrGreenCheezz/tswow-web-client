import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalBenchmarkRuntimeEnvironmentJson,
  canonicalBenchmarkVariantConfigurationJson,
  hashBenchmarkRuntimeEnvironment,
  hashBenchmarkVariantConfiguration,
  projectBenchmarkRuntimeEnvironment,
  projectBenchmarkVariantConfiguration,
  validateBenchmarkVariantKnobChange,
} from "../dist/code/browser/RenderBenchmarkIdentity.js";

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

test("runtime identity excludes lighting and settings, but includes runtime categories", async () => {
  const base = environment();
  const runtimeHash = await hashBenchmarkRuntimeEnvironment(base);
  const settingsChanged = structuredClone(base);
  settingsChanged.settings.quality = "low";
  settingsChanged.lighting = 0.5;
  assert.equal(await hashBenchmarkRuntimeEnvironment(settingsChanged), runtimeHash);

  for (const change of [
    (value) => { value.canvas.backingWidth += 1; },
    (value) => { value.browser.version = "141.0"; },
    (value) => { value.webgl.version = "WebGL 1.0"; },
  ]) {
    const altered = structuredClone(base);
    change(altered);
    assert.notEqual(await hashBenchmarkRuntimeEnvironment(altered), runtimeHash);
  }
});

test("runtime identity canonicalization sorts object keys and retains array order", async () => {
  const base = environment();
  const reversed = reverseKeys(base);
  assert.equal(canonicalBenchmarkRuntimeEnvironmentJson(base), canonicalBenchmarkRuntimeEnvironmentJson(reversed));
  assert.equal(await hashBenchmarkRuntimeEnvironment(base), await hashBenchmarkRuntimeEnvironment(reversed));

  const reorderedExtensions = structuredClone(base);
  reorderedExtensions.webgl.extensions.reverse();
  assert.notEqual(
    await hashBenchmarkRuntimeEnvironment(base),
    await hashBenchmarkRuntimeEnvironment(reorderedExtensions),
  );
});

test("variant identity includes lighting and settings, while owning frozen output", async () => {
  const base = environment();
  const configuration = projectBenchmarkVariantConfiguration(base);
  const runtime = projectBenchmarkRuntimeEnvironment(base);
  assert.ok(Object.isFrozen(configuration));
  assert.ok(Object.isFrozen(configuration.settings));
  assert.ok(Object.isFrozen(runtime));
  assert.ok(Object.isFrozen(runtime.canvas));
  assert.ok(Object.isFrozen(runtime.webgl.gpu.vendor));

  base.settings.shadows.enabled = false;
  base.lighting = 0.5;
  assert.equal(configuration.settings.shadows.enabled, true);
  assert.equal(configuration.lighting, 1);

  const baseHash = await hashBenchmarkVariantConfiguration(base);
  for (const change of [
    (value) => { value.lighting = 0.5; },
    (value) => { value.settings.quality = "medium"; },
  ]) {
    const altered = structuredClone(environment());
    change(altered);
    assert.notEqual(await hashBenchmarkVariantConfiguration(altered), baseHash);
  }
});

test("single-knob validator accepts exactly one existing scalar leaf", () => {
  const left = projectBenchmarkVariantConfiguration(environment());
  const rightInput = environment();
  rightInput.settings.shadows.size = 4096;
  const right = projectBenchmarkVariantConfiguration(rightInput);
  assert.deepEqual(
    validateBenchmarkVariantKnobChange(left, right, ["settings.shadows.size"]),
    { knobPath: "settings.shadows.size" },
  );
});

test("single-knob validator requires the same primitive type for the changed leaf", () => {
  const left = projectBenchmarkVariantConfiguration(environment());

  const booleanToNumberInput = environment();
  booleanToNumberInput.settings.shadows.enabled = 1;
  const booleanToNumber = projectBenchmarkVariantConfiguration(booleanToNumberInput);
  assert.throws(() => validateBenchmarkVariantKnobChange(
    left, booleanToNumber, ["settings.shadows.enabled"],
  ));

  const stringToNumberInput = environment();
  stringToNumberInput.settings.quality = 1;
  const stringToNumber = projectBenchmarkVariantConfiguration(stringToNumberInput);
  assert.throws(() => validateBenchmarkVariantKnobChange(
    left, stringToNumber, ["settings.quality"],
  ));

  const booleanChangeInput = environment();
  booleanChangeInput.settings.shadows.enabled = false;
  const booleanChange = projectBenchmarkVariantConfiguration(booleanChangeInput);
  assert.deepEqual(
    validateBenchmarkVariantKnobChange(left, booleanChange, ["settings.shadows.enabled"]),
    { knobPath: "settings.shadows.enabled" },
  );

  const stringChangeInput = environment();
  stringChangeInput.settings.quality = "medium";
  const stringChange = projectBenchmarkVariantConfiguration(stringChangeInput);
  assert.deepEqual(
    validateBenchmarkVariantKnobChange(left, stringChange, ["settings.quality"]),
    { knobPath: "settings.quality" },
  );
});

test("single-knob validator rejects no-op, multiple changes, shape/array changes, and bad allowlists", () => {
  const left = projectBenchmarkVariantConfiguration(environment());
  const noChange = projectBenchmarkVariantConfiguration(environment());
  assert.throws(() => validateBenchmarkVariantKnobChange(left, noChange, ["settings.quality"]));

  const twoChangesInput = environment();
  twoChangesInput.settings.quality = "medium";
  twoChangesInput.settings.shadows.size = 4096;
  const twoChanges = projectBenchmarkVariantConfiguration(twoChangesInput);
  assert.throws(() => validateBenchmarkVariantKnobChange(left, twoChanges, ["settings.quality"]));

  const missingInput = environment();
  delete missingInput.settings.quality;
  const missing = projectBenchmarkVariantConfiguration(missingInput);
  assert.throws(() => validateBenchmarkVariantKnobChange(left, missing, ["settings.quality"]));

  const arrayChangedInput = environment();
  arrayChangedInput.settings.passes.reverse();
  const arrayChanged = projectBenchmarkVariantConfiguration(arrayChangedInput);
  assert.throws(() => validateBenchmarkVariantKnobChange(left, arrayChanged, ["settings.quality"]));

  for (const allowlist of [[], ["settings.quality", "lighting"], ["settings.missing"], ["settings"], ["settings.__proto__"]]) {
    assert.throws(() => validateBenchmarkVariantKnobChange(left, left, allowlist));
  }
});

test("single-knob validator rejects prototype pollution, non-plain, and unsafe JSON values", () => {
  const left = projectBenchmarkVariantConfiguration(environment());
  const pollution = JSON.parse('{"lighting":1,"settings":{"quality":"high","__proto__":"bad"}}');
  assert.throws(() => validateBenchmarkVariantKnobChange(left, pollution, ["settings.quality"]));

  const nonPlain = { lighting: 1, settings: new Date() };
  assert.throws(() => validateBenchmarkVariantKnobChange(left, nonPlain, ["settings.quality"]));

  for (const value of [NaN, Infinity, undefined, BigInt(1), () => {}]) {
    const unsafe = { lighting: 1, settings: { quality: value } };
    assert.throws(() => projectBenchmarkVariantConfiguration(unsafe));
  }
  const cyclic = { lighting: 1, settings: { quality: "high" } };
  cyclic.settings.cycle = cyclic.settings;
  assert.throws(() => projectBenchmarkVariantConfiguration(cyclic));
});

test("identity helpers require Web Crypto for SHA-256", async () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    await assert.rejects(hashBenchmarkRuntimeEnvironment(environment()), /Web Crypto|SHA-256|crypto/i);
    await assert.rejects(hashBenchmarkVariantConfiguration(environment()), /Web Crypto|SHA-256|crypto/i);
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: original });
  }
});
