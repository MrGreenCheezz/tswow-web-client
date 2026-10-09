import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  TERRAIN_MICRO_NORMAL_PROFILE_VERSION,
  applyTerrainSplat,
  setTerrainSplatMicroNormals,
} from "../dist/code/browser/TerrainSplat.js";
import { applyWorldLight, createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";

const terrainSplatSource = await readFile(new URL("../src/browser/TerrainSplat.ts", import.meta.url), "utf8");

function splat(painted = false) {
  return {
    layers: new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1),
    alpha: new THREE.Texture(),
    index: new THREE.Texture(),
    ...(painted ? { colours: new THREE.Texture() } : {}),
  };
}

function shader() {
  return {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
}

function compile(material) {
  const compiled = shader();
  material.onBeforeCompile(compiled, {});
  return compiled;
}

test("terrain micro-normal OFF preserves the exact splat shader and cache key", () => {
  const baseline = new THREE.MeshLambertMaterial();
  const profiled = new THREE.MeshLambertMaterial();
  const tile = splat();
  applyTerrainSplat(baseline, tile);
  applyTerrainSplat(profiled, tile);
  const baselineShader = compile(baseline);
  const baselineKey = baseline.customProgramCacheKey();

  setTerrainSplatMicroNormals(profiled, false);
  const offShader = compile(profiled);
  assert.equal(profiled.customProgramCacheKey(), baselineKey);
  assert.equal(offShader.vertexShader, baselineShader.vertexShader);
  assert.equal(offShader.fragmentShader, baselineShader.fragmentShader);
});

test("terrain micro-normal is bounded, versioned, and runs before authored world light", () => {
  const material = new THREE.MeshLambertMaterial();
  applyWorldLight(material, createWorldLightUniforms(), "terrain");
  applyTerrainSplat(material, splat());
  const offShader = compile(material);
  const offKey = material.customProgramCacheKey();

  setTerrainSplatMicroNormals(material, true);
  const wrapper = material.onBeforeCompile;
  const enabledVersion = material.version;
  const onShader = compile(material);
  assert.equal(
    material.customProgramCacheKey(),
    `${offKey}|terrain-micro-normal-v${TERRAIN_MICRO_NORMAL_PROFILE_VERSION}`,
  );
  assert.equal(onShader.fragmentShader.split("terrain-micro-normal-v1").length - 1, 1);
  assert.match(onShader.fragmentShader, /dFdx\(terrainMicroHeight\)/);
  assert.match(onShader.fragmentShader, /dFdy\(terrainMicroHeight\)/);
  assert.match(onShader.fragmentShader, /smoothstep\(50\.0, 125\.0, length\(vViewPosition\)\)/);
  assert.doesNotMatch(terrainSplatSource, /fract\(vSplatUv\s*\*\s*16\.0\)/,
    "the optional detail pass must not draw a periodic line at every authored chunk border");
  assert.doesNotMatch(terrainSplatSource, /terrainTileEdge(?:Distance|Footprint|Width|Fade)|fwidth\(vSplatUv\)/,
    "an outer-edge guard still outlines every separately drawn ADT mesh");
  assert.match(terrainSplatSource,
    /terrainMicroGradient\s*\*=\s*0\.08\s*\*\s*terrainMicroOutlierFade\s*\*\s*terrainDistanceFade/,
    "only implausible derivative spikes and distance may attenuate micro normals");
  assert.match(onShader.fragmentShader, /normal = normalize\(/);
  assert.ok(onShader.fragmentShader.indexOf("terrain-micro-normal-v1")
    < onShader.fragmentShader.indexOf("vec3 wowViewSunDirection"));
  assert.match(onShader.fragmentShader, /#define WOW_LIGHT_TERRAIN/);

  setTerrainSplatMicroNormals(material, true);
  assert.equal(material.onBeforeCompile, wrapper);
  assert.equal(material.version, enabledVersion);
  setTerrainSplatMicroNormals(material, false);
  assert.equal(material.onBeforeCompile, wrapper);
  assert.equal(material.customProgramCacheKey(), offKey);
  assert.equal(compile(material).fragmentShader, offShader.fragmentShader);
});

test("painted and unpainted terrain keep distinct profile programs", () => {
  const plain = new THREE.MeshLambertMaterial();
  const painted = new THREE.MeshLambertMaterial();
  applyTerrainSplat(plain, splat());
  applyTerrainSplat(painted, splat(true));
  setTerrainSplatMicroNormals(plain, true);
  setTerrainSplatMicroNormals(painted, true);
  // 05.10-A7b-7: the splat keys carry the v2 program (baked shadow, per-chunk alpha).
  assert.match(plain.customProgramCacheKey(), /terrain-splat-v2\|terrain-micro-normal-v1$/);
  assert.match(painted.customProgramCacheKey(), /terrain-splat-mccv-v2\|terrain-micro-normal-v1$/);
  assert.notEqual(plain.customProgramCacheKey(), painted.customProgramCacheKey());
});

test("terrain profile fails closed when the Lambert marker contract drifts", () => {
  const missing = new THREE.MeshLambertMaterial();
  applyTerrainSplat(missing, splat());
  setTerrainSplatMicroNormals(missing, true);
  assert.throws(() => missing.onBeforeCompile({
    uniforms: {}, vertexShader: "", fragmentShader: "void main(){}",
  }, {}), /terrain micro-normal expected one normal marker, found 0/);

  const duplicate = new THREE.MeshLambertMaterial();
  applyTerrainSplat(duplicate, splat());
  setTerrainSplatMicroNormals(duplicate, true);
  assert.throws(() => duplicate.onBeforeCompile({
    uniforms: {},
    vertexShader: "#include <begin_vertex>",
    fragmentShader: "#include <map_fragment>\n#include <normal_fragment_maps>\n#include <normal_fragment_maps>",
  }, {}), /terrain micro-normal expected one normal marker, found 2/);
});
