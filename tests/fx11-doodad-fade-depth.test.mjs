// 15.11 (fx11, 7.66): how Wow.exe draws a doodad fading at its class distance, against frames of the original client
// (WowOracle s03, s06, s08, fog6-o-netherstorm, fx11-leaf-1/2: 102 fading copies; `.runtime/re-2026-11-15/fx11/
// fadecopies.mjs`). Every copy is drawn twice, all of its batches each time: a depth pass (colour writes off, no blending,
// depth written, LESSEQUAL, the batch's cull and alpha test), then a colour pass (SrcAlpha/InvSrcAlpha, depth still
// written, same cull and test) — e.g. s06 #2541/#2542 then #2543/#2544, the banner's cut-out at 136 = 224 × 0.607.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DoodadFadeInstances, doodadFadeDepthMaterial, doodadFadeMaterial } from "../dist/code/browser/DoodadFadeInstances.js";

test("a fading copy draws a depth-only pass before its blended colour pass, over the same copies", () => {
  const pass = new DoodadFadeInstances({ register: () => {}, unregister: () => {}, warm: () => true });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  const opaque = new THREE.MeshLambertMaterial();
  const cutout = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  cutout.alphaTest = 224 / 255;
  pass.begin();
  pass.add("tree", {}, geometry, [opaque, cutout], new THREE.Matrix4().makeTranslation(5, 0, 0), undefined, 0.6);
  pass.add("tree", {}, geometry, [opaque, cutout], new THREE.Matrix4().makeTranslation(9, 0, 0), undefined, 0.3);
  pass.commit();
  const [colour, depth] = pass.group.children;
  assert.ok(depth, "a depth pass beside the colour pass");
  assert.ok(depth.renderOrder < colour.renderOrder, "drawn first");
  assert.equal(depth.visible, true);
  assert.equal(depth.count, 2);
  assert.equal(depth.instanceMatrix, colour.instanceMatrix, "the same copies");
  assert.equal(depth.geometry, colour.geometry, "the same fade attribute (a copy at ≤ 0.01 is discarded in both)");
  for (const [index, source] of [opaque, cutout].entries()) {
    const d = depth.material[index], c = colour.material[index];
    assert.equal(d.colorWrite, false, "depth pass: colour writes off");
    assert.equal(d.depthWrite, true, "depth pass: depth written");
    assert.equal(d.alphaTest, source.alphaTest, "depth pass: the batch's own cut-out");
    assert.equal(d.side, source.side, "depth pass: the batch's own cull");
    assert.equal(c.colorWrite, true);
    assert.equal(c.transparent, true, "colour pass: blended");
    assert.equal(c.blending, THREE.NormalBlending, "SrcAlpha/InvSrcAlpha");
    assert.equal(c.depthWrite, true, "colour pass: depth still written");
    assert.equal(d.customProgramCacheKey(), c.customProgramCacheKey(), "one program for both passes");
  }
  assert.equal(doodadFadeDepthMaterial(opaque), depth.material[0], "one depth copy per source");
  assert.equal(doodadFadeMaterial(opaque), colour.material[0]);
  pass.begin();
  pass.commit();
  assert.equal(pass.group.children.length, 0, "both passes go with the copies");
});
