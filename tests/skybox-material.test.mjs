// 15.11 (sky8, 7.59): the sky copy of a LightSkybox batch keeps the batch's second texture and combiner program
// (DalaranSkyBox.m2's aurora curtains: shader 0x4014, AURORALIGHT_OR_B.BLP × AURORAMASK_B_ORANGE.BLP on UV set 1).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { carrySkyboxBatchStages } from "../dist/code/browser/SkyboxMaterial.js";

function skyCopy(source) {
  // As `WorldRenderer3D.#updateSkybox` builds it before the carry.
  return new THREE.MeshBasicMaterial({ map: source.map ?? null, transparent: source.transparent, depthTest: false, depthWrite: false });
}

test("an unlit batch's mask and its combiner program reach the sky copy", () => {
  const map = new THREE.Texture();
  const mask = new THREE.Texture();
  mask.channel = 1;
  const source = new THREE.MeshBasicMaterial({ map, alphaMap: mask, transparent: true });
  const hook = (shader) => { shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", "/* wvm-combiner */"); };
  source.onBeforeCompile = hook;
  source.customProgramCacheKey = () => "wvm-comb1-Mod_Mod2x-00";
  const copy = skyCopy(source);
  assert.equal(copy.alphaMap, null, "the copy alone loses the mask");
  carrySkyboxBatchStages(source, copy);
  assert.equal(copy.alphaMap, mask);
  assert.equal(copy.onBeforeCompile, hook);
  assert.equal(copy.customProgramCacheKey(), "wvm-comb1-Mod_Mod2x-00", "its own program, not the plain basic one");
  const shader = { fragmentShader: THREE.ShaderLib.basic.fragmentShader, vertexShader: "", uniforms: {} };
  copy.onBeforeCompile(shader, undefined);
  assert.match(shader.fragmentShader, /wvm-combiner/);
});

test("a lit batch's hook is for the standard material and stays out of the basic copy", () => {
  const source = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), alphaMap: new THREE.Texture() });
  source.onBeforeCompile = () => {};
  const copy = skyCopy(source);
  const before = copy.onBeforeCompile;
  carrySkyboxBatchStages(source, copy);
  assert.equal(copy.alphaMap, null);
  assert.equal(copy.onBeforeCompile, before);
});
