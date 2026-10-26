// 11.02 (26.10): a vehicle's camera offsets in SceneCamera.createCamera (Wow.exe 0x00600730, 0x00606f90): the yaw offset
// swings the arm about the vertical while the view keeps its direction; the pitch offset tilts the view up about
// the camera, which stays put. Without them the camera is the plain orbit to the last bit.
import assert from "node:assert/strict";
import test from "node:test";
import { createCamera } from "../dist/code/browser/SimpleScene.js";

const player = { x: 10, y: 20, z: 5, orientation: 0.7 };
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message} ${actual} vs ${expected}`);

test("zero offsets are the plain orbit", () => {
  assert.deepEqual(createCamera(player, 0.3, -0.2, 12, { pivotHeight: 1.6, lensYaw: 0, lensPitch: 0 }),
    createCamera(player, 0.3, -0.2, 12, { pivotHeight: 1.6 }));
});

test("the pitch offset tilts the view up and leaves the camera where it stands", () => {
  const plain = createCamera(player, 0.3, -0.2, 12, { pivotHeight: 1.6 });
  const lens = createCamera(player, 0.3, -0.2, 12, { pivotHeight: 1.6, lensPitch: 0.25 });
  assert.deepEqual(lens.position, plain.position);
  close(Math.asin(lens.forward.z), -0.2 + 0.25, "view pitch");
  close(Math.atan2(lens.forward.y, lens.forward.x), Math.atan2(plain.forward.y, plain.forward.x), "same heading");
});

test("the yaw offset swings the arm about the hinge and keeps the view's direction", () => {
  const plain = createCamera(player, 0.3, -0.2, 12, { pivotHeight: 1.6 });
  const lens = createCamera(player, 0.3, -0.2, 12, { pivotHeight: 1.6, lensYaw: 0.1 });
  assert.deepEqual(lens.forward, plain.forward);
  const pivot = { x: player.x, y: player.y, z: player.z + 1.6 };
  const arm = (camera) => Math.atan2(pivot.y - camera.position.y, pivot.x - camera.position.x);
  close(arm(lens) - arm(plain), 0.1, "arm turned by the offset");
  close(Math.hypot(lens.position.x - pivot.x, lens.position.y - pivot.y, lens.position.z - pivot.z), 12, "same length");
});
