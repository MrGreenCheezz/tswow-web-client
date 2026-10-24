// 25.10 (12.10): a room's opaque runs sharing a material drawn as one range (WmoRunMerge.ts).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { wmoRoomDrawGeometry, wmoRunMergePattern, wmoRunMergedGeometry } from "../dist/code/browser/WmoRunMerge.js";

function room(triangles, groups) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(triangles * 9), 3));
  geometry.setIndex(Array.from({ length: triangles * 3 }, (_, at) => at));
  for (const [start, count, material] of groups) geometry.addGroup(start, count, material);
  return geometry;
}

/**
 * What three submits for one mesh: opaque groups sorted (stably) by material id — the mesh's groups share
 * its distance and id — then transparent ones in group order; per draw the material and its index entries.
 */
function submitted(geometry, materials) {
  const items = geometry.groups.map((group, order) => ({ group, order, material: materials[group.materialIndex] }));
  const opaque = items.filter((item) => !item.material.transparent).sort((a, b) => a.material.id - b.material.id || a.order - b.order);
  const blended = items.filter((item) => item.material.transparent);
  const index = geometry.index.array;
  const entries = (list) => list.flatMap(({ group, material }) =>
    [...index.subarray(group.start, group.start + group.count)].map((entry) => `${material.id}:${entry}`));
  return { opaque: entries(opaque), blended: entries(blended), draws: items.length };
}

test("opaque runs of one material become one draw with the same triangles in the same order", () => {
  const stone = new THREE.MeshStandardMaterial(), wood = new THREE.MeshStandardMaterial();
  const glass = new THREE.MeshBasicMaterial({ transparent: true });
  // Runs: stone, wood, glass, stone, glass(again), wood — the run list names one material per ordinal.
  const materials = [stone, wood, glass, stone, glass, wood];
  const source = room(12, [[0, 6, 0], [6, 3, 1], [9, 3, 2], [12, 9, 3], [21, 6, 4], [27, 9, 5]]);
  const pattern = wmoRunMergePattern(source.groups, materials);
  assert.deepEqual([...pattern], [0, 1, 2, 0, 4, 1], "transparent runs keep their own groups");
  const merged = wmoRunMergedGeometry(source, pattern);
  assert.equal(merged.groups.length, 4);
  assert.equal(merged.attributes, source.attributes);
  const before = submitted(source, materials), after = submitted(merged, materials);
  assert.deepEqual(after.opaque, before.opaque);
  assert.deepEqual(after.blended, before.blended);
  assert.equal(before.draws - after.draws, 2);
});

test("adjacent runs widen over the room's own index; a room with nothing shared is drawn as it was", () => {
  const stone = new THREE.MeshStandardMaterial(), wood = new THREE.MeshStandardMaterial();
  const source = room(6, [[0, 3, 0], [3, 6, 1], [9, 9, 2]]);
  const merged = wmoRoomDrawGeometry(source, [stone, stone, wood]);
  assert.equal(merged.index, source.index);
  assert.deepEqual(merged.groups.map(({ start, count }) => [start, count]), [[0, 9], [9, 9]]);
  assert.equal(wmoRoomDrawGeometry(source, [stone, stone, wood]), merged, "made once per room and pattern");
  assert.equal(wmoRoomDrawGeometry(source, [stone, wood, new THREE.MeshStandardMaterial()]), source);
  let disposed = 0;
  merged.addEventListener("dispose", () => disposed++);
  source.dispose();
  assert.equal(disposed, 1, "disposed with its room, never before it");
});
