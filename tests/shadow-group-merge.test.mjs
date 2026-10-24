// 25.10 (12.10): one shadow draw per depth state of a caster (ShadowGroupMerge.ts).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  SHADOW_MERGE_COPY_BUDGET, ShadowGroupMerger, shadowDepthState, shadowMergePattern, shadowMergedGeometry,
} from "../dist/code/browser/ShadowGroupMerge.js";

/** A geometry with `count` triangles (indices 0..3count-1 in order) and the given groups. */
function geometry(count, groups, indexed = true) {
  const value = new THREE.BufferGeometry();
  value.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 9), 3));
  if (indexed) value.setIndex(Array.from({ length: count * 3 }, (_, at) => at));
  for (const [start, length, material] of groups) value.addGroup(start, length, material);
  return value;
}

const opaque = (side = THREE.FrontSide) => new THREE.MeshStandardMaterial({ side });
const keyed = () => new THREE.MeshStandardMaterial({ map: new THREE.Texture(), alphaTest: 0.5 });

/** What three's shadow walk draws for a mesh: per group, the depth state and the index entries. */
function shadowDraws(mesh) {
  const index = mesh.geometry.index.array;
  return mesh.geometry.groups.flatMap((group) => {
    const state = shadowDepthState(mesh.material[group.materialIndex], mesh.customDepthMaterial);
    if (state === null) return [];
    return [{ state, entries: [...index.subarray(group.start, group.start + group.count)] }];
  });
}

/** Index entries drawn per depth state, sorted: the depth map is the same when these are. */
function byState(draws) {
  const out = new Map();
  for (const { state, entries } of draws) out.set(state, [...(out.get(state) ?? []), ...entries]);
  for (const list of out.values()) list.sort((left, right) => left - right);
  return out;
}

test("opaque groups of one side share three's depth state; alpha-keyed ones and other sides do not", () => {
  const a = opaque(), b = opaque(), back = opaque(THREE.DoubleSide), cut = keyed();
  assert.equal(shadowDepthState(a, undefined), shadowDepthState(b, undefined));
  assert.notEqual(shadowDepthState(a, undefined), shadowDepthState(back, undefined));
  assert.equal(shadowDepthState(cut, undefined), cut);
  const hidden = opaque();
  hidden.visible = false;
  assert.equal(shadowDepthState(hidden, undefined), null);
  // A custom depth material takes the group's side, textures and threshold: opaque groups of one side merge.
  const custom = new THREE.MeshDepthMaterial();
  assert.equal(shadowDepthState(a, custom), shadowDepthState(b, custom));
});

test("a twin draws the same triangles under the same depth states in fewer draws", () => {
  const cut = keyed();
  const materials = [opaque(), cut, opaque(), opaque(THREE.DoubleSide), opaque(), cut];
  // Interleaved: states 0/2/4 are one, 1/5 another (one material), 3 its own side.
  const source = geometry(12, [[0, 3, 0], [3, 6, 1], [9, 6, 2], [15, 3, 3], [18, 9, 4], [27, 9, 5]]);
  const pattern = shadowMergePattern(source.groups, materials, undefined);
  assert.deepEqual([...pattern], [0, 1, 0, 3, 0, 1]);
  const twin = shadowMergedGeometry(source, pattern);
  assert.equal(twin.groups.length, 3);
  assert.notEqual(twin.index, source.index, "interleaved states need an index of their own");
  assert.equal(twin.attributes, source.attributes);
  assert.equal(twin.boundingSphere, source.boundingSphere);
  const before = byState(shadowDraws(new THREE.Mesh(source, materials)));
  const after = byState(shadowDraws(new THREE.Mesh(twin, materials)));
  assert.deepEqual(after, before);
  // Each merged group keeps its first member's material, so three picks the same depth material and hooks.
  assert.deepEqual(twin.groups.map((group) => group.materialIndex), [0, 1, 3]);
});

test("adjacent members widen their groups over the source index; nothing to save gives no pattern", () => {
  const materials = [opaque(), opaque(), keyed()];
  const source = geometry(6, [[0, 3, 0], [3, 6, 1], [9, 9, 2]]);
  const twin = shadowMergedGeometry(source, shadowMergePattern(source.groups, materials, undefined));
  assert.equal(twin.index, source.index);
  assert.deepEqual(twin.groups.map(({ start, count }) => [start, count]), [[0, 9], [9, 9]]);
  assert.equal(shadowMergePattern(source.groups, [opaque(), keyed(), opaque(THREE.BackSide)], undefined), undefined);
  // Non-indexed and interleaved: cannot be reordered without copying the vertices.
  const flat = geometry(4, [[0, 3, 0], [3, 3, 1], [6, 3, 0]], false);
  assert.equal(shadowMergedGeometry(flat, shadowMergePattern(flat.groups, [opaque(), keyed()], undefined)), null);
});

test("the merger swaps around the pass, restores, shares one twin, and follows a material change", () => {
  const materials = [opaque(), opaque(), opaque()];
  const source = geometry(3, [[0, 3, 0], [3, 3, 1], [6, 3, 2]]);
  const one = new THREE.Mesh(source, materials);
  const two = new THREE.Mesh(source, materials.slice());
  const merger = new ShadowGroupMerger();
  merger.begin();
  merger.swap(one);
  merger.swap(two);
  assert.notEqual(one.geometry, source);
  assert.equal(one.geometry, two.geometry, "one twin per geometry and partition");
  assert.equal(one.geometry.groups.length, 1);
  assert.equal(merger.stats.groupsSaved, 4);
  merger.restore();
  assert.equal(one.geometry, source);
  assert.equal(two.geometry, source);

  // A fade copy turns one group alpha-keyed: the next frame's partition follows.
  materials[1] = keyed();
  merger.begin();
  merger.swap(one);
  assert.equal(one.geometry.groups.length, 2);
  merger.restore();
  // A material made invisible in place is not drawn by three; nor by the twin.
  materials[1].visible = false;
  merger.begin();
  merger.swap(one);
  assert.equal(one.geometry.groups.length, 1);
  assert.equal(one.geometry.groups[0].count, 6);
  merger.restore();
});

test("a frame copies at most its budget of indices into new twins", () => {
  const big = SHADOW_MERGE_COPY_BUDGET; // one interleaved state over more than the budget
  const source = geometry(Math.ceil(big / 3) + 2, [[0, big / 2, 0], [big / 2, 3, 1], [big / 2 + 3, big / 2 + 3, 0]]);
  const mesh = new THREE.Mesh(source, [opaque(), keyed()]);
  const merger = new ShadowGroupMerger();
  merger.begin();
  merger.swap(mesh);
  assert.equal(mesh.geometry, source, "over budget: drawn as it is this frame");
  merger.restore();
});

test("disposing the source disposes its twins after it, never before", () => {
  const source = geometry(3, [[0, 3, 0], [3, 3, 1], [6, 3, 0]]);
  const mesh = new THREE.Mesh(source, [opaque(), keyed()]);
  const merger = new ShadowGroupMerger();
  merger.begin();
  merger.swap(mesh);
  const twin = mesh.geometry;
  merger.restore();
  let twinDisposed = 0;
  twin.addEventListener("dispose", () => twinDisposed++);
  assert.equal(twinDisposed, 0);
  source.dispose();
  assert.equal(twinDisposed, 1);
});

test("the cascades draw each listed caster with its twin and hand its geometry back after the pass", async () => {
  const { CascadedSunShadows } = await import("../dist/code/browser/CascadedShadows.js");
  const { lightingProfile } = await import("../dist/code/browser/LightingQuality.js");
  const { createWorldLightUniforms } = await import("../dist/code/browser/WorldLighting.js");
  const { ShadowCasterList } = await import("../dist/code/browser/ShadowCasterList.js");
  const scene = new THREE.Scene();
  const primary = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(primary, primary.target);
  const cascades = new CascadedSunShadows(primary, createWorldLightUniforms().wowShadowFade);
  const seen = [];
  const renderer = {
    info: { render: { calls: 0 } },
    shadowMap: {
      render(lights, root) {
        seen.push(root.isScene ? [] : root.children.flatMap((group) => group.children).map((mesh) => mesh.geometry));
        for (const light of lights) light.shadow.map ??= { dispose() {} };
      },
    },
  };
  cascades.configure(scene, renderer, lightingProfile(2, { shadowMaps: true, maxTextureSize: 4096 }));
  const source = geometry(3, [[0, 3, 0], [3, 3, 1], [6, 3, 2]]);
  const barrel = new THREE.Mesh(source, [opaque(), opaque(), opaque()]);
  barrel.castShadow = true;
  scene.add(barrel);
  const list = new ShadowCasterList();
  list.set(barrel, true);
  cascades.setCasterList(list);
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 4000);
  camera.position.set(-9600, 60, 300);
  camera.lookAt(-9570, 55, 330);
  camera.updateMatrixWorld();
  cascades.update(camera, new THREE.Vector3(0.19, 0.53, -0.84), 1);
  renderer.shadowMap.render(cascades.lights, scene, camera);
  assert.ok(seen.length > 0);
  for (const geometries of seen) {
    assert.equal(geometries.length, 1);
    assert.notEqual(geometries[0], source, "drawn with the twin");
    assert.equal(geometries[0].groups.length, 1);
  }
  assert.equal(barrel.geometry, source, "the view draws its own geometry");
});
