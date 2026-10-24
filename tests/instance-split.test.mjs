// 25.10 (12.10): a doodad with blended batches instanced by its opaque ones (InstanceSplit.ts).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { SPLIT_HOLE, instanceSplit, splitInstanceMaterials } from "../dist/code/browser/InstanceSplit.js";

function model(groups) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(90), 3));
  geometry.setIndex(Array.from({ length: 30 }, (_, at) => at));
  for (const [start, count, material] of groups) geometry.addGroup(start, count, material);
  return geometry;
}
const solid = () => new THREE.MeshStandardMaterial();
const keyed = () => new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
const glow = () => new THREE.MeshBasicMaterial({ transparent: true });
const ranges = (geometry) => geometry.groups.map(({ start, count, materialIndex }) => [start, count, materialIndex]);

test("the bucket draws the opaque groups, the copy the blended ones: together the model, once", () => {
  const materials = [solid(), glow(), keyed(), glow()];
  const source = model([[0, 6, 0], [6, 3, 1], [9, 12, 2], [21, 9, 3]]);
  const split = instanceSplit(source, materials);
  assert.deepEqual(ranges(split.opaque), [[0, 6, 0], [9, 12, 2]], "alpha-keyed batches are opaque: their order never mattered");
  assert.deepEqual(ranges(split.blended), [[6, 3, 1], [21, 9, 3]], "blended groups keep their order");
  for (const twin of [split.opaque, split.blended]) {
    assert.equal(twin.attributes, source.attributes);
    assert.equal(twin.index, source.index);
    assert.equal(twin.boundingSphere, source.boundingSphere);
  }
  assert.equal(instanceSplit(source, materials), split, "one split per model and pattern");
  // The bucket's array keeps its slots; the blended ones are a hole no opaque group names.
  const bucket = splitInstanceMaterials(materials);
  assert.deepEqual(bucket.map((material) => material === SPLIT_HOLE), [false, true, false, true]);
  assert.equal(SPLIT_HOLE.visible, false);
  assert.equal(SPLIT_HOLE.transparent, true, "a blended slot: the bucket casts no shadow, as the copy never did");
  let disposed = 0;
  split.opaque.addEventListener("dispose", () => disposed++);
  source.dispose();
  assert.equal(disposed, 1);
});

test("all opaque is instanced whole; all blended, or one blended material, not at all", () => {
  assert.equal(instanceSplit(model([[0, 30, 0]]), [solid()]), undefined);
  assert.equal(instanceSplit(model([[0, 15, 0], [15, 15, 1]]), [glow(), glow()]), null);
  assert.equal(instanceSplit(model([]), glow()), null);
  assert.equal(instanceSplit(model([]), solid()), undefined);
});
