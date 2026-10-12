import assert from "node:assert/strict";
import test from "node:test";
import { CollisionMesh, CollisionWorld, boomLimits } from "../dist/code/browser/game/Collision.js";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PITCH, CAMERA_FOV_DEGREES, CAMERA_NEAR_PLANE,
  boomAnchor, createCamera,
} from "../dist/code/browser/SimpleScene.js";
import {
  CAMERA_CLIP_MARGIN, CAMERA_CLIP_NEAR, CAMERA_CLIP_REARM, CAMERA_NEAR_SWEEP_SCALE, CAMERA_PIVOT_BODY_SHARE_FLOOR, CAMERA_PIVOT_FLOOR,
  CAMERA_SUBJECT_FADE_END, CAMERA_SUBJECT_FADE_START,
  cameraArmClip, cameraClipEase, cameraPivotUnderCeiling, cameraSubjectOpacity, nearPlaneHalfHeight,
} from "../dist/code/browser/game/CameraClip.js";
import { CAMERA_MIN_WALL_DISTANCE, advanceCameraFrame } from "../dist/code/browser/game/CameraRig.js";
import { WORLD_CAMERA_NEAR_PLANE } from "../dist/code/browser/WorldRenderer3D.js";
import { cameraModelPivotHeight, cameraPivotHeight, game } from "../dist/code/browser/game/Context.js";

// 5.33: the owner's live check — inside buildings the camera jerks and goes into the ceiling. Wow.exe
// 0x00606f90 → 0x00605d60 / 0x006059e0 / 0x00603d30 / 0x008ca080 (CameraClip.ts).

const FRAME = 1 / 60;
const quad = (a, b, c, d) => Float32Array.of(...a, ...b, ...c, ...a, ...c, ...d);
const slab = (z, size = 40) => new CollisionMesh(quad([-size, -size, z], [size, -size, z], [size, size, z], [-size, size, z]));

function room(ceiling) {
  const world = new CollisionWorld();
  world.set(1, slab(0));
  world.set(2, slab(ceiling));
  return world;
}

function rig(overrides = {}) {
  return {
    yaw: 0, pitch: CAMERA_DEFAULT_PITCH, distance: CAMERA_DEFAULT_DISTANCE, view: CAMERA_DEFAULT_DISTANCE,
    viewPitch: CAMERA_DEFAULT_PITCH, zoom: CAMERA_DEFAULT_DISTANCE,
    wallView: Number.POSITIVE_INFINITY, terrainView: Number.POSITIVE_INFINITY,
    pivotHeight: 2.6, eyeHeight: CAMERA_DEFAULT_EYE_HEIGHT,
    ...overrides,
  };
}

test("5.33 Wow.exe's numbers, as its floats hold them", () => {
  assert.equal(CAMERA_CLIP_MARGIN, Math.fround(1 / 9), "0x00a1e354");
  assert.ok(CAMERA_CLIP_REARM > CAMERA_CLIP_MARGIN && CAMERA_CLIP_REARM - CAMERA_CLIP_MARGIN < 1e-5, "0x00a1ea80, a hair over");
  assert.equal(CAMERA_PIVOT_FLOOR, Math.fround(5 / 6), "0x00a1e324");
  assert.equal(CAMERA_PIVOT_BODY_SHARE_FLOOR, 0.75, "0x009e9ee4");
  assert.equal(CAMERA_NEAR_SWEEP_SCALE, 1.75, "0x00a1ea74");
  assert.equal(WORLD_CAMERA_NEAR_PLANE, CAMERA_NEAR_PLANE, "the renderer's own plane");
  assert.equal(CAMERA_CLIP_NEAR, Math.fround(0.1), "0x00adeed4 into camera+0x38, the near distance Wow.exe sweeps at");
});

test("5.33 the ease is 0x008ca080's half cosine over two seconds", () => {
  assert.equal(cameraClipEase(5, 21, 0), 5);
  assert.ok(Math.abs(cameraClipEase(5, 21, 1) - 13) < 1e-12, "halfway at one second");
  assert.ok(Math.abs(cameraClipEase(5, 21, 0.5) - (5 + 16 * (1 - Math.SQRT1_2) / 2)) < 1e-12);
  assert.ok(cameraClipEase(5, 21, 0.1) - 5 < (cameraClipEase(5, 21, 1.0) - cameraClipEase(5, 21, 0.9)), "slow, then fast");
  assert.equal(cameraClipEase(5, 21, 2), 21, "the target once the ratio reaches 1");
  assert.equal(cameraClipEase(5, 21, 7), 21);
});

test("5.33 a low ceiling lowers the hinge to 1/9 under it, never under 3/4 of the body nor over the eased height", () => {
  // A mounted character, the hinge 2.5 over the feet, under a ceiling 2.2 up: the plumb line from 5/6 of a yard
  // meets it, and the hinge stands 1/9 under it.
  const low = room(2.2);
  assert.ok(Math.abs(cameraPivotUnderCeiling(low, 0, 0, 0, 2.5, 2.5, 2) - (2.2 - CAMERA_CLIP_MARGIN)) < 1e-6);
  // A body of 3 yards keeps it at 2.25, in the ceiling (0x00605d60's 3/4 of +0x854).
  assert.ok(Math.abs(cameraPivotUnderCeiling(low, 0, 0, 0, 2.5, 2.5, 3) - 2.25) < 1e-9);
  // No ceiling within reach: the eased height, untouched.
  assert.equal(cameraPivotUnderCeiling(room(6), 0, 0, 0, 2.5, 2.5, 2), 2.5);
  // Never over the eased height, however high the ceiling or the model's own height.
  assert.equal(cameraPivotUnderCeiling(room(6), 0, 0, 0, 2.5, 2.1, 2), 2.1);
  // A ceiling right over the start of the line: the reach never under 1/9, so 5/6 + 1/9.
  assert.ok(Math.abs(cameraPivotUnderCeiling(room(0.9), 0, 0, 0, 2.5, 2.5, 1) - (CAMERA_PIVOT_FLOOR + CAMERA_CLIP_MARGIN)) < 1e-6);
  // Nothing to ask: min(max(scan, 5/6), current).
  assert.equal(cameraPivotUnderCeiling(undefined, 0, 0, 0, 2.5, 2.5, 2), 2.5);
  assert.equal(cameraPivotUnderCeiling(undefined, 0, 0, 0, 0.7, 0.7, 1), 0.7, "a gnome's hinge is not raised");
});

test("5.33 a mount in a low room: the camera hangs under the ceiling, then the hinge creeps back on the cosine", () => {
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const world = room(2.5);
  // Before 5.33 the hinge stayed at the model's 2.6, over the ceiling, and every camera hung from it was above it.
  for (let degrees = -10; degrees >= -60; degrees -= 5) {
    const state = rig({ pitch: (degrees * Math.PI) / 180 });
    for (let frame = 0; frame < 30; frame++) {
      advanceCameraFrame(state, player, 2.6, { collision: world, bodyHeight: 2.9 }, FRAME);
    }
    const hinge = 2.5 - CAMERA_CLIP_MARGIN;
    assert.ok(Math.abs(state.viewPivotHeight - hinge) < 1e-6, `${degrees}°: hinge ${state.viewPivotHeight}`);
    const camera = createCamera(player, state.yaw, state.viewPitch, state.view, { pivotHeight: state.viewPivotHeight });
    assert.ok(camera.position.z < 2.5, `${degrees}°: camera at z = ${camera.position.z}`);
    // And the swept quad's upper edge too (Wow.exe's near distance, ×1.75), which is what the sweep is for.
    const top = camera.position.z + camera.forward.z * CAMERA_CLIP_NEAR
      + camera.up.z * nearPlaneHalfHeight() * CAMERA_NEAR_SWEEP_SCALE;
    assert.ok(top < 2.5, `${degrees}°: the near plane reaches z = ${top}`);
  }

  // Out of the room: the hinge goes back from 0.1111 past where it was held to the model's 2.6 in two seconds.
  const state = rig();
  advanceCameraFrame(state, player, 2.6, { collision: world, bodyHeight: 2.9 }, FRAME);
  const held = state.viewPivotHeight;
  const open = new CollisionWorld();
  open.set(1, slab(0));
  for (let frame = 1; frame <= 119; frame++) {
    advanceCameraFrame(state, player, 2.6, { collision: open, bodyHeight: 2.9 }, FRAME);
    const expected = cameraClipEase(held + CAMERA_CLIP_REARM, 2.6, frame * FRAME);
    assert.ok(Math.abs(state.viewPivotHeight - expected) < 1e-9, `frame ${frame}: ${state.viewPivotHeight} against ${expected}`);
  }
  advanceCameraFrame(state, player, 2.6, { collision: open, bodyHeight: 2.9 }, FRAME);
  advanceCameraFrame(state, player, 2.6, { collision: open, bodyHeight: 2.9 }, FRAME);
  assert.equal(state.viewPivotHeight, 2.6);
  assert.equal(state.pivotFrom, undefined);

  // First person keeps its eye and forgets the ease.
  const eye = rig({ distance: 0, zoom: 0, view: 0 });
  advanceCameraFrame(eye, player, 1.9, { collision: world, bodyHeight: 2.9 }, FRAME);
  assert.equal(eye.viewPivotHeight, undefined);
});

test("5.33 the near plane's quad (×1.75) is swept clear of a wall the segment alone never meets", () => {
  // A wall along the arm, 0.12 to its side from two yards behind the character: parallel to the segment, so the
  // segment never meets it — and inside the ×1.75 quad's half width at 16:9 (0.152), outside the ×1 quad's (0.087).
  const halfHeight = nearPlaneHalfHeight();
  assert.ok(Math.abs(halfHeight - CAMERA_CLIP_NEAR * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360)) < 1e-12);
  assert.ok(0.12 > halfHeight * 16 / 9 && 0.12 < halfHeight * CAMERA_NEAR_SWEEP_SCALE * 16 / 9);
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(quad([-2, 0.12, -5], [-30, 0.12, -5], [-30, 0.12, 10], [-2, 0.12, 10])));
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const camera = createCamera(player, 0, 0, CAMERA_DEFAULT_DISTANCE, { pivotHeight: 1.6 });
  const pivot = boomAnchor(camera, CAMERA_DEFAULT_DISTANCE);
  assert.equal(boomLimits(pivot, camera.position, { world }).wall, 1, "the segment (the old rule) grants the whole arm");
  const arm = cameraArmClip(world, pivot, camera, CAMERA_DEFAULT_DISTANCE, 16 / 9);
  // The quad meets the wall's end 2 yards out, the eye stands the near plane behind it, and 1/9 is given back.
  assert.ok(Math.abs(arm - (2 + CAMERA_CLIP_NEAR - CAMERA_CLIP_MARGIN)) < 1e-6, `${arm}`);
  // 0.2 to the side is outside the quad: the whole arm.
  const aside = new CollisionWorld();
  aside.set(1, new CollisionMesh(quad([-2, 0.2, -5], [-30, 0.2, -5], [-30, 0.2, 10], [-2, 0.2, 10])));
  assert.equal(cameraArmClip(aside, pivot, camera, CAMERA_DEFAULT_DISTANCE, 16 / 9), CAMERA_DEFAULT_DISTANCE);
  // A narrower window narrows the quad: at 4:3 the 0.12 is outside it (0.0853 × 4/3 = 0.114).
  assert.equal(cameraArmClip(world, pivot, camera, CAMERA_DEFAULT_DISTANCE, 4 / 3), CAMERA_DEFAULT_DISTANCE);
  // The same wall cut into 512 triangles, so the mesh has a grid and the sweep walks its cells.
  const tiles = [];
  for (let i = 0; i < 16; i++) {
    for (let k = 0; k < 16; k++) {
      const x0 = -2 - i * 1.75;
      const z0 = -5 + k * 0.9375;
      tiles.push(...quad([x0, 0.12, z0], [x0 - 1.75, 0.12, z0], [x0 - 1.75, 0.12, z0 + 0.9375], [x0, 0.12, z0 + 0.9375]));
    }
  }
  const gridded = new CollisionWorld();
  gridded.set(1, new CollisionMesh(Float32Array.from(tiles)));
  assert.ok(gridded.get(1).candidates(-3, 0, -2, 1) !== undefined, "the mesh is gridded");
  assert.ok(Math.abs(cameraArmClip(gridded, pivot, camera, CAMERA_DEFAULT_DISTANCE, 16 / 9) - arm) < 1e-6);
});

test("5.33 a wall across the arm: the segment, the quad clear of it, and 1/9 back", () => {
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(quad([-4, -40, -20], [-4, 40, -20], [-4, 40, 20], [-4, -40, 20])));
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const camera = createCamera(player, 0, 0, CAMERA_DEFAULT_DISTANCE, { pivotHeight: 1.6 });
  const pivot = boomAnchor(camera, CAMERA_DEFAULT_DISTANCE);
  // Square to the wall the quad touches it with the eye: the segment's 4, less 1/9.
  assert.ok(Math.abs(cameraArmClip(world, pivot, camera, CAMERA_DEFAULT_DISTANCE, 16 / 9) - (4 - CAMERA_CLIP_MARGIN)) < 1e-6);
  // Turned 60° to it, the quad's near corner meets the wall before the eye's segment does.
  const turned = createCamera(player, Math.PI / 3, 0, CAMERA_DEFAULT_DISTANCE, { pivotHeight: 1.6 });
  const segment = 4 / Math.cos(Math.PI / 3);
  const corner = (4 - nearPlaneHalfHeight() * CAMERA_NEAR_SWEEP_SCALE * (16 / 9) * Math.sin(Math.PI / 3))
    / Math.cos(Math.PI / 3);
  const arm = cameraArmClip(world, pivot, turned, CAMERA_DEFAULT_DISTANCE, 16 / 9);
  assert.ok(corner + CAMERA_CLIP_NEAR < segment, "the case is the quad's");
  assert.ok(Math.abs(arm - (corner + CAMERA_CLIP_NEAR - CAMERA_CLIP_MARGIN)) < 1e-6, `${arm} against ${corner}`);
  // Nothing in the way, nothing given back.
  assert.equal(cameraArmClip(new CollisionWorld(), pivot, camera, 12, 16 / 9), 12);
});

test("5.33 the arm is asked again along the tilt it is drawn at, when the floor changed it", () => {
  // Looking up 10°, the whole 21.31-yard arm would put the camera under the feet, so it is scanned at the 3.9° the
  // floor allows it; a wall 8 yards back cuts it, and the shorter arm is drawn at the drag's 10° — a line that
  // passes through a bench the 3.9° line clears. (Measured in the Goldshire inn before this: 26 of 960 views.)
  const world = new CollisionWorld();
  world.set(1, slab(0));
  world.set(2, new CollisionMesh(quad([-8, -40, -1], [-8, 40, -1], [-8, 40, 10], [-8, -40, 10])));
  const bench = [
    ...quad([-6.5, -3, 0.5], [-7.5, -3, 0.5], [-7.5, 3, 0.5], [-6.5, 3, 0.5]),
    ...quad([-6.5, -3, 0], [-6.5, 3, 0], [-6.5, 3, 0.5], [-6.5, -3, 0.5]),
    ...quad([-7.5, -3, 0], [-7.5, 3, 0], [-7.5, 3, 0.5], [-7.5, -3, 0.5]),
  ];
  world.set(3, new CollisionMesh(Float32Array.from(bench)));
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const state = rig({ pitch: (10 * Math.PI) / 180, pivotHeight: 1.6 });
  for (let frame = 0; frame < 10; frame++) advanceCameraFrame(state, player, 1.6, { collision: world, bodyHeight: 2 }, FRAME);
  const hinge = { x: 0, y: 0, z: 1.6 };
  const camera = createCamera(player, state.yaw, state.viewPitch, state.view, { pivotHeight: 1.6 });
  assert.equal(world.firstHit(hinge, camera.position), undefined, `the eye at ${camera.position.x}, ${camera.position.z}`);
  const halfHeight = nearPlaneHalfHeight() * CAMERA_NEAR_SWEEP_SCALE;
  const halfWidth = halfHeight * 16 / 9;
  for (const [across, up] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const corner = {
      x: camera.position.x + camera.forward.x * CAMERA_CLIP_NEAR + camera.right.x * halfWidth * across + camera.up.x * halfHeight * up,
      y: camera.position.y + camera.forward.y * CAMERA_CLIP_NEAR + camera.right.y * halfWidth * across + camera.up.y * halfHeight * up,
      z: camera.position.z + camera.forward.z * CAMERA_CLIP_NEAR + camera.right.z * halfWidth * across + camera.up.z * halfHeight * up,
    };
    assert.equal(world.firstHit(hinge, corner), undefined, `the quad's corner ${across},${up}`);
  }
});

test("5.33 the subject fades as the eye closes in on it, as Wow.exe draws it, now that a wall may bring it all the way", () => {
  assert.equal(CAMERA_MIN_WALL_DISTANCE, 0, "0x00605d60 never floors the arm over 0");
  const near = CAMERA_CLIP_NEAR;
  assert.equal(cameraSubjectOpacity(CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_PITCH, 1.6), 1);
  assert.equal(cameraSubjectOpacity(near + CAMERA_SUBJECT_FADE_START, CAMERA_DEFAULT_PITCH, 1.6), 1, "the fade starts there");
  assert.equal(cameraSubjectOpacity(near + CAMERA_SUBJECT_FADE_END, CAMERA_DEFAULT_PITCH, 1.6), 0);
  assert.equal(cameraSubjectOpacity(0, CAMERA_DEFAULT_PITCH, 1.6), 0, "an eye in the head draws no body");
  const quarter = near + CAMERA_SUBJECT_FADE_END + (CAMERA_SUBJECT_FADE_START - CAMERA_SUBJECT_FADE_END) / 4;
  // 0x008ca080(0, 255, ¼) = 255 · (1 − cos 45°) / 2 = 37.3, rounded to a byte.
  assert.equal(cameraSubjectOpacity(quarter, CAMERA_DEFAULT_PITCH, 1.6), 37 / 255, "0x008ca080 a quarter in, a byte");
  // Close under the hinge and looking up past 68°, the fade reaches further: at 80° up by (10/22)² less.
  const up80 = (80 * Math.PI) / 180;
  const share = (Math.PI / 2 - up80) / (Math.PI / 2 - 1.186823844909668);
  const reach = CAMERA_SUBJECT_FADE_START / (share * share);
  assert.ok(cameraSubjectOpacity(near + 3, up80, 3.5) < 1, `faded at 3 yards: reach ${reach}`);
  assert.equal(cameraSubjectOpacity(near + 3, up80, 2), 1, "not when the eye is farther out than the hinge is high");
  assert.equal(cameraSubjectOpacity(near + 3, CAMERA_DEFAULT_PITCH, 3.5), 1, "nor at an ordinary tilt");
});

test("5.33 every camera the frame draws hangs from the hinge the step settled on", () => {
  const saved = { ...game.camera };
  try {
    game.camera.distance = CAMERA_DEFAULT_DISTANCE;
    game.camera.pivotHeight = 2.6;
    game.camera.viewPivotHeight = 2.3889;
    assert.equal(cameraPivotHeight(), 2.3889);
    assert.equal(cameraModelPivotHeight(), 2.6, "the step itself starts from the model's");
    game.camera.viewPivotHeight = undefined;
    assert.equal(cameraPivotHeight(), 2.6);
    game.camera.distance = 0;
    game.camera.viewPivotHeight = 2.3889;
    assert.equal(cameraPivotHeight(), game.camera.eyeHeight, "first person is the eye");
  } finally {
    Object.assign(game.camera, saved);
    game.camera.viewPivotHeight = saved.viewPivotHeight;
  }
});
