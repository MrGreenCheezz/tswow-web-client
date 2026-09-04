import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  applyFallbackLiquidShaderProfile,
  applyLiquidShaderProfile,
  buildLiquidMaterial,
  createWaterShaderSharedUniforms,
  setLiquidWaterShaderProfile,
} from "../dist/code/browser/Water.js";

const currentWater = await import(`../src/browser/Water.ts?visibility=${Date.now()}`);

const PROFILE_ON = Object.freeze({
  waterFresnel: true,
  waterMicroWaves: true,
  waterSunSparkle: true,
  waterFoam: true,
  fantasyGlow: true,
});
const PROFILE_OFF = Object.freeze({
  waterFresnel: false,
  waterMicroWaves: false,
  waterSunSparkle: false,
  waterFoam: false,
  fantasyGlow: false,
});

function basicShader() {
  return {
    uniforms: {},
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
  };
}

function depthShader() {
  const shader = basicShader();
  shader.vertexShader = `attribute float liquidDepth;\nvarying float vLiquidDepth;\n${shader.vertexShader}`
    .replace("#include <begin_vertex>", "vLiquidDepth = liquidDepth;\n#include <begin_vertex>");
  shader.fragmentShader = `uniform float liquidDeepAt;\nvarying float vLiquidDepth;\n${shader.fragmentShader}`;
  return shader;
}

test("water keeps enough body alpha for its animated shader to remain readable", () => {
  const {
    WATER_FALLBACK_OPACITY,
    WATER_MIN_DEEP_ALPHA,
    WATER_MIN_SHALLOW_ALPHA,
    WATER_TEXTURE_ALPHA_FLOOR,
    WATER_WAVE_LIGHT_STRENGTH,
  } = currentWater;
  assert.ok(WATER_MIN_SHALLOW_ALPHA >= 0.7);
  assert.ok(WATER_MIN_DEEP_ALPHA >= 0.85);
  assert.ok(WATER_TEXTURE_ALPHA_FLOOR >= 0.7);
  assert.ok(WATER_FALLBACK_OPACITY >= 0.68);
  assert.ok(WATER_WAVE_LIGHT_STRENGTH >= 0.06);
  assert.ok(WATER_MIN_SHALLOW_ALPHA * WATER_TEXTURE_ALPHA_FLOOR >= WATER_FALLBACK_OPACITY,
    "the animated strip must not turn more transparent than its cold-cache fallback");

  const texture = new THREE.Texture();
  const liquid = currentWater.buildLiquidMaterial("water", { texture, frames: 30 });
  try {
    currentWater.updateLiquidMaterial(liquid, "water", {
      waterShallowAlpha: 0.05, waterDeepAlpha: 0.1,
      oceanShallowAlpha: 0.02, oceanDeepAlpha: 0.08,
      colours: {
        oceanClose: { r: 0.1, g: 0.2, b: 0.3 }, oceanFar: { r: 0.1, g: 0.2, b: 0.3 },
        riverClose: { r: 0.1, g: 0.2, b: 0.3 }, riverFar: { r: 0.1, g: 0.2, b: 0.3 },
      },
    }, 0);
    assert.equal(liquid.uniforms.liquidShallowAlpha.value, WATER_MIN_SHALLOW_ALPHA);
    assert.equal(liquid.uniforms.liquidDeepAlpha.value, WATER_MIN_DEEP_ALPHA);

    const compiled = basicShader();
    liquid.material.onBeforeCompile(compiled);
    assert.match(compiled.fragmentShader, new RegExp(`mix\\(${WATER_TEXTURE_ALPHA_FLOOR}, 1\\.0`));
  } finally {
    liquid.material.dispose();
    texture.dispose();
  }
});

test("water hook preserves OFF source/key, chains previous once, and toggles one wrapper", () => {
  const material = new THREE.MeshBasicMaterial();
  const previous = material.onBeforeCompile;
  let previousCalls = 0;
  material.onBeforeCompile = function (shader, renderer) {
    previousCalls++;
    previous.call(this, shader, renderer);
  };
  material.customProgramCacheKey = () => "liquid-fallback-water";
  const shared = createWaterShaderSharedUniforms();
  setLiquidWaterShaderProfile(material, "water", PROFILE_OFF, shared);
  const wrapper = material.onBeforeCompile;
  const offKey = material.customProgramCacheKey();
  const off = basicShader();
  wrapper.call(material, off);
  assert.equal(previousCalls, 1);
  assert.equal(offKey, "liquid-fallback-water");
  assert.equal(off.vertexShader, THREE.ShaderLib.basic.vertexShader);
  assert.equal(off.fragmentShader, THREE.ShaderLib.basic.fragmentShader);

  setLiquidWaterShaderProfile(material, "water", PROFILE_ON, shared);
  assert.equal(material.onBeforeCompile, wrapper);
  assert.equal(material.customProgramCacheKey(), "liquid-fallback-water|water-profile-v3-15");
  const on = basicShader();
  wrapper.call(material, on);
  assert.equal(previousCalls, 2);
  assert.match(on.vertexShader, /vWaterWorldPosition/);
  assert.match(on.vertexShader, /vWaterWorldNormal/);
  assert.doesNotMatch(on.vertexShader, /objectNormal/);
  assert.match(on.fragmentShader, /waterFresnel/);
  assert.match(on.fragmentShader, /waterFresnelVisibility = 1\.0 - clamp\(waterUnderwater/);
  assert.match(on.fragmentShader, /waterWave/);
  assert.match(on.fragmentShader, /waterSurfaceNormal/);
  assert.match(on.fragmentShader, /waterWaveSlope/);
  assert.doesNotMatch(on.fragmentShader, /waterFoam/);
  assert.match(on.fragmentShader, /waterUnderwater < 0\.5/);
  assert.match(on.fragmentShader, /inversesqrt\(max\(dot\(waterToCameraRaw, waterToCameraRaw\), 1e-8\)\)/);
  assert.match(on.fragmentShader, /pow\(max\(waterSunColour, vec3\(0\.0\)\), vec3\(2\.2\)\)/);
  assert.equal(on.uniforms.waterTime, shared.time);
  assert.equal(on.uniforms.waterSunDirection, shared.sunDirection);
  assert.equal(on.uniforms.waterSunColour, shared.sunColour);
  assert.equal(on.uniforms.waterUnderwater, shared.underwater);

  setLiquidWaterShaderProfile(material, "water", PROFILE_OFF, shared);
  assert.equal(material.onBeforeCompile, wrapper);
  assert.equal(material.customProgramCacheKey(), offKey);
  const offAgain = basicShader();
  wrapper.call(material, offAgain);
  assert.equal(previousCalls, 3);
  assert.equal(offAgain.vertexShader, THREE.ShaderLib.basic.vertexShader);
  assert.equal(offAgain.fragmentShader, THREE.ShaderLib.basic.fragmentShader);
});

test("enabled water material keeps the shared clock live after shader compilation", () => {
  const shared = currentWater.createWaterShaderSharedUniforms();
  const texture = new THREE.Texture();
  const liquid = currentWater.buildLiquidMaterial("water", { texture, frames: 30 });
  currentWater.applyLiquidShaderProfile(liquid, "water", PROFILE_ON, shared);
  const compiled = basicShader();
  liquid.material.onBeforeCompile(compiled);

  assert.match(compiled.vertexShader, /vWaterWorldPosition/);
  assert.match(compiled.fragmentShader, /water-profile-v3/);
  assert.equal(compiled.uniforms.waterTime, shared.time);
  try {
    shared.time.value = 23.75;
    assert.equal(compiled.uniforms.waterTime.value, 23.75);
    assert.match(compiled.fragmentShader, /waterTime \* 0\.42/,
      "the primary band moves slowly enough to read as a broad wave rather than flicker");
    assert.match(compiled.fragmentShader, /waterTime \* 0\.27/,
      "the weaker crossing band remains slower and visually sparse");
  } finally {
    liquid.material.dispose();
    texture.dispose();
  }
});

test("each water mask has its own key/source branch and stable version toggles", () => {
  const shared = createWaterShaderSharedUniforms();
  const material = new THREE.MeshBasicMaterial();
  material.customProgramCacheKey = () => "liquid-water";
  const keys = new Set();
  const sources = new Map();
  let lastVersion = material.version;
  for (let mask = 0; mask < 16; mask++) {
    const profile = {
      waterFresnel: (mask & 1) !== 0,
      waterMicroWaves: (mask & 2) !== 0,
      waterSunSparkle: (mask & 4) !== 0,
      waterFoam: (mask & 8) !== 0,
    };
    setLiquidWaterShaderProfile(material, "water", profile, shared);
    const versionAfterChange = material.version;
    setLiquidWaterShaderProfile(material, "water", profile, shared);
    assert.equal(material.version, versionAfterChange, `mask ${mask} repeated toggle`);
    if (mask > 0) assert.ok(versionAfterChange > lastVersion, `mask ${mask} needsUpdate`);
    lastVersion = versionAfterChange;
    keys.add(material.customProgramCacheKey());
    const shader = (mask & 8) !== 0 ? depthShader() : basicShader();
    material.onBeforeCompile(shader);
    sources.set(mask, shader.fragmentShader);
    assert.equal(shader.fragmentShader.split("water-profile-v3").length - 1, mask === 0 ? 0 : 1);
  }
  assert.equal(keys.size, 16);
  assert.doesNotMatch(sources.get(0), /waterFresnel|waterWave|waterSpark|waterFoam/);
  assert.match(sources.get(1), /waterFresnel/);
  assert.doesNotMatch(sources.get(1), /waterWave|waterSpark|waterFoam/);
  assert.match(sources.get(2), /waterWave/);
  assert.doesNotMatch(sources.get(2), /waterFresnel|waterSpark|waterFoam/);
  assert.match(sources.get(4), /waterSpark/);
  assert.doesNotMatch(sources.get(4), /waterFresnel|waterWave|waterFoam/);
  assert.match(sources.get(8), /waterFoamDepth|waterFoamShore|waterFoamPattern/);
  assert.match(sources.get(8), /1\.0 - waterUnderwater/);
  assert.doesNotMatch(sources.get(8), /waterFresnel|waterWave|waterSpark/);
  for (let mask = 0; mask < 16; mask++) {
    assert.equal(sources.get(mask).includes("waterFoamDepth"), (mask & 8) !== 0, `mask ${mask} foam`);
  }
  const repeated = basicShader();
  material.onBeforeCompile(repeated);
  material.onBeforeCompile(repeated);
  assert.equal(repeated.vertexShader.split("vWaterWorldPosition").length - 1, 2);
  assert.equal(repeated.vertexShader.split("vWaterWorldNormal").length - 1, 2);
});

test("animated liquid OFF is byte-identical and malformed ON shader fails closed", () => {
  const texture = new THREE.Texture();
  const expected = buildLiquidMaterial("water", { texture, frames: 30 });
  const actual = buildLiquidMaterial("water", { texture, frames: 30 });
  const shared = createWaterShaderSharedUniforms();
  applyLiquidShaderProfile(actual, "water", PROFILE_OFF, shared);
  const expectedShader = basicShader();
  const actualShader = basicShader();
  expected.material.onBeforeCompile(expectedShader);
  actual.material.onBeforeCompile(actualShader);
  assert.equal(actual.material.customProgramCacheKey(), expected.material.customProgramCacheKey());
  assert.equal(actualShader.vertexShader, expectedShader.vertexShader);
  assert.equal(actualShader.fragmentShader, expectedShader.fragmentShader);

  setLiquidWaterShaderProfile(actual.material, "water", PROFILE_ON, shared);
  assert.throws(() => actual.material.onBeforeCompile({ uniforms: {}, vertexShader: "", fragmentShader: "" }), /MeshBasic begin\/opaque markers/);
  expected.material.dispose();
  actual.material.dispose();
  texture.dispose();
});

test("water/ocean bind shared effects while magma/slime use an exact reversible glow branch", () => {
  const shared = createWaterShaderSharedUniforms();
  const texture = new THREE.Texture();
  const water = buildLiquidMaterial("water", { texture, frames: 30 });
  const ocean = buildLiquidMaterial("ocean", { texture, frames: 30 });
  const magma = buildLiquidMaterial("magma", { texture, frames: 30 });
  const slime = buildLiquidMaterial("slime", { texture, frames: 30 });
  applyLiquidShaderProfile(water, "water", PROFILE_ON, shared);
  applyLiquidShaderProfile(ocean, "ocean", PROFILE_ON, shared);
  applyLiquidShaderProfile(magma, "magma", PROFILE_OFF, shared);
  applyLiquidShaderProfile(slime, "slime", PROFILE_OFF, shared);
  const magmaHook = magma.material.onBeforeCompile;
  const slimeHook = slime.material.onBeforeCompile;
  const magmaKey = magma.material.customProgramCacheKey();
  const slimeKey = slime.material.customProgramCacheKey();
  setLiquidWaterShaderProfile(magma.material, "magma", PROFILE_ON, shared);
  setLiquidWaterShaderProfile(slime.material, "slime", PROFILE_ON, shared);
  assert.equal(magma.material.onBeforeCompile, magmaHook);
  assert.equal(slime.material.onBeforeCompile, slimeHook);
  assert.equal(magma.material.customProgramCacheKey(), magmaKey);
  assert.equal(slime.material.customProgramCacheKey(), slimeKey);
  const magmaOff = basicShader();
  magma.material.onBeforeCompile(magmaOff);
  assert.doesNotMatch(magmaOff.fragmentShader, /liquid-fantasy-glow-v1/);
  applyLiquidShaderProfile(magma, "magma", PROFILE_ON, shared);
  assert.match(magma.material.customProgramCacheKey(), /liquid-fantasy-glow-v1/);
  const magmaOn = basicShader();
  magma.material.onBeforeCompile(magmaOn);
  assert.match(magmaOn.fragmentShader, /liquid-fantasy-glow-v1/);
  assert.doesNotMatch(magmaOn.fragmentShader, /water-profile-v3|waterFoam/);
  const slimeOn = basicShader();
  slime.material.onBeforeCompile(slimeOn);
  assert.doesNotMatch(slimeOn.fragmentShader, /water-profile-v3|waterFoam/);
  applyLiquidShaderProfile(magma, "magma", PROFILE_OFF, shared);
  assert.equal(magma.material.customProgramCacheKey(), magmaKey);
  const magmaOffAgain = basicShader();
  magma.material.onBeforeCompile(magmaOffAgain);
  assert.equal(magmaOffAgain.fragmentShader, magmaOff.fragmentShader);
  const wmoOcean = basicShader();
  ocean.material.onBeforeCompile(wmoOcean);
  assert.match(wmoOcean.fragmentShader, /reflect\(-waterSunDirectionSafe/);
  assert.match(wmoOcean.fragmentShader, /waterFoamDepth|waterFoamShore|waterFoamPattern/);
  shared.underwater.value = 1;
  assert.equal(wmoOcean.uniforms.waterUnderwater.value, 1);
  for (const material of [water.material, ocean.material, magma.material, slime.material]) material.dispose();
  texture.dispose();
});

test("fallback lane is lazy, class-bounded, and cleaned independently", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /#fallbackLiquidMaterials = new Map<LiquidClass/);
  assert.match(source, /#fallbackLiquidMaterial\(liquidClass: LiquidClass\)/);
  assert.match(source, /for \(const material of this\.#fallbackLiquidMaterials\.values\(\)\) material\.dispose\(\)/);
  assert.match(source, /this\.#fallbackLiquidMaterials\.clear\(\)/);
  assert.match(source, /applyFallbackLiquidShaderProfile\(material, liquidClass/);
  assert.ok((source.match(/#fallbackLiquidMaterial\(liquidClass\)/g) ?? []).length >= 2);
  assert.match(source, /visitMaterialTextures\(visitor, material\)/);
  // The fallback has no texture/map dependency; the same real MeshBasic shader path is sufficient
  // to prove the water hook does not accidentally rely on liquid strip uniforms.
  const shared = createWaterShaderSharedUniforms();
  const fallback = new THREE.MeshBasicMaterial({ color: 0x2d7fa5, fog: true, transparent: true, opacity: 0.58, depthWrite: false, side: THREE.DoubleSide });
  setLiquidWaterShaderProfile(fallback, "water", PROFILE_ON, shared);
  const shader = basicShader();
  fallback.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /water-profile-v3/);
  assert.doesNotMatch(shader.fragmentShader, /waterFoamDepth|waterFoamShore|waterFoamPattern/);
  fallback.dispose();

  const magmaFallback = new THREE.MeshBasicMaterial();
  applyFallbackLiquidShaderProfile(magmaFallback, "magma", PROFILE_OFF, shared);
  const baseline = magmaFallback.color.clone();
  applyFallbackLiquidShaderProfile(magmaFallback, "magma", PROFILE_ON, shared);
  assert.ok(magmaFallback.color.r > baseline.r, "fantasy profile visibly lifts magma without a pass");
  assert.equal(magmaFallback.transparent, false);
  assert.equal(magmaFallback.depthWrite, true);
  magmaFallback.dispose();
});
