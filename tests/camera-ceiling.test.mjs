import assert from "node:assert/strict";
import test from "node:test";
import { CAMERA_WALL_CLEARANCE, CollisionMesh, CollisionWorld } from "../dist/code/browser/game/Collision.js";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_PIVOT_HEIGHT, createCamera,
} from "../dist/code/browser/SimpleScene.js";
import {
  CAMERA_FEET_CLEARANCE, CAMERA_FLOOR_CLEARANCE, advanceCameraFrame, cameraFloorHeight,
} from "../dist/code/browser/game/CameraRig.js";

// 11.10: the owner's live check — inside buildings the camera jerks hard and goes into the ceiling.
// The floor under the camera was searched from 0.35 over the higher of the camera and the hinge, and a
// ceiling is a floor from either side (`uprightness` is absolute): a camera the boom had parked under
// a ceiling found the ceiling, and the floor clamp swung the view until the camera stood over it.

const FRAME = 1 / 60;
const quad = (a, b, c, d) => Float32Array.of(...a, ...b, ...c, ...a, ...c, ...d);
const slab = (z) => new CollisionMesh(quad([-40, -40, z], [40, -40, z], [40, 40, z], [-40, 40, z]));
const options = { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT };

function room(ceiling) {
  const world = new CollisionWorld();
  world.set(1, slab(0));
  world.set(2, slab(ceiling));
  return world;
}

function rig(pitch) {
  return {
    yaw: 0, pitch, distance: CAMERA_DEFAULT_DISTANCE, view: CAMERA_DEFAULT_DISTANCE, viewPitch: pitch,
    zoom: CAMERA_DEFAULT_DISTANCE, wallView: Number.POSITIVE_INFINITY, terrainView: Number.POSITIVE_INFINITY,
    pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT, eyeHeight: CAMERA_DEFAULT_EYE_HEIGHT,
  };
}

test("11.10 a ceiling over the camera is not the floor under it", () => {
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const pivotZ = player.z + CAMERA_DEFAULT_PIVOT_HEIGHT;
  const world = room(3);
  // Where the boom leaves a camera the ceiling cut at the default tilt: CAMERA_WALL_CLEARANCE short of
  // the ceiling along the ray, which is 0.18 of a yard under it.
  const hit = (3 - pivotZ) / Math.sin(-CAMERA_DEFAULT_PITCH);
  const parked = createCamera(player, 0, CAMERA_DEFAULT_PITCH, hit - CAMERA_WALL_CLEARANCE, options);
  assert.ok(parked.position.z < 3 && parked.position.z > 3 - CAMERA_FLOOR_CLEARANCE, `${parked.position.z}`);
  assert.equal(cameraFloorHeight(player, parked.position, pivotZ, world), player.z + CAMERA_FLOOR_CLEARANCE,
    "the floor under it is the room's own");
  // The case the search height is for is untouched: a camera swung under the floor the character
  // stands on still finds that floor.
  const upstairs = { x: 0, y: 0, z: 3, orientation: 0 };
  const under = { x: -5, y: 0, z: 2.5 };
  assert.equal(cameraFloorHeight(upstairs, under, upstairs.z + CAMERA_DEFAULT_PIVOT_HEIGHT, world), 3 + CAMERA_FLOOR_CLEARANCE);
});

test("11.10 under a ceiling the camera keeps the drag's tilt and stays under it", () => {
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  for (const ceiling of [3, 4, 6]) {
    const world = room(ceiling);
    // A slow drag from looking along the room to looking down at the character, one degree a step:
    // before 11.10 the drawn tilt flipped between the drag's own and a clamp over the ceiling.
    for (let degrees = -10; degrees >= -60; degrees--) {
      const state = rig((degrees * Math.PI) / 180);
      for (let frame = 0; frame < 30; frame++) {
        advanceCameraFrame(state, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { collision: world }, FRAME);
      }
      assert.equal(state.viewPitch, state.pitch, `ceiling ${ceiling}, drag ${degrees}°: drawn at ${(state.viewPitch * 180 / Math.PI).toFixed(2)}°`);
      const camera = createCamera(player, state.yaw, state.viewPitch, state.view, options);
      assert.ok(camera.position.z < ceiling, `ceiling ${ceiling}, drag ${degrees}°: camera at z = ${camera.position.z}`);
      assert.ok(camera.position.z >= player.z + CAMERA_FEET_CLEARANCE);
    }
  }
});
