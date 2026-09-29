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
  // Transparent by design: the shallows show the bottom, the depths stay solid. The animated
  // minimum (shallow × texture floor) may breathe below the cold-cache fallback — that is what
  // makes waves read as waves — but never below a third, so the surface cannot vanish outright.
  assert.ok(WATER_MIN_SHALLOW_ALPHA >= 0.55 && WATER_MIN_SHALLOW_ALPHA <= 0.7);
  assert.ok(WATER_MIN_DEEP_ALPHA >= 0.8 && WATER_MIN_DEEP_ALPHA <= 0.9);
  assert.ok(WATER_TEXTURE_ALPHA_FLOOR >= 0.45 && WATER_TEXTURE_ALPHA_FLOOR <= 0.65);
  assert.ok(WATER_FALLBACK_OPACITY >= 0.5 && WATER_FALLBACK_OPACITY <= 0.65);
  assert.ok(WATER_WAVE_LIGHT_STRENGTH >= 0.06);
  assert.ok(WATER_MIN_SHALLOW_ALPHA * WATER_TEXTURE_ALPHA_FLOOR >= 0.3,
    "the animated strip must keep at least a third of its body at a wave trough in the shallows");

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
  assert.equal(material.customProgramCacheKey(), "liquid-fallback-water|water-profile-v5-15");
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
  assert.match(on.fragmentShader, /uniform vec3 waterSkyColour;/);
  assert.match(on.fragmentShader, /waterSkyColourLinear \+ waterSunColourLinear \* 0\.10/);
  assert.equal(on.uniforms.waterTime, shared.time);
  assert.equal(on.uniforms.waterSunDirection, shared.sunDirection);
  assert.equal(on.uniforms.waterSunColour, shared.sunColour);
  assert.equal(on.uniforms.waterSkyColour, shared.skyColour);
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
    assert.match(compiled.fragmentShader, /time \* 0\.42/,
      "the primary swell drifts slowly enough to read as a broad wave rather than flicker");
    assert.match(compiled.fragmentShader, /time \* 0\.27/,
      "the weaker crossing swell remains slower and visually sparse");
    assert.match(compiled.fragmentShader, /waterSwell\(vWaterWorldPosition\.xz, waterTime, waterFootprint\)/);
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

const CINEMATIC_WATER = Object.freeze({ ...PROFILE_ON, waterSunGlitter: true, waterSkyReflection: true });

function compileWater(liquidClass, profile, shared, shader = depthShader()) {
  const material = new THREE.MeshBasicMaterial();
  material.customProgramCacheKey = () => `liquid-${liquidClass}`;
  currentWater.setLiquidWaterShaderProfile(material, liquidClass, profile, shared);
  material.onBeforeCompile(shader);
  material.dispose();
  return shader;
}

test("no water leaf draws a fixed-frequency sine pattern: every ripple is rotated value noise", () => {
  const shared = currentWater.createWaterShaderSharedUniforms();
  // The owner's lattice came from sums of sines of world position (glitter, sky ripple, micro-waves,
  // sparkle, foam): two crossing plane waves repeat as diamonds. None of those leaves may use one.
  for (const bit of [2, 4, 8, 16, 32]) {
    const profile = {
      waterMicroWaves: bit === 2, waterSunSparkle: bit === 4, waterFoam: bit === 8,
      waterSunGlitter: bit === 16, waterSkyReflection: bit === 32,
    };
    const { fragmentShader } = compileWater("water", profile, shared);
    assert.doesNotMatch(fragmentShader, /\bsin\(|\bcos\(/, `mask ${bit} has no sine lattice`);
    assert.match(fragmentShader, /float waterHash\(vec2 p\)/, `mask ${bit} reads the value noise`);
    assert.match(fragmentShader, /dFdx\(vWaterWorldPosition\)/, `mask ${bit} knows its pixel footprint`);
  }
  // Octave ratios are not powers of two and every octave has its own rotation.
  const octaves = currentWater.WATER_RIPPLE_OCTAVES;
  assert.ok(octaves.length >= 4);
  for (let i = 1; i < octaves.length; i++) {
    const ratio = octaves[i - 1].wavelength / octaves[i].wavelength;
    assert.ok(ratio > 1.8 && ratio < 2.3 && Math.abs(ratio - 2) > 0.02, `ratio ${ratio}`);
  }
  assert.equal(new Set(octaves.map((octave) => octave.angle.toFixed(3))).size, octaves.length);
});

test("ripples too fine for the pixel fade out and hand their variance to the reflection", () => {
  const shared = currentWater.createWaterShaderSharedUniforms();
  const { fragmentShader } = compileWater("water", CINEMATIC_WATER, shared);
  assert.match(fragmentShader, new RegExp(`\\(wavelength / footprint - ${currentWater.WATER_RIPPLE_MIN_PIXELS}\\.0+\\) / 3\\.0`));
  assert.match(fragmentShader, /\(1\.0 - keep \* keep\) \* steepness \* steepness/);
  // The glitter lobe widens by the unresolved variance; the sky lookup is blurred by it.
  assert.match(fragmentShader, /float glitterVariance = waterRipple\.z \+ /);
  assert.match(fragmentShader, /float waterSkySpread = 1\.4 \* sqrt\(waterRipple\.z\);/);
});

test("sky reflection is Schlick-weighted, capped, and layered over the authored body", () => {
  const shared = currentWater.createWaterShaderSharedUniforms();
  const { fragmentShader, uniforms } = compileWater("water", CINEMATIC_WATER, shared);
  assert.match(fragmentShader, /water-sky-reflection-v2/);
  assert.match(fragmentShader, /min\(0\.02 \+ 0\.98 \* pow\(1\.0 - waterSkyFacing, 5\.0\), /);
  assert.ok(currentWater.WATER_SKY_REFLECTION_STRENGTH <= 0.6, "a grazing lake never becomes a full mirror");
  assert.ok(currentWater.WATER_SKY_MIRROR_MAX < 0.6, "a sunset horizon is held under display white");
  // final = F sky + (1 - F) (a body + (1 - a) bed): the alpha rises only by the reflection's share.
  assert.match(fragmentShader, /float waterSkyAlpha = waterSkyAmount \+ \(1\.0 - waterSkyAmount\) \* waterSkyBodyAlpha;/);
  // A ripple tipping the ray below the horizon reads the horizon band, never the dark fog below it.
  assert.match(fragmentShader, /float h = clamp\(height, 0\.0, 1\.0\);/);
  assert.equal(uniforms.waterVisibleSun, shared.visibleSun, "glints follow the disc that sets");
});

test("normal maps plug in per class without a recompile; still water picks the calm map per vertex", () => {
  const shared = currentWater.createWaterShaderSharedUniforms();
  const water = compileWater("water", CINEMATIC_WATER, shared);
  const ocean = compileWater("ocean", CINEMATIC_WATER, shared);
  assert.equal(water.uniforms.waterDetailNear, shared.detail.water.near);
  assert.equal(water.uniforms.waterDetailAlternate, shared.detail.water.alternate);
  assert.equal(ocean.uniforms.waterDetailParams, shared.detail.ocean.params);
  assert.match(water.vertexShader, /attribute float liquidCalm;/);
  assert.match(water.vertexShader, /vWaterCalm = liquidCalm;/);
  assert.match(water.fragmentShader, /waterDetailRipple\(vWaterWorldPosition\.xz, waterTime, waterFootprint, vWaterCalm\)/);
  assert.doesNotMatch(ocean.vertexShader, /liquidCalm/);
  assert.match(ocean.fragmentShader, /waterDetailRipple\(vWaterWorldPosition\.xz, waterTime, waterFootprint, smoothstep\(/);
  // Until a map is bound the procedural octaves carry the surface.
  assert.match(water.fragmentShader, /if \(waterDetailParams\.x > 0\.0\) \{/);
  assert.equal(shared.detail.water.params.value.x, 0);

  const near = new THREE.Texture({ width: 1024, height: 683 });
  const calm = new THREE.Texture({ width: 1024, height: 683 });
  currentWater.setWaterDetailNormalMaps(shared, "water", near, calm, { tileYards: 9, stretch: 1.5, slopeVariance: [0.048, 0.014] });
  assert.ok(shared.detail.water.params.value.x > 0);
  assert.equal(shared.detail.water.near.value, near);
  assert.equal(shared.detail.water.alternate.value, calm);
  assert.ok(Math.abs(shared.detail.water.aspect.value.x - 683 / 1024 * 1.5) < 1e-9);
  assert.equal(near.wrapS, THREE.RepeatWrapping);
  assert.equal(near.colorSpace, THREE.NoColorSpace);
  assert.equal(shared.detail.ocean.params.value.x, 0, "classes are independent");
  currentWater.setWaterDetailNormalMaps(shared, "water", null);
  assert.equal(shared.detail.water.params.value.x, 0);
  assert.equal(shared.detail.water.near.value, null);

  assert.equal(currentWater.liquidCalmOf(5), 1, "Slow Water");
  assert.equal(currentWater.liquidCalmOf(13), 1, "WMO Water");
  assert.equal(currentWater.liquidCalmOf(1), 0, "Water (rivers)");
  assert.equal(currentWater.liquidCalmOf(9), 0, "Fast Water");
  assert.equal(currentWater.liquidCalmOf(0, true), 1, "any WMO group liquid");
});

test("the shipped maps load once, only on request, and a failure keeps the procedural surface", async () => {
  const shared = currentWater.createWaterShaderSharedUniforms();
  const requested = [];
  const made = [];
  const maps = new currentWater.WaterDetailNormalMaps(shared, "/textures/water/", async (url) => {
    requested.push(url);
    if (url.endsWith("SeaDistant_N.jpg")) throw new Error("offline");
    const texture = new THREE.Texture({ width: 1024, height: 683 });
    made.push(texture);
    return texture;
  });
  assert.equal(requested.length, 0, "nothing is fetched before an enhanced water leaf asks");
  maps.request();
  maps.request();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([...requested].sort(), ["/textures/water/GreenCalm_N.jpg", "/textures/water/Lake_N.jpg",
    "/textures/water/SeaDistant_N.jpg", "/textures/water/SeaWaves_N.jpg"]);
  assert.ok(shared.detail.water.params.value.x > 0, "lakes and rivers got both of their maps");
  assert.equal(shared.detail.ocean.params.value.x, 0, "the sea lost one map and stays procedural");
  assert.deepEqual(maps.stats, { pending: 0, loaded: 3, failed: 1 });
  let disposed = 0;
  for (const texture of made) texture.addEventListener("dispose", () => disposed++);
  maps.dispose();
  assert.equal(disposed, 3);
  assert.equal(shared.detail.water.params.value.x, 0);
  assert.equal(shared.detail.water.near.value, null);
});

test("renderer fetches the maps only under an enhanced water leaf and tags still water", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /if \(next\.waterSunGlitter \|\| next\.waterSkyReflection\) this\.#waterDetailMaps\.request\(\);/);
  assert.match(source, /const profile = this\.#lightingProfile\.quality === 0 \? undefined : this\.#cinematicRequested;/);
  assert.match(source, /this\.#waterShaderUniforms\.visibleSun\.value\.copy\(sun\);/);
  assert.match(source, /geometry\.setAttribute\("liquidCalm", new THREE\.Float32BufferAttribute\(surface\.calm, 1\)\);/);
  assert.match(source, /this\.#waterDetailMaps\.dispose\(\);/);
});
