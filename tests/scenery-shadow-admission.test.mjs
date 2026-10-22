// 22.10 (7.41): a model behind the camera whose shadow falls into the view must keep casting
// (owner's report 22.10: a tree's shadow on the player vanished when they turned away from it).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

import {
  SCENERY_SHADOW_ADMISSION_BUDGET, admitShadowCastersInto, outdoorCasterGroups, shadowCasterSphere, shadowReachesView,
} from "../dist/code/browser/SceneryShadowAdmission.js";
import { admitEnvironmentInto } from "../dist/code/browser/WorldRenderer3D.js";

// Three's default camera at the origin looks down -z; "behind" it is +z. World (x, y, z) maps to
// scene (x, z, -y), so a world y of -20 stands 20 yards behind the camera.
function viewOf({ sun, covers = () => true, shadowDistance = 120 }) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  return { planes: frustum.planes, sun: new THREE.Vector3(...sun), camera: camera.position, shadowDistance, viewFittedCovers: covers };
}

const tree = (id, behind, radius = 5, extra = {}) =>
  ({ id, kind: "m2", name: "tree.m2", x: 0, y: -behind, z: -2, scale: 1, admissionRadius: radius, ...extra });
const SUN_BEHIND = [0, 0.5, 1]; // the shadow falls along -z, into the view
const SUN_AHEAD = [0, 0.5, -1]; // the shadow falls along +z, further behind the camera

test("a tree behind the camera casts into the view only when the sun is behind it too", () => {
  assert.equal(shadowReachesView(tree(1, 20), viewOf({ sun: SUN_BEHIND })), true);
  assert.equal(shadowReachesView(tree(1, 20), viewOf({ sun: SUN_AHEAD })), false);
});

test("off the view-fitted cascades only a large caster within shadowDistance qualifies", () => {
  const nowhere = () => false;
  assert.equal(shadowReachesView(tree(1, 20), viewOf({ sun: SUN_BEHIND, covers: nowhere })), true);
  assert.equal(shadowReachesView(tree(1, 20), viewOf({ sun: SUN_BEHIND, covers: nowhere, shadowDistance: 1 })), false);
  // 2 yards casts into the near cascades but not into the cached one.
  assert.equal(shadowReachesView(tree(1, 6, 2), viewOf({ sun: SUN_BEHIND, covers: nowhere })), false);
  assert.equal(shadowReachesView(tree(1, 6, 2), viewOf({ sun: SUN_BEHIND })), true);
  assert.equal(shadowReachesView(tree(1, 20, 2), viewOf({ sun: SUN_BEHIND })), false, "its shadow ends behind the camera");
});

test("props too small to cast, furniture and unsized placements are never admitted for a shadow", () => {
  const view = viewOf({ sun: SUN_BEHIND });
  assert.equal(shadowReachesView(tree(1, 20, 1), view), false);
  assert.equal(shadowReachesView(tree(1, 20, 5, { interior: true }), view), false);
  assert.equal(shadowReachesView(tree(1, 20, 5, { admissionRadius: undefined }), view), false);
  assert.equal(shadowReachesView(tree(1, 20, 5, { sun: undefined }), viewOf({ sun: [0, 0, 1] })), false, "no sun above the horizon");
});

test("a building's world box stands on its floor and reaches its top", () => {
  const out = { x: 0, y: 0, z: 0, radius: 0 };
  const building = { kind: "wmo", x: 0, y: 0, z: 0, scale: 1,
    bounds: { minX: -10, minY: 10, minZ: 5, maxX: 10, maxY: 30, maxZ: 25 } };
  assert.equal(shadowCasterSphere(building, out), true);
  assert.deepEqual([out.x, out.y, out.z], [0, 5, -20]);
  assert.ok(Math.abs(out.radius - Math.hypot(10, 10, 20)) < 1e-9);
  assert.equal(shadowReachesView({ ...building, bounds: { minX: -10, minY: -40, minZ: -2, maxX: 10, maxY: -20, maxZ: 18 } },
    viewOf({ sun: SUN_BEHIND, covers: () => false })), true, "a tower behind the camera");
});

test("admission is nearest first and bounded", () => {
  const rejected = [];
  for (let id = 0; id < SCENERY_SHADOW_ADMISSION_BUDGET + 40; id++) rejected.push({ object: tree(id, 20), distance: 1000 - id });
  const out = admitShadowCastersInto(rejected, viewOf({ sun: SUN_BEHIND }), [7]);
  assert.equal(out.length, SCENERY_SHADOW_ADMISSION_BUDGET);
  assert.equal(out[0].distance, 1000 - (SCENERY_SHADOW_ADMISSION_BUDGET + 39));
  for (let at = 1; at < out.length; at++) assert.ok(out[at - 1].distance <= out[at].distance);
});

test("the view's admission hands over what its frustum rejected, furniture excepted", () => {
  const view = viewOf({ sun: SUN_BEHIND });
  const ahead = { object: tree(1, -30), distance: 30, range: 200 };
  const behind = { object: tree(2, 30), distance: 30, range: 200 };
  const furniture = { object: tree(3, 30, 5, { interior: true }), distance: 30 };
  const rejected = [ahead];
  const admitted = admitEnvironmentInto([ahead, behind, furniture], view.planes, undefined, 0, [], rejected);
  const ids = admitted.map(({ object }) => object.id);
  assert.ok(ids.includes(1) && !ids.includes(2));
  assert.deepEqual(rejected.map(({ object }) => object.id), [2]);
});

test("a building's shadow-only rooms are the ones with a stand-in", () => {
  const groups = [{ indoor: false, exterior: false }, { indoor: true, exterior: false }, { indoor: true, exterior: true }, undefined];
  assert.deepEqual(outdoorCasterGroups(groups, [0, 1, 2, 3], [9]), [0, 2]);
});

test("the renderer builds shadow-only admissions hidden, keeps a building's rooms and gates them to cast", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const gate = /readonly #environmentShadowGate: CasterGate = \(ref\) => \{([\s\S]*?)\n  \};/.exec(source)?.[1] ?? "";
  assert.match(gate, /shadowUntil >= this\.#submissionSerial \? 2 : 1/, "a building admitted for its shadow answers gate 2");
  assert.match(source, /this\.#admissionRejected,\n\s*\);/, "admission collects its rejected candidates");
  assert.match(source, /this\.#admitShadowCasters\(\);/);
  assert.match(source, /admitted: !shadowOnly/, "a shadow-only build is not drawn");
  assert.match(source, /if \(rendered\.wmo && !keepRooms\) this\.#clearWmoGroups/, "its rooms stay hung");
  assert.match(source, /this\.#shadowCasters\.set\(proxy, casts, owner\.node, this\.#environmentShadowGate, owner\)/,
    "a room's stand-in is owned by its placement");
});
