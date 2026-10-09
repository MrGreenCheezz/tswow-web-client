import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMERA_LOOK_SENSITIVITY, CAMERA_SMOOTH_ALWAYS, CAMERA_SMOOTH_HORIZONTAL_WHEN_MOVING, CAMERA_SMOOTH_NEVER,
  CAMERA_SMOOTH_WHEN_MOVING, advanceCameraFollow, cameraLookPerPixel,
} from "../dist/code/browser/game/CameraRig.js";
import { CAMERA_DEFAULT_PITCH } from "../dist/code/browser/SimpleScene.js";

// 5.14: the stock cameraSmoothStyle (OPTION_TOOLTIP_CAMERA1-4) and cameraYawSmoothSpeed.
const DEG = Math.PI / 180;
const rig = (yaw, pitch = CAMERA_DEFAULT_PITCH) => ({ yaw, pitch });

test("the style decides when the camera comes back behind the character", () => {
  const cases = [
    // style, moving, mouse held → yaw moved?, pitch moved?
    [CAMERA_SMOOTH_NEVER, true, false, false, false],
    [CAMERA_SMOOTH_NEVER, false, false, false, false],
    [CAMERA_SMOOTH_HORIZONTAL_WHEN_MOVING, true, false, true, false],
    [CAMERA_SMOOTH_HORIZONTAL_WHEN_MOVING, false, false, false, false],
    [CAMERA_SMOOTH_WHEN_MOVING, true, false, true, true],
    [CAMERA_SMOOTH_WHEN_MOVING, false, false, false, false],
    [CAMERA_SMOOTH_ALWAYS, false, false, true, true],
    [CAMERA_SMOOTH_ALWAYS, true, false, true, true],
    [CAMERA_SMOOTH_ALWAYS, true, true, false, false],
    [CAMERA_SMOOTH_WHEN_MOVING, true, true, false, false],
    // 3 is not a stock value (the dropdown offers 0, 1, 2, 4).
    [3, true, false, false, false],
  ];
  for (const [style, moving, held, yawMoves, pitchMoves] of cases) {
    const state = rig(60 * DEG, 10 * DEG);
    advanceCameraFollow(state, style, 180, moving, held, 0.1);
    assert.equal(state.yaw !== 60 * DEG, yawMoves, `style ${style} moving ${moving} held ${held}: yaw`);
    assert.equal(state.pitch !== 10 * DEG, pitchMoves, `style ${style} moving ${moving} held ${held}: pitch`);
  }
});

test("the yaw comes home at cameraYawSmoothSpeed degrees a second, the pitch at a quarter of it", () => {
  const state = rig(120 * DEG, CAMERA_DEFAULT_PITCH + 40 * DEG);
  advanceCameraFollow(state, CAMERA_SMOOTH_WHEN_MOVING, 180, true, false, 0.5);
  assert.ok(Math.abs(state.yaw - 30 * DEG) < 1e-9, `90° in half a second, got ${state.yaw / DEG}`);
  assert.ok(Math.abs(state.pitch - (CAMERA_DEFAULT_PITCH + 17.5 * DEG)) < 1e-9, `22.5° of pitch, got ${(state.pitch - CAMERA_DEFAULT_PITCH) / DEG}`);
  advanceCameraFollow(state, CAMERA_SMOOTH_WHEN_MOVING, 180, true, false, 1);
  assert.equal(state.yaw, 0, "and it stops behind the character rather than swinging past");
  assert.equal(state.pitch, CAMERA_DEFAULT_PITCH);
  // The short way round: an offset just past the back comes home through it.
  const behind = rig(-170 * DEG);
  advanceCameraFollow(behind, CAMERA_SMOOTH_HORIZONTAL_WHEN_MOVING, 90, true, false, 0.1);
  assert.ok(Math.abs(behind.yaw - (-161 * DEG)) < 1e-9, `${behind.yaw / DEG}`);
  const faster = rig(120 * DEG);
  advanceCameraFollow(faster, CAMERA_SMOOTH_HORIZONTAL_WHEN_MOVING, 270, true, false, 0.2);
  assert.ok(Math.abs(faster.yaw - 66 * DEG) < 1e-9, "270°/s is the slider's top");
});

test("the mouse look is 0.2° a pixel at the defaults and scales with mouseSpeed and cameraYawMoveSpeed", () => {
  assert.equal(cameraLookPerPixel(100, 180), CAMERA_LOOK_SENSITIVITY);
  assert.ok(Math.abs(cameraLookPerPixel(50, 180) - CAMERA_LOOK_SENSITIVITY / 2) < 1e-15);
  assert.ok(Math.abs(cameraLookPerPixel(100, 270) - CAMERA_LOOK_SENSITIVITY * 1.5) < 1e-15);
  assert.ok(Math.abs(cameraLookPerPixel(150, 90) - CAMERA_LOOK_SENSITIVITY * 0.75) < 1e-15);
  assert.equal(cameraLookPerPixel(Number.NaN, 0), CAMERA_LOOK_SENSITIVITY, "a broken blob is the default");
});
