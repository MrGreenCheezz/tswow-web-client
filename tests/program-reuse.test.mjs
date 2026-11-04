// 04.11: a material's hooks against three's own program reuse. three 0.185 (`WebGLRenderer.getProgram`): a key this material
// has already compiled gets that program back, with no `onBeforeCompile` and with the uniforms of the material's LAST compile
// (`materialProperties.uniforms`). So a hook whose key turns over at run time must put its uniforms into every compile, drawn or
// not: kept to the "on" compile, on → off → on left the reused program uploading nothing to them. That was the owner's report:
// the buildings' relief «порой» gone after a setting or the lighting level was flipped, until the materials were rebuilt.
// What this does NOT prove: what a driver draws; `bench/lookdev.mjs --flip wmoRelief=false --flip wmoRelief=true` does.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "three";

import { applyIndoorLampsToRoom, setIndoorLampsEnabled } from "../dist/code/browser/IndoorLamps.js";
import { RELIEF_STRENGTH } from "../dist/code/browser/ReliefStrength.js";
import { setTerrainSplatRelief } from "../dist/code/browser/TerrainReliefShader.js";
import { applyTerrainSplat } from "../dist/code/browser/TerrainSplat.js";
import { WET_SURFACE_UNIFORMS, setTerrainWetness, setWaterRainRipples } from "../dist/code/browser/WetSurfaces.js";
import { WmoReliefMaps } from "../dist/code/browser/WmoReliefMaps.js";
import { setWmoReliefActive, trackWmoReliefMaterial, wmoReliefMaps } from "../dist/code/browser/WmoReliefShader.js";
import { applyWorldLight, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import { applyWmoInteriorFog } from "../dist/code/browser/WorldRenderer3D.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** three's `getProgram`, for one material: what its next draw binds. `compiled` counts the programs it has made. */
function threeOf(material) {
  const lib = material instanceof THREE.MeshBasicMaterial ? THREE.ShaderLib.basic
    : material instanceof THREE.MeshLambertMaterial ? THREE.ShaderLib.lambert : THREE.ShaderLib.standard;
  const programs = new Map();
  let uniforms;
  return () => {
    const key = material.customProgramCacheKey();
    let program = programs.get(key);
    if (program === undefined) {
      const shader = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
      material.onBeforeCompile(shader, {});
      program = shader.fragmentShader;
      programs.set(key, program);
      uniforms = shader.uniforms;
    }
    return { program, uniforms, compiled: programs.size };
  };
}

test("three still reuses a material's program without its hook, keeping the last compile's uniforms", async () => {
  // The model above. If three changes this, this file's reasoning is to be read again, not patched.
  const source = await readFile(new URL("../node_modules/three/src/renderers/WebGLRenderer.js", import.meta.url), "utf8");
  assert.match(source, new RegExp([
    /let program = programs\.get\( programCacheKey \);/,
    /if \( program !== undefined \) \{/,
    /\} else \{\s*parameters\.uniforms = programCache\.getUniforms\( material \);/,
    /material\.onBeforeCompile\( parameters, _this \);/,
    /programs\.set\( programCacheKey, program \);\s*materialProperties\.uniforms = parameters\.uniforms;\s*\}\s*const uniforms = materialProperties\.uniforms;/,
  ].map((part) => part.source).join("[\\s\\S]{0,500}?")));
});

test("the buildings' relief: on, off, on — the reused program still finds its map, its switch and its strength", async () => {
  wmoReliefMaps(new WmoReliefMaps(async () => ({ relief: new Uint8Array(4 * 4 * 4).fill(200), side: 4, contrast: 0.1 })));
  setWmoReliefActive(true);
  try {
    const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    applyWorldLight(material, createWorldLightUniforms(), "surface");
    const baseline = material.customProgramCacheKey();
    trackWmoReliefMaterial(material, "/visual/texture/reuse-0.png", "lit");
    const draw = threeOf(material);
    const on = draw();
    await settle();
    setWmoReliefActive(false);
    const off = draw();
    assert.equal(material.customProgramCacheKey(), baseline);
    assert.doesNotMatch(off.program, /wmoRelief/, "off draws none of it: the uniforms are only held");
    setWmoReliefActive(true);
    await settle();
    const again = draw();
    assert.equal(again.compiled, 2, "the on program came back from the material's own cache");
    assert.equal(again.program, on.program);
    assert.equal(again.uniforms.wmoRelief?.value.image.width, 4, "the map");
    assert.ok(again.uniforms.wmoReliefOn?.arrived, "the switch");
    assert.equal(again.uniforms.reliefStrength, RELIEF_STRENGTH, "«Сила объёма»");
    material.dispose();
  } finally {
    setWmoReliefActive(false);
  }
});

function terrainMaterial() {
  const material = new THREE.MeshLambertMaterial();
  applyWorldLight(material, createWorldLightUniforms(), "terrain");
  applyTerrainSplat(material, {
    layers: new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2), alpha: new THREE.Texture(), index: new THREE.Texture(),
  });
  return material;
}

test("the ground's relief: on, off, on — the reused program still finds its map and its strength", () => {
  const material = terrainMaterial();
  const relief = new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2);
  setTerrainSplatRelief(material, relief, true);
  const draw = threeOf(material);
  draw();
  setTerrainSplatRelief(material, undefined, false);
  draw();
  setTerrainSplatRelief(material, relief, true);
  const again = draw();
  assert.equal(again.compiled, 2);
  assert.equal(again.uniforms.splatRelief?.value, relief);
  assert.equal(again.uniforms.reliefStrength, RELIEF_STRENGTH, "«Сила объёма»");
});

test("a room's lamps: on, off, on — the reused program still finds the lamps", () => {
  const uniforms = createWorldLightUniforms();
  setIndoorLampsEnabled(uniforms, true);
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  applyWmoInteriorFog(material, { colour: { value: new THREE.Color() }, near: { value: 0 }, far: { value: 1 } });
  applyIndoorLampsToRoom(material, uniforms);
  const draw = threeOf(material);
  draw();
  setIndoorLampsEnabled(uniforms, false);
  draw();
  setIndoorLampsEnabled(uniforms, true);
  const again = draw();
  assert.equal(again.compiled, 2);
  assert.equal(again.uniforms.wowLocalLightCount, uniforms.wowLocalLightCount);
  assert.equal(again.uniforms.wowLocalLightPosition, uniforms.wowLocalLightPosition);
  assert.equal(again.uniforms.wowLampIndoor, uniforms.wowLampIndoor);
});

test("wet surfaces and rain rings: on, off, on — the reused programs still find the rain", () => {
  const ground = terrainMaterial();
  setTerrainWetness(ground, true, false);
  const drawGround = threeOf(ground);
  drawGround();
  setTerrainWetness(ground, false, false);
  drawGround();
  setTerrainWetness(ground, true, false);
  const wet = drawGround();
  assert.equal(wet.compiled, 2);
  assert.equal(wet.uniforms.uWetness, WET_SURFACE_UNIFORMS.wetness);
  assert.equal(wet.uniforms.uWetTime, WET_SURFACE_UNIFORMS.time);

  const water = new THREE.MeshBasicMaterial();
  setWaterRainRipples(water, true);
  const drawWater = threeOf(water);
  drawWater();
  setWaterRainRipples(water, false);
  drawWater();
  setWaterRainRipples(water, true);
  const rain = drawWater();
  assert.equal(rain.compiled, 2);
  assert.equal(rain.uniforms.uWetRain, WET_SURFACE_UNIFORMS.rain);
});
