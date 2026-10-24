// 25.10 (12.10): one depth material per caster kind in the cascades (ShadowDepthKinds.ts).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { shadowDepthFor, shadowDepthKind } from "../dist/code/browser/ShadowDepthKinds.js";

const box = () => new THREE.BoxGeometry();
const plain = () => new THREE.Mesh(box(), new THREE.MeshStandardMaterial());
const bucket = (colour) => {
  const mesh = new THREE.InstancedMesh(box(), new THREE.MeshStandardMaterial(), 2);
  if (colour) mesh.setColorAt(0, new THREE.Color(1, 0, 0));
  return mesh;
};
const body = () => new THREE.SkinnedMesh(box(), new THREE.MeshStandardMaterial());

test("each caster kind draws three's depth material through a twin of its own; plain meshes keep it", () => {
  const shared = new THREE.MeshDepthMaterial();
  const casters = [plain(), bucket(false), bucket(true), body()];
  assert.deepEqual(casters.map(shadowDepthKind), [0, 1, 2, 3]);
  const drawn = casters.map((object) => shadowDepthFor(shared, object));
  assert.equal(drawn[0], shared);
  assert.equal(new Set(drawn).size, 4, "one material per kind: no kind ever hands its program to another");
  assert.equal(shadowDepthFor(shared, bucket(false)), drawn[1], "made once per kind");
  // A mesh's own depth material is kind-specific already; anything not a depth material is left alone.
  const carrier = body();
  carrier.customDepthMaterial = new THREE.MeshDepthMaterial();
  assert.equal(shadowDepthFor(carrier.customDepthMaterial, carrier), carrier.customDepthMaterial);
  const basic = new THREE.MeshBasicMaterial();
  assert.equal(shadowDepthFor(basic, bucket(false)), basic);
});

test("a twin draws with the state three just wrote onto the source, and with its compile hooks", () => {
  const clone = new THREE.MeshDepthMaterial();
  const sway = () => {};
  clone.onBeforeCompile = sway;
  clone.customProgramCacheKey = () => "wind";
  const instanced = bucket(false);
  // As `getDepthMaterial` leaves it for an alpha-keyed batch, and as the depth-only hook does.
  const map = new THREE.Texture();
  Object.assign(clone, { side: THREE.DoubleSide, map, alphaTest: 0.5, colorWrite: false });
  const twin = shadowDepthFor(clone, instanced);
  assert.notEqual(twin, clone);
  assert.equal(twin.side, THREE.DoubleSide);
  assert.equal(twin.map, map);
  assert.equal(twin.alphaTest, 0.5);
  assert.equal(twin.colorWrite, false);
  assert.equal(twin.onBeforeCompile, sway);
  assert.equal(twin.customProgramCacheKey(), "wind");
  // The next draw's state follows; so does a hook installed on the source later.
  Object.assign(clone, { side: THREE.FrontSide, map: null, alphaTest: 0 });
  const later = () => {};
  clone.onBeforeCompile = later;
  const version = twin.version;
  assert.equal(shadowDepthFor(clone, instanced), twin);
  assert.equal(twin.side, THREE.FrontSide);
  assert.equal(twin.map, null);
  assert.equal(twin.alphaTest, 0);
  assert.equal(twin.onBeforeCompile, later);
  assert.ok(twin.version > version, "recompiled with the new hook");
});

test("a prototype method swapped for a frame (the bench census) is not taken for a new hook", () => {
  const shared = new THREE.MeshDepthMaterial();
  const instanced = bucket(true);
  const twin = shadowDepthFor(shared, instanced);
  const version = twin.version;
  const original = THREE.Material.prototype.customProgramCacheKey;
  THREE.Material.prototype.customProgramCacheKey = function () { return original.call(this); };
  try {
    assert.equal(shadowDepthFor(shared, instanced), twin);
  } finally {
    THREE.Material.prototype.customProgramCacheKey = original;
  }
  assert.equal(shadowDepthFor(shared, instanced), twin);
  assert.equal(twin.version, version, "no program derived again for an inherited hook");
  assert.equal(Object.prototype.hasOwnProperty.call(twin, "customProgramCacheKey"), false);
});

test("the cascades swap only while they render, through renderBufferDirect installed once", async () => {
  const { CascadedSunShadows } = await import("../dist/code/browser/CascadedShadows.js");
  const { lightingProfile } = await import("../dist/code/browser/LightingQuality.js");
  const { createWorldLightUniforms } = await import("../dist/code/browser/WorldLighting.js");
  const { ShadowCasterList } = await import("../dist/code/browser/ShadowCasterList.js");
  const scene = new THREE.Scene();
  const primary = new THREE.DirectionalLight(0xffffff, 0);
  scene.add(primary, primary.target);
  const cascades = new CascadedSunShadows(primary, createWorldLightUniforms().wowShadowFade);
  const shared = new THREE.MeshDepthMaterial();
  const seen = [];
  const renderer = {
    info: { render: { calls: 0 } },
    renderBufferDirect(camera, scene_, geometry, material, object) { seen.push({ material, object }); },
    shadowMap: {
      render(lights, root) {
        // three's shadow walk: each caster drawn with its depth material.
        for (const group of root.children ?? []) for (const object of group.children) renderer.renderBufferDirect(null, null, object.geometry, shared, object, null);
        for (const light of lights) light.shadow.map ??= { dispose() {} };
      },
    },
  };
  cascades.configure(scene, renderer, lightingProfile(2, { shadowMaps: true, maxTextureSize: 4096 }));
  cascades.configure(scene, renderer, lightingProfile(2, { shadowMaps: true, maxTextureSize: 4096 }));
  const instanced = bucket(false);
  instanced.castShadow = true;
  scene.add(instanced);
  const list = new ShadowCasterList();
  list.set(instanced, true);
  cascades.setCasterList(list);
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 4000);
  camera.position.set(-9600, 60, 300);
  camera.lookAt(-9570, 55, 330);
  camera.updateMatrixWorld();
  cascades.update(camera, new THREE.Vector3(0.19, 0.53, -0.84), 1);
  renderer.shadowMap.render(cascades.lights, scene, camera);
  assert.ok(seen.length > 0);
  assert.ok(seen.every(({ material }) => material !== shared && material.isMeshDepthMaterial), "the bucket drew with its kind's twin");
  assert.equal(new Set(seen.map(({ material }) => material)).size, 1, "the same twin in every cascade, wrapped once");
  // Outside the cascades the call passes through untouched.
  seen.length = 0;
  renderer.renderBufferDirect(null, null, instanced.geometry, shared, instanced, null);
  assert.equal(seen[0].material, shared);
});
