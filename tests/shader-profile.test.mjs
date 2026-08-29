import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_EXPERIMENTAL_SHADER_PROFILE,
} from "../dist/code/browser/WorldRenderer3D.js";
import {
  defaultSettings,
  parseSettings,
  serialiseSettings,
  settingDefinition,
} from "../dist/code/browser/ui/SettingsModel.js";
import { LiveFormalRenderBenchmarkHost } from "../dist/code/browser/LiveFormalRenderBenchmarkHost.js";

const PROFILE_IDS = [
  "experimentalAerialHeightFog",
  "experimentalTerrainMicroNormals",
  "experimentalWaterFresnel",
  "experimentalWaterMicroWaves",
  "experimentalWaterSunSparkle",
  "experimentalFantasyGlow",
];

function profile(enabled = false) {
  return {
    aerialHeightFog: enabled,
    terrainMicroNormals: enabled,
    waterFresnel: enabled,
    waterMicroWaves: enabled,
    waterSunSparkle: enabled,
    fantasyGlow: enabled,
  };
}

function configuration(enabled = false) {
  return {
    lighting: 1,
    settings: {
      renderScale: 100,
      wmoOcclusion: true,
      characterAtlasAnisotropy: false,
      grassRadius: 50,
      grassDense: true,
      experimentalAerialHeightFog: enabled,
      experimentalTerrainMicroNormals: enabled,
      experimentalWaterFresnel: enabled,
      experimentalWaterMicroWaves: enabled,
      experimentalWaterSunSparkle: enabled,
      experimentalFantasyGlow: enabled,
    },
  };
}

function makeHarness(options = {}) {
  const calls = [];
  const renderer = {
    replayEpochActive: false,
    isolationActive: false,
    lightingQuality: 1,
    renderScalePercent: 100,
    wmoOcclusion: true,
    characterAtlasAnisotropy: false,
    grassRadius: 50,
    grassDense: true,
    profile: profile(),
    beginFormalBenchmarkIsolation() { this.isolationActive = true; },
    endFormalBenchmarkIsolation() { this.isolationActive = false; },
    resetRenderEvolutionClock() {},
    resetFrameCadence() {},
    resetGpuTimingEpoch() {},
    setLightingQuality(value) { this.lightingQuality = value; calls.push(["lighting", value]); },
    setRenderScale(value) { this.renderScalePercent = value * 100; calls.push(["scale", value]); },
    setWmoOcclusion(value) { this.wmoOcclusion = value; calls.push(["wmo", value]); },
    setCharacterAtlasAnisotropy(value) {
      this.characterAtlasAnisotropy = value;
      calls.push(["atlas", value]);
    },
    setExperimentalShaderProfile(value) {
      if (options.throwProfileSetter) throw new Error("profile setter failed");
      this.profile = { ...value };
      calls.push(["profile", { ...value }]);
    },
    setGroundCover(_client, radius, dense) {
      this.grassRadius = radius;
      this.grassDense = dense;
      calls.push(["grass", radius, dense]);
    },
    setSelection() {},
    get formalRenderSurfaceStamp() {
      return {
        cssWidth: 1920,
        cssHeight: 1080,
        backingWidth: 1920,
        backingHeight: 1080,
        systemDpr: 1,
        effectivePixelRatio: 1,
        contextLost: false,
        contextGeneration: 0,
      };
    },
    get benchmarkGraphicsConfiguration() {
      return {
        lightingQuality: this.lightingQuality,
        renderScalePercent: this.renderScalePercent,
        wmoOcclusion: this.wmoOcclusion,
        characterAtlasAnisotropy: this.characterAtlasAnisotropy,
        grassRadius: this.grassRadius,
        grassDense: this.grassDense,
        experimentalShaderProfile: options.malformedProfileReadback
          ? null
          : { ...this.profile },
      };
    },
  };
  if (options.missingProfileSetter) delete renderer.setExperimentalShaderProfile;
  const context = {
    renderer,
    terrain: {}, terrainSplat: {}, groundCover: {}, light: {}, liquids: {}, environment: {},
    assetWarmup: {}, creatureModels: {}, creatureMetadata: {}, itemMetadata: {}, factions: { ready: true },
    gameObjectMetadata: {}, transportPaths: {}, horizon: {}, collision: {},
  };
  const userGraphics = {
    lightingQuality: 1,
    renderScalePercent: 100,
    wmoOcclusion: true,
    characterAtlasAnisotropy: false,
    experimentalAerialHeightFog: false,
    experimentalTerrainMicroNormals: false,
    experimentalWaterFresnel: false,
    experimentalWaterMicroWaves: false,
    experimentalWaterSunSparkle: false,
    experimentalFantasyGlow: false,
    grassRadius: 50,
    grassDense: true,
  };
  const host = new LiveFormalRenderBenchmarkHost(() => ({}), {
    context,
    bindings: {
      captureTelemetry: () => ({}),
      captureClientReadiness: () => ({}),
      captureUserGraphics: () => ({ ...userGraphics }),
      unitModel: () => undefined,
      mountModel: () => undefined,
      selectionRingColour: () => 0,
    },
  });
  return {
    host,
    renderer,
    calls,
    setProfileSetterFailure(value) { options.throwProfileSetter = value; },
    setMalformedProfileReadback(value) { options.malformedProfileReadback = value; },
  };
}

function epoch(index) {
  return Object.freeze({ suiteNonce: "shader-profile-test", epochNonce: `epoch-${index}` });
}

test("R5 settings enable bounded terrain/water upgrades by default while keeping aerial fog OFF", () => {
  const defaults = defaultSettings();
  for (const id of PROFILE_IDS) {
    assert.equal(settingDefinition(id)?.kind, "boolean");
    assert.equal(parseSettings(`{"${id}":1}`)?.[id], false);
  }
  assert.equal(defaults.experimentalAerialHeightFog, false);
  for (const id of PROFILE_IDS.slice(1)) {
    assert.equal(defaults[id], true);
    assert.equal(parseSettings(`{"${id}":false}`)?.[id], false);
  }
  assert.equal(serialiseSettings(defaults), "{}");
  const changed = { ...defaults, experimentalWaterFresnel: false };
  assert.deepEqual(JSON.parse(serialiseSettings(changed)), { experimentalWaterFresnel: false });
});

test("renderer profile is frozen default-OFF state with terrain/water delegation", async () => {
  assert.deepEqual(DEFAULT_EXPERIMENTAL_SHADER_PROFILE, profile());
  assert.equal(Object.isFrozen(DEFAULT_EXPERIMENTAL_SHADER_PROFILE), true);
  const source = await readFile("src/browser/WorldRenderer3D.ts", "utf8");
  assert.match(source, /setExperimentalShaderProfile\(/);
  assert.match(source, /#experimentalShaderProfile = DEFAULT_EXPERIMENTAL_SHADER_PROFILE/);
  const setter = source.match(/setExperimentalShaderProfile\([\s\S]*?\n  \}\n\n  \/\*\*/)?.[0] ?? "";
  assert.doesNotMatch(setter, /onBeforeCompile|ShaderChunk|customProgramCacheKey/);
  assert.match(setter, /applyLiquidShaderProfile|setLiquidWaterShaderProfile/);
  assert.match(setter, /setTerrainSplatMicroNormals/);
});

test("formal host applies and observes all six leaves, then rolls them back", async () => {
  const { host, renderer, calls } = makeHarness();
  const lease = await host.acquireExclusiveLease();
  try {
    host.applyVariant(lease, epoch(0), "A", configuration(true));
    assert.deepEqual(renderer.profile, profile(true));
    assert.deepEqual(calls.find(([name]) => name === "profile")?.[1], profile(true));
  } finally {
    await lease.release();
  }
  assert.deepEqual(renderer.profile, profile(false));
  assert.deepEqual(calls.filter(([name]) => name === "profile").at(-1)?.[1], profile(false));
});

test("formal host intercepts an external shader-profile mutation and fails closed", async () => {
  const { host, renderer } = makeHarness();
  const lease = await host.acquireExclusiveLease();
  try {
    host.applyVariant(lease, epoch(0), "A", configuration(false));
    renderer.setExperimentalShaderProfile({ ...profile(), waterSunSparkle: true });
    assert.throws(
      () => host.applyVariant(lease, epoch(1), "A", configuration(false)),
      /graphics configuration drifted at experimentalShaderProfile: external setExperimentalShaderProfile/,
    );
  } finally {
    await lease.release();
  }
  assert.deepEqual(renderer.profile, profile(false));
});

test("missing profile setter fails before epoch commit and permits a fresh disabled epoch", async () => {
  const { host, renderer } = makeHarness({ missingProfileSetter: true });
  const lease = await host.acquireExclusiveLease();
  try {
    assert.throws(
      () => host.applyVariant(lease, epoch(0), "A", configuration(true)),
      /experimental shader profile setter is unavailable/,
    );
    host.applyVariant(lease, epoch(1), "A", configuration(false));
    assert.deepEqual(renderer.profile, profile(false));
  } finally {
    await lease.release();
  }
});

test("setter and readback failures clear the committed epoch without releasing the lease", async () => {
  const setterFailure = makeHarness({ throwProfileSetter: true });
  const setterLease = await setterFailure.host.acquireExclusiveLease();
  try {
    assert.throws(
      () => setterFailure.host.applyVariant(setterLease, epoch(0), "A", configuration(true)),
      /profile setter failed/,
    );
    setterFailure.setProfileSetterFailure(false);
    setterFailure.host.applyVariant(setterLease, epoch(1), "A", configuration(false));
  } finally {
    await setterLease.release();
  }

  const readbackFailure = makeHarness({ malformedProfileReadback: true });
  const readbackLease = await readbackFailure.host.acquireExclusiveLease();
  try {
    assert.throws(
      () => readbackFailure.host.applyVariant(readbackLease, epoch(0), "A", configuration(false)),
      /renderer experimental shader profile readback must be an object/,
    );
    readbackFailure.setMalformedProfileReadback(false);
    readbackFailure.host.applyVariant(readbackLease, epoch(1), "A", configuration(false));
  } finally {
    await readbackLease.release();
  }
});

test("invalid and reused epoch identities are rejected before renderer mutations", async () => {
  const { host, calls } = makeHarness();
  const lease = await host.acquireExclusiveLease();
  try {
    const before = calls.length;
    assert.throws(
      () => host.applyVariant(lease, { suiteNonce: "shader-profile-test", epochNonce: "bad" }, "A", configuration(false)),
      /epoch identity must be a frozen object/,
    );
    assert.equal(calls.length, before);
    const first = epoch(0);
    host.applyVariant(lease, first, "A", configuration(false));
    assert.throws(
      () => host.applyVariant(lease, first, "A", configuration(false)),
      /epoch is already active/,
    );
  } finally {
    await lease.release();
  }
});
