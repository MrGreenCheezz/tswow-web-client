// 11.02 (15.11, vehicle9): MsslTrgtImpactModel drawn at the aim's impact (Wow.exe 0x006fda20 → 0x008251d0: the impact point,
// the mover's facing, the scale MsslTrgtImpactRadius / the M2 header's bounding radius (0x004f5e80), the arc's strength as the
// model's alpha; 0x006fbfa0 drops it at strength 0).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { VehicleImpactModelMesh, impactModelPlacement } from "../dist/code/browser/VehicleImpactModelMesh.js";

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} ${actual} vs ${expected}`);

// Vehicle row 26 of the dataset (Flags 0x470d6677): MsslTrgtImpactModel[0] Vehicle_Target_02.mdx with radius 10. The file's
// header radius, decoded from the gateway's WVM (.runtime/re-2026-11-15/vehicle9/probe2.txt): 26.96533203125.
const TARGET_02 = "Interface\\Vehicles\\Vehicle_Target_02.m2";
const TARGET_02_RADIUS = 26.96533203125;

function shape(opacity, models = [{ path: TARGET_02, radius: 10 }]) {
  return {
    points: Float32Array.from([0, 0, 5, 30, 40, 2]), facing: 1.2, opacity, width: 1, endOpacity: 1, arcSpeed: 1, arcRepeat: 1,
    arcTexture: "", impactTexture: "", impactRadius: 0, impactModels: models,
  };
}

function fakeHost() {
  const built = [];
  const projected = [];
  return {
    built, projected,
    build(model, path) {
      const material = new THREE.MeshBasicMaterial({ opacity: 0.8 });
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const result = { geometry, materials: [material], height: 1, texturePaths: [], ownedTextures: [], materialSlots: [0],
        geosetSubstitutions: [], animatedBatches: [] };
      built.push({ path, model, result });
      return result;
    },
    project(mesh, batches) { projected.push({ mesh, batches }); },
  };
}

const wvm = { bounds: { min: [0, 0, 0], max: [0, 0, 0], radius: TARGET_02_RADIUS }, globalSequences: new Uint32Array(0) };

test("15.11: the placement 0x008251d0 gives the model: the impact, the facing, the radius over the header's", () => {
  const placed = impactModelPlacement(shape(1), 10, TARGET_02_RADIUS);
  assert.deepEqual({ x: placed.x, y: placed.y, z: placed.z, yaw: placed.yaw }, { x: 30, y: 40, z: 2, yaw: 1.2 });
  close(placed.scale, 10 / TARGET_02_RADIUS);
  assert.equal(impactModelPlacement({ points: new Float32Array(0), facing: 0 }, 10, 1), undefined);
});

test("15.11: nothing until the file is in, then the model at the impact with the arc's strength as its alpha", () => {
  const scene = new THREE.Scene();
  const host = fakeHost();
  const marks = new VehicleImpactModelMesh(scene, host);
  let arrived;
  marks.update(shape(1), 0, () => arrived);
  assert.equal(marks.builtCount, 0, "the model has not arrived: nothing is drawn");
  arrived = wvm;
  marks.update(shape(0.5), 16, (path) => (path === TARGET_02 ? arrived : undefined));
  assert.equal(marks.builtCount, 1);
  const group = scene.getObjectByName("vehicle-impact-models");
  assert.equal(group.visible, true);
  const node = group.children[0];
  assert.deepEqual(node.position.toArray(), [30, 2, -40], "the impact, in the scene's axes");
  close(node.rotation.y, 1.2, "turned to the mover's facing");
  close(node.scale.x, 10 / TARGET_02_RADIUS, "scaled to MsslTrgtImpactRadius");
  const material = host.built[0].result.materials[0];
  close(material.opacity, 0.4, "the build's 0.8 times the arc's strength 0.5");
  assert.equal(material.transparent, true);
  marks.update(shape(1), 32, () => arrived);
  close(material.opacity, 0.8, "the strength is applied to the build's own opacity, not to last frame's");
  assert.equal(host.projected.length, 1, "the batches flag 4 kept out of the mesh go to the decal pass");
  marks.update(shape(0), 48, () => arrived);
  assert.equal(group.visible, false, "strength 0: dropped (0x006fbfa0)");
  marks.update(shape(1, []), 64, () => arrived);
  assert.equal(marks.builtCount, 0, "a row without models lets the build go");
  assert.equal(host.built.length, 1, "built once");
});
